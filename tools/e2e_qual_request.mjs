/* 精査データ依頼文(§5-6 ⓪)の通し確認。
 *
 *   python3 -m http.server 8766 &
 *   node tools/e2e_qual_request.mjs [--url http://localhost:8766]
 *
 *   ① サンプルを取り込んだ状態で精査・定性評価画面を開く
 *   ② 「精査データ依頼文を作ってコピー」で、精査待ち上位10名を埋めた依頼文が出る
 *   ③ 依頼文に3ファイル仕様・taken_at降順・本人返信全文・禁止事項が入っている
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const URL_BASE = arg("--url", "http://localhost:8766");
const CHROME = arg("--chrome", `${homedir()}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`);
const PORT = 9225;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${PORT}`, "--window-size=1440,1100",
  "--user-data-dir=/tmp/castnext-e2e-qual", URL_BASE + "/#/dash"
], { stdio: "ignore" });

let ws, msgId = 0;
const pending = new Map();
const results = [];
function rec(no, title, ok, obs) { results.push({ no, ok }); console.log(`[${ok ? "PASS" : "FAIL"}] ${no}. ${title}\n      ${obs}`); }
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
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  };
  await send("Page.enable"); await send("Runtime.enable");
  await send("Page.navigate", { url: URL_BASE + "/#/dash" });
  await sleep(1300);
  await evaluate(`window.BASE = ${JSON.stringify(URL_BASE)}`);

  /* 候補を入れる(サンプル30件 → 機械合格が候補ボードに入る) */
  await evaluate(`(async () => {
    const store = await import(BASE + '/js/store.js');
    if (!store.state.project) await store.createProject({ id:'p1', name:'検証', preset:'stembeaute_v26' });
    const text = await (await fetch(BASE + '/tests/fixtures/run6_compact.jsonl')).text();
    const collect = await import(BASE + '/js/views/collect.js');
    collect.handleFile(text, 'run6_compact.jsonl');
    return true;
  })()`);
  await sleep(1500);
  await evaluate(`location.hash = '#/qual'`);
  await sleep(900);

  const before = await evaluate(`(async () => {
    const store = await import(BASE + '/js/store.js');
    const q = await import(BASE + '/js/pipeline/qualReport.js');
    return { cands: store.state.cands.length, targets: q.qualTargets(store.state.cands, 10).length,
             hasBtn: !!document.getElementById('btnQualReq') };
  })()`);
  rec(1, "精査画面に依頼文ボタンが出る(精査待ちがいるとき)",
    before.hasBtn && before.targets > 0, JSON.stringify(before));

  await evaluate(`document.getElementById('btnQualReq').click()`);
  await sleep(900);
  const req = await evaluate(`(() => {
    const t = document.getElementById('qualReqText').value;
    return {
      len: t.length,
      handles: (t.match(/^\\d+\\. @/gm) || []).length,
      files: ['_captions.txt','_comments.txt','_profile.txt'].every(f => t.includes(f)),
      taken: t.includes('taken_at'), ownFull: /本人の返信は全文|全文を載せる/.test(t),
      ban: t.includes('DM送信') && t.includes('UA'),
      bio: t.includes('bio'), noPlaceholder: !/\\{[A-Z_]+\\}/.test(t),
      rate: /得点率/.test(t)
    };
  })()`);
  rec(2, "上位10名を埋めた精査データ依頼文が生成される",
    req.len > 1500 && req.handles > 0 && req.handles <= 10 && req.files && req.taken
    && req.ownFull && req.ban && req.bio && req.noPlaceholder && req.rate, JSON.stringify(req));

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync("/tmp/castnext_qual.png", Buffer.from(shot.data, "base64"));
  console.log("スクリーンショット: /tmp/castnext_qual.png");

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
