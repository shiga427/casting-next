/* 判断22:業者シグナルの取得後隔離(設計書§6-1・§2-2 v2.6)。移植元:postscreen_biz.py。
 *
 * **判定対象は 表示名 + IGカテゴリ + 外部リンクのドメイン のみ。bio は使わない。**
 * bio を除外に使うと「公式アンバサダー」を名乗る個人を誤爆する(v2.4 run#5 判断3)。
 * bio由来の業者語は SBIS-1④の減点(−8)と業者シグナル表示に回す(§4-1d)。
 *
 * 隔離であって破棄ではない(判断7の記録原則):該当は run に全件残して画面に出す。
 */

/* IGカテゴリ(ショップ/ブランド/製品・サービス/広告代理店/メディア系) */
export const CATEGORY_NG = [
  "shopping", "retail", "store", "shop", "brand", "product", "service",
  "advertising", "marketing", "agency", "media", "publisher", "magazine",
  "news", "broadcasting", "company", "business", "e-commerce", "commercial",
  "ショップ", "ブランド", "製品", "サービス", "広告", "代理店", "メディア",
  "雑誌", "小売", "会社", "企業",
];
/* 表示名の法人語(店舗/サロン/クリニック/公式/select shop 等) */
export const NAME_NG = [
  "店", "支店", "本店", "サロン", "salon", "クリニック", "clinic", "公式",
  "official", "セレクトショップ", "select shop", "selectshop", "株式会社",
  "有限会社", "合同会社", "inc.", "co.,ltd", "ltd.", "運営事務局", "編集部",
  "スタジオ", "studio", "アカデミー", "academy", "スクール", "school",
];
/* 集客導線ドメイン(予約サイト・自社EC・LINE公式) */
export const LINK_NG = [
  "lin.ee", "line.me", "hotpepper", "beauty.hotpepper", "reserva", "coubic",
  "airrsv", "stores.jp", "thebase.in", "base.shop", "shopify", "bookings",
  "square.site", "minimo", "epark",
];
/* 楽天ROOM・Amazonアソシエイト等は「個人が使うアフィリエイト棚」であって集客導線ではない。
   run#6実測:LINK_NG に入れると隔離11件中8件が楽天ROOMの生活者になり、
   §2-2「個人の誤爆を除外段階で起こさない」に正面から反した。よって隔離せず参考記録のみ。 */
export const AFFILIATE_LINKS = ["room.rakuten.co.jp", "rakuten.co.jp", "amazon.co.jp", "amzn.to",
  "a.r10.to", "px.a8.net", "lit.link", "linktr.ee"];
/* 個人名らしさ(表示名が非個人名かの判定に使う簡易ヒューリスティック) */
const PERSON_HINT = /(ちゃん|さん|ママ|mama|ﾏﾏ|♡|👶|🌷|の日常|の暮らし|@|\||｜)/;

function norm(text) {
  try { return String(text ?? "").normalize("NFKC").toLowerCase(); } catch (e) { return String(text ?? "").toLowerCase(); }
}

/* user は prof_compact のプロフィール部(fn/cat/ext)。戻り値 verdict は biz_susp / keep */
export function screenUser(user) {
  const name = norm(user.fn), category = norm(user.cat), link = norm(user.ext);
  const why = [];
  const hitCat = category ? CATEGORY_NG.filter(w => norm(w) && category.includes(norm(w))) : [];
  if (hitCat.length) why.push("IGカテゴリ:" + (user.cat || ""));
  const hitName = NAME_NG.filter(w => name.includes(norm(w)));
  if (hitName.length) why.push("表示名:" + hitName.join(","));
  const hitLink = LINK_NG.filter(d => link.includes(d));
  if (hitLink.length) {
    /* リンク単独での隔離は「表示名が非個人名」のときだけ(§2-2)。
       個人が予約リンクを貼っているだけのケースを誤爆させない */
    if (!PERSON_HINT.test(user.fn || "")) {
      why.push("集客導線リンク:" + hitLink.join(",") + "(表示名が非個人名)");
    } else {
      why.push("(参考)集客導線リンク:" + hitLink.join(",") + " ただし表示名は個人名らしい→隔離しない");
    }
  }
  const hitAff = AFFILIATE_LINKS.filter(d => link.includes(d));
  if (hitAff.length) why.push("(参考)アフィリエイト棚:" + hitAff.slice(0, 2).join(",") + "→隔離しない");
  const hard = why.filter(w => !w.startsWith("(参考)"));
  return { verdict: hard.length ? "biz_susp" : "keep", why };
}

/* 収集結果(parseJsonl の raws)に対して一括で判断22を実行する。
 * 戻り値の rows は「黙って捨てない」ための隔離リスト(分析結果画面に出す)。 */
export function postscreen(raws) {
  const rows = [];
  let kept = 0;
  raws.forEach(rec => {
    const user = rec.u;
    if (!user) return;
    const { verdict, why } = screenUser(user);
    if (verdict === "biz_susp") {
      rows.push({
        handle: user.un || rec.h,
        full_name: user.fn || "",
        ig_category: user.cat || "",
        external_url: user.ext || "",
        followers: user.f ?? null,
        verdict,
        reason: why.join(" / "),
        note: "隔離(取得キューから外す)。破棄はしない。人が最終判断する(§4-1d)"
      });
    } else kept++;
  });
  return { keep: kept, bizSusp: rows.length, rows };
}
