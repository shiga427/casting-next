/* DM送付ループのドライランE2E(設計書_DM自動一括送付 §9-4)。
 *
 *   export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
 *   node tools/e2e_dm_dryrun.mjs
 *
 * ★実送信を一切せずに、事故になる経路が塞がっていることを機械で確かめる。
 *   ダッシュボードの buildCdpDm が作ったキューを、拡張の dm_runner.js に**そのまま**流し、
 *   IGアクセス(resolveUserId / sendDirect / openDraft)は stub で受ける。
 *   sendDirect が1度でも呼ばれたら、その時点で FAIL。
 *
 * 確認項目:
 *   ① ダッシュボードのキューを拡張がそのまま読める(ラウンドトリップ)
 *   ② ドライランで送信APIが1度も呼ばれない。user_id解決とレート待機は行われる
 *   ③ 監査ログが1行1件で出る。本文全文を残さない(textHash)
 *   ④ 半自動は送信せず下書きだけ作る
 *   ⑤ キルスイッチで即停止する
 *   ⑥ 日次上限で停止する(拡張側の二重ガード)
 *   ⑦ チェックポイント/スパム判定を1件踏んだら全停止する
 *   ⑧ レート設定を緩める指定が通らない
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { buildCdpDm } from "../js/pipeline/cdpDm.js";
import { DM_DAILY_CAP, DM_MAX_WAIT, DM_MIN_WAIT } from "../js/pipeline/conf.js";
import { newCand } from "../js/pipeline/schema.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* 拡張の dm_runner.js を classic script のまま読み込む(拡張と同じコードを検証する) */
const ctx = { window: {}, setTimeout, clearTimeout, Date, Math, JSON, Promise, console, crypto };
vm.createContext(ctx);
vm.runInContext(readFileSync(join(ROOT, "extension", "dm_runner.js"), "utf8"), ctx);
const DM = ctx.window.__CASTNEXT_DM;

const results = [];
function rec(no, title, ok, obs) {
  results.push({ no, ok });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${no}. ${title}\n      ${obs}`);
}

function cand(username, over) {
  return Object.assign(newCand(), {
    username, followers: 12000,
    fitComment: "生活文脈で語れる人。懸念は投稿頻度。",
    score: { rate: 78, total: 78, max: 100, cut: false, tier: "micro", mode: "full" },
  }, over || {});
}

/* 時間は仮想。sleep は即座に解決し、仮想時計だけを進める(45〜90秒×N を実時間で待たない) */
function harness(opts) {
  const o = opts || {};
  const calls = { send: 0, resolve: 0, draft: 0, sleeps: [] };
  let clock = Date.parse("2026-08-04T09:00:00.000Z");
  let aborted = false;
  return {
    calls,
    abortAfter: o.abortAfter,
    deps: {
      sleep: async (ms) => { calls.sleeps.push(ms); clock += ms; },
      now: () => clock,
      random: () => 0.5,                       /* 決定的にする(モックはランダムに依存しない) */
      isAborted: () => aborted,
      onProgress: (p) => {
        if (o.abortAfter && p.phase === "dm" && p.i >= o.abortAfter) aborted = true;
      },
      resolveUserId: async (h) => { calls.resolve++; return "1000" + h.replace(/\D/g, ""); },
      sendDirect: async () => {
        calls.send++;                          /* ★ここが1でも増えたらドライラン失格 */
        return o.sendResult || { ok: true, threadId: "t" + calls.send };
      },
      openDraft: async () => { calls.draft++; return { ok: true }; },
      dailyCount: async () => o.alreadySentToday || 0,
      onSent: async () => { },
    },
  };
}

/* ---------- ① ダッシュボード → 拡張 のラウンドトリップ ---------- */
const cands = Array.from({ length: 4 }, (_, i) => cand("u" + i));
const queue = buildCdpDm(cands, { dryRun: true, at: "2026-08-04T09:00:00.000Z" });
const clamped = DM.clampPayload(queue);
rec(1, "ダッシュボードの送付キューを拡張がそのまま読める(件数・モード・レート・上限が一致)",
  clamped.items.length === queue.items.length && clamped.mode === queue.mode
  && clamped.minWaitMs === queue.minWaitMs && clamped.maxWaitMs === queue.maxWaitMs
  && clamped.dailyCap === queue.dailyCap && clamped.perMinMax === queue.perMinMax
  && clamped.items.every((it, i) => it.handle === queue.items[i].handle && it.text === queue.items[i].text),
  `items=${clamped.items.length} mode=${clamped.mode} wait=${clamped.minWaitMs}-${clamped.maxWaitMs} cap=${clamped.dailyCap}`);

/* ---------- ② ドライラン（auto の下見。ここでレート待機と user_id 解決が要る） ---------- */
{
  const autoDry = buildCdpDm(cands, { mode: "auto", dryRun: true, at: "x" });
  const h = harness();
  const out = await DM.runDm(autoDry, h.deps);
  const s = out.stats;
  const waitsOk = h.calls.sleeps.length === autoDry.items.length - 1
    && h.calls.sleeps.every((ms) => ms >= DM_MIN_WAIT && ms <= DM_MAX_WAIT);
  rec(2, "ドライラン(auto):送信APIが1度も呼ばれない / user_id解決とレート待機は行われる(§6-4)",
    h.calls.send === 0 && h.calls.draft === 0 && h.calls.resolve === autoDry.items.length
    && s.skipped === autoDry.items.length && s.sent === 0 && !s.stopped && waitsOk
    && s.waitedMs >= (autoDry.items.length - 1) * DM_MIN_WAIT,
    `send=${h.calls.send} draft=${h.calls.draft} resolve=${h.calls.resolve} skipped=${s.skipped} waits=${JSON.stringify(h.calls.sleeps)}`);

  /* ---------- ③ 監査ログ ---------- */
  const keys = ["at", "handle", "userId", "mode", "dryRun", "result", "textHash"];
  const logOk = out.log.length === autoDry.items.length
    && out.log.every((r) => keys.every((k) => k in r) && r.dryRun === true && r.result === "dryrun")
    && out.log.every((r) => !r.text && !queue.items.some((it) => it.text.length > 200 && r.textHash.includes(it.text)));
  rec(3, "監査ログが1行1件で出る。本文全文は残さない(§6-6・§10)",
    logOk && out.log[0].textHash.startsWith("len="),
    `rows=${out.log.length} sample=${JSON.stringify(out.log[0])}`);
}

/* ---------- ④ 半自動 ---------- */
{
  const semi = buildCdpDm(cands, { mode: "semi", dryRun: false, at: "x" });
  const h = harness();
  const out = await DM.runDm(semi, h.deps);
  rec(4, "半自動:送信APIを呼ばず下書きだけ作る。status は進めない draft を返す(§5-1・§7)",
    h.calls.send === 0 && h.calls.draft === semi.items.length
    && out.stats.draft === semi.items.length && out.stats.sent === 0
    && out.results.every((r) => r.result === "draft"),
    `send=${h.calls.send} draft=${h.calls.draft} results=${out.results.map((r) => r.result).join(",")}`);

  /* 半自動は ig.me/m/<handle> で開くので user_id が要らない。
     Instagramに1回も触らない以上、レート待機も無い（下書き30件で45分待つ意味が無い）。 */
  rec(5, "半自動はInstagramに1回もアクセスしない(user_id解決0回・レート待機0回)",
    h.calls.resolve === 0 && h.calls.sleeps.length === 0 && out.stats.waitedMs === 0,
    `resolve=${h.calls.resolve} sleeps=${h.calls.sleeps.length} waitedMs=${out.stats.waitedMs}`);
}

/* ---------- ⑤ キルスイッチ ---------- */
{
  const auto = buildCdpDm(cands, { mode: "auto", dryRun: false, at: "x" });
  const h = harness({ abortAfter: 2 });
  const out = await DM.runDm(auto, h.deps);
  rec(6, "キルスイッチ:停止フラグでループ先頭から即停止する(§6-5)",
    out.stats.stopped === "aborted" && h.calls.send === 2 && out.stats.sent === 2,
    `stopped=${out.stats.stopped} send=${h.calls.send} sent=${out.stats.sent} / 全${auto.items.length}件中`);
}

/* ---------- ⑥ 日次上限(拡張側の二重ガード) ---------- */
{
  const auto = buildCdpDm(cands, { mode: "auto", dryRun: false, at: "x" });
  const h = harness({ alreadySentToday: DM_DAILY_CAP });
  const out = await DM.runDm(auto, h.deps);
  rec(8, "日次上限:本日すでに上限まで送っていたら1件も送らずに停止する(§6-2)",
    out.stats.stopped === "daily_cap" && h.calls.send === 0 && out.stats.sent === 0,
    `already=${DM_DAILY_CAP} stopped=${out.stats.stopped} send=${h.calls.send}`);

  const h2 = harness({ alreadySentToday: DM_DAILY_CAP - 2 });
  const out2 = await DM.runDm(auto, h2.deps);
  rec(9, "日次上限:残り枠のぶんだけ送って止まる(残りは黙って送らない)",
    out2.stats.stopped === "daily_cap" && h2.calls.send === 2 && out2.stats.sent === 2,
    `already=${DM_DAILY_CAP - 2} send=${h2.calls.send} stopped=${out2.stats.stopped}`);
}

/* ---------- ⑦ チェックポイント/スパム判定 ---------- */
{
  const auto = buildCdpDm(cands, { mode: "auto", dryRun: false, at: "x" });
  const h = harness({ sendResult: { ok: false, reason: "feedback_required" } });
  const out = await DM.runDm(auto, h.deps);
  rec(10, "スパム判定/チェックポイントを1件でも踏んだら、その回は全停止する(§5-3・§10)",
    out.stats.stopped === "challenge" && h.calls.send === 1
    && out.results.length === 1 && out.results[0].result === "failed:challenge",
    `stopped=${out.stats.stopped} send=${h.calls.send} results=${out.results.map((r) => r.result).join(",")}`);
  rec(11, "challenge の検出が握りつぶされず監査ログに残る(§10)",
    out.log.length === 1 && out.log[0].result === "failed:challenge",
    JSON.stringify(out.log[0]));
}

/* ---------- ⑧ レート設定は緩められない ---------- */
{
  const loose = DM.clampPayload({ items: [], minWaitMs: 500, maxWaitMs: 800, perMinMax: 50, dailyCap: 9999, mode: "auto" });
  rec(12, "拡張側でもレート設定を緩められない(短縮・上限引き上げを受け付けない)(§6-1・§6-2)",
    loose.minWaitMs === DM_MIN_WAIT && loose.maxWaitMs === DM_MAX_WAIT
    && loose.perMinMax === 1 && loose.dailyCap === DM_DAILY_CAP,
    JSON.stringify({ min: loose.minWaitMs, max: loose.maxWaitMs, perMin: loose.perMinMax, cap: loose.dailyCap }));
}

const fails = results.filter((r) => !r.ok);
console.log(`\n==== RESULT: ${fails.length ? fails.length + " FAIL" : "ALL PASS"}（${results.length}項目・実送信 0件）====`);
process.exitCode = fails.length ? 1 : 0;
