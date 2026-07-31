/* 取得キューの並べ替え(設計書§5-2・§6-1)。移植元:rank_queue.py(v2.6・判断24)。
 *
 * 「個人アカウントらしさ × 生活者らしさ」で並べる。除外はせず後回しにする原則
 * (§2-1「ソートキーのために母集団を削らない」)は不変。
 * **取得済み除外の照合キーは username**(run#6 不具合1:列名 handle しか見ておらず
 * 取得済み除外が一度も効いていなかった。列名の揺れを両方受ける)。
 */
import { csvToObjects } from "./util.js";

/* 法人語(部分一致)。ブランド名を数え上げるのではなく「法人が使う語」を見る */
export const CORP_WORDS = [
  "official", "officiel", "cosmetics", "cosmetic", "onlineshop", "onlinestore", "shopping",
  "showroom", "magazine", "editors", "pharma", "company", "atelier", "academy", "clinic",
  "salon", "outlet", "corp", "global", "worldwide", "flagship", "press", "staff", "info",
  "brand", "shop", "store", "japan", "_jp", "jp_", "labo", "lab", "inc", "co_", "group",
  "beautyjp", "makeupjp", "tokyo", "ginza", "shibuya", "harajuku", "yokohama", "recruit",
  "campaign", "event", "news", "media", "times", "channel", "tv", "radio", "supply", "works",
];
/* 既知の大手ブランド/媒体(トークン一致) */
export const BRANDS = new Set(`
chanel dior gucci prada pradabeauty hermes ysl lancome shiseido
kose kanebo canmake cezanne cosrx innisfree laneige etude clarins
clinique lush skii sk2 loreal maybelline nars panasonic amazon
rakuten qoo10 lohaco matsukiyo matsukiyococokara welcia ainz donki
biteki vivi maquia voce vogue baila ldk elle oggi cledepeau
espoir lips muji refa sucle kate opera visee dhc orbis fancl
curel minon ipsa decorte albion sofina elixir anessa uno senka
rohto kao lion drjart ettusaisjp ettusais excelmake excel jillstuart
jillstuartbeauty floranotis lamer larocheposay larocheposayjp pantene
panteneid lits litsbeauty ishizawalab chacott chacottcosme laduree
ladureejapon maisondefleur plazastyle dianebetrue diane amuse anemone
kenelephant kenelestand dupbeauty dup esbonita haru kokyumaison
nameraka namerakahonpo jetaime pesca lieuplie restandrecreation
clubsuppin oshietebacosme owllhair owllkiyoi pilatestoday kansosansg
igarishinobu hakamata kyokohakamata
`.trim().split(/\s+/));

/* v2.6(判断24):cosme/beauty/make は加点から除外(レビュアー専業をキュー上位に呼ぶため) */
const PERSONAL = /(chan|ch4n|kun|san|nyan|love|diary|memo|log|record|kirei|hada|ol_|_ol|aya|yuki|mi|na|ko|ka|ri)/;
/* v2.6(判断24):生活語 +2 — 「普段の生活を発信している個人」をキュー先頭へ */
const LIFE = /(mama|mom|papa|kurashi|ikuji|kosodate|ouchi|days|life|home|katazuke|kaji|gohan|oyako|futago|working|wife|shufu)/;
/* v2.6(判断24):レビュアー専業疑い −2(除外はしない・後回しのみ) */
const REVIEWER = /(cosme|beauty|make_?up|review|swatch)/;
const NAME_LIKE = /^[a-z]{2,10}[._][a-z0-9._]{1,15}$/;

/* E1 行動タグ(本丸)と v2.6 生活文脈タグ */
export const E1_TAGS = ["購入品", "コスメレポ", "使い切り", "当選", "モニター", "スキンケア記録", "美容記録"];
export const LIFE_TAGS = ["アラサー美容", "アラフォー美容", "ママ美容", "ずぼらスキンケア", "夜のスキンケア", "自分磨き記録"];

function tokens(h) {
  return new Set(String(h).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

export function score(handle, tags, likes) {
  const h = String(handle || "").toLowerCase();
  let s = 0; const why = [];
  const tk = tokens(h);
  if ([...tk].some(t => BRANDS.has(t))) { s -= 12; why.push("brand_name"); }
  for (const w of CORP_WORDS) {
    if (h.includes(w)) { s -= 8; why.push("corp:" + w); break; }
  }
  /* 個人アカウントは「区切り記号 or 数字」を含むことが圧倒的に多い */
  if (/\d/.test(h)) { s += 3; why.push("digit"); }
  if (h.includes("_") || h.includes(".")) { s += 3; why.push("sep"); }
  if (NAME_LIKE.test(h)) { s += 2; why.push("namelike"); }
  if (PERSONAL.test(h)) s += 1;
  if (LIFE.test(h)) { s += 2; why.push("life"); }
  if (REVIEWER.test(h)) { s -= 2; why.push("reviewer_susp"); }
  /* 区切りも数字も無い短い英単語=ブランド語の典型(amuse / lamer / excel) */
  if (!/[\d_.]/.test(h) && h.length <= 12) { s -= 6; why.push("bare_word"); }
  /* 帯ターゲット窓(§2-1 v2.4) */
  let lk = null;
  const raw = String(likes ?? "").trim();
  if (raw !== "" && raw !== "None") { const n = Number(raw); lk = isFinite(n) ? Math.trunc(n) : null; }
  if (lk == null) { s += 1; why.push("likes_na"); }
  else if (lk >= 100 && lk <= 8000) { s += 4; why.push(`likes_in_window(${lk})`); }
  else if (lk > 8000) { s -= 5; why.push(`likes_high(${lk})`); }
  else { s -= 2; why.push(`likes_low(${lk})`); }
  const t = String(tags || "");
  if (E1_TAGS.some(x => t.includes(x))) { s += 3; why.push("e1_tag"); }
  /* v2.6:生活文脈タグ由来はさらに優先(§2-1 E1 v2.6 の取得順序②) */
  if (LIFE_TAGS.some(x => t.includes(x))) { s += 3; why.push("life_tag"); }
  return { score: s, why };
}

/* 取得済み台帳(job_in_done 相当)の読み込み。**列名の揺れ(handle / username)を両方受ける** */
export function readDoneHandles(csvText) {
  const { rows } = csvToObjects(csvText);
  const done = new Set();
  rows.forEach(r => {
    const value = r.handle || r.username || "";
    if (String(value).trim()) done.add(String(value).trim().toLowerCase().replace(/^@/, ""));
  });
  return done;
}

/* プール(handle/tags/likes)+ 取得済み → 今回のキュー。
 * limit 既定100件(§5-2)。プール残数も返す(画面に出す)。 */
export function buildQueue(pool, done, limit = 100) {
  const doneSet = done instanceof Set ? done : new Set((done || []).map(h => String(h).toLowerCase().replace(/^@/, "")));
  const merged = new Map();
  pool.forEach(row => {
    const h = String(row.handle || "").trim().toLowerCase().replace(/^@/, "");
    if (!h || doneSet.has(h)) return;
    const entry = merged.get(h) || { handle: h, tags: "", likes: row.likes ?? "" };
    entry.tags += " " + (row.tags || "");
    if (!entry.likes) entry.likes = row.likes ?? "";
    merged.set(h, entry);
  });
  const ranked = [...merged.values()].map(e => {
    const { score: s, why } = score(e.handle, e.tags, e.likes);
    return { score: s, handle: e.handle, tags: e.tags.trim(), likes: e.likes, why: why.join(";") };
  }).sort((a, b) => (b.score - a.score) || (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));

  return {
    poolSize: ranked.length,
    excludedByDone: doneSet.size,
    queue: ranked.slice(0, limit),
    deferred: ranked.slice(limit)
  };
}
