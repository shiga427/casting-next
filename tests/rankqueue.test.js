/* 取得キューの並べ替え(rank_queue v2.6・判断24)の移植テスト。
 * run#6 不具合1(取得済み除外が一度も効いていなかった)の回帰を含む。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { score, buildQueue, readDoneHandles } from "../js/pipeline/rankQueue.js";
import { screen, screenAll, hasPersonName } from "../js/pipeline/screenBrand.js";
import { screenUser, postscreen } from "../js/pipeline/postscreenBiz.js";

test("生活語のハンドルは加点され、レビュアー専業は後回しになる(判断24)", () => {
  const life = score("mama_kurashi_07", "スキンケア記録", 500);
  const reviewer = score("cosme_review_07", "スキンケア記録", 500);
  assert.ok(life.score > reviewer.score, `life=${life.score} reviewer=${reviewer.score}`);
  assert.ok(life.why.includes("life"));
  assert.ok(reviewer.why.includes("reviewer_susp"));
});

test("ブランド語・法人語・区切りなしの短い英単語は減点される(除外はしない)", () => {
  assert.ok(score("shiseido", "", 500).score < 0);
  assert.ok(score("beautyjp_official", "", 500).score < 0);
  assert.ok(score("amuse", "", 500).score < 0, "bare_word が効いていない");
});

test("いいね数の帯ターゲット窓(100〜8000)で加点、外れると減点", () => {
  assert.ok(score("mi_ki.07", "", 500).score > score("mi_ki.07", "", 20000).score);
  assert.ok(score("mi_ki.07", "", 500).score > score("mi_ki.07", "", 10).score);
});

test("取得済み除外は username 列でも handle 列でも効く(run#6 不具合1の回帰)", () => {
  const csvUsername = "username\nalready_got\nsecond_one\n";
  const csvHandle = "handle,likes\n@already_got,100\n";
  assert.ok(readDoneHandles(csvUsername).has("already_got"));
  assert.ok(readDoneHandles(csvHandle).has("already_got"), "@ 付き・handle列を受けられていない");
  const pool = [{ handle: "already_got", tags: "", likes: 500 }, { handle: "fresh_one.01", tags: "", likes: 500 }];
  const q = buildQueue(pool, readDoneHandles(csvUsername), 100);
  assert.deepEqual(q.queue.map(r => r.handle), ["fresh_one.01"]);
  assert.equal(q.poolSize, 1);
});

test("キューは上限で切り、残りは deferred に回す(母集団を削らない)", () => {
  const pool = Array.from({ length: 12 }, (_, i) => ({ handle: `user_${String(i).padStart(2, "0")}`, tags: "", likes: 500 }));
  const q = buildQueue(pool, new Set(), 5);
  assert.equal(q.queue.length, 5);
  assert.equal(q.deferred.length, 7);
});

test("ブランド公式疑い:強ブランド語は隔離、人名が読めれば残す(§2-2)", () => {
  assert.equal(screen("tokyo_beauty_salon").verdict, "brand_susp");
  assert.equal(screen("ayaka_official").verdict, "keep_person");
  assert.equal(screen("mi_ki.07").verdict, "keep");
  assert.equal(hasPersonName("ayaka_official"), "ayaka");
  const all = screenAll(["tokyo_beauty_salon", "ayaka_official", "mi_ki.07"]);
  assert.equal(all.counts.brand_susp, 1);
  assert.equal(all.counts.keep_person, 1);
  assert.equal(all.counts.keep, 1);
});

test("判断22の取得後隔離:bioは使わず、表示名・カテゴリ・リンク先だけで判定する", () => {
  /* bio に業者語があっても、表示名が個人名らしければ隔離しない(v2.4 run#5 判断3の誤爆防止) */
  const personal = screenUser({ fn: "あやかママ♡", cat: null, ext: "https://lin.ee/abc" });
  assert.equal(personal.verdict, "keep");
  assert.match(personal.why.join(" "), /隔離しない/);
  const shop = screenUser({ fn: "セレクトショップ公式", cat: "Shopping & retail", ext: "https://thebase.in/x" });
  assert.equal(shop.verdict, "biz_susp");
  /* 楽天ROOM等のアフィリエイト棚は隔離しない(run#6実測:8/11件が生活者だった) */
  const affiliate = screenUser({ fn: "あここ", cat: null, ext: "https://room.rakuten.co.jp/x" });
  assert.equal(affiliate.verdict, "keep");
  assert.match(affiliate.why.join(" "), /アフィリエイト棚/);
});

test("隔離は破棄ではなく、理由つきで全件残る", () => {
  const raws = [
    { h: "a", u: { un: "a", fn: "サロン公式", cat: null, ext: "", f: 1000 } },
    { h: "b", u: { un: "b", fn: "あやかママ", cat: null, ext: "", f: 1000 } }
  ];
  const r = postscreen(raws);
  assert.equal(r.bizSusp, 1);
  assert.equal(r.keep, 1);
  assert.match(r.rows[0].note, /破棄はしない/);
});
