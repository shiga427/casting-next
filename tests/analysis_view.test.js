/* 分析結果画面の描画テスト(P2の完了条件をCIでも守るため)。
 * ブラウザ無しで render() の出力HTMLを検査し、run#6 の実績値が画面に出ることを確認する。
 * 実機の通し確認は tools/e2e_smoke.mjs(Chrome DevTools Protocol)で別途行う。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { analyzeRun } from "../js/pipeline/ingest.js";
import { state } from "../js/store.js";
import * as analysis from "../js/views/analysis.js";
import { buildAlerts } from "../js/alerts.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const jsonl = readFileSync(join(HERE, "fixtures", "run6_compact.jsonl"), "utf8");
const run = analyzeRun(jsonl, { runTag: "run6", sourceFile: "run6_compact.jsonl", now: "2026-07-30T00:00:00Z" });

state.project = { id: "p1", name: "ステムボーテ", preset: "stembeaute_v26" };
state.runs = [run];
state.activeRunTag = "run6";

const html = analysis.render();

test("取得成績・帯内・機械合格が画面に出る", () => {
  assert.match(html, /取得試行[\s\S]{0,80}>100</);
  assert.match(html, /帯内\(5千〜10万\)[\s\S]{0,120}>35</);
  assert.match(html, /機械合格[\s\S]{0,120}>13</);
});

test("落ち理由が全12コード出る(黙って捨てない)", () => {
  const codes = Object.keys(run.dropReasons);
  assert.equal(codes.length, 12);
  codes.forEach(code => assert.ok(html.includes(code), code + " が画面に出ていない"));
});

test("シグナル内訳と語りの向きの内訳が凡例に出る", () => {
  assert.match(html, /生活者<b>36<\/b>/);
  assert.match(html, /他社契約<b>7<\/b>/);
  assert.match(html, /業者<b>15<\/b>/);
  assert.match(html, /当事者型<b>5<\/b>/);
  assert.match(html, /判定保留<b>6<\/b>/);
  assert.match(html, /権威型<b>1<\/b>/);
  assert.match(html, /カタログ型<b>1<\/b>/);
});

test("review_needed 12名と隔離リストが出る(黙って捨てない)", () => {
  assert.equal(run.reviewNeeded.length, 12);
  run.reviewNeeded.forEach(u => assert.ok(html.includes("@" + u), u));
  assert.ok(html.includes("業者疑いの隔離(判断22)"));
});

test("定性列の信頼性が⚠のとき、A2アラートが発火する", () => {
  assert.ok(String(run.reliability.verdict).startsWith("⚠"));
  const alerts = buildAlerts({ cands: [], coverage: [], govLog: [], runs: [run], run, conf: {} });
  const a2 = alerts.find(a => a.id === "A2");
  assert.ok(a2, "A2 が発火していない");
  assert.equal(a2.level, "warn");
  assert.match(a2.body, /判定保留/);
});
