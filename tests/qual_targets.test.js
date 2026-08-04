/* 精査対象の選定と、拡張へ渡す精査指示（castnext_cdp_qual）の検証。
 *
 * 2026-08-03: Claude依頼文フローの撤去にともない tests/qual_request.test.js を廃止し、
 * テンプレに依存しないテスト（パーサの実書式・60点以上の選定・不足人数と発掘プラン）だけをここへ移した。
 * 精査データの収集は拡張(extension/)の「③精査データ」が行う。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { qualTargets, parseCaptions, parseComments, parseProfile } from "../js/pipeline/qualReport.js";
import { buildCdpQual, cdpQualSummary } from "../js/pipeline/cdpQual.js";
import {
  QUAL_DISCOVER_MAX_ROUNDS, QUAL_FILL_TARGET, QUAL_MAX_COLLECT, QUAL_MIN_SCORE,
} from "../js/pipeline/conf.js";
import { newCand } from "../js/pipeline/schema.js";

function cand(username, rate, over) {
  return Object.assign(newCand(), {
    username, followers: 12000,
    score: { rate, cut: false, tier: "micro", mode: "full", total: rate, max: 100 }
  }, over || {});
}

test("拡張が保存する3ファイルの書式が、精査画面のパーサでそのまま読める", () => {
  /* extension/content_ig.js が書き出す見出し行の形を、実際のパーサに通して確認する */
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

test("精査の対象はスコア60点以上・得点率の高い順。足切りと精査済みは外す", () => {
  const cands = [
    cand("low", 30), cand("high", 90), cand("mid", 60),
    cand("under", 59),
    cand("cutoff", 95, { score: { rate: 95, total: 95, max: 100, cut: true, tier: "micro", mode: "full" } }),
    cand("mega", 99, { score: { rate: 99, total: 99, max: 100, cut: false, tier: "mega", mode: "full" } }),
    cand("out", 98, { score: { rate: 98, total: 98, max: 100, cut: false, tier: "out", mode: "full" } }),
    cand("done", 80, { qualReport: { done: true } }),
    cand("dropped", 85, { status: "見送り" }),
  ];
  /* 60点未満(low/under)は精査に回さない。上位N名ではなく閾値で切る */
  assert.deepEqual(qualTargets(cands).map(c => c.username), ["high", "mid"]);
  /* 閾値は引数で上書きできる(既定は QUAL_MIN_SCORE) */
  assert.deepEqual(qualTargets(cands, { minScore: 0 }).map(c => c.username), ["high", "mid", "under", "low"]);
  /* 60点以上が何人いても件数では切らない(渡す人数の上限は cdpQual 側の役目) */
  const many = Array.from({ length: 25 }, (_, i) => cand("u" + i, 100 - i * 2)); /* 100,98,…,52点 */
  assert.equal(qualTargets(many).length, 21);   /* 100〜80点の21人 */
  assert.equal(qualTargets(many)[0].username, "u0");
  /* 数値を渡したときは後方互換で limit 扱い */
  assert.equal(qualTargets(many, 10).length, 10);
});

test("精査指示(castnext_cdp_qual)に不足人数と発掘プランが入る", () => {
  const three = [cand("a", 90), cand("b", 80), cand("c", 70)];
  const p = buildCdpQual(three, { at: "2026-08-03T00:00:00.000Z" });
  assert.equal(p.minScore, QUAL_MIN_SCORE);
  assert.equal(p.fillTarget, QUAL_FILL_TARGET);
  assert.equal(p.eligible, 3);
  assert.deepEqual(p.handles, ["a", "b", "c"]);
  assert.equal(p.shortfall, QUAL_FILL_TARGET - 3, "不足人数が出ていない");
  assert.ok(p.discover.tags.length, "発掘プランのタグが空");
  assert.ok(p.discover.tags.every(t => t.tag.startsWith("#")), "タグが#始まりでない");
  assert.equal(p.discover.maxRounds, QUAL_DISCOVER_MAX_ROUNDS);

  /* 上限を超えたぶんは「次回」に回す。黙って捨てない */
  const many = Array.from({ length: 25 }, (_, i) => cand("u" + i, 100 - i * 2)); /* 100,98,…,52点 */
  const q = buildCdpQual(many, { at: "2026-08-03T00:00:00.000Z" });
  assert.equal(q.handles.length, QUAL_MAX_COLLECT);
  assert.equal(q.eligible, 21);
  assert.equal(q.deferred, 21 - QUAL_MAX_COLLECT);
  assert.equal(q.shortfall, 0);
  assert.ok(cdpQualSummary(q).includes("残り " + (21 - QUAL_MAX_COLLECT) + "名"), "繰り越しぶんを言っていない");
  /* 「今回」「◯名/回」という語は使わない(1回あたりの人数上限という概念は廃止した) */
  [cdpQualSummary(q), cdpQualSummary(p)].forEach(t => {
    assert.ok(!t.includes("今回"), "「今回」が残っている: " + t);
    assert.ok(!/名\/回/.test(t), "「◯名/回」が残っている: " + t);
  });
});
