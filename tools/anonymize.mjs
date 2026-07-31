/* 匿名化(設計書§11-2)。実在ハンドルのデータを公開リポジトリに入れないための唯一の入口。
 *
 * 方針:
 *   ハンドル置換  username / full_name / account_url / @メンション / bio内の自ハンドル表記を差し替え
 *   数値摂動      followers / avg_likes / avg_comments / following に ±0.5%以内の決定的なズレを与える
 *                 (乱数は使わない。同じ入力から常に同じfixtureが出る)
 *   URL           ドメインだけ残してパスを捨てる(bizDomains 判定はドメインで効くため意味を保つ)
 *
 * 数値摂動は「判定を跨がない」ことを呼び出し側で検証する(tools/build_fixtures.mjs)。
 * 跨いだ行は摂動量0に戻す。ゴールデンテストの照合値は**摂動後の値**で固定する。
 */

/* 決定的な擬似乱数(seed固定)。Math.random は使わない */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeHandleMap(usernames) {
  const map = new Map();
  [...usernames].sort().forEach((u, i) => {
    const n = String(i + 1).padStart(3, "0");
    map.set(u, { username: `sample_${n}`, full_name: `サンプル${n}` });
  });
  return map;
}

const URL_RE = /https?:\/\/[^\s"'<>）)、,]+/gi;

export function anonDomain(url) {
  if (!url) return "";
  const m = String(url).match(/^https?:\/\/([^/\s]+)/i);
  if (!m) return "";
  return "https://" + m[1] + "/x";
}

/* bio・キャプションの匿名化:URL・@メンション・自ハンドル/表示名の痕跡を落とす。
 * 語彙(生活語・業者語・成分語…)は判定に効くので残す。 */
export function anonText(text, original, replacement, extraSeeds) {
  let t = String(text ?? "");
  t = t.replace(URL_RE, " ");
  t = t.replace(/[@＠][A-Za-z0-9._]{2,}/g, " ");
  const seeds = new Set();
  if (original) {
    seeds.add(original);
    String(original).split(/[._\-0-9]+/).filter(s => s.length >= 3).forEach(s => seeds.add(s));
  }
  /* 表示名(full_name)とその区切り片も落とす。bio に自分の名前を書いている人が多い */
  (extraSeeds || []).forEach(x => {
    const v = String(x || "").trim();
    if (v.length >= 2) seeds.add(v);
    v.split(/[｜|/／・,、\s]+/).filter(y => y.length >= 2).forEach(y => seeds.add(y));
  });
  seeds.forEach(s => {
    if (!s) return;
    const re = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    t = t.replace(re, replacement || "");
  });
  /* サロンなどの判定語を消さないよう、置換で生まれた連続空白だけ畳む */
  return t.replace(/[ \t]{2,}/g, " ").trim();
}

/* 数値摂動:±maxPct 以内の決定的なズレ。整数は整数に、小数1桁は小数1桁に丸める */
export function jitter(value, rnd, maxPct, digits) {
  if (value == null) return null;
  const f = 1 + (rnd() * 2 - 1) * maxPct;
  const v = value * f;
  if (digits === 0) return Math.max(0, Math.round(v));
  const p = Math.pow(10, digits ?? 1);
  return Math.max(0, Math.round(v * p) / p);
}
