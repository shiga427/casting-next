/* 匿名化fixtureの生成(設計書§11-2)。
 *
 *   node tools/build_fixtures.mjs [--ref ../reference]
 *
 * 入力(コミットしない):
 *   reference/成果物_run6/{all,rejected}_run6.csv, summary_run6.json
 * 出力(コミットする。すべて匿名化済み):
 *   tests/fixtures/run6_compact.jsonl      収集結果 .jsonl 相当(100件)
 *   tests/fixtures/v3_export_sample.json   管制室 v1.4 の v3書き出し相当(100件)
 *   tests/fixtures/legacy_v11_sample.json  v1.1形式(旧s2・旧チェック・convFloor)の移行テスト用
 *
 * 匿名化の方針(設計書§11-2「ハンドル置換+数値摂動」):
 *   ・username / full_name / account_url / URL / @メンション は差し替える
 *   ・full_name と bio に含まれていた**判定辞書の語だけ**は残す(生活語・業者語・他社契約語)。
 *     語を落とすとシグナル内訳が変わり、run#6 の実績値と突合できなくなるため。
 *   ・数値は ±0.5% の決定的な摂動。**判定を1件も跨がないこと**を検証し、跨ぐ行は摂動しない。
 *   ・キャプションは記録された引用(qual_evidence / qual_voice)からの復元。
 *     run#6 の生 JSONL はキットに含まれないため、引用として記録された文しか復元できない。
 *
 * さらに、匿名化で失われる派生値(genre / language)が run#6 の判定と食い違わないよう、
 * 「記録された落ち理由コードに一致するまで語彙を補う」調整を行う(tuneToRecordedVerdict)。
 * 調整の残差は最後に必ず表示する(黙って合わせない)。
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv, toNum, toBool, stripLoneSurrogates } from "../js/pipeline/util.js";
import { makeHandleMap, anonText, anonDomain, jitter, mulberry32 } from "./anonymize.mjs";
import { DEFAULT_CONF } from "../js/pipeline/conf.js";
import { evaluate } from "../js/pipeline/filters.js";
import { classifyGenre, GENRE_KEYWORDS } from "../js/pipeline/genres.js";
import { detectLanguage } from "../js/pipeline/language.js";
import { KW_LIFE, KW_BIZ, KW_AMB, KW_AGE, KW_WIN, KW_INGREDIENT, KW_REVIEW, signals } from "../js/pipeline/fitcomment.js";
import { to_record } from "../js/pipeline/ingest.js";
import * as QS from "../js/pipeline/qualsignals.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const argRef = process.argv.indexOf("--ref");
const REF = argRef > 0 ? process.argv[argRef + 1] : join(ROOT, "..", "reference");
const OUT = join(ROOT, "tests", "fixtures");
mkdirSync(OUT, { recursive: true });

function readCsvObjects(path) {
  const rows = parseCsv(readFileSync(path, "utf8"));
  const head = rows[0].map(h => h.trim());
  return rows.slice(1).filter(r => r.length > 1).map(r => {
    const o = {}; head.forEach((h, i) => { o[h] = r[i] ?? ""; }); return o;
  });
}

const all = readCsvObjects(join(REF, "成果物_run6", "all_run6.csv"));
const rejected = readCsvObjects(join(REF, "成果物_run6", "rejected_run6.csv"));
const summary = JSON.parse(readFileSync(join(REF, "成果物_run6", "summary_run6.json"), "utf8"));
const rejByUser = new Map(rejected.map(r => [r.username.replace(/^@/, ""), r]));
const reviewNeeded = summary["review_needed(verified×カテゴリnull)"] || [];

const handles = all.map(r => r.username.replace(/^@/, ""));
const map = makeHandleMap(handles);
const rnd = mulberry32(20260730);

/* ---- 記録された落ち理由メッセージ → 理由コード ------------------------- */
const MSG_TO_CODE = [
  [/^非公開アカウント/, "private"],
  [/^認証済みアカウント/, "verified"],
  [/^フォロワー .* < 下限/, "followers_too_low"],
  [/^フォロワー .* > 上限/, "followers_too_high"],
  [/^プロフィールに外部リンクなし/, "no_external_link"],
  [/^平均コメント .* < 下限/, "avg_comments_too_low"],
  [/^平均いいね .* < 下限/, "avg_likes_too_low"],
  [/^ER .* < 下限/, "engagement_too_low"],
  [/^ER .* > 上限/, "engagement_too_high"],
  [/^ER不明.*コメント率/, "comment_rate_below_min"],
  [/^推定ジャンル .* 許可リスト/, "genre_not_allowed"],
  [/^除外ジャンルに該当/, "genre_excluded"],
  [/^言語 .* が指定/, "language_mismatch"],
  [/^純度ハードゲート:フォロー/, "following_too_high"],
  [/^純度ハードゲート:FF比/, "ff_ratio_too_low"],
  [/平均コメント数が算出できず/, "unknown_avg_comments"],
  [/平均いいね数が算出できず/, "unknown_avg_likes"],
  [/エンゲージメント率が算出できず/, "unknown_engagement_rate"],
  [/言語を判定できず/, "unknown_language"],
  [/フォロー数が取得できず/, "unknown_following"],
  [/FF比が算出できず/, "unknown_ff_ratio"],
  [/フォロワー数が取得できず/, "unknown_followers"],
  [/非公開かどうか不明/, "unknown_is_private"],
  [/認証済みかどうか不明/, "unknown_is_verified"],
];
function codesFromDetail(detail) {
  return String(detail || "").split(" / ").map(s => s.trim()).filter(Boolean).map(msg => {
    const hit = MSG_TO_CODE.find(([re]) => re.test(msg));
    if (!hit) throw new Error("未知の落ち理由メッセージ: " + msg);
    return hit[1];
  });
}

/* ---- 1件を匿名化した「素の指標レコード」にする -------------------------- */
const DICT = [...new Set([...KW_LIFE, ...KW_BIZ, ...KW_AMB, ...KW_AGE, ...KW_WIN, ...KW_INGREDIENT, ...KW_REVIEW])];

function keepVocabulary(originalText, anonymized) {
  /* 匿名化で消えた判定辞書の語を拾い直す(シグナル・④文脈適合の再現に必要) */
  const src = String(originalText || "").toLowerCase();
  const dst = String(anonymized || "").toLowerCase();
  const lost = DICT.filter(w => src.includes(w.toLowerCase()) && !dst.includes(w.toLowerCase()));
  return lost;
}

function baseRecord(row) {
  const u = row.username.replace(/^@/, "");
  const a = map.get(u);
  const anonBio = stripLoneSurrogates(anonText(row.bio, u, a.full_name, [row.full_name]));
  /* full_name は差し替えるが、判定辞書の語(サロン・ママ・アンバサダー等)だけ残す */
  const nameVocab = keepVocabulary(row.full_name, "");
  const bioVocab = keepVocabulary(row.bio, anonBio);
  return {
    orig: u,
    _origName: row.full_name,
    username: a.username,
    full_name: (a.full_name + (nameVocab.length ? "｜" + nameVocab.join("・") : "")),
    account_url: `https://www.instagram.com/${a.username}/`,
    followers: toNum(row.followers),
    following: toNum(row.following),
    avg_likes: toNum(row.avg_likes),
    avg_comments: toNum(row.avg_comments),
    engagement_rate: toNum(row.engagement_rate),
    genre: row.genre || null,
    has_external_link: toBool(row.has_external_link),
    external_url: anonDomain(row.external_url),
    bio_text: anonBio + (bioVocab.length ? " " + bioVocab.join(" ") : ""),
    matched_keywords: row.matched_keywords || "",
    discovered_via: row.discovered_via || "",
    scraped_at: "2026-07-30T00:00:00+00:00",
    qual_evidence: row.qual_evidence || "",
    qual_voice: row.qual_voice || "",
    qual_stance: row.qual_stance || "",
    qual_pr_posts: row.qual_pr_posts || "",
    qual_caption_len: toNum(row.qual_caption_len),
    is_verified: reviewNeeded.includes(u), ig_category: null,
    /* 非公開・認証済みは CSV に列が無いので、記録された落ち理由と summary から復元する */
    is_private: rejByUser.has(u) ? codesFromDetail(rejByUser.get(u).reject_detail).includes("private") : false,
    targetCodes: rejByUser.has(u) ? codesFromDetail(rejByUser.get(u).reject_detail) : [],
  };
}

/* ingest_compact.to_record と同じ丸めで派生値を作り直す(摂動後の整合を保つ) */
function derive(rec) {
  const f = rec.followers;
  rec.ff_ratio = (f && rec.following != null) ? Math.round(f / Math.max(rec.following, 1) * 100) / 100 : null;
  rec.engagement_rate = (rec.avg_likes != null && f)
    ? Math.round((rec.avg_likes + (rec.avg_comments || 0)) / f * 100 * 100) / 100 : null;
  rec.comment_rate = (rec.avg_comments != null && f)
    ? Math.round(rec.avg_comments / f * 100 * 1000) / 1000 : null;
  return rec;
}

/* ---- キャプションの復元(定性シグナル用) ------------------------------- */
/* 精査で全文を持ち帰った2名(定性評価の回帰対象)は実際のキャプションを使う。
 * run#6 の取得設定と同じ **60字で切り詰める**(__CAP=60)。それ以外の98名は
 * 記録された引用しか残っていないため、引用文だけを復元する。 */
/* 全文キャプションを持つ精査ファイルは reference/成果物_run6/*_captions.txt。
 * **実在ハンドルをこのソースに書かない**ため、ファイル先頭の `# handle=` から実行時に対応表を作る。 */
const RUN6_CAP = 60;
const CAPTION_FILES = (() => {
  const map = new Map();
  let files = [];
  try { files = readdirSync(join(REF, "成果物_run6")).filter(f => /_captions\.txt$/.test(f)); } catch (e) { return map; }
  files.forEach(f => {
    try {
      const head = readFileSync(join(REF, "成果物_run6", f), "utf8").slice(0, 400);
      const m = head.match(/#\s*handle=([^\s]+)/);
      if (m) map.set(m[1], f);
    } catch (e) { }
  });
  return map;
})();
function loadRealCaptions(orig) {
  const file = CAPTION_FILES.get(orig);
  if (!file) return null;
  let text;
  try { text = readFileSync(join(REF, "成果物_run6", file), "utf8"); } catch (e) { return null; }
  const blocks = text.split(/^---$/m);
  const caps = [];
  blocks.forEach(b => {
    const lines = b.split("\n").filter(l => !/^\s*#/.test(l) && !/^\[\d+\]\s/.test(l) && !/^code=/.test(l));
    const cap = lines.join("\n").trim();
    if (cap) caps.push(cap);
  });
  return caps.slice(0, 12);
}

function restoreCaptions(rec) {
  const real = loadRealCaptions(rec.orig);
  if (real) {
    return real.map(c => {
      const anon = stripLoneSurrogates(anonText(c, rec.orig, "", [rec._origName]));
      return { cap: Array.from(anon).slice(0, RUN6_CAP).join(""), capl: Array.from(anon).length };
    });
  }
  const caps = [];
  /* 記録された引用は bio 由来のものも混じっている(自己開示・営業導線・権威の提示は
     bio+キャプションの両方を見るため)。bio に既にある文をキャプションにも入れると
     同じ文が2回数えられ、語りの向きが実際より権威側に寄る。bio 由来は除く。 */
  const bioLower = String(rec.bio_text || "").toLowerCase();
  const fromBio = s => {
    const head = Array.from(String(s)).slice(0, 12).join("").toLowerCase();
    return head.length >= 4 && bioLower.includes(head);
  };
  const push = s => {
    const t = String(s || "").trim();
    if (t && !caps.includes(t) && !fromBio(t)) caps.push(t);
  };
  (rec.qual_evidence || "").split("|").forEach(part => {
    const m = part.trim().match(/^\[[^\]]+\](.*)$/);
    if (m) push(anonText(m[1], rec.orig, "", [rec._origName]));
  });
  (rec.qual_voice || "").split(" / ").forEach(part => {
    const m = part.match(/[「『]([^」』]+)[」』]/);
    if (m) push(anonText(m[1], rec.orig, "", [rec._origName]));
  });
  return caps.map(stripLoneSurrogates).filter(Boolean)
    .map(c => ({ cap: c, capl: rec.qual_caption_len != null ? rec.qual_caption_len : Array.from(c).length }));
}

/* ---- ジョブ定義(ingest_compact.py 冒頭の定数と一致) -------------------- */
const PURITY = { following_max: 3000, ff_ratio_min: 2.0 };
const MICRO = { followers_min: 5000, followers_max: 30000, engagement_rate_min: 2.0, avg_comments_min: 3, comment_rate_min: 0.10 };
const MIDDLE = { followers_min: 30000, followers_max: 100000, engagement_rate_min: 1.5, avg_comments_min: 5, comment_rate_min: 0.05 };
const COMMON = { genre_exclude: ["reseller", "bot", "adult", "gambling", "finance"], language: ["ja"], exclude_private: true, unknown_policy: "exclude" };
const filtersFor = rec => ({ ...((rec.followers || 0) >= 30000 ? MIDDLE : MICRO), ...PURITY, ...COMMON });
const codesOf = rec => evaluate(rec, filtersFor(rec)).reasons.map(r => r.code);

/* ---- 数値摂動(判定を跨いだら戻す) ----------------------------------- */
let reverted = 0;
const records = all.map(row => {
  const plain = derive(baseRecord(row));
  const before = codesOf(plain).join(",");
  const j = { ...plain };
  j.followers = jitter(plain.followers, rnd, 0.005, 0);
  j.following = plain.following == null ? null : jitter(plain.following, rnd, 0.005, 0);
  j.avg_likes = plain.avg_likes == null ? null : jitter(plain.avg_likes, rnd, 0.005, 1);
  j.avg_comments = plain.avg_comments == null ? null : jitter(plain.avg_comments, rnd, 0.005, 1);
  derive(j);
  if (codesOf(j).join(",") !== before) { reverted++; return plain; }
  return j;
});
console.log(`数値摂動: ${records.length - reverted}件に適用 / ${reverted}件は判定を跨ぐため摂動なし`);

/* ---- compact レコード(.jsonl 1行)への変換 ---------------------------- */
function toCompact(rec) {
  const caps = rec._caps || restoreCaptions(rec);
  const prPosts = Number(String(rec.qual_pr_posts || "0/0").split("/")[0]) || 0;
  const likesHidden = rec.avg_likes == null;
  const commentsUnknown = rec.avg_comments == null;
  const posts = [];
  for (let i = 0; i < 12; i++) {
    /* avg_comments が不明(=開放投稿3件未満)だった行は、コメント閉鎖を10件にして再現する */
    const cd = commentsUnknown ? i < 10 : false;
    const slot = caps.length ? caps[i % caps.length] : { cap: "", capl: 0 };
    posts.push({
      cap: slot.cap,
      capl: slot.capl,
      prl: i < prPosts,
      l: likesHidden ? null : rec.avg_likes,
      c: commentsUnknown ? (cd ? null : 0) : rec.avg_comments,
      lv: likesHidden, cd: cd,
      t: 1785000000 - i * 86400, mt: 1, pp: false
    });
  }
  return {
    h: rec.username, src: rec.discovered_via, tags: rec.matched_keywords, media: "v1_feed",
    u: {
      un: rec.username, fn: rec.full_name, bio: rec.bio_text,
      f: rec.followers, fg: rec.following, mc: 500,
      ext: rec.external_url, priv: !!rec.is_private, ver: !!rec.is_verified, cat: rec.ig_category
    },
    p: posts
  };
}

/* ---- 記録された判定に一致するまで語彙を補う ---------------------------- */
/* 匿名化で bio / キャプションが変わると genre と language が変わる。
 * 変えてよいのは「語彙」だけで、判定(=落ち理由コードの集合)は run#6 の記録と一致させる。 */
const LANG_FILLER = {
  en: " daily notes about skincare routine and simple makeup for everyone",
  ko: " 스킨케어 기록과 데일리 메이크업 이야기를 남깁니다",
  zh: " 护肤记录与日常彩妆分享笔记",
  th: " บันทึกการดูแลผิวและแต่งหน้าประจำวัน",
  ru: " записки об уходе за кожей и повседневном макияже",
  ar: " ملاحظات عن العناية بالبشرة والمكياج اليومي",
};
const STRIP_KANA = /[぀-ヿｦ-ﾝ]/g;

function tuneToRecordedVerdict(rec) {
  const want = rec.targetCodes;
  const wantLangMismatch = want.includes("language_mismatch");
  const wantUnknownLang = want.includes("unknown_language");
  const wantExcluded = (() => {
    const rej = rejByUser.get(rec.orig);
    if (!rej) return [];
    const m = String(rej.reject_detail || "").match(/除外ジャンルに該当:\s*\[([^\]]*)\]/);
    return m ? m[1].split(",").map(s => s.trim().replace(/^'|'$/g, "")).filter(Boolean) : [];
  })();
  const langFromDetail = (() => {
    const rej = rejByUser.get(rec.orig);
    if (!rej) return null;
    const m = String(rej.reject_detail || "").match(/言語\s*([A-Za-z]+)\s*が指定/);
    return m ? m[1] : null;
  })();
  rec._caps = restoreCaptions(rec);

  /* 1) 言語 */
  const targetLang = wantUnknownLang ? null : (wantLangMismatch ? langFromDetail : "ja");
  const langText = () => {
    const r = to_record(toCompact(rec));
    return r.language;
  };
  if (targetLang !== "ja") {
    /* 日本語の引用が混ざると必ず ja になるので、非日本語の行はキャプションを持たせない */
    rec._caps = [];
    rec.bio_text = rec.bio_text.replace(STRIP_KANA, "");
    if (targetLang && LANG_FILLER[targetLang] && langText() !== targetLang) rec.bio_text += LANG_FILLER[targetLang];
    if (targetLang === null) {
      /* 「言語を判定できず」= 文字が2つ未満。記号だけの bio にする */
      rec.bio_text = rec.bio_text.replace(/[\p{L}\p{N}]/gu, "").trim() || "✿";
    }
  } else if (langText() !== "ja") {
    rec.bio_text += " 毎日のスキンケアの記録です";
  }

  /* 2) 除外ジャンルの所属 */
  for (const g of wantExcluded) {
    const r = to_record(toCompact(rec));
    const found = new Set([...(r.genres || []), r.genre].filter(Boolean));
    if (found.has(g)) continue;
    const kw = GENRE_KEYWORDS[g].find(k => !rec.bio_text.toLowerCase().includes(k.toLowerCase()));
    if (kw) rec.bio_text += " " + kw;
  }
  /* 3) 記録に無い除外ジャンルが混ざっていたら、原因語を落とす */
  for (let pass = 0; pass < 5; pass++) {
    const r = to_record(toCompact(rec));
    const found = new Set([...(r.genres || []), r.genre].filter(Boolean));
    const extra = [...found].filter(g => COMMON.genre_exclude.includes(g) && !wantExcluded.includes(g));
    if (!extra.length) break;
    extra.forEach(g => GENRE_KEYWORDS[g].forEach(k => {
      const re = new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      rec.bio_text = rec.bio_text.replace(re, "");
      rec._caps = rec._caps.map(c => ({ ...c, cap: c.cap.replace(re, "") }));
    }));
  }
  return rec;
}

records.forEach(tuneToRecordedVerdict);

/* ---- 語りの向きの復元(記録された stance を満たす最小の補完) ------------
 * run#6 の生 JSONL がキットに無いため、キャプションは「記録された引用」しか復元できない。
 * 引用の表示上限は1カテゴリ3件・全体4件なので、**件数**は記録から復元できない
 * (例:生活の場面が5件あっても3件しか残っていない)。件数が足りずに stance が
 * 記録と食い違う行に限り、その行が実際に持っていたカテゴリの一般文を1文ずつ足して
 * 記録された stance に一致させる。足した内容は必ず run6_stance_notes.json に残す。
 * ★これはfixtureの復元であり、判定ロジックには一切手を入れていない。 */
const WITNESS_TEMPLATES = {
  "生活の場面": ["朝の支度のあいだに家族と少し話した", "休日の夜は子どもと過ごしている",
    "平日のお迎えのあとは寝不足だった", "夫と話しながら夏休みの予定を決めた"],
  "自己開示": ["40歳の会社員です", "30代のワーママをしています", "アラフォーの主婦です"],
};
const stanceNotes = [];
function completeStance(rec) {
  const recorded = rec.qual_stance || "";
  if (!recorded) return;
  const stanceNow = () => {
    const r = to_record(toCompact(rec));
    return QS.extract(r, r._captions, r._pr_posts);
  };
  let q = stanceNow();
  if (q.stance === recorded) return;
  /* 記録の頭(当事者型/判定保留/カタログ型…)が一致すればよい */
  const head = s => s.split("(")[0];
  const category = Object.keys(WITNESS_TEMPLATES).find(k => (rec._caps || []).some(c => QS._count(QS[k === "自己開示" ? "P_SELFDISCLOSE" : "P_LIFE_SCENE"], [c.cap]) > 0))
    || "生活の場面";
  const added = [];
  for (const t of WITNESS_TEMPLATES[category]) {
    if (head(q.stance) === head(recorded)) break;
    rec._caps = (rec._caps || []).concat([{ cap: t, capl: Array.from(t).length }]);
    added.push(t);
    q = stanceNow();
  }
  if (added.length) {
    stanceNotes.push({
      handle: rec.username, category, added,
      recorded: recorded, result: q.stance,
      why: "記録された引用の表示上限(1カテゴリ3件)で件数が復元できないため、同カテゴリの一般文を補完"
    });
  }
}
/* 機械合格の行だけ stance を数える(Python の stance_mix と同じ母集団) */
records.filter(r => r.targetCodes.length === 0).forEach(completeStance);

/* ---- 検証:記録された判定コードと一致しているか ------------------------ */
const diffs = [];
records.forEach(rec => {
  const r = to_record(toCompact(rec));
  const got = codesOf(r).slice().sort().join(",");
  const want = rec.targetCodes.slice().sort().join(",");
  if (got !== want) diffs.push({ handle: rec.username, want, got });
});
if (diffs.length) {
  console.log(`⚠ 記録された落ち理由と一致しない行 ${diffs.length}件:`);
  diffs.slice(0, 10).forEach(d => console.log(`   ${d.handle}  want=[${d.want}] got=[${d.got}]`));
} else {
  console.log("落ち理由コード:100件すべて run#6 の記録と一致");
}
/* シグナル内訳の一致も確認する */
const sigCount = { life: 0, amb: 0, biz: 0 };
records.forEach(rec => {
  const s = signals(to_record(toCompact(rec)));
  if (s.biz.length) sigCount.biz++;
  if (s.amb.length) sigCount.amb++;
  if (s.life.length && !s.biz.length) sigCount.life++;
});
const wantSig = summary["シグナル内訳(全取得)"];
console.log(`シグナル内訳: 生活者 ${sigCount.life}/${wantSig["生活者シグナル"]} 他社契約 ${sigCount.amb}/${wantSig["他社契約シグナル"]} 業者 ${sigCount.biz}/${wantSig["業者シグナル"]}`);

/* ---- 出力1:run6_compact.jsonl --------------------------------------- */
const jsonl = records.map(r => JSON.stringify(toCompact(r))).join("\n") + "\n";
writeFileSync(join(OUT, "run6_compact.jsonl"), jsonl, "utf8");

/* ---- 出力1b:samples/sample_run.jsonl(オンボーディングの体験用・30件) -- */
/* 「実データの前に成功体験を作る」(§9-1 の③)。匿名化済みの一部を同梱する。 */
mkdirSync(join(ROOT, "samples"), { recursive: true });
const sample = records.filter((_, i) => i % 3 === 0).slice(0, 30);
writeFileSync(join(ROOT, "samples", "sample_run.jsonl"),
  sample.map(r => JSON.stringify(toCompact(r))).join("\n") + "\n", "utf8");
console.log(`サンプル: samples/sample_run.jsonl(${sample.length}件・匿名化済み)`);

/* ---- 出力2:v3_export_sample.json(管制室 v1.4 の書き出し形式) ---------- */
const v3conf = {
  ver: "SBIS v2.2",
  microMin: 5000, microMax: 30000, midMin: 30000, midMax: 100000,
  convMid0: 0.004, convMidFull: 0.02, convMic0: 0.006, convMicFull: 0.03,
  erMid0: 2.0, erMidFull: 5.0, erMic0: 3.0, erMicFull: 8.0, cutoffConv: 5,
  crMid0: 0.05, crMidFull: 0.30, crMic0: 0.10, crMicFull: 0.60,
  purFollow1: 5000, purFollow2: 3000, purFfMin: 1, purCap: -15,
  growMin: 10000, growMax: 30000, growLift: 1.3, growEr: 6.0,
  kwIngredient: DEFAULT_CONF.kwIngredient, kwReview: DEFAULT_CONF.kwReview,
  kwAge: DEFAULT_CONF.kwAge, kwWin: DEFAULT_CONF.kwWin,
  kwPenaltyPr: DEFAULT_CONF.kwPenaltyPr, kwPenaltyDisc: DEFAULT_CONF.kwPenaltyDisc,
  ngWords: DEFAULT_CONF.ngWords, mannerWords: DEFAULT_CONF.mannerWords
};
const STATUS_CYCLE = ["候補", "候補", "精査済", "候補", "DM送付", "候補", "資料送付"];
const v3cands = records.map((r, i) => ({
  account_url: r.account_url, username: r.username, full_name: r.full_name,
  followers: r.followers, er: r.engagement_rate, avg_likes: r.avg_likes, avg_comments: r.avg_comments,
  following: r.following, genre: r.genre || "", has_external_link: r.has_external_link,
  external_url: r.external_url, bio: r.bio_text, matched_keywords: r.matched_keywords,
  discovered_via: r.discovered_via, scraped_at: r.scraped_at,
  status: STATUS_CYCLE[i % STATUS_CYCLE.length], notes: "", manual: false, manualWhy: "", slot: "",
  fitComment: i % 5 === 0 ? "自動生成の下書き。生活の場面が画面に載るタイプ。懸念:タイアップ比率が未確認。" : "",
  selectReason: "", fitConcern: "",
  checks: [true, false, false, false, false, false, false], checksVer: 2,
  s2: { t1: i % 9 === 0 ? "15" : "", t2: i % 11 === 0 ? "10" : "", t3: i % 13 === 0 ? "5" : "", t4: "", t5: i % 17 === 0 ? "5" : "" },
  s2ev: { t1: i % 9 === 0 ? "根拠メモ" : "", t2: i % 11 === 0 ? "根拠メモ" : "", t3: i % 13 === 0 ? "根拠メモ" : "", t4: "", t5: i % 17 === 0 ? "根拠メモ" : "" },
  s3: { save: i % 7 === 6 ? "5" : "" },
  aux: { t1Topic: i % 9 === 0 ? "6" : "", t1Tieup: i % 9 === 0 ? "5" : "", gPre: "", gPost: "", gWeekly: false },
  legacy_s2: null, scan: null, dmName: "", dmMention: "", captions: "",
  dmSentAt: STATUS_CYCLE[i % STATUS_CYCLE.length] === "DM送付" ? "2026-07-20" : "", remindAt: ""
}));
const v3 = {
  app: "stembeaute-casting", v: 3, savedAt: "2026-07-30T01:00:00.000Z", tool: "tool v1.4",
  conf: v3conf, cands: v3cands,
  rejected: rejected.slice(0, 30).map(row => {
    const u = row.username.replace(/^@/, "");
    const a = map.get(u) || { username: "sample_x", full_name: "サンプルX" };
    return {
      username: a.username, full_name: a.full_name, followers: toNum(row.followers),
      er: toNum(row.engagement_rate), avg_likes: toNum(row.avg_likes), avg_comments: toNum(row.avg_comments),
      following: toNum(row.following), bio: anonText(row.bio, u, a.full_name, [row.full_name]),
      has_external_link: toBool(row.has_external_link), reason: row.reject_reason,
      account_url: `https://www.instagram.com/${a.username}/`
    };
  }),
  confLog: [],
  coverage: [{ route: "E1", term: "#購入品紹介", collected: "120", fetched: "100", st: "完了" },
    { route: "E2", term: "購入品紹介", collected: "", fetched: "", st: "未実行" }],
  covMeta: { brand: "6", revived: "0", rate: "0" },
  govLog: [{ at: "2026-07-29T00:00:00.000Z", content: "美容言及 8本中2本以上を必須化", impact: "13件中?", state: "提案中" }]
};
writeFileSync(join(OUT, "v3_export_sample.json"), JSON.stringify(v3, null, 1), "utf8");

/* ---- 出力3:legacy_v11_sample.json(v1.1形式の移行テスト) --------------- */
const legacy = {
  app: "stembeaute-casting", v: 3, savedAt: "2026-07-01T00:00:00.000Z",
  conf: {
    ver: "SBIS v1.1", microMin: 5000, microMax: 30000, midMin: 30000, midMax: 100000,
    convFloor: 0.005, convFull: 0.03,
    erMid0: 2.0, erMidFull: 5.0, erMic0: 3.5, erMicFull: 8.0, cutoffConv: 5,
    kwIngredient: DEFAULT_CONF.kwIngredient, kwReview: DEFAULT_CONF.kwReview,
    kwAge: DEFAULT_CONF.kwAge, kwWin: DEFAULT_CONF.kwWin,
    kwPenaltyPr: DEFAULT_CONF.kwPenaltyPr, kwPenaltyDisc: DEFAULT_CONF.kwPenaltyDisc,
    ngWords: DEFAULT_CONF.ngWords, mannerWords: DEFAULT_CONF.mannerWords
  },
  cands: [
    {
      username: "legacy_001", account_url: "https://www.instagram.com/legacy_001/", full_name: "サンプル旧1",
      followers: 12000, er: 5.0, avg_likes: 500, avg_comments: 20, bio: "30代ママの記録。暮らしと美容の話",
      status: "精査済", checksVer: 1, checks: [true, true, false, true, false, false],
      s2: { s2yaku: "10", s2pr: "5", s2cont: "", s2world: "5", s2save: "" },
      s2ev: {}, s3: {}, aux: {}
    },
    {
      username: "legacy_002", account_url: "https://www.instagram.com/legacy_002/", full_name: "サンプル旧2",
      followers: 45000, er: 1.9, avg_likes: 800, avg_comments: 45, bio: "サロン運営。ご予約はDMから",
      status: "候補", checksVer: 2, checks: [true, false, false, false, false, false, false],
      s2: { t1: "10", t2: "", t3: "", t4: "", t5: "" }, s2ev: { t1: "根拠メモ" }, s3: { save: "" }, aux: {}
    }
  ],
  rejected: [], confLog: [], coverage: [], covMeta: {}, govLog: []
};
writeFileSync(join(OUT, "legacy_v11_sample.json"), JSON.stringify(legacy, null, 1), "utf8");

/* ---- 出力4:精査データ3ファイル(P6のテスト用・匿名化) --------------- */
/* qual_report.py と同じ入力形式のまま、ハンドル・表示名・コメント投稿者を差し替える。
 * 対象は全文キャプションが残っている1名だけ(コメント欄が本体なので comments がある方を選ぶ)。 */
(() => {
  const dir = join(REF, "成果物_run6");
  let files = [];
  try { files = readdirSync(dir); } catch (e) { return; }
  const capFiles = files.filter(f => /_captions\.txt$/.test(f));
  let chosen = null;
  for (const f of capFiles) {
    const base = f.replace(/_captions\.txt$/, "");
    if (files.includes(base + "_comments.txt")) { chosen = base; break; }
  }
  if (!chosen) return;
  const head = readFileSync(join(dir, chosen + "_captions.txt"), "utf8").slice(0, 400);
  const orig = (head.match(/#\s*handle=([^\s]+)/) || [])[1] || "";
  const anonHandle = "sample_qual";
  /* コメント投稿者(user=@xxx)は連番の匿名IDに置き換える */
  const readerMap = new Map();
  const anonReader = h => {
    if (!readerMap.has(h)) readerMap.set(h, "reader_" + String(readerMap.size + 1).padStart(3, "0"));
    return readerMap.get(h);
  };
  const scrub = text => stripLoneSurrogates(String(text)
    .replace(/user=@([^\s]+)/g, (_, h) => "user=@" + anonReader(h))
    .replace(/@([A-Za-z0-9._]{2,})/g, (_, h) => "@" + anonReader(h))
    .replace(/https?:\/\/[^\s]+/g, "https://example.com/x")
    .replaceAll(orig, anonHandle));
  ["captions", "comments", "profile"].forEach(kind => {
    const src = join(dir, `${chosen}_${kind}.txt`);
    try {
      writeFileSync(join(OUT, `${anonHandle}_${kind}.txt`), scrub(readFileSync(src, "utf8")), "utf8");
    } catch (e) { /* profile が無い場合はスキップ */ }
  });
  console.log(`精査fixture: ${anonHandle}_{captions,comments,profile}.txt(読者 ${readerMap.size}名を匿名化)`);
})();

writeFileSync(join(OUT, "run6_stance_notes.json"), JSON.stringify(stanceNotes, null, 1), "utf8");
console.log("stance補完:", stanceNotes.length + "件", stanceNotes.map(n => n.handle + "(" + n.category + "×" + n.added.length + ")").join(" "));
console.log("書き出し:", ["run6_compact.jsonl", "v3_export_sample.json", "legacy_v11_sample.json"].join(" / "));
