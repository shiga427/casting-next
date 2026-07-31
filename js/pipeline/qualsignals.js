/* 定性シグナルの抽出(設計書§6-1)。移植元:igfinder/qualsignals.py(v2.7)。
 *
 * **このモジュールの役割は「引用を拾うこと」だけ**である。良し悪しの判断はしない。
 * 語ではなく**当たった文そのもの**を返す。stance 判定は「導線の有無を先に見る」構造を維持する
 * (営業導線は当事者性で相殺されない=§6-2 の1)。
 *
 * 移植上の注意(Python と JS の差を吸収した箇所。ロジックは変えていない):
 *  - Python の \W は Unicode 対応なので、JS では [^\p{L}\p{N}] で書き直している
 *    (JS の \W は ASCII 基準のため、そのまま使うと日本語の文が全部「装飾行」になる)
 *  - len()/スライスはコードポイント単位(cpLen/cpSlice)。JS の .length では絵文字でずれる
 */
import { cpLen, cpSlice } from "./util.js";
import { pyRound } from "./ingest.js";

/* ---- 文の切り出し -------------------------------------------------- */
const SPLIT = /[。\n！!？?]+/;
/* ハッシュタグ・メンション・区切り装飾だけの行は引用にしない
   (Python: ^[\s\W_]*$|^[#＃@][^\s]*$|^[-—ー=＝*＊・\s]+$) */
const NOISE = /^[^\p{L}\p{N}]*$|^[#＃@][^\s]*$|^[-—ー=＝*＊・\s]+$/u;
const TAIL_TAGS = /(?:[#＃][^\s#＃]+\s*){2,}$/;

export function norm(text) {
  try { return String(text ?? "").normalize("NFKC"); } catch (e) { return String(text ?? ""); }
}

function pyStrip(s) {
  /* Python の .strip() → 空白類を除去。続く .strip("　") で全角空白も除去 */
  return String(s).replace(/^\s+|\s+$/g, "").replace(/^　+|　+$/g, "");
}

export function sentences(text, minLen = 6, maxLen = 90) {
  const out = [];
  for (const raw of String(text ?? "").split(SPLIT)) {
    let s = pyStrip(raw);
    /* 行内のハッシュタグ塊を落とす(末尾のタグ列が引用に混じるのを防ぐ) */
    s = pyStrip(s.replace(TAIL_TAGS, ""));
    if (!s || NOISE.test(s) || cpLen(s) < minLen) continue;
    out.push(cpSlice(s, 0, maxLen));
  }
  return out;
}

/* 当たった文の数(重複文は1件)。表示上限とは独立に数える */
export function _count(patterns, pool) {
  const seen = new Set();
  for (const s of pool) {
    const n = norm(s);
    if (patterns.some(p => p.test(n))) seen.add(cpSlice(n, 0, 20));
  }
  return seen.size;
}

/* パターンに当たった**文そのもの**を返す。
 * 当たったパターン数と引用として読める長さ(15〜60字)で並べ替えてから返す。 */
export function _find(patterns, pool, limit = 3) {
  const scored = [], seen = new Set();
  pool.forEach((s, idx) => {
    const n = norm(s);
    const matched = patterns.reduce((acc, p) => acc + (p.test(n) ? 1 : 0), 0);
    if (!matched) return;
    const key = cpSlice(n, 0, 20);
    if (seen.has(key)) return;
    seen.add(key);
    const length = cpLen(s);
    /* 短すぎる断片・長すぎる説明文はどちらも引用に向かない */
    const fit = (15 <= length && length <= 60) ? 2 : ((8 <= length && length <= 80) ? 1 : 0);
    /* 「」つきの実況・読者の声はそのまま引用として強い */
    const quoted = /[「『][^」』]{4,}[」』]/.test(s) ? 1 : 0;
    scored.push([-(matched * 3 + fit * 2 + quoted), idx, s]);
  });
  scored.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  return scored.slice(0, limit).map(x => x[2]);
}

/* ---- 定性シグナルの定義 -------------------------------------------- */
/* 「当事者(証言者)」側のシグナル */
export const P_SELFDISCLOSE = [/\d{2}\s*歳/, /\d{3}\s*cm/, /アラサー|アラフォー|アラフィフ/,
  /\d\s*児|双子|年子|ワンオペ|共働き|産後|育休/,
  /看護師|保育士|会社員|OL|主婦|ワーママ|自営/];
export const P_STRUGGLE = [/(ボロボロ|崩れ|悩ん|コンプレックス|諦め|できなかった|苦手|下手|失敗|挫折)/,
  /(なんか|なんとなく).{0,12}(かも|気がする|違う|しっくり)/,
  /気になり出した|気になってきた|前と同じ.{0,8}(しっくり|合わ)/];
export const P_READER_VOICE = [/(ない|よね|かな|でしょ)\s*[?？]/, /ある\s*[?？]/, /全員集合/,
  /(みんな|あなた)は/, /教えて|コメントで|聞かせて/];
/* 「¥649」のように通貨記号が前に来る書き方も価格の明示として拾う(run#6実測:生活者の候補) */
export const P_PRICE = [/\d[\d,]{1,7}\s*円/, /[¥￥$]\s*\d/, /税込/, /プチプラ|ワンコイン|お財布に優しい|お安さ|コスパ/];
export const P_EMPATHY = [/(あなた|自分)の(せい|ため)じゃな/, /責めないで/, /無理(しなくて|してやらなくて)/,
  /私も(そう|同じ|イライラ|できな)/, /大丈夫だよ|一緒に/];
export const P_HUMBLE = [/(分からな|わからな|どうなんだろう|知らな)/, /ひよっこ|まだまだ|途中/,
  /普通に(食べ|する)|完璧じゃな/, /正直/];
export const P_LIFE_SCENE = [/(息子|娘|子ども|子供|家族|夫|旦那)/, /(朝|夜|休日|平日|夏休み|お迎え|通勤|寝不足)/,
  /vlog|日常|暮らし|ごはん|旅行/];

/* 「権威・営業」側のシグナル。**「予約」という語だけでは営業導線にならない**(§6-2 の2)。
   判定は「本人が予約・来店・申込を募っている文脈」に限る(勧誘の語とセットで見る)。 */
export const P_FUNNEL = [/ご?予約.{0,10}(はこちら|受付|お待ち|承|枠|リンク|DM|下さい|ください)/,
  /(ご新規|新規|翌月|来月).{0,6}予約/,
  /当店|当サロン|ご来店(ください|お待ち)|ご相談(下さい|ください)/,
  /詳細は.{0,8}リンク/, /お問い合わせ.{0,8}(ください|下さい|はDM|はこちら)/,
  /(体験|カウンセリング|無料相談).{0,10}(受付|募集|申込|お申し込み|はこちら)/,
  /(モデル|生徒|スタッフ|受講生).{0,6}募集/, /受付中|残\s*\d+\s*(名|枠)/];
export const P_AUTHORITY = [/代表|オーナー|院長|講師|主宰|塾/, /(サロン|スクール|アカデミー|クリニック|会社)経営/,
  /化粧品開発|プロデュース/, /検定\s*(特級|\d\s*級)|資格/];
export const P_SAVE_CTA = [/「?保存」?(して|してね|しておく)/, /あとで見返せる/, /フォロー(して|お願い)/];
export const P_PR_LABEL = [/#\s*PR\b/, /#\s*ad\b/, /#\s*提供/, /タイアップ/, /提供いただ/, /いただきもの/];

/* bio + キャプションから定性シグナルを引用つきで抽出する */
export function extract(record, captions, prPosts) {
  const caps = captions != null ? captions : (record._captions || []);
  const bioPool = sentences(record.bio_text, 4).concat(sentences(record.full_name, 4));
  const capPool = [];
  caps.forEach(c => sentences(c).forEach(s => capPool.push(s)));
  const both = bioPool.concat(capPool);

  const spec = {
    "自己開示": [P_SELFDISCLOSE, both],
    "当事者の悩み": [P_STRUGGLE, both],
    "読者への呼びかけ": [P_READER_VOICE, capPool],
    "価格の明示": [P_PRICE, capPool],
    "自己否定の解除": [P_EMPATHY, capPool],
    "完璧を演じない": [P_HUMBLE, both],
    "生活の場面": [P_LIFE_SCENE, capPool],
    "営業導線": [P_FUNNEL, both],
    "権威の提示": [P_AUTHORITY, both],
    "保存・フォロー誘導": [P_SAVE_CTA, capPool]
  };
  const quotes = {}, counts = {};
  for (const [k, [p, pool]] of Object.entries(spec)) quotes[k] = _find(p, pool);
  /* **件数は表示上限(3件)と切り離して数える。**
     上限で打ち切った数を stance に使うと権威型が「判定保留」に落ちる(run#6実測:権威型の候補) */
  for (const [k, [p, pool]] of Object.entries(spec)) counts[k] = _count(p, pool);

  /* PR表記のある投稿数。**`#PR` はキャプション末尾に付くため切り詰めたテキストからは拾えない。**
     ブラウザ側(__PROF)が全文で判定した件数(prl)を渡せるなら必ずそれを使う。 */
  let pr = prPosts;
  if (pr == null) {
    pr = caps.filter(c => P_PR_LABEL.some(p => p.test(norm(c)))).length;
    counts["PR判定の出所"] = "切り詰め後のテキスト(過小の可能性)";
  } else {
    counts["PR判定の出所"] = "全文(ブラウザ側判定)";
  }
  counts["PR表記のある投稿"] = pr;
  counts["判定に使ったキャプション数"] = caps.length;
  /* Python の round は半数偶数丸め(28.5→28)。Math.round では 29 になり平均字数がずれる */
  const avg = caps.length ? pyRound(caps.reduce((a, c) => a + cpLen(c), 0) / caps.length, 0) : 0;
  counts["キャプション平均文字数"] = avg;
  counts["定性列の信頼性"] = avg >= 100 ? "十分"
    : `低い(平均${avg}字。__PROFのキャプション上限を140字以上にすること)`;

  /* ---- 語りの向き(stance)の一次判定。**最終判断は人** ---- */
  const witness = counts["自己開示"] + counts["当事者の悩み"] + counts["価格の明示"]
    + counts["自己否定の解除"] + counts["完璧を演じない"] + counts["生活の場面"];
  const authority = counts["営業導線"] * 2 + counts["権威の提示"];
  const why = [];
  const ex = key => (quotes[key].length ? quotes[key][0] : "(引用なし)");
  if (counts["営業導線"]) why.push(`営業導線の文が${counts["営業導線"]}件(例:「${ex("営業導線")}」)`);
  if (counts["権威の提示"]) why.push(`権威の提示が${counts["権威の提示"]}件(例:「${ex("権威の提示")}」)`);
  if (counts["自己開示"]) why.push(`自己開示「${ex("自己開示")}」`);
  if (counts["当事者の悩み"]) why.push(`当事者の悩み「${ex("当事者の悩み")}」`);
  if (caps.length && pr) why.push(`PR表記 ${pr}/${caps.length}本`);

  /* **営業導線は当事者性で相殺されない。** 導線の有無を先に見る(スコア比較は最後の手段) */
  const funnel = counts["営業導線"], auth = counts["権威の提示"];
  let stance;
  if (funnel >= 2 && auth >= 1) {
    stance = "権威型(語りの終着点が自社導線・裏書き/監修向き。証言枠には向かない)";
  } else if (funnel >= 1 || auth >= 2) {
    if (witness >= 6) stance = "混在型(当事者の語りと自社導線が同居。役割を分けて判断すること)";
    else stance = "権威型寄り(導線・権威の提示があり当事者性の引用が乏しい)";
  } else if (witness >= 4) {
    stance = "当事者型(証言者向き)";
  } else if (witness === 0 && caps.length) {
    stance = "カタログ型(生活・当事者性の引用が1件も拾えない)";
  } else {
    stance = "判定保留(引用が少ない。精査で全文を読むこと)";
  }

  return { quotes, counts, stance, stance_why: why, witness_score: witness, authority_score: authority };
}

/* CSVの1セルに収める「声の特徴」。引用を必ず1つ以上入れる */
export function voiceLine(result) {
  const q = result.quotes;
  const bits = [];
  for (const key of ["当事者の悩み", "自己開示", "自己否定の解除", "読者への呼びかけ",
    "完璧を演じない", "生活の場面", "営業導線", "権威の提示"]) {
    if (q[key].length) bits.push(`${key}「${q[key][0]}」`);
    if (bits.length >= 3) break;
  }
  if (result.counts["価格の明示"]) bits.push(`価格明示${result.counts["価格の明示"]}件`);
  return bits.length ? bits.join(" / ") : "引用を拾えず(キャプションが短すぎる可能性・要精査)";
}

/* 根拠引用を | 区切りで返す(人が読む列) */
export function evidenceCell(result, limit = 4) {
  const out = [];
  for (const [key, quotes] of Object.entries(result.quotes)) {
    for (const s of quotes) {
      out.push(`[${key}]${s}`);
      if (out.length >= limit) return out.join(" | ");
    }
  }
  return out.join(" | ");
}
