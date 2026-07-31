/* 自動診断アラート12本の発火条件(P5の完了条件:各アラートをfixtureで単体テスト)。
 * 設計書§5-1b。文言のトーン(責めない・次の一歩を示す・数値の根拠を添える)も形式的に検査する。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAlerts } from "../js/alerts.js";
import { newCand } from "../js/pipeline/schema.js";
import { rescoreAll } from "../js/pipeline/sbis.js";
import { DEFAULT_CONF } from "../js/pipeline/conf.js";

const conf = { ...DEFAULT_CONF };
const TODAY = "2026-07-31";
const base = { cands: [], coverage: [], govLog: [], runs: [], run: null, conf, today: TODAY };
const ids = ctx => buildAlerts({ ...base, ...ctx }).map(a => a.id);
const get = (ctx, id) => buildAlerts({ ...base, ...ctx }).find(a => a.id === id);

function cand(over) {
  const c = Object.assign(newCand(), {
    username: "u1", followers: 12000, er: 5, avg_likes: 500, avg_comments: 20,
    bio: "30代ママの記録", following: 300, account_url: "", full_name: ""
  }, over);
  rescoreAll([c], conf);
  return c;
}
function run(over) {
  return Object.assign({
    runTag: "run7", attempts: 100, succeeded: 100, inBand: 35, machinePassed: 13,
    purityExcluded: 40, signals: {}, dropReasons: {}, rateLimited: 0,
    reliability: { avgCaptionLen: 140, verdict: "十分", prSource: "全文", stanceBreakdown: {} },
    reviewNeeded: [], rows: []
  }, over);
}

test("A1 探索カバレッジに未実行行があると要対応", () => {
  assert.ok(!ids({}).includes("A1"));
  const a = get({ coverage: [{ route: "E1", term: "#購入品紹介", st: "未実行" }] }, "A1");
  assert.equal(a.level, "warn");
  assert.match(a.body, /未実行 1行/);
  assert.equal(a.to, "coverage");
});

test("A2 取得の信頼性が⚠なら要対応(キャプション平均と判定保留の数を根拠に出す)", () => {
  const r = run({ reliability: { avgCaptionLen: 57, verdict: "⚠ 低い(平均57字)。", prSource: "切り詰め", stanceBreakdown: { "判定保留": 6 } } });
  const a = get({ run: r, runs: [r] }, "A2");
  assert.equal(a.level, "warn");
  assert.match(a.body, /57字/);
  assert.match(a.body, /6名/);
  assert.equal(a.to, "collect");
  assert.ok(!ids({ run: run({}), runs: [run({})] }).includes("A2"));
});

test("A3 DM送付から5営業日で催促期限(営業日カウント)", () => {
  const c = cand({ status: "DM送付", dmSentAt: "2026-07-20", fitComment: "書いた" });
  const a = get({ cands: [c], today: TODAY }, "A3");
  assert.equal(a.level, "warn");
  assert.match(a.body, /1名/);
  const fresh = cand({ status: "DM送付", dmSentAt: TODAY, fitComment: "書いた" });
  assert.ok(!ids({ cands: [fresh], today: TODAY }).includes("A3"));
});

test("A4 救済採点(SBIS-1s)のままDM工程にいると要対応", () => {
  /* いいね非表示 = er null かつ avg_comments あり → rescue */
  const c = cand({ er: null, avg_likes: null, avg_comments: 30, status: "DM送付", fitComment: "書いた" });
  assert.equal(c.score.mode, "rescue");
  const a = get({ cands: [c] }, "A4");
  assert.equal(a.level, "warn");
  /* 証拠メモにコメント質の確認を書いたら消える */
  c.s2ev.t2 = "コメント質を確認:定型文なし・外国語なし";
  assert.ok(!ids({ cands: [c] }).includes("A4"));
});

test("A5 精査済なのに適合コメントが空なら要対応(DM送付に進めない)", () => {
  const c = cand({ status: "精査済", fitComment: "" });
  const a = get({ cands: [c] }, "A5");
  assert.equal(a.level, "warn");
  assert.match(a.body, /3〜5文/);
  c.fitComment = "① 何をしている人か…④ 懸念";
  assert.ok(!ids({ cands: [c] }).includes("A5"));
});

test("A6 運用ログに提案中が残っていると確認", () => {
  const a = get({ govLog: [{ state: "提案中", content: "x" }, { state: "承認", content: "y" }] }, "A6");
  assert.equal(a.level, "check");
  assert.match(a.title, /1件/);
});

test("A7 review_needed の目視が未了なら確認(確認済みは除く)", () => {
  const r = run({ reviewNeeded: ["a", "b"], reviewChecked: ["a"] });
  const a = get({ run: r, runs: [r] }, "A7");
  assert.equal(a.level, "check");
  assert.match(a.body, /1名/);
  const done = run({ reviewNeeded: ["a"], reviewChecked: ["a"] });
  assert.ok(!ids({ run: done, runs: [done] }).includes("A7"));
});

test("A8 タイアップ比率50%超(紹介者)が残っていると確認。ちょうど50%は該当しない", () => {
  const over = cand({ aux: { t1Topic: "6", t1Tieup: "5", gPre: "", gPost: "", gWeekly: false } });
  assert.ok(ids({ cands: [over] }).includes("A8"));
  const exact = cand({ aux: { t1Topic: "6", t1Tieup: "4", gPre: "", gPost: "", gWeekly: false } });
  assert.ok(!ids({ cands: [exact] }).includes("A8"), "ちょうど50%で紹介者になっている");
});

test("A9 純度未評価(フォロー数なし)が精査待ち上位にいると確認", () => {
  const c = cand({ following: null });
  const a = get({ cands: [c] }, "A9");
  assert.equal(a.level, "check");
  assert.match(a.body, /1名/);
});

test("A10 rate_limited が出た run があると確認", () => {
  const r = run({ rateLimited: 3 });
  const a = get({ run: r, runs: [r] }, "A10");
  assert.equal(a.level, "check");
  assert.match(a.body, /3件/);
});

test("A11 純度評価済み40件超で相関を情報として出す", () => {
  const cands = Array.from({ length: 45 }, (_, i) => cand({ username: "u" + i, following: 100 + i * 10, er: 2 + (i % 7) }));
  const a = get({ cands }, "A11");
  assert.equal(a.level, "info");
  assert.match(a.body, /相関係数/);
  assert.ok(!ids({ cands: cands.slice(0, 10) }).includes("A11"));
});

test("A12 判断22の隔離を実行したら情報として残す(黙って捨てない)", () => {
  const r = run({ bizQuarantined: [{ handle: "x" }, { handle: "y" }] });
  const a = get({ run: r, runs: [r] }, "A12");
  assert.equal(a.level, "info");
  assert.match(a.title, /2件/);
  assert.match(a.body, /黙って捨てていません/);
});

test("すべてのアラートが4点セット(バッジ/見出し/根拠/誘導先)を持ち、要対応から順に並ぶ", () => {
  const r = run({
    rateLimited: 1, reviewNeeded: ["a"], bizQuarantined: [{ handle: "x" }],
    reliability: { avgCaptionLen: 57, verdict: "⚠ 低い", prSource: "", stanceBreakdown: {} }
  });
  const alerts = buildAlerts({
    ...base, run: r, runs: [r], coverage: [{ route: "E1", term: "t", st: "未実行" }],
    govLog: [{ state: "提案中", content: "x" }],
    cands: [cand({ status: "精査済", fitComment: "" })]
  });
  assert.ok(alerts.length >= 6);
  alerts.forEach(a => {
    assert.ok(["warn", "check", "info"].includes(a.level), a.id);
    assert.ok(a.title && a.title.length > 4, a.id + " の見出しがない");
    assert.ok(a.body && /\d/.test(a.body), a.id + " に数値の根拠がない");
    assert.ok(a.to, a.id + " に誘導先がない");
  });
  const order = { warn: 0, check: 1, info: 2 };
  const levels = alerts.map(a => order[a.level]);
  assert.deepEqual(levels, levels.slice().sort((x, y) => x - y), "要対応→確認→情報の順になっていない");
});
