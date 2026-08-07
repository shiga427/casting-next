/* ジャンル適合(2026-08-07 追加)。
 *
 * 【なぜ要るか】
 * SBIS-1 の100点(①会話の濃さ30 ②ER25 ③帯の中心15 ④bio語20 ⑤リンク+bio長10)には
 * **ジャンルの項目が1点も無い**。そのため実測で次のことが起きていた:
 *   @ina_chan0520 [travel] F19,259 / ER 17.81% / 発掘タグ #当選報告 → SBIS-1 81.9点で**1位**
 *   @mikajimbox   [food]   F31,274 / ER  4.17%                     → 71.6点で3位
 *   @gonta.h      [pet]    F71,048 / ER 約4.0% / FF比110           → 機械フィルタを全通過
 * 懸賞垢は応募コメントと相互いいねで①②(合計55点)が水増しされるため、**構造的に上位を取る**。
 *
 * 【なぜ SBIS-1 の total を直接いじらないか】
 * sbis.js は「管制室 v1.4 / Python版と1文字も変えずに移植した」ことをゴールデンテスト
 * (tests/sbis_port.test.js / tests/golden_run6.test.js)で担保している。ここに減点を混ぜると
 * その担保が壊れ、以後「JS版とPython版が違うのはバグか仕様か」が判別できなくなる。
 * よって **SBIS-1 は不可侵のまま、優先順位付けの軸をもう1本足す**。
 *
 * 【なぜ除外ではなく減点か】
 * run#6 で「genre_include 方式なら機械合格13名中8名(baby/fitness/sports/pet/food/travel)が
 * 全員落ちていた」ことが分かっている。落とすと母数が死ぬ。**順位だけ下げる。**
 */
import { r1 } from "./util.js";

/* 主ジャンルがここなら減点なし */
export const GENRE_CORE = ["beauty", "cosme"];
/* 主ジャンルがここなら軽い減点(生活の中で美容の話が成立しうる層) */
export const GENRE_LIFE = ["fashion", "baby", "interior", "food", "fitness", "art"];

export const GENRE_FIT = {
  core: { penalty: 0, label: "美容" },
  sub: { penalty: -8, label: "美容が副ジャンル" },
  life: { penalty: -14, label: "生活寄り(美容ではない)" },
  far: { penalty: -20, label: "美容と無関係" },
  none: { penalty: -8, label: "ジャンル不明" },
};

/* 並び替えの同点処理用。適合率が同じなら**ジャンルが近い方**を上に置く
 * (例: 適合70%で並んだ「travel 90点−20」と「beauty 70点」は beauty を上にする) */
export const FIT_ORDER = { core: 4, sub: 3, life: 2, none: 1, far: 0 };

function lower(v) { return String(v == null ? "" : v).toLowerCase(); }

/* 候補のジャンル適合を判定する。DOM にも state にも触れない純関数。
 * 返り値: { genre, klass, penalty, label } */
export function genreFit(cd) {
  const c = cd || {};
  const primary = lower(c.genre);
  const list = (Array.isArray(c.genres) ? c.genres : []).map(lower).filter(Boolean);
  if (!primary && !list.length) return { genre: null, klass: "none", ...GENRE_FIT.none };
  if (GENRE_CORE.includes(primary)) return { genre: primary || null, klass: "core", ...GENRE_FIT.core };
  /* 主ジャンルは別でも、副ジャンルに美容が入っているなら「美容の話ができる人」ではある */
  if (GENRE_CORE.some(g => list.includes(g))) return { genre: primary || null, klass: "sub", ...GENRE_FIT.sub };
  if (GENRE_LIFE.includes(primary)) return { genre: primary, klass: "life", ...GENRE_FIT.life };
  if (!primary) return { genre: null, klass: "none", ...GENRE_FIT.none };
  return { genre: primary, klass: "far", ...GENRE_FIT.far };
}

/* 適合点 = SBIS-1 total + ジャンル減点(下限0)。**total は書き換えない。**
 * 採点不能(total が null)なら null を返す。0 に丸めない。 */
export function fitScore(cd) {
  const sc = (cd && cd.score) || {};
  if (sc.total == null) return null;
  return r1(Math.max(0, Number(sc.total) + genreFit(cd).penalty));
}

/* 適合率(%)。満点は SBIS-1 と同じ(救済採点は75点満点)。全帯・全モード共通の並び替えキー */
export function fitRate(cd) {
  const sc = (cd && cd.score) || {};
  const f = fitScore(cd);
  if (f == null || !sc.max) return null;
  return Math.round(f / sc.max * 1000) / 10;
}

/* 表示用の一行説明。減点が無いときは空文字(バッジを出さない) */
export function fitNote(cd) {
  const g = genreFit(cd);
  if (!g.penalty) return "";
  return `ジャンル適合 ${g.penalty}(${g.label}${g.genre ? ":" + g.genre : ""})`;
}

/* 適合クラスの順位(大きいほど美容に近い)。同点処理と表の並び替えで使う */
export function fitOrder(cd) {
  const v = FIT_ORDER[genreFit(cd).klass];
  return v == null ? 0 : v;
}
