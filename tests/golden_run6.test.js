/* ゴールデンテスト(設計書§6-3・P1の受け入れ基準)。
 *
 * run#6 の匿名化fixture(tests/fixtures/run6_compact.jsonl)に対して、
 * **JS版パイプラインの出力が Python版の出力と一致すること**を検証する。
 * 期待値 tests/fixtures/run6_expected.json は tools/gen_run6_expected.py が
 * reference/ingest_compact.py を実際に走らせて作ったもの(手書きしていない)。
 *
 * 同時に run#6 の実績値(summary_run6.json)そのものも突合する:
 *   機械合格13名 / 帯内35 / 純度ゲート除外40 / 落ち理由12コードの件数 /
 *   シグナル内訳 36-7-15 / review_needed 12名 / stance内訳 当事者5・保留6・権威1・カタログ1
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { analyzeRun, to_record, parseJsonl, toSummaryJson } from "../js/pipeline/ingest.js";
import { extRow, EXT_COLUMNS } from "../js/pipeline/export.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures");
const jsonl = readFileSync(join(FIX, "run6_compact.jsonl"), "utf8");
const expected = JSON.parse(readFileSync(join(FIX, "run6_expected.json"), "utf8"));

const run = analyzeRun(jsonl, { runTag: "run6", now: "2026-07-30T00:00:00+00:00", sourceFile: "run6_compact.jsonl" });
const summary = toSummaryJson(run);
const py = expected.summary;

test("取得成績:試行・成功・失敗が Python版と一致", () => {
  assert.equal(summary["取得試行"], py["取得試行"]);
  assert.equal(summary["取得成功"], py["取得成功"]);
  assert.deepEqual(summary["取得失敗"], py["取得失敗"]);
  assert.equal(summary["rate_limited"], py["rate_limited"]);
});

test("帯内・機械合格・純度ゲート除外が Python版と一致(run#6実績:35 / 13 / 40)", () => {
  assert.equal(summary["帯内(5千〜10万)"], py["帯内(5千〜10万)"]);
  assert.equal(summary["機械合格"], py["機械合格"]);
  assert.equal(summary["純度ゲート除外"], py["純度ゲート除外"]);
  assert.equal(summary["機械合格"], 13);
  assert.equal(summary["帯内(5千〜10万)"], 35);
  assert.equal(summary["純度ゲート除外"], 40);
});

test("落ち理由の内訳(降順・全コード)が Python版と一致", () => {
  assert.deepEqual(summary["落ち理由"], py["落ち理由"]);
  /* 件数だけでなく順序(降順→コード名昇順)も仕様 */
  assert.deepEqual(Object.keys(summary["落ち理由"]), Object.keys(py["落ち理由"]));
});

test("シグナル内訳が Python版と一致(run#6実績:生活者36・他社契約7・業者15)", () => {
  assert.deepEqual(summary["シグナル内訳(全取得)"], py["シグナル内訳(全取得)"]);
  assert.equal(summary["シグナル内訳(全取得)"]["生活者シグナル"], 36);
  assert.equal(summary["シグナル内訳(全取得)"]["他社契約シグナル"], 7);
  assert.equal(summary["シグナル内訳(全取得)"]["業者シグナル"], 15);
});

test("review_needed(verified×カテゴリnull)が Python版と一致(12名)", () => {
  assert.deepEqual(summary["review_needed(verified×カテゴリnull)"].slice().sort(),
    py["review_needed(verified×カテゴリnull)"].slice().sort());
  assert.equal(summary["review_needed(verified×カテゴリnull)"].length, 12);
});

test("語りの向きの内訳が Python版と一致(run#6実績:当事者5・保留6・権威1・カタログ1)", () => {
  const got = summary["定性列の信頼性(v2.7)"]["語りの向きの内訳"];
  assert.deepEqual(got, py["定性列の信頼性(v2.7)"]["語りの向きの内訳"]);
  assert.deepEqual(got, { "当事者型": 5, "判定保留": 6, "権威型": 1, "カタログ型": 1 });
});

test("定性列の信頼性(キャプション平均・評価文)が Python版と一致", () => {
  const a = summary["定性列の信頼性(v2.7)"], b = py["定性列の信頼性(v2.7)"];
  assert.equal(a["キャプション平均文字数"], b["キャプション平均文字数"]);
  assert.equal(a["評価"], b["評価"]);
});

test("適用フィルタの値が Python版と一致(ジョブ定義v4)", () => {
  assert.deepEqual(summary["適用フィルタ"], py["適用フィルタ"]);
});

test("機械合格の並び(ER降順)が Python版と一致", () => {
  assert.deepEqual(run.ranked, expected.matched);
});

test("全100件の拡張CSV25列が Python版と1文字単位で一致", () => {
  const { raws } = parseJsonl(jsonl);
  const rows = raws.map(r => to_record(r, { now: "2026-07-30T00:00:00+00:00" })).filter(Boolean).map(extRow);
  assert.equal(rows.length, expected.rows.length);
  const diffs = [];
  rows.forEach((row, i) => {
    const want = expected.rows[i];
    EXT_COLUMNS.forEach(col => {
      /* scraped_at は実行時刻。fixture 生成時刻と一致しないので比較対象外 */
      if (col === "scraped_at") return;
      if (String(row[col] ?? "") !== String(want[col] ?? "")) {
        diffs.push(`${want.username} ${col}\n  JS  : ${row[col]}\n  Py  : ${want[col]}`);
      }
    });
  });
  assert.deepEqual(diffs, [], "Python版との差分:\n" + diffs.slice(0, 8).join("\n"));
});
