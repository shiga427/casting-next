/* 一次適合コメントの自動生成(設計書§6-1)。移植元:igfinder/fitcomment.py(v2.6/v2.7)。
 *
 * 語彙は管制室 v1.4 の既定設定(kwLife / kwBiz / kwAmb / bizDomains / kwAge / kwWin ほか)と
 * 同一に保つこと。ツール側とパイプライン側でシグナル判定がずれると、
 * 「CSVでは生活者なのに画面では業者」という不整合が起きる。
 *
 * 移植上の注意:Python の f-string は float を "5.0" と出す。JS の String(5) は "5" になるため
 * 指標値の埋め込みは pf()(整数値の float を .0 付きで出す)を通す。文言を一致させるため。
 */
import * as Q from "./qualsignals.js";

/* --- 管制室 v1.4 の既定値と一致させる(§4-1・§4-1d) --- */
export const KW_LIFE = ["ママ", "子育て", "育児", "主婦", "ワーママ", "OL", "会社員", "看護師", "保育士",
  "暮らし", "日常", "等身大", "ずぼら", "双子", "ワンオペ", "家事", "共働き",
  "アラサー", "アラフォー", "自分時間"];
export const KW_BIZ = ["所属クリエイター", "事務所", "案件募集", "案件はDM", "お仕事依頼", "お仕事のご依頼",
  "ご依頼はDM", "PR実績", "タイアップ実績", "サロン", "店舗", "ご予約",
  "セレクトショップ", "運営", "代理店"];
export const KW_AMB = ["アンバサダー", "専属", "公認"];
export const BIZ_DOMAINS = ["lin.ee", "line.me", "hotpepper", "reserva", "coubic", "shopify",
  "thebase.in", "base.shop", "stores.jp"];
export const KW_AGE = ["20代", "30代", "40代", "50代", "アラサー", "アラフォー"];
export const KW_WIN = ["当選", "モニター", "懸賞"];
export const KW_INGREDIENT = ["成分", "ナイアシンアミド", "レチノール", "ヒト幹細胞", "幹細胞培養液",
  "ビタミンC", "セラミド", "ペプチド"];
export const KW_REVIEW = ["購入品", "レポ", "正直", "レビュー", "使い切り", "スウォッチ", "比較"];

export const GATE_FOLLOW = 3000;
export const GATE_FF = 2.0;
export const GRAY_FF_MAX = 3.5;   /* §4-1b 灰色帯 2.0〜3.5 */

/* NFKC正規化(判断27と同じ前置き)。装飾文字での取りこぼしを防ぐ */
function _norm(text) {
  try { return String(text ?? "").normalize("NFKC").toLowerCase(); } catch (e) { return String(text ?? "").toLowerCase(); }
}
function _hits(text, words) { return words.filter(w => text.includes(_norm(w))); }
/* Python の f-string と同じ見え方(float の 5 は "5.0") */
function pf(v) { return (typeof v === "number" && Number.isInteger(v)) ? v.toFixed(1) : String(v); }
/* Python 側で int になる平均値は "4"、float なら "4.0"(ingest が _pyInt で判定済み) */
function pfField(record, field) {
  const v = record[field];
  if (v == null) return "";
  return (record._pyInt && record._pyInt[field]) ? String(v) : pf(v);
}
function comma(v) { return typeof v === "number" ? v.toLocaleString("en-US") : String(v); }

/* §4-1d 業者/他社契約/生活者シグナル。スコアとは別軸の表示用。
 * 自動見送りには使わない(判断は人間)。理由を必ず併記できるよう語を返す。 */
export function signals(record) {
  const text = _norm((record.bio_text || "") + " " + (record.full_name || ""));
  const url = _norm(record.external_url);
  const biz = _hits(text, KW_BIZ).concat(BIZ_DOMAINS.filter(d => url.includes(d)));
  const amb = _hits(text, KW_AMB);
  const life = _hits(text, KW_LIFE);
  return { biz, amb, life: biz.length ? life : life };
}

function _tier(record) { return (record.followers || 0) >= 30000 ? "ミドル" : "マイクロ"; }

/* ①何をしている人か */
function _who(record, sig) {
  const followers = record.followers;
  const genre = record.genre || "不明";
  const life = sig.life.slice(0, 3).join("・");
  const base = followers ? `フォロワー${comma(followers)}の${_tier(record)}層(${genre}系)` : `${genre}系`;
  if (life) return `${base}で、bioに「${life}」と自己開示している生活発信者。`;
  return `${base}。bioに生活属性の自己開示はなく、発信の主語は精査で確認が必要。`;
}

/* ②どこが強いか — 生活者としての信頼の根拠(§4-5 v2.6) */
function _strength(record, sig) {
  const parts = [];
  const er = record.engagement_rate;
  const comments = record.avg_comments;
  if (comments != null) parts.push(`直近12投稿の平均コメント${pfField(record, "avg_comments")}件`);
  if (er != null) parts.push(`ER${pf(er)}%`);
  else if (record.comment_rate != null) parts.push(`いいね非表示のためコメント率${pf(record.comment_rate)}%で代替評価`);
  const ff = record.ff_ratio;
  if (ff != null) parts.push(`FF比${pf(ff)}(フォロー${comma(record.following)})`);
  const body = parts.length ? parts.join("・") : "指標は精査で確認";
  if (sig.life.length) {
    return `${body}。読者と会話が成立している水準で、`
      + `「${sig.life.slice(0, 2).join("・")}」という生活の位置から語れるのが強み。`;
  }
  return `${body}。数値上の会話量は基準を超えている。`;
}

/* ③ステム戦略との接続(行列の証言者・抽選文化・LESS is MORE・週次リズム) */
function _strategy(record, sig) {
  const text = _norm(record.bio_text);
  if (_hits(text, KW_WIN).length) {
    return "抽選文化(#当選報告)の作法を既に持っており、"
      + "「当たった」を生活の事件として書ける=行列の証言者に直結する。";
  }
  if (sig.life.length) {
    return "普段の生活を主語に発信しているため、"
      + "「使い続けている」が広告でなく生活の中の出来事として読まれる(行列の証言者)。"
      + "週次リズムの連載にも耐える。";
  }
  if (_hits(text, KW_INGREDIENT).length) {
    return "成分理解があり、LESS is MORE(処方の絞り込み)の説明を任せられる。"
      + "ただし解説者枠であり、生活者の証言とは別の役割。";
  }
  return "美容の購買文脈は書けるため都度枠の証言者候補。"
    + "連載枠に上げるかは生活文脈の有無を精査で確認してから。";
}

/* ④懸念(必ず1つ)。優先度の高い順に1つだけ返す */
function _concern(record, sig) {
  if (sig.biz.length) {
    return `懸念:業者シグナル(${sig.biz.slice(0, 3).join("・")})。`
      + "DM前に所属・契約形態(事務所経由/直接)の確認が必須(付録B)。";
  }
  if (sig.amb.length) {
    return `懸念:他社契約シグナル(${sig.amb.slice(0, 2).join("・")})。`
      + "競合(ヒト幹細胞系)の現行アンバサダー契約の排他確認が最優先。";
  }
  const ff = record.ff_ratio;
  if (ff != null && ff < GRAY_FF_MAX) {
    return `懸念:FF比${pf(ff)}は灰色帯(2.0〜3.5)。`
      + "コメント欄の相互率を精査で確認し、相互フォロー網の会話でないことを見る。";
  }
  if (!sig.life.length) {
    return "懸念:bioに生活属性の自己開示がなく、カタログ型レビュアーの可能性がある。"
      + "精査で生活文脈投稿を8本中2本以上あるか数える(§4-2b)。";
  }
  const openRate = record.comment_open_rate;
  if (openRate != null && openRate < 0.7) {
    return `懸念:コメント開放率${pf(openRate)}。`
      + "平均コメントが閉鎖投稿を含む母数で下振れ/上振れしていないか精査で確認。";
  }
  if (record.is_verified) return "懸念:認証済みアカウントのため、個人か媒体かを§2-2の3値判定で目視確認する。";
  return "懸念:直近8投稿を未読のため、タイアップ比率(T1の50%ゲート)と"
    + "読者の質問+本人返信の実在(付録B)が未確認。";
}

/* 機械合格の理由(選定理由)。何が効いて上がってきたのかを1文で残す */
function _selectReason(record, sig) {
  const bits = [];
  const er = record.engagement_rate;
  if (er != null) bits.push(`ER${pf(er)}%`);
  if (record.avg_comments != null) bits.push(`平均コメント${pfField(record, "avg_comments")}件`);
  if (record.ff_ratio != null) bits.push(`FF比${pf(record.ff_ratio)}(純度ゲート通過)`);
  if (sig.life.length) bits.push(`生活語${sig.life.slice(0, 3).join("・")}`);
  if (record.genre) bits.push(`genre=${record.genre}`);
  const via = record.discovered_via || record.source;
  if (via) bits.push(`出自=${via}`);
  return "v4機械フィルタ通過:" + bits.join(" / ") + "。選抜はSBIS得点率と精査で行う。";
}

/* ②の「生活者としての信頼の根拠」を**本文の引用**で書く(v2.7) */
function _voice(record, qual) {
  const q = qual.quotes;
  const parts = [];
  if (q["当事者の悩み"].length) parts.push(`悩みを当事者の語順で書く(「${q["当事者の悩み"][0]}」)`);
  if (q["自己開示"].length) parts.push(`bio/本文で属性を自己開示(「${q["自己開示"][0]}」)`);
  if (q["自己否定の解除"].length) parts.push(`読者の自己否定を解除する言葉がある(「${q["自己否定の解除"][0]}」)`);
  if (q["完璧を演じない"].length) parts.push(`分からないことを分からないと書く(「${q["完璧を演じない"][0]}」)`);
  if (qual.counts["価格の明示"]) parts.push(`価格を明示して読者の財布の側に立つ(「${q["価格の明示"][0]}」)`);
  if (q["生活の場面"].length) parts.push(`生活の場面が画面に載る(「${q["生活の場面"][0]}」)`);
  if (!parts.length) {
    return "本文から定性の引用を拾えなかった(キャプションが短い/カタログ型の可能性)。"
      + "精査で全文を読むこと。";
  }
  return "声の特徴:" + parts.slice(0, 3).join(" / ") + "。";
}

/* 語りの向き。権威型なら「証言にならない」構造を先に出す */
function _stanceNote(qual) {
  const q = qual.quotes;
  if (q["営業導線"].length || q["権威の提示"].length) {
    const cite = (q["営業導線"].length ? q["営業導線"] : q["権威の提示"])[0];
    return `語りの向き:${qual.stance}。本文に「${cite}」があり、`
      + "第三者の体験談として読まれるかを人が確認する必要がある。";
  }
  return `語りの向き:${qual.stance}。`;
}

/* 1件分の select_reason / fit_comment / fit_concern + 定性列を作る */
export function build(record, captions, prPosts) {
  const sig = signals(record);
  const qual = Q.extract(record, captions, prPosts);
  const concern = _concern(record, sig);
  const comment = [
    _who(record, sig),
    _voice(record, qual),
    _strength(record, sig),
    _stanceNote(qual),
    _strategy(record, sig),
    concern
  ].join(" ");
  return {
    select_reason: _selectReason(record, sig) + " 定性:" + Q.voiceLine(qual),
    fit_comment: comment,
    fit_concern: concern,
    biz_signal: sig.biz.join("・"),
    other_brand_signal: sig.amb.join("・"),
    life_signal: sig.life.join("・"),
    /* v2.7 定性列(人が読む列) */
    qual_stance: qual.stance,
    qual_voice: Q.voiceLine(qual),
    qual_evidence: Q.evidenceCell(qual),
    qual_pr_posts: `${qual.counts["PR表記のある投稿"]}/${qual.counts["判定に使ったキャプション数"]}`,
    qual_caption_len: qual.counts["キャプション平均文字数"],
    qual_reliability: qual.counts["定性列の信頼性"]
  };
}
