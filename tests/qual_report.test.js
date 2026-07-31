/* 精査・定性評価(P6の完了条件)。
 * run#6 の実3ファイル(匿名化済み)で、**Python版 qual_report.py と同じ内容**が出ることを確認する。
 * 期待値 tests/fixtures/qual_expected.json は tools/gen_qual_expected.py が
 * reference/qual_report.py を実際に走らせて作ったもの。
 * あわせて「人が書く欄が未記入なら精査完了にできない」ことも確認する。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildReport, isComplete, toMarkdown, HUMAN_FIELDS, parseCaptions, parseComments, parseProfile } from "../js/pipeline/qualReport.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures");
const H = "sample_qual";
const read = kind => {
  const p = join(FIX, `${H}_${kind}.txt`);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
};
const expected = JSON.parse(readFileSync(join(FIX, "qual_expected.json"), "utf8"));
const report = buildReport({
  captionsText: read("captions"), commentsText: read("comments"),
  profileText: read("profile"), handle: H
});

test("キャプションのパース:本文中の --- で投稿を落とさない(run#6実測の回帰)", () => {
  assert.equal(report.source.posts, expected.posts);
  assert.equal(report.source.posts, 12, "直近12投稿が揃っていない");
});

test("コメントのパース:読者・本人返信・ユニーク率が Python版と一致", () => {
  assert.equal(report.comments.total, expected.comments);
  assert.equal(report.comments.own, expected.own);
  assert.equal(report.comments.readers, expected.readers);
  assert.equal(report.comments.uniqueOwn, expected.uniqueOwn);
  assert.equal(report.comments.questions, expected.questions);
});

test("読者の質問 → 本人の返信のペアが Python版と一致", () => {
  assert.equal(report.comments.pairs.length, expected.pairs.length);
  report.comments.pairs.forEach((p, i) => assert.equal(p.own, expected.pairs[i].own));
});

test("語りの向き・スコア・引用が Python版と一致", () => {
  assert.equal(report.stance.verdict, expected.stance);
  assert.equal(report.stance.witness, expected.witness);
  assert.equal(report.stance.authority, expected.authority);
  assert.deepEqual(report.quotes, expected.quotes);
});

test("PR件数・キャプション平均・信頼性が Python版と一致", () => {
  assert.equal(report.pr.posts, expected.pr_posts);
  assert.equal(report.captionAvg, expected.captionAvg);
  assert.equal(report.reliability, expected.reliability);
});

test("bio を読まないと自己開示を取りこぼす(profile.txt の [biography] を明示で当てる)", () => {
  const { bio } = parseProfile(read("profile"));
  assert.ok(bio.length > 0, "bio が読めていない");
  const noBio = buildReport({ captionsText: read("captions"), commentsText: read("comments"), profileText: "", handle: H });
  assert.ok(report.counts["自己開示"] >= noBio.counts["自己開示"],
    "bio を渡したのに自己開示が増えていない");
});

test("人が書く欄が未記入なら精査完了にできない(空欄のまま提出しない の強制化)", () => {
  assert.equal(isComplete(report), false);
  HUMAN_FIELDS.forEach(([k]) => { report.human[k] = "書いた"; });
  assert.equal(isComplete(report), true);
  /* 1つでも空に戻したら完了不可 */
  report.human.concern = "  ";
  assert.equal(isComplete(report), false);
  report.human.concern = "懸念:タイアップ比率が未確認";
});

test("md 書き出しが qual_report.py と同じ章立てになる", () => {
  const md = toMarkdown(report);
  expected.md_sections.forEach(sec => assert.ok(md.includes(sec), `章「${sec}」がない`));
});
