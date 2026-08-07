/* 採点基準と定数。移植元:管制室 v1.4 の constants ブロックを1文字変えずに移す。
 * 値の変更は「理由+バージョン表記」を伴う運用(設計書§5-7)。ここを直接編集しないこと。
 */

export const TOOL_VER = "NEXT v0.1 (port of tool v1.4)";
export const SBIS_VER = "SBIS v2.6";

export const STATUSES = ["候補", "精査済", "DM送付", "資料送付", "条件交渉", "契約", "見送り"];
/* SBIS-3(保存率)を活性化するステータス:資料送付以降(指示書§4-3) */
export const S3_FROM = 3;
/* T3(薬機法の作法)の判定母集団。T1と同一の直近8投稿に固定する(v2.1 §4-2/§9 判断2) */
export const T3_SAMPLE = 8;
export const SLOTS = ["連載枠", "都度枠"];
export const SLOT_CAP = { "連載枠": 4, "都度枠": 10 };

/* 証言力rubric(§4-2)。maxは満点、keyはs2/s2evの共通キー */
export const RUBRIC = [
  { k: "t1", lab: "T1 解説者度", max: 15 },
  { k: "t2", lab: "T2 購買文脈", max: 10 },
  { k: "t3", lab: "T3 薬機法の作法", max: 15 },
  { k: "t4", lab: "T4 世界観・文体", max: 5 },
  { k: "t5", lab: "T5 継続素養", max: 5 }
];
export const RUBRIC_KEYS = RUBRIC.map(r => r.k);
export const LEGACY_S2_KEYS = ["s2yaku", "s2pr", "s2cont", "s2world", "s2save"];
export const LEGACY_S2_LAB = { s2yaku: "薬機法リテラシー", s2pr: "PR投稿の質", s2cont: "連載・継続素養", s2world: "世界観適合", s2save: "保存率実測" };

/* 探索カバレッジの既定行(指示書§2-1)。プロジェクト設定のキーワード群から生成できるよう配列で持つ */
export const COV_SEED = [
  ...["#購入品紹介", "#スキンケア購入品", "#コスメレポ", "#使い切りコスメ", "#当選報告", "#当選しました", "#モニター当選", "#スキンケア記録", "#美容記録",
    /* v2.2 §2-1 追加:コミュニティ参加意思の明示層(母数大) */
    "#美容垢さんと繋がりたい", "#コスメ好きさんと繋がりたい"].map(t => ({ route: "E1", term: t })),
  ...["購入品紹介", "コスメレポ", "当選報告", "スキンケア記録", "スキンケア購入品", "モニター当選", "使い切りコスメ", "ナイアシンアミド", "レチノール", "ご褒美コスメ", "30代コスメ", "スキンケア紹介"].map(t => ({ route: "E2", term: t }))
];
export const COV_STATES = ["未実行", "実行中", "完了"];
export const STAGE_COLORS = ["#EAD5DE", "#D5AEC0", "#C08BA0", "#A96A85", "#96506C", "#6D2E46", "#B9AFB4"];

/* 精査チェックリスト:設計指示書 v2.1 付録B(§9 判断1で差し替え確定) */
export const CHECKS_VER = 2;
export const CHECK_ITEMS = [
  "直近8投稿を実際に読んだ(T1〜T4の証拠メモを記録した)",
  "タイアップ比率を数えた(8投稿中何本か)",
  "コメント欄に読者の質問+本人の返信がある",
  "フォロワー購入の兆候なし",
  "競合(ヒト幹細胞系)の現行アンバサダー契約なし",
  "(連載枠候補)T5=5および成長中判定の根拠数値を記録した",
  "生活文脈投稿を数えた(8投稿中何本か・§4-2b)/業者シグナルがある場合は業者性を確認した"
];
/* v1.1(付録B v1.0)の項目。legacy_checks の表示にのみ使う */
export const LEGACY_CHECK_ITEMS = [
  "直近12投稿に薬機法NGワードなし",
  "PR投稿に#PR・タイアップラベルの明記歴あり(なければ「PR経験なし」扱い)",
  "コメント欄に本人の返信がある(会話の実在)",
  "フォロワー購入の兆候なし",
  "世界観がBerry&Creamトーンと並べられる",
  "競合(ヒト幹細胞系)の現行アンバサダー契約なし"
];
export const LEGACY_ERMIC0 = 3.5;      /* v1.1の旧既定値。移行時の自動更新はこの値のときだけ行う(v2.1 §9 判断3) */
export const LEGACY_CONV = [0.005, 0.03]; /* v1.2の旧①スケール(全帯共通) */

export const DEFAULT_CONF = {
  ver: SBIS_VER,
  microMin: 5000, microMax: 30000, midMin: 30000, midMax: 100000,
  /* v2.2 §4-1:①会話の濃さをティア別に再校正(旧 convFloor .005 / convFull .03 は廃止) */
  convMid0: 0.004, convMidFull: 0.020, convMic0: 0.006, convMicFull: 0.030,
  erMid0: 2.0, erMidFull: 5.0, erMic0: 3.0, erMicFull: 8.0,
  cutoffConv: 5,
  /* v2.3 §4-1c SBIS-1s:救済合格者(いいね非表示)の①代替=コメント率のティア正規化 */
  crMid0: 0.05, crMidFull: 0.30, crMic0: 0.10, crMicFull: 0.60,
  /* v2.2 §4-1b オーディエンス純度減点 */
  purFollow1: 5000, purFollow2: 3000, purFfMin: 1, purCap: -15,
  /* v2.6 §4-1b 純度ハードゲート(判断19):フォロー>3,000 または FF比<2.0 は足切り扱い */
  gateFollow: 3000, gateFf: 2.0,
  growMin: 10000, growMax: 30000, growLift: 1.3, growEr: 6.0,  /* §4-4 成長中マイクロ判定 */
  kwIngredient: "成分,ナイアシンアミド,レチノール,ヒト幹細胞,幹細胞培養液,ビタミンC,セラミド,ペプチド",
  kwReview: "購入品,レポ,正直,レビュー,使い切り,スウォッチ,比較",
  kwAge: "20代,30代,40代,50代,アラサー,アラフォー",
  kwWin: "当選,モニター,懸賞",
  /* v2.6 §4-1・§4-1d:生活語(+4)・業者語(−8)・他社契約シグナル・集客導線ドメイン */
  kwLife: "ママ,子育て,育児,主婦,ワーママ,OL,会社員,看護師,保育士,暮らし,日常,等身大,ずぼら,双子,ワンオペ,家事,共働き,アラサー,アラフォー,自分時間",
  kwBiz: "所属クリエイター,事務所,案件募集,案件はDM,お仕事依頼,お仕事のご依頼,ご依頼はDM,PR実績,タイアップ実績,サロン,店舗,ご予約,セレクトショップ,運営,代理店",
  kwAmb: "アンバサダー,専属,公認",
  bizDomains: "lin.ee,line.me,hotpepper,reserva,coubic,shopify,thebase.in,base.shop,stores.jp",
  kwPenaltyPr: "案件募集,PRはDM,お仕事依頼,コラボ募集",
  kwPenaltyDisc: "クーポン,割引,セール,激安,お得情報",
  ngWords: "再生,幹細胞が肌を作り変える,シワが消える,シワ改善,美白効果,若返り,治る,治療,アンチエイジング効果,細胞レベル,ターンオーバー正常化,医薬品級,肌が生まれ変わる",
  /* v1.2:作法語のポジティブ検出(指示書 付録A)。正規表現は MANNER_RE で別途 */
  mannerWords: "いただきものを含みます,いただき物を含みます,個人の感想です,提供いただきました,PR,タイアップ"
};

/* 作法語の記号パターン(注記の実在) */
export const MANNER_RE = [
  { re: /\*[¹1２²]|＊[¹1]/g, lab: "注記記号(*¹)" },
  { re: /※[^\n]{2,}/g, lab: "※付き注記" }
];

/* v1.2:10万超は「対象外帯」ではなく「第0候補(保管)」(指示書§0) */
export const TIER_LAB = { middle: "ミドル", micro: "マイクロ", mega: "第0候補", out: "対象外帯" };

/* 精査(qual)対象の選び方(2026-08-03 変更)。
 * 旧: 得点率の上位N名を機械的に取る → 母数が薄いと30点台まで精査に回っていた。
 * 新: **スコア60点以上だけを対象**にし、10名に満たなければ発掘で母数を足す。
 * ここは拡張(extension/popup.js)も参照する正本。数値を散らさずこの4つだけを見ること。 */
export const QUAL_MIN_SCORE = 60;          /* 精査対象の下限(score.total)。これ未満は精査に回さない */
export const QUAL_FILL_TARGET = 10;        /* 1回で揃えたい精査対象の人数。不足ぶんを発掘で埋める */
export const QUAL_MAX_COLLECT = 12;        /* 1回の収集で拡張に渡す上限(超過ぶんは次回へ回す。黙って切り捨てない) */
export const QUAL_DISCOVER_MAX_ROUNDS = 3; /* 不足時の自動発掘の最大周回。これを超えたら足りないまま続行して事実を言う */

/* ============================================================================
 * DM自動一括送付(設計書_DM自動一括送付_v1.0)
 *
 * ★この4つの数値と、下のブランド事実・文面骨子が「DMの数値・文言の正本」(同§8)。
 *   拡張(extension/dm_runner.js)にも同じ既定値のフォールバックがあるが、
 *   判断の正はここ。散らさないこと。
 *
 * ★DM送付は読み取りと違い**書き込み操作**であり、凍結・スパム判定の直接対象(同§0-1)。
 *   これらは「推奨」ではなく必須要件。緩める向きの変更をしない
 *   (待機は伸ばす方向・上限は下げる方向だけを許可する。cdpDm.js の clampDmOpts)。
 * ========================================================================== */
export const DM_MIN_WAIT = 45000;   /* 送信間の待機の下限ms(§6-1。収集の4〜12秒より大幅に長い) */
export const DM_MAX_WAIT = 90000;   /* 同上限ms */
export const DM_PER_MIN_MAX = 1;    /* 1分あたりの最大送付数(§6-1) */
export const DM_DAILY_CAP = 30;     /* 1日の送付上限(§6-2。拡張側でも二重にガードする) */

/* §4-1 案内文に使ってよいブランド事実(ブランド概要pptxの実値。ここに無い事実を作文しない) */
export const DM_BRAND = {
  name: "ステムボーテ",
  weeklyMin: 30, weeklyMax: 50,   /* 購入枠 週30〜50名 */
  oddsMin: 5, oddsMax: 7,         /* 当選倍率 5〜7倍 */
};

/* §4-2 ティア別のアングル。{{angle_line}} の既定(精査の読みがあればそちらを優先) */
export const DM_ANGLE = {
  micro: "普段の暮らしの中でコスメを等身大に紹介されている発信を拝見し、",
  middle: "丁寧で保存されやすいレビューを拝見し、",
};
/* §4-5 {{experience_word}} */
export const DM_EXPERIENCE_WORD = { micro: "体験", middle: "体験レビュー" };
/* §4-5 {{slot_line}}。middle かつ連載枠のときだけ入る(micro は空) */
export const DM_SLOT_LINE = "（ミドル層の方には月2回程度の継続契約と、フォロワー属性インサイトのご提出をお願いしています）";
/* §4-3 精査の読みを差し込む一文。charm=魅力 / role=戦略での役割 */
export const DM_CHARM_ANGLE = "「{{charm}}」という発信を拝見し、";
export const DM_ROLE_LINE = "{{role}}としてお力をお借りできればと考えています。";
/* §4-2 ティア既定の枠 */
export const DM_TIER_SLOT = { micro: "都度枠", middle: "連載枠" };

/* §4-5 文面テンプレート(敬体・営業色を抑える)。段落ごとに定数化する。
 * ※ closing の「この投稿への返信で」は設計書§4-5 の文言そのまま。
 *   DMなので「このメッセージへの返信で」が自然だが、文言を勝手に変えない規約により原文を保持している。
 *   変更が要ると判断したらここだけを直す(オーナー確認事項として報告済み)。 */
export const DM_TEMPLATE = {
  greeting: "{{name}} 様",
  intro: "はじめてご連絡します。スキンケアブランド「{{brand}}」のアンバサダーを\nお願いできる方を探しており、{{angle_line}}ご連絡しました。",
  brandFact: "{{brand}}は一般販売をしていない完全紹介制のブランドで、毎週の抽選に\n"
    + "当たった方だけが購入できます（購入枠 週{{weekly_min}}〜{{weekly_max}}名／当選倍率 {{odds_min}}〜{{odds_max}}倍）。\n"
    + "「効果」ではなく、応募した・当たった・届いたという{{experience_word}}を\n投稿していただく起用です。",
  offer: "ご用意しているのは、本品のギフティング／フォロワーの方を抽選なしでご招待\n"
    + "いただける特別紹介コード／固定報酬の3点です{{slot_line}}。",
  compliance: "投稿は #PR 表記をお願いし、公開前に弊社で薬機法チェックを行います\n（差し戻しの手間を減らすためのものです）。",
  closing: "ご興味をお持ちいただけましたら、この投稿への返信でお知らせください。",
};

/* §4-4 景表法・法務未確定のため、文面に出してはいけない断定語。
 * 薬機法のNG語は ngWords(DEFAULT_CONF)を流用し、生成後にまとめてスキャンする。 */
export const DM_FORBIDDEN_WORDS = ["限定"];
