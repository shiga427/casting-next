/* ブラウザ実機での通しスモーク(P2の完了条件の検証)。
 *
 *   python3 -m http.server 8765 &            # リポジトリ直下で
 *   node tools/e2e_smoke.mjs [--url http://localhost:8765] [--chrome <path>]
 *
 * やること:
 *   ① 画面を開く → プロジェクト作成 → run6 の匿名化fixtureを「ドロップ」相当で流し込む
 *   ② 分析結果画面のDOMに summary_run6.json と同値(機械合格13・帯内35・純度ゲート除外40・
 *      シグナル36/7/15・stance 5/6/1/1)が出ているかを検査
 *   ③ 概要・分析結果のスクリーンショットを /tmp に保存(目視レビュー用)
 *
 * 依存パッケージなし。Chrome の DevTools Protocol を Node 標準の WebSocket で叩くだけ。
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const URL_BASE = arg("--url", "http://localhost:8765");
const CHROME = arg("--chrome", `${homedir()}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`);
const PORT = 9222;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${PORT}`, "--window-size=1440,1180",
  "--user-data-dir=/tmp/castnext-e2e-profile", URL_BASE + "/#/dash"
], { stdio: "ignore" });

let ws, msgId = 0;
const pending = new Map();
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
    } catch (e) { /* まだ起動途中 */ }
  }
  if (!target) throw new Error("Chrome に接続できませんでした");

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");
  const errors = [];
  ws.addEventListener("message", ev => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || "例外");
  });

  await send("Page.navigate", { url: URL_BASE + "/#/dash" });
  await sleep(1200);

  /* ① 初見者テスト(§9-1・P7):URLを開いただけの状態からウィザードをクリックだけで進む */
  const wiz1 = await evaluate(`(() => { const b = document.getElementById('wNext1'); if (b) { b.click(); return true; } return false; })()`);
  await sleep(500);
  await evaluate(`(() => { const b = document.getElementById('wNext2'); if (b) b.click(); })()`);
  await sleep(400);
  const hasSample = await evaluate(`!!document.getElementById('wSample')`);
  await evaluate(`(() => { const b = document.getElementById('wSample'); if (b) b.click(); })()`);
  await sleep(1500);
  const afterWizard = await evaluate(`(async () => {
    const store = await import('/js/store.js');
    return { hash: location.hash, cands: store.state.cands.length };
  })()`);
  console.log(`ウィザード:①作成=${wiz1} ③サンプル=${hasSample} → ${afterWizard.hash}(候補 ${afterWizard.cands}件)`);

  /* ② 本番相当:run#6 の匿名化fixture を「ドロップ」相当で流し込む */
  await evaluate(`(async () => {
    const text = await (await fetch('/tests/fixtures/run6_compact.jsonl')).text();
    const collect = await import('/js/views/collect.js');
    collect.handleFile(text, 'run6_compact.jsonl');
    return true;
  })()`);
  await sleep(1500);

  /* ② 画面の値を検査(DOMのテキストから読む) */
  const check = await evaluate(`(() => {
    const t = document.getElementById('view').innerText;
    /* ドーナツの凡例は <div><i></i>ラベル<b>値</b></div> なので DOM から直接読む */
    const legend = () => {
      const out = {};
      document.querySelectorAll('.legend div').forEach(d => {
        const b = d.querySelector('b'); if (!b) return;
        const label = d.textContent.replace(b.textContent, '').trim();
        out[label] = b.textContent.trim();
      });
      return out;
    };
    return {
      hash: location.hash,
      text: t,
      機械合格: (t.match(/機械合格\\n(\\d+)/) || [])[1],
      帯内: (t.match(/帯内\\(5千〜10万\\)\\n(\\d+)/) || [])[1],
      取得試行: (t.match(/取得試行\\n(\\d+)/) || [])[1],
      ...legend(),
    };
  })()`);

  const want = { 機械合格: "13", 帯内: "35", 取得試行: "100", 生活者: "36", 他社契約: "7", 業者: "15", 当事者型: "5", 判定保留: "6", 権威型: "1", カタログ型: "1" };
  let ng = 0;
  for (const [k, v] of Object.entries(want)) {
    const ok = String(check[k]) === v;
    if (!ok) ng++;
    console.log(`${ok ? "OK  " : "NG  "}${k}: 画面=${check[k]} 期待=${v}`);
  }
  console.log(`遷移先: ${check.hash}`);

  /* ③ スクリーンショット */
  for (const [hash, file] of [["#/analysis", "/tmp/castnext_analysis.png"], ["#/dash", "/tmp/castnext_dash.png"],
  ["#/board", "/tmp/castnext_board.png"], ["#/kanban", "/tmp/castnext_kanban.png"],
  ["#/collect", "/tmp/castnext_collect.png"], ["#/settings", "/tmp/castnext_settings.png"]]) {
    await evaluate(`location.hash = '${hash}'`);
    await sleep(700);
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    console.log("スクリーンショット:", file);
  }
  /* 候補詳細(モーダル)も1枚 */
  await evaluate(`(async () => {
    const store = await import('/js/store.js');
    const detail = await import('/js/views/detail.js');
    location.hash = '#/board';
    await new Promise(r => setTimeout(r, 400));
    const top = store.state.cands.filter(c => c.score && !c.score.cut).sort((a,b) => b.score.rate - a.score.rate)[0];
    if (top) detail.open(top.username);
    return top ? top.username : null;
  })()`);
  await sleep(800);
  const shot2 = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync("/tmp/castnext_detail.png", Buffer.from(shot2.data, "base64"));
  console.log("スクリーンショット: /tmp/castnext_detail.png");
  if (errors.length) { console.log("⚠ ページ例外:", errors.slice(0, 5)); ng++; }
  console.log(ng ? `\n==== ${ng}件NG ====` : "\n==== ALL PASS ====");
  process.exitCode = ng ? 1 : 0;
} catch (e) {
  console.error("失敗:", e.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch (e) { }
  chrome.kill();
}
