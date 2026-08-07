/* 一括DMパネルの通し確認(設計書_DM自動一括送付 §2-2・§5-1・§9-3)。
 *
 *   python3 -m http.server 8765 &            # リポジトリ直下で
 *   node tools/e2e_dm_panel.mjs [--url http://localhost:8765]
 *
 * ★人が「送る」と決める画面そのものを検査する。ここが黙って壊れると、
 *   ガードに掛かった候補が素通りする・意図しない文面が出る、という不可逆な事故になる(§0-1)。
 *
 * 確認項目:
 *   ① 候補ボードの選択列で選ぶとボタンの件数が変わる(選択はセッション内メモリのみ)
 *   ② パネルが開き、対象ごとに全文プレビュー(編集可)と最適化根拠が出る
 *   ③ ガードに掛かった候補は理由付きで「除外」に出る(黙って落とさない・§6-3)
 *   ④ 既定は半自動で、全自動はドライラン未実施のため選べない(§5-1)
 *   ⑤ 「ドライラン」で castnext_cdp_dm が書かれ、レート設定が既定どおりで dryRun=true
 *
 * このスクリプトは Instagram に一切アクセスしない。書き出すのは localStorage のキューだけ。
 */
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const URL_BASE = arg("--url", "http://localhost:8765");
const CHROME = arg("--chrome", `${homedir()}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`);
const PORT = 9231;
const PROFILE = "/tmp/castnext-e2e-dmpanel";
const sleep = ms => new Promise(r => setTimeout(r, ms));
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { }

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${PORT}`, "--window-size=1440,1400",
  `--user-data-dir=${PROFILE}`, URL_BASE + "/#/dash",
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
    } catch (e) { /* まだ起動途中 */ }
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
  await sleep(1400);
  await evaluate(`window.BASE = ${JSON.stringify(URL_BASE)}`);

  /* ウィザードを進めて run#6 の匿名化fixtureを流し込む(実データは使わない) */
  const clickWhenReady = async id => {
    for (let i = 0; i < 25; i++) {
      if (await evaluate(`(() => { const b = document.getElementById('${id}'); if (b) { b.click(); return true; } return false; })()`)) return true;
      await sleep(300);
    }
    return false;
  };
  await clickWhenReady("wNext1");
  await clickWhenReady("wNext2");
  await clickWhenReady("wSkip");
  await sleep(400);
  await evaluate(`(async () => {
    const text = await (await fetch(BASE + '/tests/fixtures/run6_compact.jsonl')).text();
    const collect = await import(BASE + '/js/views/collect.js');
    collect.handleFile(text, 'run6_compact.jsonl');
    return true;
  })()`);
  await sleep(1800);

  /* 送れる2名と、ガードで落ちる2名(見送り・適合コメント未記入)を用意する */
  const prep = await evaluate(`(async () => {
    const s = await import(BASE + '/js/store.js');
    const ok = s.state.cands.filter(c => c.score && !c.score.cut
      && (c.score.tier === 'micro' || c.score.tier === 'middle')).slice(0, 4);
    ok.slice(0, 2).forEach(c => { c.fitComment = '生活文脈で語れる人。懸念は投稿頻度。'; });
    if (ok[2]) { ok[2].fitComment = '書いてある'; ok[2].status = '見送り'; }
    if (ok[3]) { ok[3].fitComment = ''; }
    return ok.map(c => c.username);
  })()`);
  if (prep.length < 4) throw new Error("検証に必要な候補が足りません: " + JSON.stringify(prep));

  await evaluate(`location.hash = '#/board'`);
  await sleep(900);

  /* ① 選択列 */
  const sel = await evaluate(`(() => {
    const want = ${JSON.stringify(prep)};
    const boxes = [...document.querySelectorAll('.rowsel')].filter(b => want.includes(b.dataset.u));
    boxes.forEach(b => { b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); });
    return { picked: boxes.length, btn: document.getElementById('btnDmSend').textContent,
             persisted: !!localStorage.getItem('castnext_dm_selected') };
  })()`);
  rec(1, "選択列でチェックした件数がボタンに出る(選択はセッション内メモリのみで永続しない・§2-1)",
    sel.picked === 4 && sel.btn === `選択4件にDMを送る` && !sel.persisted, JSON.stringify(sel));

  /* ②③④ パネル */
  await evaluate(`document.getElementById('btnDmSend').click()`);
  await sleep(800);
  const panel = await evaluate(`(() => {
    const o = document.getElementById('ovDm');
    if (!o) return { open: false };
    const t = o.innerText;
    return {
      open: o.classList.contains('open'),
      head: o.querySelector('.mhead h3').textContent,
      textareas: o.querySelectorAll('[data-dmtext]').length,
      basis: (t.match(/差し込んだ最適化根拠:/g) || []).length,
      firstText: (o.querySelector('[data-dmtext]') || {}).value || '',
      excludedRows: [...o.querySelectorAll('.breakdown .r')].map(r => r.innerText.replace(/\\n/g, ' ')),
      semiChecked: !!o.querySelector('input[value=semi]:checked'),
      autoDisabled: !!o.querySelector('input[value=auto][disabled]'),
      why: (t.match(/全自動が選べない理由:[^\\n]*/) || [''])[0],
    };
  })()`);
  rec(2, "パネルが開き、対象ごとに全文プレビュー(編集可)と最適化根拠が出る(§2-2)",
    panel.open && panel.textareas === 2 && panel.basis === 2
    && panel.firstText.includes("#PR") && panel.firstText.includes("薬機法チェック")
    && !panel.firstText.includes("限定"),
    `head=${panel.head} textarea=${panel.textareas} basis=${panel.basis} len=${panel.firstText.length}`);

  const exText = (panel.excludedRows || []).join(" / ");
  rec(3, "ガードに掛かった候補が理由付きで「除外」に出る(黙って落とさない・§6-3)",
    /見送り/.test(exText) && /適合コメント/.test(exText),
    exText || "(除外行が無い)");

  rec(4, "既定は半自動。全自動はドライラン未実施のため選べない(§5-1)",
    panel.semiChecked && panel.autoDisabled && /ドライラン/.test(panel.why),
    `semi=${panel.semiChecked} autoDisabled=${panel.autoDisabled} ${panel.why}`);

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync("/tmp/castnext_dmpanel.png", Buffer.from(shot.data, "base64"));
  console.log("スクリーンショット: /tmp/castnext_dmpanel.png");

  /* ⑤ ドライランのキュー書き出し */
  await evaluate(`document.getElementById('dmDry').click()`);
  await sleep(700);
  const q = await evaluate(`(() => {
    const raw = localStorage.getItem('castnext_cdp_dm');
    if (!raw) return null;
    const p = JSON.parse(raw);
    return { n: p.items.length, mode: p.mode, dry: p.dryRun, cap: p.dailyCap,
             min: p.minWaitMs, max: p.maxWaitMs, perMin: p.perMinMax, ex: (p.excluded || []).length,
             keys: Object.keys(p.items[0] || {}).sort().join(',') };
  })()`);
  rec(5, "「ドライラン」で送付キュー(castnext_cdp_dm)が書かれ、既定レート・dryRun=true になる(§3・§6-1)",
    q && q.n === 2 && q.mode === "semi" && q.dry === true && q.cap === 30
    && q.min === 45000 && q.max === 90000 && q.perMin === 1 && q.ex === 2
    && q.keys === "handle,slot,text,tier,userId",
    JSON.stringify(q));

  if (errors.length) { console.log("⚠ ページ例外:", errors.slice(0, 5)); }
  const fails = results.filter(r => !r.ok);
  console.log(`\n==== RESULT: ${fails.length ? fails.length + " FAIL" : "ALL PASS"}（${results.length}項目・Instagramへのアクセス 0回）====`);
  process.exitCode = (fails.length || errors.length) ? 1 : 0;
} catch (e) {
  console.error("失敗:", e.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch (e) { }
  chrome.kill();
}
