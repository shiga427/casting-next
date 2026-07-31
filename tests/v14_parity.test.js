/* 管制室 v1.4 のヘッドレス検証(verify_v14_run6.py)11項目の移植(P3の完了条件)。
 * DOM を伴う項目(①起動・⑥DM送付日の記録・⑥b モーダルを閉じても消えない)は
 * tools/e2e_v14.mjs が実ブラウザで検証する。ここはロジック層の8項目。
 *
 * fixture は make_fixture_v26.py と同じ4類型を匿名ハンドルで作った tests/fixtures/v26_cases.jsonl。
 *   sample_life   他社契約シグナル🟡+生活者シグナル🟢 / ④=基礎6+年代3+生活4=13
 *   sample_biz    業者シグナル🔴(所属クリエイター・lin.ee)/ ④=6−8 → 下限0
 *   sample_expert 専門家型 / ④=基礎6+成分2+レビュー2=10(生活者13を下回ること)
 *   sample_gate   純度ハードゲート(FF比1.49)で機械不合格になること
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { analyzeRun } from "../js/pipeline/ingest.js";
import { extRow, EXT_COLUMNS, rowsToCsv, DM_LIST_COLUMNS, dmListRows } from "../js/pipeline/export.js";
import { importCandidateCsv, applyData, newCand, exportV4 } from "../js/pipeline/schema.js";
import {
  rescoreAll, scoreSbis1, scoreSbis2, scoreSbis3, totalOf, t1Auto, ffRatio, commentRate,
  scanCaptions, signalsOf, setStatus
} from "../js/pipeline/sbis.js";
import { DEFAULT_CONF, TIER_LAB, RUBRIC_KEYS, CHECK_ITEMS, SBIS_VER } from "../js/pipeline/conf.js";
import { numOrNull, parseCsv } from "../js/pipeline/util.js";
import { to_record, parseJsonl } from "../js/pipeline/ingest.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const conf = { ...DEFAULT_CONF };
const jsonl = readFileSync(join(HERE, "fixtures", "v26_cases.jsonl"), "utf8");
const run = analyzeRun(jsonl, { runTag: "fixture", now: "2026-07-30T00:00:00Z" });

/* run → 拡張CSV(25列)→ 候補ボード取り込み、という実際の経路で候補を作る */
const { raws } = parseJsonl(jsonl);
const records = raws.map(r => to_record(r, { now: "2026-07-30T00:00:00Z" }));
const csv = rowsToCsv(records.map(extRow), EXT_COLUMNS);
const cands = [];
const imported = importCandidateCsv(csv, cands, { runTag: "fixture" });
rescoreAll(cands, conf);
const by = u => cands.find(c => c.username === u);

test("② 拡張CSVの取込で fit_comment / select_reason / fit_concern が自動セットされる(判断25)", () => {
  assert.equal(imported.added, 5);
  const f = by("sample_life"), h = by("sample_biz");
  assert.ok(f.fitComment.length > 50, "fit_comment が短い");
  assert.ok(f.selectReason.length > 20, "select_reason が短い");
  assert.ok(f.fitConcern.length > 10, "fit_concern が短い");
  assert.ok(h.fitComment.length > 50);
});

test("③ 業者/他社契約/生活者シグナル(§4-1d)", () => {
  const biz = signalsOf(by("sample_biz"), conf);
  const life = signalsOf(by("sample_life"), conf);
  const trend = signalsOf(by("sample_trend"), conf);
  const expert = signalsOf(by("sample_expert"), conf);
  assert.ok(biz.biz.length > 0, "業者シグナルが立たない");
  assert.ok(life.amb.length > 0, "他社契約シグナルが立たない");
  assert.ok(life.life.length > 0, "生活者シグナルが立たない");
  assert.equal(trend.biz.length, 0);
  assert.equal(expert.biz.length, 0);
});

test("④ 文脈適合の再配分(SBIS v2.6):生活者13 > 専門家10 / 業者は下限0", () => {
  assert.equal(by("sample_life").score.parts.p4, 13);
  assert.equal(by("sample_expert").score.parts.p4, 10);
  assert.equal(by("sample_biz").score.parts.p4, 0);
  assert.ok(by("sample_life").score.parts.p4 > by("sample_expert").score.parts.p4,
    "生活者が専門家を上回らない(v2.6 の生活者シフトが効いていない)");
});

test("⑤ 純度ハードゲート(判断19):足切り扱いで、既定の一覧から外れる", () => {
  const g = by("sample_gate");
  assert.ok(g.score.gated, "gated が立たない");
  assert.ok(g.score.cut, "cut が立たない");
  assert.match(g.score.flags.join("|"), /純度ハードゲート/);
  /* 機械フィルタ側でも rejected(ff_ratio_too_low) */
  const row = run.rows.find(r => r.username === "sample_gate");
  assert.equal(row.verdict, "rejected");
  assert.ok(row.reasons.some(r => r.code === "ff_ratio_too_low"));
  /* 候補ボードの既定表示(足切りを隠す)から外れる */
  const visible = cands.filter(c => !(c.score && c.score.cut)).map(c => c.username);
  assert.ok(!visible.includes("sample_gate"));
});

test("⑦ NFKC正規化+NG常習判定+表示リスク(判断27)", () => {
  const posts = [
    "今日の購入品。𝖲𝗎𝗂𝗌𝖺𝗂様からご提供いただきました #𝖯𝖱",   // 装飾文字PR
    "ｼﾜ改善クリームを試した記録",                                 // 半角カナNG(NFKCで検出)
    "この美容液でシワ改善を実感",                                  // NG 2件目 → 常習
    "朝のスキンケア記録", "夜のスキンケア記録", "使い切りコスメ", "角栓ケアの話", "日焼け止め比較"
  ].join("\n---\n");
  const scan = scanCaptions(posts, conf, "2026-07-30T00:00:00Z");
  assert.equal(scan.ngPosts, 2);
  assert.ok(scan.habitual, "常習判定にならない");
  assert.ok(scan.risk.disguised >= 1, "装飾文字PRを検出できていない");
  assert.equal(scan.posts, 8);
});

test("⑦b NG語は投稿単位で数える(同一投稿内の複数NG語は1件)", () => {
  const one = scanCaptions("シワ改善と美白効果を実感\n---\n普通の投稿\n---\n普通の投稿", conf, "");
  assert.equal(one.ngPosts, 1);
  assert.equal(one.habitual, false);
});

test("⑧ 旧JSON(SBIS v2.2)→ v2.6 移行:履歴が残り、v2.0の移行は誤発火しない", () => {
  const legacy = {
    app: "stembeaute-casting", v: 3,
    conf: {
      ver: "SBIS v2.2", microMin: 5000, microMax: 30000, midMin: 30000, midMax: 100000,
      convMid0: 0.004, convMidFull: 0.02, convMic0: 0.006, convMicFull: 0.03,
      erMid0: 2.0, erMidFull: 5.0, erMic0: 3.0, erMicFull: 8.0, cutoffConv: 5,
      crMid0: 0.05, crMidFull: 0.30, crMic0: 0.10, crMicFull: 0.60,
      purFollow1: 5000, purFollow2: 3000, purFfMin: 1, purCap: -15,
      growMin: 10000, growMax: 30000, growLift: 1.3, growEr: 6.0,
      kwIngredient: "成分", kwReview: "レポ", kwAge: "30代", kwWin: "当選",
      kwPenaltyPr: "案件募集", kwPenaltyDisc: "クーポン", ngWords: "再生", mannerWords: "PR"
    },
    cands: [{
      username: "old_cand", account_url: "https://www.instagram.com/old_cand/",
      followers: 12000, er: 5.0, avg_likes: 500, avg_comments: 20, bio: "30代ママの記録",
      status: "候補", checksVer: 2, checks: [false, false, false, false, false, false],
      s2: { t1: "", t2: "", t3: "", t4: "", t5: "" }, s2ev: { t1: "", t2: "", t3: "", t4: "", t5: "" },
      s3: { save: "" }, aux: { t1Topic: "", t1Tieup: "", gPre: "", gPost: "", gWeekly: false }
    }],
    rejected: [], confLog: [], coverage: [], covMeta: {}, govLog: []
  };
  const s = applyData(legacy, "2026-07-30T00:00:00Z");
  assert.equal(s.conf.ver, SBIS_VER);
  assert.ok(s.confLog.some(l => l.ver === "SBIS v2.6"), "v2.6 の移行ログがない");
  assert.ok(!s.confLog.some(l => l.ver === "SBIS v2.0"), "v2.0 の移行が誤発火している");
  assert.equal(s.conf.gateFollow, 3000);
  assert.ok(s.conf.kwLife.length > 0);
  assert.equal(s.cands.length, 1);
});

test("⑧b v2.6 の JSON を読み直しても二重移行しない", () => {
  const first = applyData({
    app: "stembeaute-casting", v: 3, conf: { ...DEFAULT_CONF }, cands: [], rejected: [],
    confLog: [], coverage: [], covMeta: {}, govLog: []
  }, "2026-07-30T00:00:00Z");
  const exported = exportV4({ ...first, project: null }, { now: "2026-07-30T00:00:00Z" });
  const second = applyData(exported, "2026-07-30T00:00:00Z");
  assert.equal(second.confLog.filter(l => l.ver === "SBIS v2.6").length, 0,
    "v2.6 のまま読み直したのに移行ログが増えている");
});

test("⑨ DMリストCSVに v1.4 の新列(ゲート・シグナル・判断25の3列)が出る", () => {
  const rows = dmListRows(cands, {
    TIER_LAB, ffRatio, commentRate, scoreSbis2, scoreSbis3, totalOf, t1Auto, numOrNull, RUBRIC_KEYS, CHECK_ITEMS
  });
  const csvText = rowsToCsv(rows, DM_LIST_COLUMNS);
  const head = parseCsv(csvText)[0];
  ["purity_gate", "biz_signal", "other_brand_signal", "life_signal", "select_reason", "fit_comment", "fit_concern", "score_rate", "scoring_mode"]
    .forEach(col => assert.ok(head.includes(col), col + " が列にない"));
  const gate = rows.find(r => r.username === "sample_gate");
  assert.equal(gate.purity_gate, "ゲート");
  assert.equal(rows.find(r => r.username === "sample_biz").biz_signal.length > 0, true);
});

test("⑤b 適合コメントが空なら「DM送付」に進めない(§4-5・A5)", () => {
  const c = Object.assign(newCand(), { username: "blocked", fitComment: "" });
  const r = setStatus(c, "DM送付", "2026-07-30");
  assert.equal(r.ok, false);
  assert.match(r.reason, /適合コメントが空/);
  c.fitComment = "① 何をしている人か…④ 懸念";
  const r2 = setStatus(c, "DM送付", "2026-07-30");
  assert.equal(r2.ok, true);
  assert.equal(c.dmSentAt, "2026-07-30", "DM送付日が自動記録されない");
});
