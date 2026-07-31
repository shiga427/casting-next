/* 精査データ収集の依頼文(§5-6 ⓪・§8-3 の精査データ収集節)。
 * 精査は「キャプション全文・コメント欄・bio全文」が要る。取得時の140字では足りないため、
 * 精査対象だけ別経路で集める。書式が1つでも崩れると精査画面のパーサが読めなくなる。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { qualTargets, parseCaptions, parseComments, parseProfile } from "../js/pipeline/qualReport.js";
import { newCand } from "../js/pipeline/schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const tpl = readFileSync(join(ROOT, "kit", "qual_request_template.md"), "utf8");

function cand(username, rate, over) {
  return Object.assign(newCand(), {
    username, followers: 12000,
    score: { rate, cut: false, tier: "micro", mode: "full", total: rate, max: 100 }
  }, over || {});
}

test("依頼文に3ファイルの仕様が入っている(captions / comments / profile)", () => {
  ["_captions.txt", "_comments.txt", "_profile.txt"].forEach(f =>
    assert.ok(tpl.includes(f), f + " の指定がない"));
  assert.ok(tpl.includes("直近12投稿"), "直近12投稿の指定がない");
  assert.ok(tpl.includes("上位4投稿"), "コメント欄の対象(上位4投稿)がない");
  assert.ok(tpl.includes("50件"), "コメントの上限件数がない");
});

test("精査で落とせない3点が明記されている(全文・taken_at降順・本人返信全文)", () => {
  assert.ok(/切り詰めない|切り詰めなし/.test(tpl), "キャプション全文の指定がない");
  assert.ok(tpl.includes("taken_at"), "taken_at 降順の整列指示がない");
  assert.ok(/本人の返信は全文|全文を載せる/.test(tpl), "本人返信の全文指定がない");
  assert.ok(tpl.includes("bio は全文が必須") || tpl.includes("bio 全文"), "bio全文の指定がない");
  /* bio を渡さないと自己開示を取りこぼす、という理由まで書いてあること */
  assert.ok(tpl.includes("自己開示"), "bioが必要な理由が書かれていない");
});

test("依頼文にも禁止事項が入っている(取得依頼文と同じ規律)", () => {
  ["DM送信", "フォロー", "いいね", "UA", "ページ遷移"].forEach(w =>
    assert.ok(tpl.includes(w), w + " の禁止が書かれていない"));
  assert.ok(tpl.includes("429"), "レート制限時の中断指示がない");
  assert.ok(tpl.includes("推測で埋めない"), "推測記入の禁止がない");
});

test("プレースホルダが画面側の埋め込みと一致している", () => {
  ["{COUNT}", "{HANDLES}", "{KIT_URL}", "{BRAND}", "{KIT_VERSION}"]
    .forEach(k => assert.ok(tpl.includes(k), k + " がテンプレートにない"));
  /* 精査は全文が要るので prof_compact(140字)は使わない、と明記されていること */
  assert.ok(tpl.includes("prof_compact.js"), "prof_compact を使わない旨がない");
});

test("依頼文の書式サンプルが、精査画面のパーサでそのまま読める", () => {
  /* テンプレートに書いた見出し行の形を、実際のパーサに通して確認する */
  const caps = parseCaptions([
    "# handle=x 直近12投稿(taken_at降順) 取得 2026-07-31",
    "",
    "[1] 2026-07-28 like=272 comment=8 type=reel paid=false",
    "code=XXXX media_id=1 taken_at=1 media_type=2 comments_disabled=false cap_len=10",
    "本文A",
    "---",
    "[2] 2026-07-26 like=310 comment=12 type=carousel paid=true",
    "code=YYYY media_id=2 taken_at=2 media_type=8 comments_disabled=false cap_len=10",
    "本文B"
  ].join("\n"));
  assert.equal(caps.length, 2);
  assert.equal(caps[0].caption, "本文A");
  assert.equal(caps[1].paid, true);

  const cmts = parseComments([
    "# handle=x コメント欄(上位4投稿×最大50件) 取得 2026-07-31",
    "",
    "--- #1  user=@reader_a  own_reply=no  post=XXXX",
    "どこで買えますか？",
    "--- #2  user=@x  own_reply=YES  post=XXXX",
    "ドラッグストアで買えます"
  ].join("\n"));
  assert.equal(cmts.length, 2);
  assert.equal(cmts[0].own, false);
  assert.equal(cmts[1].own, true);

  const prof = parseProfile([
    "# handle=x プロフィール 取得 2026-07-31",
    "full_name = サンプル",
    "followers = 14238",
    "",
    "[bio_links]",
    "https://example.com/x",
    "",
    "[biography 全文]",
    "41歳 2児のママ"
  ].join("\n"));
  assert.equal(prof.fullName, "サンプル");
  assert.equal(prof.bio, "41歳 2児のママ");
  assert.ok(!prof.bio.includes("example.com"), "bio_links を bio と誤認している");
});

test("依頼の対象は得点率の高い順・上限10名。足切りと精査済みは外す", () => {
  const cands = [
    cand("low", 30), cand("high", 90), cand("mid", 60),
    cand("cutoff", 95, { score: { rate: 95, cut: true, tier: "micro", mode: "full" } }),
    cand("mega", 99, { score: { rate: 99, cut: false, tier: "mega", mode: "full" } }),
    cand("out", 98, { score: { rate: 98, cut: false, tier: "out", mode: "full" } }),
    cand("done", 80, { qualReport: { done: true } }),
    cand("dropped", 85, { status: "見送り" }),
  ];
  const got = qualTargets(cands, 10).map(c => c.username);
  assert.deepEqual(got, ["high", "mid", "low"]);
  /* 上限が効く */
  const many = Array.from({ length: 25 }, (_, i) => cand("u" + i, 100 - i));
  assert.equal(qualTargets(many, 10).length, 10);
  assert.equal(qualTargets(many, 10)[0].username, "u0");
});
