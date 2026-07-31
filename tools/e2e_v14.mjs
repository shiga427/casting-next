/* 管制室 v1.4 のヘッドレス検証(verify_v14_run6.py)のうち、**DOMが要る3項目**を実ブラウザで確認する。
 *   ① 起動・バージョン表記・コンソールエラーなし
 *   ⑥ 詳細モーダル経由のDM送付日が記録される(判断16の回帰)
 *   ⑥b モーダルを閉じても送付日が消えない
 * 残り8項目は tests/v14_parity.test.js(node --test)で検証している。
 *
 *   python3 -m http.server 8765 &
 *   node tools/e2e_v14.mjs
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const URL_BASE = arg("--url", "http://localhost:8765");
const CHROME = arg("--chrome", `${homedir()}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`);
const PORT = 9223;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${PORT}`, "--window-size=1440,1100",
  "--user-data-dir=/tmp/castnext-e2e-v14", URL_BASE + "/#/dash"
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
  await send("Page.navigate", { url: URL_BASE + "/#/board" });
  await sleep(1200);
  await evaluate(`window.BASE = ${JSON.stringify(URL_BASE)}`);

  /* 準備:プロジェクト作成 + v26 fixture の取り込み */
  await evaluate(`(async () => {
    const store = await import(BASE + '/js/store.js');
    if (!store.state.project) await store.createProject({ id:'p1', name:'検証', preset:'stembeaute_v26' });
    const text = await (await fetch(BASE + '/tests/fixtures/v26_cases.jsonl')).text();
    const collect = await import(BASE + '/js/views/collect.js');
    collect.handleFile(text, 'fixture_v26.jsonl');
    location.hash = '#/board';
    return true;
  })()`);
  await sleep(1200);

  /* ① 起動・バージョン表記・コンソールエラーなし */
  const ver = await evaluate(`document.getElementById('verLabel') ? document.getElementById('verLabel').textContent : ''`);
  rec(1, "起動・バージョン表記・コンソールエラーなし",
    ver.includes("SBIS v2.6") && errors.length === 0, `verLabel=${JSON.stringify(ver)} pageerror=${JSON.stringify(errors)}`);

  /* ⑥ 詳細モーダル経由のDM送付日(判断16の回帰) */
  const dm = await evaluate(`(async () => {
    const detail = await import(BASE + '/js/views/detail.js');
    const store = await import(BASE + '/js/store.js');
    const util = await import(BASE + '/js/pipeline/util.js');
    const c = store.state.cands.find(x => x.username === 'sample_life');
    c.fitComment = '① 生活者の証言者候補。② 生活の場面が画面に載る。③ 週次リズムに耐える。④ 懸念:タイアップ比率が未確認。';
    detail.open('sample_life');
    const sel = document.getElementById('mStatus');
    sel.value = 'DM送付';
    sel.dispatchEvent(new Event('change'));
    detail.save();
    const today = util.todayISO();
    return { dmSentAt: c.dmSentAt, today, input: document.getElementById('mDmDate').value };
  })()`);
  rec(6, "詳細モーダル経由のDM送付日が記録される(判断16)",
    dm.dmSentAt === dm.today && dm.input === dm.today, JSON.stringify(dm));

  /* ⑥b モーダルを閉じても送付日が消えない */
  const dm2 = await evaluate(`(async () => {
    const detail = await import(BASE + '/js/views/detail.js');
    const store = await import(BASE + '/js/store.js');
    document.getElementById('mClose').click();
    const c = store.state.cands.find(x => x.username === 'sample_life');
    return { dmSentAt: c.dmSentAt, open: document.getElementById('ovDetail').classList.contains('open') };
  })()`);
  rec("6b", "モーダルを閉じても送付日が消えない", dm2.dmSentAt === dm.today && !dm2.open, JSON.stringify(dm2));

  /* おまけ:適合コメントが空の候補は「DM送付」列にドロップできない(§4-5) */
  const blocked = await evaluate(`(async () => {
    const store = await import(BASE + '/js/store.js');
    const sbis = await import(BASE + '/js/pipeline/sbis.js');
    const c = store.state.cands.find(x => x.username === 'sample_expert');
    c.fitComment = '';
    const r = sbis.setStatus(c, 'DM送付', '2026-07-30');
    return { ok: r.ok, reason: r.reason || '', status: c.status };
  })()`);
  rec(5, "適合コメント空のままDM送付に進めない(§4-5・A5)",
    blocked.ok === false && blocked.status !== "DM送付", JSON.stringify(blocked));

  if (errors.length) console.log("⚠ ページ例外:", errors.slice(0, 5));
  const fails = results.filter(r => !r.ok);
  console.log(`\n==== RESULT: ${fails.length ? fails.length + " FAIL" : "ALL PASS"}(${results.length}項目・残り8項目は node --test tests/v14_parity.test.js)====`);
  process.exitCode = fails.length || errors.length ? 1 : 0;
} catch (e) {
  console.error("失敗:", e.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch (e) { }
  chrome.kill();
}
