/* 「発掘から始める」モードの通し確認(プールCSVを1度も使わない経路)。
 *
 *   python3 -m http.server 8765 &
 *   node tools/e2e_discovery.mjs [--url http://localhost:8765]
 *
 * データゼロの新規プロジェクトから:
 *   ① 収集画面の既定タブが「発掘から始める」であること(プール警告が出ないこと)
 *   ② タグ選択 → 発掘依頼文の生成(タグ・取得済み除外・禁止事項が入っていること)
 *   ③ 取得結果(サンプルJSONL)のドロップ → 分析結果が出ること
 *   ④ ドロップでプール・取得済み台帳・探索カバレッジ表が自動更新され、②プールモードが使えること
 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { homedir } from "node:os";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const URL_BASE = arg("--url", "http://localhost:8765");
const CHROME = arg("--chrome", `${homedir()}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`);
const PORT = 9224;
const PROFILE = "/tmp/castnext-e2e-discovery";
const sleep = ms => new Promise(r => setTimeout(r, ms));
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { }

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${PORT}`, "--window-size=1440,1100",
  `--user-data-dir=${PROFILE}`, URL_BASE + "/#/dash"
], { stdio: "ignore" });

let ws, msgId = 0;
const pending = new Map();
const results = [];
function rec(no, title, ok, obs) {
  results.push({ no, ok });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${no}. ${title}\n      ${obs}`);
}
function send(method, params) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params: params || {} }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "評価に失敗");
  return r.result.value;
}

try {
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find(t => t.type === "page" && t.webSocketDebuggerUrl);
    } catch (e) { }
  }
  if (!target) throw new Error("Chrome に接続できませんでした");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const errors = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || "例外");
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: URL_BASE + "/#/dash" });
  await sleep(1300);
  await evaluate(`window.BASE = ${JSON.stringify(URL_BASE)}`);

  /* 新規プロジェクトを作る(ウィザードのクリックだけ。サンプルは読まずデータゼロのまま) */
  await evaluate(`(() => { const b = document.getElementById('wNext1'); if (b) b.click(); })()`);
  await sleep(500);
  await evaluate(`(() => { const b = document.getElementById('wNext2'); if (b) b.click(); })()`);
  await sleep(300);
  await evaluate(`(() => { const b = document.getElementById('wSkip'); if (b) b.click(); })()`);
  await sleep(300);
  await evaluate(`location.hash = '#/collect'`);
  await sleep(900);

  /* ① 既定タブが発掘モードで、プール警告が出ていない */
  const first = await evaluate(`(async () => {
    const store = await import(BASE + '/js/store.js');
    const t = document.getElementById('view').innerText;
    return {
      cands: store.state.cands.length, runs: store.state.runs.length,
      pool: ((store.state.queue||{}).pool||[]).length,
      tagCount: document.querySelectorAll('.tagchk').length,
      checked: document.querySelectorAll('.tagchk:checked').length,
      hasDiscoverBtn: !!document.getElementById('btnDiscover'),
      poolWarning: /プールCSVを読み込んでください/.test(t),
      activeTab: (document.querySelector('.runsel .chip.on')||{}).textContent || ''
    };
  })()`);
  rec(1, "データゼロの新規プロジェクトで既定が「発掘から始める」・プール警告なし",
    first.cands === 0 && first.runs === 0 && first.pool === 0 && first.tagCount >= 17
    && first.checked === first.tagCount && first.hasDiscoverBtn && !first.poolWarning
    && first.activeTab.includes("発掘"),
    JSON.stringify(first));

  /* ② 発掘依頼文の生成(プールなしで作れること) */
  await evaluate(`document.getElementById('btnDiscover').click()`);
  await sleep(900);
  const req = await evaluate(`(() => {
    const t = document.getElementById('reqText').value;
    return {
      len: t.length,
      hasTags: /#ママ美容/.test(t), hasHashtagApi: /IGF\\.hashtag/.test(t),
      hasProfileBatch: /IGF\\.profileBatch/.test(t), hasBan: /DM送信/.test(t),
      hasPace: /429/.test(t), hasBandCheck: /30件/.test(t), hasCap: /__CAP/.test(t),
      hasDoneSection: /取得済み/.test(t), noPlaceholder: !/\\{[A-Z_]+\\}/.test(t),
      hasE1Marker: /E1:/.test(t)
    };
  })()`);
  rec(2, "プールなしで発掘依頼文が作れる(タグ・発掘API・取得API・禁止事項・ペース・帯内チェック入り)",
    req.len > 1500 && req.hasTags && req.hasHashtagApi && req.hasProfileBatch && req.hasBan
    && req.hasPace && req.hasBandCheck && req.hasCap && req.hasDoneSection && req.noPlaceholder && req.hasE1Marker,
    JSON.stringify(req));

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  (await import("node:fs")).writeFileSync("/tmp/castnext_discover.png", Buffer.from(shot.data, "base64"));
  console.log("スクリーンショット: /tmp/castnext_discover.png");

  /* ③ 取得結果(サンプル)のドロップ → 分析結果 */
  await evaluate(`(async () => {
    const text = await (await fetch(BASE + '/samples/sample_run.jsonl')).text();
    const collect = await import(BASE + '/js/views/collect.js');
    collect.handleFile(text, 'run1_compact.jsonl');
    return true;
  })()`);
  await sleep(1500);
  const analysis = await evaluate(`(() => {
    const t = document.getElementById('view').innerText;
    return { hash: location.hash, attempts: (t.match(/取得試行\\n(\\d+)/)||[])[1], passed: (t.match(/機械合格\\n(\\d+)/)||[])[1] };
  })()`);
  rec(3, "プールCSVなしのまま、ドロップ→分析結果まで到達する",
    analysis.hash === "#/analysis" && Number(analysis.attempts) > 0, JSON.stringify(analysis));

  /* ④ プール・取得済み台帳・カバレッジ表が自動更新され、②が使える */
  const after = await evaluate(`(async () => {
    const store = await import(BASE + '/js/store.js');
    const q = store.state.queue || {};
    location.hash = '#/collect?mode=pool';
    await new Promise(r => setTimeout(r, 600));
    document.getElementById('btnQueue').click();
    await new Promise(r => setTimeout(r, 400));
    const q2 = store.state.queue || {};
    return {
      pool: (q.pool||[]).length, done: (q.doneExtra||[]).length,
      coverage: store.state.coverage.length,
      coverageDone: store.state.coverage.filter(r => r.st === '完了').length,
      sampleRow: store.state.coverage[0] || null,
      queueAfter: (q2.queue||[]).length
    };
  })()`);
  rec(4, "ドロップでプール・取得済み台帳・カバレッジ表が自動更新される(2周目は取得済みが全除外)",
    after.pool > 0 && after.done > 0 && after.coverage > 0 && after.coverageDone > 0 && after.queueAfter === 0,
    JSON.stringify(after));

  if (errors.length) console.log("⚠ ページ例外:", errors.slice(0, 5));
  const fails = results.filter(r => !r.ok);
  console.log(`\n==== RESULT: ${fails.length ? fails.length + " FAIL" : "ALL PASS"}(${results.length}項目)====`);
  process.exitCode = fails.length || errors.length ? 1 : 0;
} catch (e) {
  console.error("失敗:", e.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch (e) { }
  chrome.kill();
}
