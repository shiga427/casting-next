#!/usr/bin/env node
/**
 * collect_cdp.mjs — Chrome DevTools Protocol 経由の IG 収集 CLI（LLM 非経由）
 *
 * これまで Claude in Chrome の javascript_tool がやっていた「ig_probe.js を注入して
 * IGF.profile() を回し、__PROF 圧縮レコードを持ち帰る」を、CDP で直接行う。
 * 取得ロジックは発明しない: kit/ig_probe.js と kit/prof_compact.js を
 * **ファイルからそのまま注入する**（スニペット貼り付け禁止の原則どおり）。
 * 出力 JSONL は ingest_compact.py が読む形式と 1:1（1行 = __PROF レコード）。
 *
 * 前提:
 *   - Node 22 以上（追加ライブラリ不要。fetch / WebSocket は同梱）
 *   - CDP を開いた Chrome。**Chrome 136 以降は既定プロファイルでは
 *     --remote-debugging-port が無効化される**ため、専用プロファイルで起動する:
 *
 *       open -na "Google Chrome" --args \
 *         --remote-debugging-port=9222 \
 *         --user-data-dir="$HOME/.igf-chrome"
 *
 *     開いたウィンドウで instagram.com に一度ログインする（以後は保持される）。
 *
 * 使い方:
 *   node tools/collect_cdp.mjs --queue job_in/queue_v8.txt \
 *        [--done job_in_done.csv] [--out cdp_out/compact.jsonl] \
 *        [--tags "E1:寝かしつけ"] [--src E1] [--limit 100] \
 *        [--min-wait 4000] [--max-wait 12000] [--port 9222] [--no-payloads] [--yes]
 *
 *   - queue: .txt（1行1ハンドル）または .csv（username / handle 列。tags / src 列があれば使う）
 *   - done:  取得済み除外リスト。**username 列でも handle 列でも読む**
 *            （rank_queue.py が handle 固定読みで除外が全滅していた事故の再発防止）
 *   - out:   既存ファイルがあれば追記し、収載済みハンドルはスキップ（中断→再開が可能）
 *   - 429/401 (rate_limited) が出たら即座に停止する。進捗は1件ごとに保存済み。
 *
 * やらないこと: DM送信・フォロー・いいね・投稿・UA偽装（運用ルールどおり）。
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'kit');

// ---------------- 引数 ----------------
const args = {};
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const k = a[i].slice(2);
    if (i + 1 < a.length && !a[i + 1].startsWith('--')) { args[k] = a[++i]; }
    else { args[k] = true; }
  }
}
if (args.help || !args.queue) {
  console.log('usage: node tools/collect_cdp.mjs --queue <file> [--done <csv>] [--out <jsonl>]');
  console.log('       [--tags <str>] [--src <str>] [--limit N] [--min-wait ms] [--max-wait ms]');
  console.log('       [--port 9222] [--url https://www.instagram.com/] [--no-payloads] [--yes]');
  process.exit(args.help ? 0 : 1);
}
const PORT = Number(args.port || 9222);
const BASE_URL = String(args.url || 'https://www.instagram.com/');
const OUT = resolve(String(args.out || 'cdp_out/compact.jsonl'));
const PAYLOAD_DIR = args['no-payloads'] ? null : join(dirname(OUT), 'payloads');
const MIN_WAIT = Number(args['min-wait'] || 4000);   // profileBatch と同じ既定値
const MAX_WAIT = Number(args['max-wait'] || 12000);  // （rate_limited 0 の実績値）
const LIMIT = args.limit ? Number(args.limit) : Infinity;

// ---------------- キュー読み込み ----------------
function parseCsv(text) {
  // 単純CSV（クォート内カンマ非対応。queue/done は単純な列しか持たない前提）
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return [];
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((l) => {
    const cells = l.split(',');
    const row = {};
    header.forEach((h, i) => { row[h] = (cells[i] || '').trim(); });
    return row;
  });
}
function handleCol(row) {
  return (row.username || row.handle || '').replace(/^@/, '').trim();
}
function loadQueue(path) {
  const text = readFileSync(path, 'utf8');
  if (path.toLowerCase().endsWith('.csv')) {
    return parseCsv(text)
      .map((r) => ({ h: handleCol(r), tags: r.tags || '', src: r.src || r.source || '' }))
      .filter((r) => r.h);
  }
  return text.split(/\r?\n/)
    .map((l) => l.trim().replace(/^@/, ''))
    .filter((l) => l && !l.startsWith('#'))
    .map((h) => ({ h, tags: '', src: '' }));
}
function loadDone(path) {
  if (!path) return new Set();
  const text = readFileSync(path, 'utf8');
  const rows = path.toLowerCase().endsWith('.csv')
    ? parseCsv(text).map(handleCol)
    : text.split(/\r?\n/).map((l) => l.trim().replace(/^@/, ''));
  return new Set(rows.filter(Boolean).map((h) => h.toLowerCase()));
}
function loadAlreadyOut(path) {
  const set = new Set();
  if (!existsSync(path)) return set;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    // err 付きレコード(rate_limited 等)は再開時に取り直すため「収載済み」に数えない。
    // ingest_compact.py は err 行をスキップするので、err行→後続のOK行の重複は無害。
    try { const r = JSON.parse(line); if (r.h && !r.err) set.add(String(r.h).toLowerCase()); } catch {}
  }
  return set;
}

// ---------------- CDP ----------------
async function httpJson(method, path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method });
  if (!res.ok) throw new Error(`CDP http ${res.status} for ${path}`);
  return res.json();
}
async function findOrCreateTab() {
  let targets;
  try {
    targets = await httpJson('GET', '/json/list');
  } catch (e) {
    console.error(`\nCDPポート ${PORT} に接続できません。専用プロファイルでChromeを起動してください:\n`);
    console.error('  open -na "Google Chrome" --args \\');
    console.error(`    --remote-debugging-port=${PORT} \\`);
    console.error('    --user-data-dir="$HOME/.igf-chrome"\n');
    console.error('※ Chrome 136以降、既定プロファイルではCDPが無効化されるため');
    console.error('   --user-data-dir の指定は必須です。開いたウィンドウで instagram.com に');
    console.error('   一度ログインしてから、このコマンドを再実行してください。');
    process.exit(2);
  }
  const origin = new URL(BASE_URL).origin;
  let tab = targets.find((t) => t.type === 'page' && (t.url || '').startsWith(origin));
  if (!tab) {
    tab = await httpJson('PUT', `/json/new?${encodeURIComponent(BASE_URL)}`);
    await new Promise((r) => setTimeout(r, 3000));
    const again = await httpJson('GET', '/json/list');
    tab = again.find((t) => t.id === tab.id) || tab;
  }
  if (!tab.webSocketDebuggerUrl) {
    throw new Error('タブは見つかりましたが webSocketDebuggerUrl がありません。他のCDPクライアント(DevTools等)が接続中の可能性があります。そのタブのDevToolsを閉じてください。');
  }
  return tab;
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, ng) => { ws.onopen = ok; ws.onerror = () => ng(new Error('WebSocket接続失敗')); });
    const c = new Cdp(ws);
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && c.pending.has(msg.id)) {
        const { ok, ng } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        msg.error ? ng(new Error(msg.error.message)) : ok(msg.result);
      }
    };
    return c;
  }
  send(method, params = {}, timeoutMs = 120000) {
    const id = ++this.id;
    return new Promise((ok, ng) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        ng(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        ok: (v) => { clearTimeout(timer); ok(v); },
        ng: (e) => { clearTimeout(timer); ng(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  /** ページ内で式を評価して値を返す。例外は Error として投げる。 */
  async eval(expression, timeoutMs) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: false,
    }, timeoutMs);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('page exception: ' + (d.exception?.description || d.text || 'unknown').slice(0, 500));
    }
    return r.result?.value;
  }
}

// ---------------- メイン ----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => MIN_WAIT + Math.random() * Math.max(0, MAX_WAIT - MIN_WAIT);

async function ensureInjected(cdp) {
  const ready = await cdp.eval('typeof window.IGF !== "undefined" && typeof window.__PROF === "function"');
  if (ready) return;
  cdp.probe = cdp.probe || readFileSync(join(KIT_DIR, 'ig_probe.js'), 'utf8');
  cdp.prof = cdp.prof || readFileSync(join(KIT_DIR, 'prof_compact.js'), 'utf8');
  await cdp.eval(cdp.probe);
  await cdp.eval(cdp.prof);
}

async function main() {
  // 1) キュー確定
  const done = loadDone(args.done);
  const already = loadAlreadyOut(OUT);
  const queueAll = loadQueue(String(args.queue));
  const queue = queueAll.filter(
    (r) => !done.has(r.h.toLowerCase()) && !already.has(r.h.toLowerCase())
  ).slice(0, LIMIT);
  console.log(`キュー ${queueAll.length} 件 → 対象 ${queue.length} 件（done ${done.size} 件・出力済み ${already.size} 件を照合して除外）`);
  if (!queue.length) { console.log('取得対象がありません。'); return; }

  // 2) タブ接続 + 注入
  const tab = await findOrCreateTab();
  console.log(`タブ: ${tab.url}`);
  const cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
  await ensureInjected(cdp);

  // 3) ログイン中アカウントの確認（誰のセッションで取るかを明示する）
  const viewer = await cdp.eval('window.IGF.viewer()');
  if (!viewer || !viewer.logged_in) {
    console.error('Instagram にログインしていません。CDP用プロファイルのChromeウィンドウでログインしてから再実行してください。');
    process.exit(3);
  }
  console.log(`ログイン中: @${viewer.username || viewer.viewer_id} — このセッションで取得します`);
  if (!args.yes) {
    process.stdout.write('続行しますか? [y/N] ');
    const ans = await new Promise((r) => {
      process.stdin.once('data', (d) => r(String(d).trim().toLowerCase()));
    });
    if (ans !== 'y' && ans !== 'yes') { console.log('中止しました。'); process.exit(0); }
  }

  // 4) 出力準備
  mkdirSync(dirname(OUT), { recursive: true });
  if (PAYLOAD_DIR) mkdirSync(PAYLOAD_DIR, { recursive: true });

  // 5) 取得ループ（1件ごとに評価→保存。ページ遷移はしない）
  const stats = { ok: 0, err: 0, byErr: {} };
  const t0 = Date.now();
  for (let i = 0; i < queue.length; i++) {
    const { h, tags, src } = queue[i];
    if (i > 0) await sleep(jitter());
    await ensureInjected(cdp); // 遷移等で消えていたら再注入
    let rec, full = null;
    try {
      const r = await cdp.eval(
        `(async () => { const res = await window.IGF.profile(${JSON.stringify(h)});` +
        ` return { compact: window.__PROF(res, ${JSON.stringify(String(args.tags || tags || ''))},` +
        ` ${JSON.stringify(String(args.src || src || ''))}), full: res }; })()`
      );
      rec = r.compact; full = r.full;
    } catch (e) {
      rec = { h, err: 'eval_error: ' + String(e.message).slice(0, 300) };
    }
    appendFileSync(OUT, JSON.stringify(rec) + '\n');
    if (PAYLOAD_DIR && full) {
      writeFileSync(join(PAYLOAD_DIR, h.replace(/[^\w.\-]/g, '_') + '.json'), JSON.stringify(full));
    }
    const err = rec.err || (full && full.error) || null;
    if (err) { stats.err++; stats.byErr[err] = (stats.byErr[err] || 0) + 1; }
    else stats.ok++;
    console.log(`[${i + 1}/${queue.length}] ${h} ${err ? 'NG(' + err + ')' : 'OK'}`);
    if (err === 'rate_limited') {
      console.error('\nrate_limited を検出したため停止します。進捗は保存済みです。');
      console.error('時間を置いて同じコマンドを再実行すれば、続きから再開されます。');
      break;
    }
  }

  // 6) サマリ
  const min = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\n完了: OK ${stats.ok} / NG ${stats.err}（${min}分)`);
  for (const [k, v] of Object.entries(stats.byErr)) console.log(`  ${k}: ${v}`);
  console.log(`出力: ${OUT}`);
  if (PAYLOAD_DIR) console.log(`生ペイロード: ${PAYLOAD_DIR}/`);
  console.log(`次工程: python3 ingest_compact.py ${OUT} <出力ディレクトリ名>`);
  process.exit(0);
}

main().catch((e) => { console.error('致命的エラー:', e.message); process.exit(1); });
