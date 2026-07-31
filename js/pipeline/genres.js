/* ジャンル推定(設計書§6-1)。移植元:igfinder/genres.py。辞書・順序・confident の条件をそのまま。
 * ① IGカテゴリ → ② bio/表示名/キャプションのキーワードマッチ(bio を重めに見る)。
 * ③ LLM フォールバックはブラウザ内処理では使わない(confident=false をそのまま返す)。
 */

export const GENRE_KEYWORDS = {
  beauty: ["美容", "コスメ", "スキンケア", "メイク", "化粧", "美白", "毛穴", "リップ",
    "アイシャドウ", "ネイル", "エステ", "脱毛", "beauty", "makeup", "skincare",
    "cosmetic", "cosme", "美容師", "美容ライター", "美容オタク"],
  cosme: ["コスメ", "韓国コスメ", "プチプラ", "デパコス", "新作コスメ", "cosme",
    "kbeauty", "韓国美容", "swatch"],
  fashion: ["ファッション", "コーデ", "着回し", "古着", "プチプラコーデ", "outfit",
    "fashion", "ootd", "styling", "スタイリスト", "アパレル"],
  food: ["グルメ", "カフェ", "食べ歩き", "レシピ", "料理", "スイーツ", "ラーメン",
    "居酒屋", "food", "foodie", "cafe", "recipe", "gourmet", "パン"],
  fitness: ["筋トレ", "ジム", "ダイエット", "ヨガ", "ピラティス", "トレーニング",
    "fitness", "workout", "gym", "diet", "yoga", "パーソナルトレーナー"],
  travel: ["旅行", "旅", "観光", "絶景", "ホテル", "温泉", "travel", "trip",
    "wanderlust", "旅好き", "海外旅行"],
  pet: ["犬", "猫", "ねこ", "いぬ", "ペット", "dog", "cat", "pet", "柴犬", "保護猫"],
  gadget: ["ガジェット", "スマホ", "pc", "カメラ", "レビュー", "gadget", "tech",
    "iphone", "デスク環境"],
  finance: ["投資", "株", "資産運用", "節約", "副業", "nisa", "fx", "仮想通貨",
    "finance", "投資家", "お金"],
  education: ["英語", "勉強", "受験", "資格", "学習", "study", "english", "勉強垢",
    "教員", "塾"],
  interior: ["インテリア", "収納", "暮らし", "diy", "北欧", "interior", "myhome",
    "新築", "注文住宅"],
  baby: ["育児", "ママ", "мама", "子育て", "妊娠", "マタニティ", "赤ちゃん",
    "ワンオペ", "mama", "babygirl", "babyboy", "ママ友"],
  art: ["イラスト", "絵", "アート", "デザイン", "art", "illustration", "design", "絵描き"],
  music: ["音楽", "バンド", "ギター", "ピアノ", "歌", "music", "guitar", "singer", "dj"],
  photo: ["写真", "カメラ", "ポートレート", "photography", "photographer", "portrait", "写真好き"],
  sports: ["サッカー", "野球", "バスケ", "ゴルフ", "サーフィン", "soccer", "baseball", "golf", "surf"],
  car: ["車", "バイク", "愛車", "カスタム", "car", "bike", "jdm", "ドライブ"],
  anime: ["アニメ", "漫画", "コスプレ", "推し", "anime", "manga", "cosplay", "オタ活"],
  /* --- 除外用途で使われがちなジャンル --- */
  reseller: ["転売", "せどり", "仕入れ", "卸", "激安", "在庫あり", "即購入", "代行",
    "海外通販", "格安", "buyma", "reseller", "wholesale", "dropship",
    "アフィリエイト", "紹介コード"],
  bot: ["相互フォロー", "フォロバ100", "follow4follow", "f4f", "followback",
    "いいね返し", "自動化", "無料プレゼント企画", "dm ください",
    "副業紹介", "稼げる", "月収", "簡単に稼"],
  adult: ["18+", "onlyfans", "アダルト", "エロ", "パパ活", "裏垢"],
};

export const IG_CATEGORY_MAP = {
  "beauty, cosmetic & personal care": "beauty",
  "beauty salon": "beauty",
  "cosmetics": "cosme",
  "cosmetics store": "cosme",
  "health/beauty": "beauty",
  "makeup artist": "beauty",
  "skin care service": "beauty",
  "clothing (brand)": "fashion",
  "clothing store": "fashion",
  "fashion model": "fashion",
  "restaurant": "food",
  "food & beverage": "food",
  "cafe": "food",
  "chef": "food",
  "sports & fitness instruction": "fitness",
  "gym/physical fitness center": "fitness",
  "personal trainer": "fitness",
  "travel company": "travel",
  "hotel": "travel",
  "tour agency": "travel",
  "pet service": "pet",
  "veterinarian": "pet",
  "electronics": "gadget",
  "financial service": "finance",
  "education": "education",
  "tutor/teacher": "education",
  "home decor": "interior",
  "furniture": "interior",
  "artist": "art",
  "graphic designer": "art",
  "musician/band": "music",
  "photographer": "photo",
  "athlete": "sports",
  "automotive": "car",
};

const HASHTAG_RE = /[#＃]([^\s#＃、。,.!?！？]+)/g;

export function extractHashtags(text) {
  if (!text) return [];
  const out = [];
  for (const m of String(text).matchAll(HASHTAG_RE)) out.push(m[1].toLowerCase());
  return out;
}

export function scoreGenres(text) {
  const lowered = (text || "").toLowerCase();
  const scores = {};
  for (const [genre, keywords] of Object.entries(GENRE_KEYWORDS)) {
    let hits = 0;
    keywords.forEach(kw => { if (lowered.includes(kw.toLowerCase())) hits++; });
    if (hits) scores[genre] = hits;
  }
  return scores;
}

export function classifyGenre({ bio = null, captions = null, ig_category = null, full_name = null } = {}) {
  /* ① IG が持つビジネスカテゴリを最優先(人手で入れられた一次情報) */
  if (ig_category) {
    const key = String(ig_category).trim().toLowerCase();
    let mapped = IG_CATEGORY_MAP[key];
    if (mapped == null) {
      for (const [cat, genre] of Object.entries(IG_CATEGORY_MAP)) {
        if (cat.includes(key) || key.includes(cat)) { mapped = genre; break; }
      }
    }
    if (mapped) {
      return { genre: mapped, genres: [mapped], scores: { [mapped]: 99 }, method: "ig_category", confident: true };
    }
  }

  /* ② bio / 表示名 / キャプション(bio を重めに見る) */
  const parts = [];
  if (bio) { parts.push(bio, bio); }
  if (full_name) parts.push(full_name);
  if (captions) parts.push(...captions);
  const blob = parts.join("\n");

  const scores = scoreGenres(blob);
  const keys = Object.keys(scores);
  if (!keys.length) return { genre: null, genres: [], scores: {}, method: "unknown", confident: false };

  const ordered = Object.entries(scores).sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const [topGenre, topScore] = ordered[0];
  const runnerUp = ordered.length > 1 ? ordered[1][1] : 0;
  /* 単独ヒット1件かつ差がない場合は曖昧扱い */
  const confident = topScore >= 2 || topScore > runnerUp;

  return {
    genre: topGenre,
    genres: ordered.map(([g]) => g),
    scores,
    method: "keyword",
    confident: !!confident
  };
}
