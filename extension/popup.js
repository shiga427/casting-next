/* popup.js — ②プールから取得 と ①発掘して収集 の2タブ。
 * 収集/発掘の本体は instagram.com のタブ(content_ig.js)で走るので、
 * popup を閉じても最後まで完走し、ダウンロードも行われる。 */
const $ = (id) => document.getElementById(id);
let queue = null; // ②用 { handles:[{handle,tags}], runTag }

function findTab(patterns) {
  return chrome.tabs.query({}).then((tabs) => tabs.find((t) => t.url && patterns.some((p) => t.url.startsWith(p))));
}
async function readDashboard(key) {
  const tab = await findTab(['https://shiga427.github.io/casting-next']);
  if (!tab) return { error: 'ダッシュボードのタブが見つかりません。casting-next を開いてください。' };
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, args: [key],
      func: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    });
    return { raw: res && res.result };
  } catch (e) { return { error: '読取失敗: ' + (e && e.message) }; }
}
async function ensureIgTab() {
  let t = await findTab(['https://www.instagram.com/', 'https://instagram.com/']);
  if (!t) { t = await chrome.tabs.create({ url: 'https://www.instagram.com/', active: false }); await new Promise((r) => setTimeout(r, 4000)); }
  return t;
}
function bindProgress(barId, statusId) {
  const setBar = (d, n) => { $(barId).style.width = n ? Math.round((d / n) * 100) + '%' : '0'; };
  const onMsg = (msg) => {
    if (!msg || msg.type !== 'IGF_PROGRESS' || !msg.p) return;
    const p = msg.p;
    if (p.phase === 'discover') { $(statusId).textContent = `発掘中 [${p.i}/${p.n}] ${p.handle}（候補 ${p.found}）`; setBar(p.i, p.n); }
    else if (p.phase === 'discover_done') { $(statusId).textContent = `発掘完了：候補${p.discovered} / 新規${p.fresh} / 取得対象${p.picked}。取得を開始します…`; setBar(0, 1); }
    else if (p.phase === 'collect') { $(statusId).textContent = `取得中 [${p.i}/${p.n}] ${p.handle} ${p.err ? 'NG(' + p.err + ')' : 'OK'}`; setBar(p.i, p.n); }
    else if (p.phase === 'qual') { $(statusId).textContent = `精査データ収集中 [${p.i}/${p.n}] @${p.handle}`; setBar(p.i, p.n); }
    else if (p.phase === 'dm_wait') { $(statusId).textContent = `レート待機中 ${Math.round(p.waitMs / 1000)}秒 → 次は @${p.handle} [${p.i}/${p.n}]`; setBar(p.i - 1, p.n); }
    else if (p.phase === 'dm') { $(statusId).textContent = `DM処理中 [${p.i}/${p.n}] @${p.handle}`; setBar(p.i, p.n); }
    else if (p.phase === 'dm_result') { $(statusId).textContent = `[${p.i}/${p.n}] @${p.handle} → ${p.result}`; setBar(p.i, p.n); }
  };
  chrome.runtime.onMessage.addListener(onMsg);
  return () => chrome.runtime.onMessage.removeListener(onMsg);
}
function doneSummary(statusId, result) {
  const s = (result && result.stats) || {};
  const errLines = Object.entries(s.byErr || {}).map(([k, v]) => `  ${k}: ${v}`).join('\n');
  const head = s.picked != null ? `発掘→取得 完了（@${s.viewer}）\n候補${s.discovered} / 新規${s.fresh} / 取得${s.picked}\n` : `完了（@${s.viewer}）\n`;
  $(statusId).textContent = head + `OK ${s.ok} / NG ${s.err}`
    + (s.stopped ? `\n⚠ ${s.stopped} で中断（時間を置いて再実行で続きから）` : '')
    + (errLines ? '\n' + errLines : '')
    + `\n→ ${(result.runTag || 'run')}_compact.jsonl を保存。ダッシュボードを開いていれば自動反映します…`;
}

// 自動反映の結果（background から）を、開いていれば表示に足す
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'IGF_AUTOIMPORT') return;
  if (msg.dm) {
    const d = document.getElementById('dmstatus');
    if (d) d.textContent += (msg.result && msg.result.done)
      ? '\n✔ ダッシュボードに反映しました（候補ボードをご確認ください）'
      : '\n（ダッシュボード未オープンのため未反映。開いてから popup を開き直すと反映します）';
    return;
  }
  const el = document.querySelector('.pane.on #status, .pane.on #dstatus') || document.getElementById('dstatus');
  if (!el) return;
  el.textContent += (msg.result && msg.result.done)
    ? (msg.qual ? '\n✔ 先頭の1名を精査画面に自動反映しました（残りは Downloads から順にドロップ）' : '\n✔ ダッシュボードに自動反映しました（分析画面をご確認ください）')
    : (msg.qual ? '\n（ダッシュボード未オープンのため未反映。保存した3ファイルを精査画面にドロップしてください）' : '\n（ダッシュボードが開いていないため未反映。保存したjsonlを「取得結果のドロップ」に入れてください）');
});

/* ---------------- ② プールから取得 ---------------- */
function parseManual() {
  const lines = $('manual').value.split(/\r?\n/).map((l) => l.trim().replace(/^@/, '')).filter(Boolean);
  return lines.length ? { handles: lines.map((h) => ({ handle: h, tags: '' })), runTag: 'manual' } : null;
}
function refreshRun() { const m = parseManual(); $('btnRun').disabled = !((queue && queue.handles && queue.handles.length) || (m && m.handles.length)); }
async function reloadQueue() {
  $('queueInfo').textContent = 'ダッシュボードからキュー取得中…';
  const r = await readDashboard('castnext_cdp_queue');
  if (r.error || !r.raw) { queue = null; $('queueInfo').textContent = r.error || 'ダッシュボードにキューがありません。casting-next で「キューを作る」を押してください。'; }
  else { try { const q = JSON.parse(r.raw); queue = (q.handles && q.handles.length) ? q : null;
    $('queueInfo').textContent = queue ? `キュー ${queue.handles.length}件（run: ${queue.runTag || '?'}）を読み込みました` : 'キューが空です。'; } catch { queue = null; $('queueInfo').textContent = 'キューの読取に失敗しました。'; } }
  refreshRun();
}
async function runPool() {
  const q = (queue && queue.handles && queue.handles.length) ? queue : parseManual();
  if (!q) { $('status').textContent = 'キューがありません。'; return; }
  const ig = await ensureIgTab();
  $('btnRun').disabled = true; $('status').textContent = `${q.handles.length}件の収集を開始…`;
  const unbind = bindProgress('barFill', 'status');
  try {
    const result = await chrome.tabs.sendMessage(ig.id, { type: 'IGF_COLLECT', payload: { handles: q.handles, runTag: q.runTag || 'run', src: '' } });
    unbind();
    if (!result || !result.ok) $('status').textContent = '失敗: ' + ((result && result.error) || '不明') ;
    else doneSummary('status', result);
  } catch (e) { unbind(); $('status').textContent = 'タブ送信に失敗: ' + (e && e.message) + '\ninstagram.com のタブを再読込して再実行してください。'; }
  finally { $('btnRun').disabled = false; }
}

/* ---------------- ① 発掘して収集 ---------------- */
function parseTags() {
  return $('dtags').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const life = l.startsWith('*'); const t = l.replace(/^\*/, '').trim();
    const tag = t.startsWith('#') ? t : '#' + t;
    return { tag, life };
  });
}
function refreshDiscover() { $('btnDiscover').disabled = parseTags().length === 0; }
async function reloadDiscoverTags() {
  const r = await readDashboard('castnext_cdp_discover');
  if (r.error || !r.raw) { $('dstatus').textContent = r.error || 'ダッシュボードの発掘設定が見つかりません。「①発掘から始める」タブでタグを選んでください。'; return; }
  try {
    const cfg = JSON.parse(r.raw);
    $('dtags').value = (cfg.tags || []).map((t) => (t.life ? '*' : '') + t.tag).join('\n');
    if (cfg.target) $('dtarget').value = cfg.target;
    window.__cdp_done = cfg.done || [];
    $('dstatus').textContent = `タグ${(cfg.tags || []).length}件・取得済み${(cfg.done || []).length}件を取り込みました。`;
  } catch { $('dstatus').textContent = '発掘設定の読取に失敗しました。'; }
  refreshDiscover();
}
async function runDiscover() {
  const tags = parseTags();
  if (!tags.length) { $('dstatus').textContent = 'タグを1つ以上入れてください。'; return; }
  const target = Number($('dtarget').value) || 100;
  // done は「ダッシュボードのタグを取り込む」で取得済み。無ければ空（＝全部新規扱い）
  let done = window.__cdp_done || [];
  if (!done.length) { const r = await readDashboard('castnext_cdp_discover'); try { done = JSON.parse(r.raw).done || []; } catch {} }
  const ig = await ensureIgTab();
  $('btnDiscover').disabled = true; $('dstatus').textContent = `${tags.length}タグの発掘を開始…`;
  const unbind = bindProgress('dbarFill', 'dstatus');
  try {
    const result = await chrome.tabs.sendMessage(ig.id, { type: 'IGF_DISCOVER', payload: { tags, target, done, runTag: 'disc' } });
    unbind();
    if (!result || !result.ok) $('dstatus').textContent = '失敗: ' + ((result && result.error) || '不明');
    else doneSummary('dstatus', result);
  } catch (e) { unbind(); $('dstatus').textContent = 'タブ送信に失敗: ' + (e && e.message) + '\ninstagram.com のタブを再読込して再実行してください。'; }
  finally { $('btnDiscover').disabled = false; }
}

/* ---------------- ③ 精査データ収集 ---------------- */
/* 精査対象は「スコア○点以上」。10名に満たなければ発掘→自動反映→再判定を回して補充する。
 * 判断に使う数値の正本はダッシュボード側 js/pipeline/conf.js（castnext_cdp_qual に載って来る）。
 * ここのフォールバックは、ダッシュボードが読めなかったときだけ使う保険。 */
const QUAL_FALLBACK = { maxCollect: 12, maxRounds: 3, minScore: 60, fillTarget: 10 };
const QUAL_WAIT_MS = 30000;   // 発掘→ダッシュボード自動反映の待ち上限
const QUAL_POLL_MS = 2000;
let qualCfg = null;           // 最後に読んだ castnext_cdp_qual

function parseQHandles() {
  return $('qhandles').value.split(/\r?\n/).map((l) => l.trim().replace(/^@/, '')).filter(Boolean);
}
function refreshQual() { $('btnQual').disabled = false; } // 空欄なら精査待ちを取り込むので常に押せる
async function readQualCfg() {
  const r = await readDashboard('castnext_cdp_qual');
  if (r.error || !r.raw) return { error: r.error || 'ダッシュボードに精査待ちがありません。casting-next を開いてください。' };
  try { return { cfg: JSON.parse(r.raw) }; } catch { return { error: '精査待ちの読取に失敗しました。' }; }
}
function qualLine(cfg) {
  const n = (cfg.eligible == null ? (cfg.handles || []).length : cfg.eligible);
  const deferred = cfg.deferred || 0;
  return `スコア${cfg.minScore || QUAL_FALLBACK.minScore}点以上 ${n}名`
    + (deferred > 0 ? `（1回に渡せるのは ${(cfg.handles || []).length}名まで。残り ${deferred}名は次回）` : '')
    + ((cfg.shortfall || 0) > 0 ? `（${cfg.fillTarget || QUAL_FALLBACK.fillTarget}名に ${cfg.shortfall}名不足）` : '');
}
async function reloadQualHandles() {
  const r = await readQualCfg();
  if (r.error) { $('qstatus').textContent = r.error; return; }
  qualCfg = r.cfg;
  $('qhandles').value = (qualCfg.handles || []).map((h) => '@' + h).join('\n');
  $('qstatus').textContent = `精査待ちを取り込みました：${qualLine(qualCfg)}`;
  refreshQual();
}
/* 発掘の結果がダッシュボードにマージされ、castnext_cdp_qual が更新されるのを待つ */
async function waitQualUpdate(prevAt) {
  const until = Date.now() + QUAL_WAIT_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, QUAL_POLL_MS));
    const r = await readQualCfg();
    if (r.cfg && r.cfg.at && r.cfg.at !== prevAt) return r.cfg;
  }
  return null;
}
async function runQual() {
  const manual = parseQHandles();
  const notes = [];
  let cfg = qualCfg;
  if (!manual.length) {
    const r = await readQualCfg();
    if (r.error) { $('qstatus').textContent = r.error; return; }
    cfg = qualCfg = r.cfg;
  }
  const maxCollect = (cfg && cfg.maxCollect) || QUAL_FALLBACK.maxCollect;
  let handles = manual.length ? manual : (cfg.handles || []);
  const ig = await ensureIgTab();
  $('btnQual').disabled = true;
  const unbind = bindProgress('qbarFill', 'qstatus');
  try {
    /* 手入力でないときだけ、不足ぶんを発掘で埋める（手入力は本人の指定を尊重して発掘しない） */
    if (!manual.length && (cfg.shortfall || 0) > 0 && cfg.discover && (cfg.discover.tags || []).length) {
      const maxRounds = cfg.discover.maxRounds || QUAL_FALLBACK.maxRounds;
      const startedWith = cfg.eligible || 0;
      for (let round = 1; round <= maxRounds; round++) {
        const shortfall = cfg.shortfall || 0;
        if (shortfall <= 0) break;
        const target = Math.max(shortfall * 4, 40);
        const prevAt = cfg.at;
        const prevEligible = cfg.eligible || 0;
        $('qstatus').textContent = `${cfg.minScore}点以上が ${prevEligible}件（${cfg.fillTarget}件に不足）。`
          + `\n発掘 ${round}/${maxRounds} 回目：新規${target}件を目標に集めます…`;
        let dr = null;
        try {
          dr = await chrome.tabs.sendMessage(ig.id, {
            type: 'IGF_DISCOVER',
            payload: { tags: cfg.discover.tags, target, done: cfg.discover.done || [], runTag: 'disc' },
          });
        } catch (e) { notes.push(`発掘${round}回目のタブ送信に失敗（${e && e.message}）`); break; }
        if (!dr || !dr.ok) { notes.push(`発掘${round}回目に失敗（${(dr && dr.error) || '不明'}）`); break; }
        const ds = dr.stats || {};
        const limited = ds.stopped === 'rate_limited';
        $('qstatus').textContent = `発掘 ${round}/${maxRounds} 完了（取得${ds.ok || 0}件）。ダッシュボードへの反映を待っています…`;
        const next = await waitQualUpdate(prevAt);
        if (!next) { notes.push(`発掘${round}回目の反映を確認できませんでした（ダッシュボードが開いていない可能性）`); break; }
        cfg = qualCfg = next;
        if (limited) { notes.push(`発掘${round}回目でInstagramのレート制限に当たり中断`); break; }
        if ((cfg.eligible || 0) <= prevEligible) { notes.push(`発掘${round}回目で基準到達の新規が増えませんでした`); break; }
      }
      const gained = (cfg.eligible || 0) - startedWith;
      if (gained > 0) notes.push(`発掘で ${gained}件追加`);
      handles = cfg.handles || [];
    }
    handles = handles.slice(0, maxCollect);   // 取りすぎ防止（残りは次回）
    if (!handles.length) {
      unbind();
      $('qstatus').textContent = `対象が0件です。${(cfg && cfg.minScore) || QUAL_FALLBACK.minScore}点以上の候補がいません。`
        + (notes.length ? '\n' + notes.join(' / ') : '');
      return;
    }
    const head = manual.length ? `手入力 ${handles.length}名` : qualLine(cfg);
    $('qstatus').textContent = `${head}\n${handles.length}名分の精査データ収集を開始…`;
    const result = await chrome.tabs.sendMessage(ig.id, { type: 'IGF_QUAL', payload: { handles } });
    unbind();
    if (!result || !result.ok) $('qstatus').textContent = '失敗: ' + ((result && result.error) || '不明');
    else {
      const s = result.stats || {};
      $('qstatus').textContent = `精査データ完了：${s.ok}名分（NG ${s.err}）${s.stopped ? '（中断）' : ''}\n`
        + (manual.length ? '' : qualLine(cfg) + '\n')
        + (notes.length ? notes.join(' / ') + '\n' : '')
        + `→ 3ファイル×${s.ok}名を Downloads/casting-next/qual/ に保存。先頭は精査画面へ自動反映します…`;
    }
  } catch (e) { unbind(); $('qstatus').textContent = 'タブ送信に失敗: ' + (e && e.message) + '\ninstagram.com のタブを再読込して再実行してください。'; }
  finally { $('btnQual').disabled = false; }
}

/* ---------------- ④ DM送付（設計書_DM自動一括送付 §5-4） ----------------
 * ★ここは唯一の書き込み経路。フォロー・いいね・投稿は実装しない。
 * ★キューは候補ボードで人がチェックした候補だけ。popup 側で対象を増やさない。 */
const DM_DRAFTS_KEY = 'castnext_dm_drafts';
const DM_PENDING_KEY = 'castnext_dm_pending';
const DM_DAILY_KEY = 'castnext_dm_daily';
let dmQueue = null;

function stGet(keys) { return new Promise((r) => { try { chrome.storage.local.get(keys, (v) => r(v || {})); } catch (e) { r({}); } }); }
function stSet(obj) { return new Promise((r) => { try { chrome.storage.local.set(obj, () => r(true)); } catch (e) { r(false); } }); }

/* ★popup では window.confirm() を使わないこと。
 * 拡張のポップアップでネイティブダイアログを開くとポップアップがフォーカスを失って閉じ、
 * JSコンテキストごと壊れるので confirm() の後ろが実行されない（＝押しても無反応・原因も出ない）。
 * 取り消せない操作の確認は「もう一度押す」の2段階でポップアップ内に閉じる。 */
const armed = new Map();
function armOrGo(btnId, label, go) {
  const b = $(btnId);
  const prev = armed.get(btnId);
  if (prev) { clearTimeout(prev.timer); armed.delete(btnId); b.textContent = prev.label; b.classList.remove('danger'); go(); return; }
  const orig = b.textContent;
  b.textContent = label;
  b.classList.add('danger');
  const timer = setTimeout(() => { armed.delete(btnId); b.textContent = orig; b.classList.remove('danger'); }, 30000);
  armed.set(btnId, { timer, label: orig });
}

/* instagram.com のタブで動いている content script が「今の拡張のもの」かを確かめる。
 * 拡張をリロードしただけでは既存タブの content script は入れ替わらない（古いまま or 無効化済み）。 */
async function pingIgTab(tabId, need) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'IGF_PING' });
    if (!r || !r.ok) return { ok: false, reason: 'no-response' };
    if (need && !(r.features || []).includes(need)) return { ok: false, reason: 'stale', features: r.features || [] };
    return { ok: true, info: r };
  } catch (e) { return { ok: false, reason: 'no-listener', error: String(e && e.message) }; }
}
const RELOAD_HINT = 'instagram.com のタブを再読込してから、もう一度押してください。\n'
  + '（拡張をリロードしても、開いたままのタブの中身は古いままなので届きません）';

function dmLine(q) {
  const n = (q.items || []).length;
  const ex = (q.excluded || []).length;
  return `${q.mode === 'auto' ? '全自動' : '半自動'}${q.dryRun ? '・ドライラン' : ''} ${n}件`
    + `\nレート ${Math.round(q.minWaitMs / 1000)}〜${Math.round(q.maxWaitMs / 1000)}秒間隔 / 1分あたり${q.perMinMax}通 / 日次上限${q.dailyCap}件`
    + (ex ? `\nガードで除外 ${ex}件（ダッシュボードのパネルに理由が出ています）` : '')
    + ((q.deferred || 0) > 0 ? `\n日次上限のため 残り ${q.deferred}名は次回` : '');
}

async function reloadDmQueue() {
  $('dmInfo').textContent = 'ダッシュボードから送付キュー取得中…';
  const r = await readDashboard('castnext_cdp_dm');
  if (r.error || !r.raw) {
    dmQueue = null; $('btnDm').disabled = true;
    $('dmInfo').textContent = r.error || '送付キューがありません。ダッシュボードの候補ボードで候補をチェックし、「送付キューを書き出す」を押してください。';
    return;
  }
  try {
    const q = JSON.parse(r.raw);
    dmQueue = (q.items && q.items.length) ? q : null;
    $('btnDm').disabled = !dmQueue;
    const today = await dmSentToday();
    $('dmInfo').textContent = dmQueue
      ? dmLine(dmQueue) + `\n本日この拡張が送った実績 ${today}件（§6-2 の二重ガード）`
      : '送付キューが空です。';
  } catch (e) { dmQueue = null; $('btnDm').disabled = true; $('dmInfo').textContent = '送付キューの読取に失敗しました。'; }
}

async function dmSentToday() {
  const v = (await stGet([DM_DAILY_KEY]))[DM_DAILY_KEY];
  return (v && v.day === new Date().toISOString().slice(0, 10)) ? Number(v.sent) || 0 : 0;
}

async function renderDrafts() {
  const drafts = (await stGet([DM_DRAFTS_KEY]))[DM_DRAFTS_KEY] || [];
  const box = $('dmDrafts');
  if (!drafts.length) { box.textContent = '下書きはありません。'; return; }
  box.innerHTML = drafts.map((d, i) =>
    `<div style="display:flex;gap:6px;align-items:center;margin:4px 0">
       <span style="flex:1">@${String(d.handle).replace(/[<>&]/g, '')}</span>
       <button class="btn ghost" style="width:auto;padding:4px 10px" data-draft="${i}">開く</button>
       <button class="btn" style="width:auto;padding:4px 10px" data-sent="${i}">送信した</button>
     </div>`).join('')
    + `<button class="btn ghost" style="margin-top:6px" id="btnDraftClear">下書きを全部消す</button>`;
  /* 「送信した」＝人が送ったことの申告。ここで初めて status が「DM送付」に進み、
   * dmSentAt が入って既存の dmDue（5営業日でリマインド期限）が動き出す（§7）。
   * 機械は人が送ったかを知りようがないので、この1クリックが唯一の確定手段。 */
  box.querySelectorAll('[data-sent]').forEach((b) => b.onclick = async () => {
    const d = drafts[Number(b.dataset.sent)];
    if (!d) return;
    if (d.test) {   /* 動作確認用の下書きは候補ではないので、状態も監査ログも触らない */
      const rest = drafts.filter((x) => x !== d);
      await stSet({ [DM_DRAFTS_KEY]: rest }); renderDrafts();
      $('dmstatus').textContent = '動作確認用の下書きを片付けました（候補の状態は変えていません）。';
      return;
    }
    try { chrome.runtime.sendMessage({ type: 'IGF_DM_SENT_MANUAL', handle: d.handle, text: d.text }); } catch (e) { /* noop */ }
    const rest = drafts.filter((x) => x !== d);
    await stSet({ [DM_DRAFTS_KEY]: rest });
    renderDrafts();
    $('dmstatus').textContent = `@${d.handle} を「DM送付」にしました。\n`
      + '監査ログに記録し、ダッシュボードが開いていれば候補ボードにも反映します。\n'
      + '5営業日で返信待ちの期限アラートが出ます。';
  });
  box.querySelectorAll('[data-draft]').forEach((b) => b.onclick = async () => {
    const d = drafts[Number(b.dataset.draft)];
    if (!d) return;
    /* ★本文を先にクリップボードへ入れる。
     * DMの入力欄は Lexical 製で、自動入力が通るとは限らない（実機で通らなかった）。
     * 自動入力が失敗しても ⌘V で貼れる状態にしておけば、人は必ず先へ進める。
     * popup のクリック中＝ドキュメントにフォーカスがあるので、ここが最も確実にコピーできる場所。 */
    let copied = false;
    try { await navigator.clipboard.writeText(d.text); copied = true; }
    catch (e) {
      try {   /* 古い経路のフォールバック */
        const ta = document.createElement('textarea');
        ta.value = d.text; document.body.appendChild(ta); ta.select();
        copied = document.execCommand('copy'); ta.remove();
      } catch (e2) { copied = false; }
    }
    $('dmstatus').textContent = copied
      ? `@${d.handle} の本文をコピーしました。\nDM画面が開いたら、自動で入らなければ ⌘V で貼り付けてください。`
      : `@${d.handle} のDM画面を開きます（本文のコピーに失敗しました）。`;
    // DMページを開き、content_ig が本文を流し込む。送信ボタンは押さない（人が押す）。
    // ig.me/m/<handle> は handle だけで1:1スレッドが開く（2026-08-04 実機確認）。
    await stSet({ [DM_PENDING_KEY]: Object.assign({}, d, { copied }) });
    const url = d.handle ? 'https://ig.me/m/' + encodeURIComponent(d.handle)
      : 'https://www.instagram.com/direct/t/' + encodeURIComponent(d.userId) + '/';
    await chrome.tabs.create({ url, active: true });
  });
  const clr = $('btnDraftClear');
  if (clr) clr.onclick = async () => { await stSet({ [DM_DRAFTS_KEY]: [] }); renderDrafts(); };
}

async function runDmSend() {
  if (!dmQueue) { $('dmstatus').textContent = '送付キューがありません。'; return; }
  const n = (dmQueue.items || []).length;
  const already = await dmSentToday();
  // §6-2 拡張側の二重ガード。ダッシュボードのカウントを信用しきらない
  if (!dmQueue.dryRun && dmQueue.mode === 'auto' && already >= dmQueue.dailyCap) {
    $('dmstatus').textContent = `本日すでに ${already}件送っています（上限 ${dmQueue.dailyCap}件）。今日はこれ以上送りません。`;
    return;
  }
  const head = dmQueue.dryRun ? `ドライラン ${n}件（送信しません）`
    : dmQueue.mode === 'auto' ? `全自動で ${n}件に送信します` : `半自動で ${n}件の下書きを作ります（送信はご自身で）`;
  /* 実送信だけ2段階にする（confirm() は使わない。上の armOrGo のコメント参照） */
  if (!dmQueue.dryRun && dmQueue.mode === 'auto') {
    armOrGo('btnDm', `⚠ もう一度押すと ${n}件に本当に送ります`, () => doDmSend(head));
    return;
  }
  doDmSend(head);
}

async function doDmSend(head) {
  const ig = await ensureIgTab();
  $('btnDm').disabled = true; $('btnDmStop').disabled = false;
  $('dmstatus').textContent = `${head}\n最初の1件を処理しています…`;
  const unbind = bindProgress('dmbarFill', 'dmstatus');
  try {
    const ping = await pingIgTab(ig.id, 'IGF_DM');
    if (!ping.ok) {
      unbind();
      $('dmstatus').textContent = (ping.reason === 'stale'
        ? '⚠ instagram.com のタブが古い拡張のままです（DM機能が入っていません）。\n'
        : '⚠ instagram.com のタブに届きませんでした。\n') + RELOAD_HINT;
      return;
    }
    const result = await chrome.tabs.sendMessage(ig.id, { type: 'IGF_DM', payload: dmQueue });
    unbind();
    if (!result || !result.ok) { $('dmstatus').textContent = '失敗: ' + ((result && result.error) || '不明'); return; }
    const s = result.stats || {};
    $('dmstatus').textContent = `完了（@${s.viewer}）\n`
      + (s.dryRun ? `ドライラン ${s.skipped}件（送信API未呼出）\n` : `送信 ${s.sent} / 下書き ${s.draft} / 失敗 ${s.failed}\n`)
      + (s.stopped ? `⚠ ${s.stopped} で全停止しました\n` : '')
      + `→ 監査ログを casting-next/dm/ に保存。ダッシュボードが開いていれば状態を反映します…`;
    renderDrafts();
    reloadDmQueue();
  } catch (e) {
    unbind();
    $('dmstatus').textContent = 'タブ送信に失敗: ' + (e && e.message) + '\ninstagram.com のタブを再読込して再実行してください。';
  } finally { $('btnDm').disabled = false; $('btnDmStop').disabled = true; }
}

/* 動作確認用の下書き（§9-5 の実機確認を、候補データ抜きで行うため）。
 * ★入れるのは固定の確認用テキストだけ。案内文は入らない。
 *   ここから案内文を送れてしまうと「チェックした候補にしか送らない」(§10)の抜け道になる。
 * ★Instagramへのアクセスは0回。下書きをキューに積むだけで、送信は人が押す。 */
const DM_TEST_TEXT = '（Casting Next の動作確認です。この文章に意味はありません）';
async function makeTestDraft() {
  const handle = $('dmTestHandle').value.trim().replace(/^@/, '');
  if (!handle) { $('dmstatus').textContent = '相手のハンドルを入れてください。'; return; }
  const cur = (await stGet([DM_DRAFTS_KEY]))[DM_DRAFTS_KEY] || [];
  const next = cur.filter((x) => String(x.handle).toLowerCase() !== handle.toLowerCase());
  next.push({ handle, userId: '', text: DM_TEST_TEXT, at: new Date().toISOString(), test: true });
  await stSet({ [DM_DRAFTS_KEY]: next });
  await renderDrafts();
  $('dmstatus').textContent = `@${handle} の確認用の下書きを作りました。\n`
    + '下の一覧の「開く」を押すと、DM画面が開いて入力欄に文字が入ります。\n'
    + '**入るかどうかだけ**を見てください。送信は不要です（送っても確認用の文章です）。';
}

async function stopDm() {
  $('dmstatus').textContent += '\n停止を送信しました…';
  try {
    const t = await findTab(['https://www.instagram.com/', 'https://instagram.com/']);
    if (t) await chrome.tabs.sendMessage(t.id, { type: 'IGF_DM_ABORT' });
  } catch (e) { /* 走っていなければ無害 */ }
}

/* ---------------- タブ切替・初期化 ---------------- */
document.querySelectorAll('.tab').forEach((t) => t.onclick = () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.id === 'pane-' + t.dataset.pane));
});
$('btnReload').onclick = reloadQueue;
$('btnRun').onclick = runPool;
$('manual').oninput = refreshRun;
$('btnDReload').onclick = reloadDiscoverTags;
$('btnDiscover').onclick = runDiscover;
$('btnQReload').onclick = reloadQualHandles;
$('btnQual').onclick = runQual;
$('qhandles').oninput = refreshQual;
$('btnDmReload').onclick = reloadDmQueue;
$('btnDm').onclick = runDmSend;
$('btnDmStop').onclick = stopDm;
$('btnDmTest').onclick = makeTestDraft;
// タグ・目標件数はブラウザに保存して、次に開いたとき復元する（都度入力しなくてよい）
$('dtags').oninput = () => { refreshDiscover(); try { chrome.storage.local.set({ dtags: $('dtags').value }); } catch (e) {} };
$('dtarget').oninput = () => { refreshDiscover(); try { chrome.storage.local.set({ dtarget: $('dtarget').value }); } catch (e) {} };
try {
  chrome.storage.local.get(['dtags', 'dtarget'], (v) => {
    if (v && v.dtags && !$('dtags').value) $('dtags').value = v.dtags;
    if (v && v.dtarget) $('dtarget').value = v.dtarget;
    refreshDiscover();
  });
} catch (e) { /* noop */ }
reloadQueue();
refreshDiscover();
refreshQual();
renderDrafts();
