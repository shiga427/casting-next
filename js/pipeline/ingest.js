/* 収集結果(.jsonl)→ 指標レコード → v4フィルタ → run サマリ(設計書§6-1・§4-3)。
 * 移植元:ingest_compact.py。
 *
 * 守っていること:
 *  - to_record のキー(h/u/p/cap/capl/prl/l/c/lv/cd/fg…)は prof_compact.js と1対1のまま変えない
 *  - いいね非表示は null(0扱いしない)/ 開放投稿3件未満で avg_comments 不明
 *  - ER・コメント率・FF比の丸め桁は Python と同一(round は半数偶数丸めまで合わせる)
 *  - 落ちた候補の理由は全件残す。隔離も review_needed も「黙って捨てない」
 */
import { classifyGenre } from "./genres.js";
import { detectLanguage } from "./language.js";
import { evaluate } from "./filters.js";
import { signals, build as buildFitComment } from "./fitcomment.js";
import { stripLoneSurrogates } from "./util.js";

/* Python の round(半数偶数丸め)。Math.round(半数切り上げ)とは境界で1違う */
export function pyRound(x, digits) {
  const d = digits || 0;
  const p = Math.pow(10, d);
  const y = x * p;
  const f = Math.floor(y);
  const diff = y - f;
  let r;
  if (diff > 0.5) r = f + 1;
  else if (diff < 0.5) r = f;
  else r = (f % 2 === 0) ? f : f + 1;
  return r / p;
}

export function avg(values) {
  const v = values.filter(x => x != null);
  if (!v.length) return null;
  return pyRound(v.reduce((a, b) => a + b, 0) / v.length, 1);
}

/* Python の statistics.mean は「入力が全部 int で割り切れる」とき int を返し、
 * round(int, 1) も int になる(= CSV に "4" と出る。float なら "4.0")。
 * 表示文字列を Python と一致させるために、int になる条件をここで判定する。 */
export function isPyInt(values, rounded) {
  const v = values.filter(x => x != null);
  return v.length > 0 && v.every(Number.isInteger) && Number.isInteger(rounded);
}

/* §4-1b 判断19:純度ハードゲート(機械フィルタ扱い) */
export const PURITY = { following_max: 3000, ff_ratio_min: 2.0 };
/* §2-3 ジョブ定義v4(jobs/job_micro_v4.jsonc・job_middle_v4.jsonc と一致させること) */
export const MICRO = { followers_min: 5000, followers_max: 30000, engagement_rate_min: 2.0, avg_comments_min: 3, comment_rate_min: 0.10 };
export const MIDDLE = { followers_min: 30000, followers_max: 100000, engagement_rate_min: 1.5, avg_comments_min: 5, comment_rate_min: 0.05 };
/* 判断21:include方式は撤廃。exclude は明白なノイズのみ */
export const COMMON = { genre_exclude: ["reseller", "bot", "adult", "gambling", "finance"], language: ["ja"], exclude_private: true, unknown_policy: "exclude" };

export function to_record(raw, opts) {
  const user = raw.u;
  if (!user) return null;
  const posts = (raw.p || []).slice(0, 12);
  const followers = user.f ?? null;
  const following = user.fg ?? null;

  /* いいね: like_and_view_counts_disabled の投稿は null(0扱いにしない) */
  const likes = posts.filter(p => !p.lv).map(p => (p.l == null ? null : p.l));
  /* コメント: v2.4 判断15 — comments_disabled は平均の分母から除外 */
  const openPosts = posts.filter(p => !p.cd);
  const comments = openPosts.map(p => (p.c == null ? null : p.c));

  const avgLikes = avg(likes);
  let avgComments = avg(comments);
  if (openPosts.length < 3) avgComments = null;  // §2-3「開放投稿が3件未満なら不明」

  let er = null;
  if (avgLikes != null && followers) er = pyRound((avgLikes + (avgComments || 0)) / followers * 100, 2);
  const commentRate = (avgComments != null && followers) ? pyRound(avgComments / followers * 100, 3) : null;
  const ff = (followers && following != null) ? pyRound(followers / Math.max(following || 0, 1), 2) : null;

  const captions = posts.map(p => stripLoneSurrogates(p.cap || ""));
  const genre = classifyGenre({ bio: user.bio, captions, ig_category: user.cat, full_name: user.fn });
  const text = (user.bio || "") + " " + captions.slice(0, 5).join(" ");
  const username = user.un || raw.h;
  return {
    username,
    account_url: `https://www.instagram.com/${username}/`,
    full_name: user.fn || "",
    bio_text: stripLoneSurrogates(user.bio || ""),
    followers, following, ff_ratio: ff,
    avg_likes: avgLikes, avg_comments: avgComments,
    engagement_rate: er, comment_rate: commentRate,
    comment_open_rate: posts.length ? pyRound(openPosts.length / posts.length, 2) : null,
    posts_used: posts.length,
    genre: genre.genre, genres: genre.genres, genre_method: genre.method,
    language: detectLanguage(text),
    has_external_link: !!user.ext, external_url: user.ext || "",
    is_private: !!user.priv, is_verified: !!user.ver,
    ig_category: user.cat ?? null,
    media_count: user.mc ?? null,
    matched_keywords: raw.tags || "",
    discovered_via: raw.src || "",
    scraped_at: (opts && opts.now) || new Date().toISOString().replace(/\.\d+Z$/, "+00:00"),
    source: raw.src ?? null, media_source: raw.media ?? null,
    /* v2.7:定性シグナルの抽出に本文が必要なのでレコードに持たせる(CSVには出さない) */
    _captions: captions,
    /* __PROF が全文で判定した PR表記の件数(prl)。None ならフォールバックで
       切り詰め後テキストから数える(過小になるので summary に出所を残す) */
    _pr_posts: posts.some(p => "prl" in p) ? posts.filter(p => p.prl).length : null,
    /* 収集キットの版数(§8-4)。JSONL 先頭レコードに入っていれば拾う */
    _kit: raw.kit ?? null,
    /* 平均値が Python では int になる(=表示が "4" になる)かどうか */
    _pyInt: { avg_likes: isPyInt(likes, avgLikes), avg_comments: isPyInt(comments, avgComments) }
  };
}

/* .jsonl テキスト → {records, errors, lines} */
export function parseJsonl(text) {
  const lines = String(text).split(/\r?\n/).filter(l => l.trim());
  const raws = [], errors = {}, badLines = [];
  lines.forEach((line, i) => {
    let raw;
    try { raw = JSON.parse(line); }
    catch (e) { errors.json_decode = (errors.json_decode || 0) + 1; badLines.push({ line: i + 1, why: "JSONとして読めません" }); return; }
    if (raw.err || !raw.u) {
      const key = raw.err || "no_user";
      errors[key] = (errors[key] || 0) + 1;
      badLines.push({ line: i + 1, why: raw.err ? `取得エラー: ${raw.err}` : "レコードに u(プロフィール)がありません", handle: raw.h });
      return;
    }
    raws.push(raw);
  });
  return { raws, errors, lines, badLines };
}

/* run 全体の解析。ingest_compact.py の main() が summary_<tag>.json に出していた内容+全件の判定結果。
 * 画面(§5-3)がそのまま描ける形で返す。CSVは介在しない。 */
export function analyzeRun(text, options) {
  const o = options || {};
  const runTag = o.runTag || "run";
  const { raws, errors, lines, badLines } = parseJsonl(text);
  const records = raws.map(r => to_record(r, o)).filter(Boolean);

  const matched = [], rejected = [], review = [];
  records.forEach(record => {
    const tier = (record.followers || 0) >= 30000 ? "middle" : "micro";
    const jobFilters = { ...(tier === "middle" ? MIDDLE : MICRO), ...PURITY, ...COMMON };
    const result = evaluate(record, jobFilters);
    record._tier = tier; record._filters = jobFilters;
    record.filter_reasons = result.reasons.map(r => ({ ...r }));
    record.reject_reason = result.first_reason;
    (result.matched ? matched : rejected).push(record);
    /* §2-2 3値判定: verified かつ カテゴリ null は目視キューへ */
    if (record.is_verified && !record.ig_category) review.push(record);
  });

  const band = records.filter(r => (r.followers || 0) >= 5000 && (r.followers || 0) <= 100000);
  const ranked = matched.slice().sort((a, b) => (b.engagement_rate || 0) - (a.engagement_rate || 0));

  /* Python の Counter.most_common():件数降順・同数は**出現順**(コード名順ではない)。
     filters.reasonHistogram はコード名昇順で並べる別仕様なので、ここでは使わない。 */
  const counter = new Map();
  rejected.forEach(record => (record.filter_reasons || []).forEach(reason => {
    counter.set(reason.code, (counter.get(reason.code) || 0) + 1);
  }));
  const histogram = Object.fromEntries([...counter.entries()]
    .map(([k, v], i) => [k, v, i])
    .sort((a, b) => (b[1] - a[1]) || (a[2] - b[2]))
    .map(([k, v]) => [k, v]));

  /* §4-1d シグナルの内訳(表示用・自動見送りにはしない) */
  const sig = { 生活者シグナル: 0, 他社契約シグナル: 0, 業者シグナル: 0 };
  records.forEach(record => {
    const s = signals(record);
    if (s.biz.length) sig["業者シグナル"]++;
    if (s.amb.length) sig["他社契約シグナル"]++;
    if (s.life.length && !s.biz.length) sig["生活者シグナル"]++;
  });

  /* v2.7:定性列の信頼性。キャプションが短いまま気づかず使うのを防ぐ */
  const caplens = [];
  records.forEach(r => (r._captions || []).forEach(x => caplens.push(x.length)));
  const capAvg = caplens.length ? pyRound(caplens.reduce((a, b) => a + b, 0) / caplens.length, 0) : 0;
  const prSource = records.some(r => r._pr_posts != null)
    ? "全文(__PROFのprl)"
    : "切り詰め後テキスト(過小の可能性・__PROFにprlを実装すること)";
  const qualNote = capAvg >= 100 ? "十分"
    : `⚠ 低い(平均${capAvg}字)。__PROF のキャプション上限を140字以上にすること。定性列(qual_*)とPR件数は過小に出ている`;

  /* 機械合格の定性列(語りの向きの内訳は matched のみで数える=Python と同じ) */
  const parts = new Map();
  matched.forEach(r => parts.set(r.username, buildFitComment(r, r._captions, r._pr_posts)));
  const stanceMix = {};
  matched.forEach(r => {
    const head = parts.get(r.username).qual_stance.split("(")[0];
    stanceMix[head] = (stanceMix[head] || 0) + 1;
  });

  const rows = records.map(r => {
    const p = parts.get(r.username) || null;
    return {
      username: r.username, account_url: r.account_url, full_name: r.full_name,
      verdict: r.reject_reason == null ? "passed" : "rejected",
      reasons: (r.filter_reasons || []).map(x => ({ code: x.code, message: x.message })),
      followers: r.followers, following: r.following, ff_ratio: r.ff_ratio,
      avg_likes: r.avg_likes, avg_comments: r.avg_comments,
      engagement_rate: r.engagement_rate, comment_rate: r.comment_rate,
      genre: r.genre, language: r.language, is_verified: r.is_verified, ig_category: r.ig_category,
      bio: r.bio_text, external_url: r.external_url, has_external_link: r.has_external_link,
      matched_keywords: r.matched_keywords, discovered_via: r.discovered_via,
      tier: r._tier, sig: signals(r),
      select_reason: p ? p.select_reason : "", fit_comment: p ? p.fit_comment : "", fit_concern: p ? p.fit_concern : "",
      qual_stance: p ? p.qual_stance : "", qual_voice: p ? p.qual_voice : "", qual_evidence: p ? p.qual_evidence : "",
      qual_pr_posts: p ? p.qual_pr_posts : "", qual_caption_len: p ? p.qual_caption_len : null,
      qual_reliability: p ? p.qual_reliability : ""
    };
  });

  return {
    runTag,
    ingestedAt: (o.now || new Date().toISOString()),
    sourceFile: o.sourceFile || "",
    attempts: lines.length,
    succeeded: records.length,
    failures: errors,
    badLines,
    inBand: band.length,
    machinePassed: matched.length,
    purityExcluded: (histogram.ff_ratio_too_low || 0) + (histogram.following_too_high || 0),
    signals: sig,
    dropReasons: histogram,
    rateLimited: errors.rate_limited || 0,
    reliability: { avgCaptionLen: capAvg, verdict: qualNote, prSource, stanceBreakdown: stanceMix },
    reviewNeeded: review.map(r => r.username),
    ranked: ranked.map(r => r.username),
    rows,
    filters: { micro: MICRO, middle: MIDDLE, purity: PURITY, common: COMMON },
    kitVersion: records.length ? (records[0]._kit || null) : null
  };
}

/* 画面表示・照合用に summary_<tag>.json と同じキーのオブジェクトを作る(§5-3 の照合に使う) */
export function toSummaryJson(run) {
  return {
    "取得試行": run.attempts, "取得成功": run.succeeded,
    "取得失敗": run.failures,
    "帯内(5千〜10万)": run.inBand,
    "機械合格": run.machinePassed,
    "純度ゲート除外": run.purityExcluded,
    "シグナル内訳(全取得)": run.signals,
    "review_needed(verified×カテゴリnull)": run.reviewNeeded,
    "落ち理由": run.dropReasons,
    "rate_limited": run.rateLimited,
    "定性列の信頼性(v2.7)": {
      "キャプション平均文字数": run.reliability.avgCaptionLen,
      "評価": run.reliability.verdict,
      "PR判定の出所": run.reliability.prSource,
      "語りの向きの内訳": run.reliability.stanceBreakdown
    },
    "適用フィルタ": run.filters
  };
}
