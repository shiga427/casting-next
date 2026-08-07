/* ジャンル適合(2026-08-07)。
 *
 * 実測で「SBIS-1 にジャンルの配点が1点も無い」ため、候補ボードの1位が旅行アカ・3位がグルメアカに
 * なっていた。ここでは **SBIS-1 の値を書き換えずに順位だけ直せていること**を検証する。
 * 期待値は実データ(@ina_chan0520 81.9 travel / @mikajimbox 71.6 food / @fujimotosubaru 78.1 beauty)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { genreFit, fitScore, fitRate, GENRE_CORE, GENRE_LIFE } from "../js/pipeline/genrefit.js";
import { qualTargets } from "../js/pipeline/qualReport.js";

const cand = (username, genre, total, genres) => ({
  username, genre, genres: genres || [],
  score: { total, max: 100, rate: total, cut: false, tier: "micro" }, status: "候補"
});

test("主ジャンルが美容なら減点なし・無関係なら-20", () => {
  assert.equal(genreFit(cand("a", "beauty", 80)).penalty, 0);
  assert.equal(genreFit(cand("a", "cosme", 80)).penalty, 0);
  assert.equal(genreFit(cand("a", "pet", 80)).klass, "far");
  assert.equal(genreFit(cand("a", "travel", 80)).penalty, -20);
});

test("生活寄り(-14)と、美容が副ジャンル(-8)を区別する", () => {
  GENRE_LIFE.forEach(g => assert.equal(genreFit(cand("a", g, 80)).penalty, -14, g));
  /* 主ジャンルはグルメでも副ジャンルに美容があるなら「美容の話ができる人」ではある */
  assert.equal(genreFit(cand("a", "food", 80, ["food", "beauty"])).penalty, -8);
});

test("ジャンル判定不能は推測で落とさない(-8・不明として表示)", () => {
  const g = genreFit({ score: { total: 80, max: 100 } });
  assert.equal(g.klass, "none");
  assert.equal(g.penalty, -8);
  assert.equal(g.genre, null);
});

test("実データ:旅行81.9点が美容78.1点を抜いていた並びが直る", () => {
  const ina = cand("ina_chan0520", "travel", 81.9);
  const fuji = cand("fujimotosubaru", "beauty", 78.1);
  const mika = cand("mikajimbox", "food", 71.6);
  /* SBIS-1 は書き換えない */
  assert.equal(ina.score.total, 81.9);
  assert.equal(fitScore(ina), 61.9);
  assert.equal(fitScore(fuji), 78.1);
  assert.equal(fitScore(mika), 57.6);
  const order = [ina, fuji, mika].sort((a, b) => fitRate(b) - fitRate(a)).map(c => c.username);
  assert.deepEqual(order, ["fujimotosubaru", "ina_chan0520", "mikajimbox"]);
});

test("採点不能(total=null)は0点にせず null を返す", () => {
  assert.equal(fitScore({ genre: "beauty", score: { total: null, max: 100 } }), null);
  assert.equal(fitRate({ genre: "beauty", score: { total: null, max: 100 } }), null);
});

test("救済採点(75点満点)でも適合率が満点基準で出る", () => {
  const c = { genre: "beauty", genres: [], score: { total: 60, max: 75, rate: 80 } };
  assert.equal(fitRate(c), 80);
});

test("精査待ちの並びも適合率になる(精査枠を非美容が食わない)", () => {
  const cands = [
    cand("travel90", "travel", 90),
    cand("beauty70", "beauty", 70),
    cand("food80", "food", 80),
  ];
  /* SBIS-1 の閾値(60点)で切るのは従来どおり。並びだけ適合率に変わる */
  assert.deepEqual(qualTargets(cands).map(c => c.username), ["beauty70", "travel90", "food80"]);
});

test("GENRE_CORE / GENRE_LIFE は重複しない", () => {
  GENRE_CORE.forEach(g => assert.ok(!GENRE_LIFE.includes(g), g));
});
