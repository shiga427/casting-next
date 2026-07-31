/* 条件フィルタ(設計書§6-1)。移植元:igfinder/filters.py。
 *
 * 判定順(EVALUATION_ORDER)・理由コード・unknown_policy の扱い・純度ハードゲートを
 * 1文字単位で維持する。**未知のキーは素通りさせずエラー**(run#6 不具合3の再発防止)。
 * 不合格アカウントには理由を全件残す(後で条件を緩める判断に使う)。
 */

export const EVALUATION_ORDER = [
  "exclude_private",
  "exclude_verified",
  "followers_min",
  "followers_max",
  "must_have_external_link",
  "avg_comments_min",
  "avg_likes_min",
  "engagement_rate_min",
  "engagement_rate_max",
  "genre_include",
  "genre_exclude",
  "language",
  /* v2.6 §4-1b(判断19)オーディエンス純度ハードゲート。機械フィルタ扱いで rejected に落とす。
     相互フォロー網の中の会話は「行列の証言」にならないため、減点ではなく足切りにする。 */
  "following_max",
  "ff_ratio_min",
];

/* Python の f-string と同じ見え方にする(2.0 が "2" にならないように) */
function f1(v) { return (typeof v === "number" && Number.isInteger(v)) ? v.toFixed(1) : String(v); }
function pyList(arr) { return "[" + arr.map(s => `'${s}'`).join(", ") + "]"; }

export function Reason(code, message, extra) { return Object.assign({ code, message }, extra || {}); }

function unknown(policy, code, message) {
  if (policy === "pass") return null;
  return Reason(`unknown_${code}`, `${message}(unknown_policy=exclude のため除外)`);
}

function check(key, value, record, policy, filters) {
  if (key === "exclude_private") {
    if (!value) return null;
    const isPrivate = record.is_private;
    if (isPrivate == null) return unknown(policy, "is_private", "非公開かどうか不明");
    return isPrivate ? Reason("private", "非公開アカウント") : null;
  }

  if (key === "exclude_verified") {
    if (!value) return null;
    const isVerified = record.is_verified;
    if (isVerified == null) return unknown(policy, "is_verified", "認証済みかどうか不明");
    return isVerified ? Reason("verified", "認証済みアカウント(除外指定)") : null;
  }

  if (key === "followers_min") {
    const followers = record.followers;
    if (followers == null) return unknown(policy, "followers", "フォロワー数が取得できず");
    return followers < value
      ? Reason("followers_too_low", `フォロワー ${followers} < 下限 ${value}`, { actual: followers, threshold: value })
      : null;
  }

  if (key === "followers_max") {
    const followers = record.followers;
    if (followers == null) return unknown(policy, "followers", "フォロワー数が取得できず");
    return followers > value
      ? Reason("followers_too_high", `フォロワー ${followers} > 上限 ${value}`, { actual: followers, threshold: value })
      : null;
  }

  if (key === "must_have_external_link") {
    if (!value) return null;
    return record.has_external_link ? null : Reason("no_external_link", "プロフィールに外部リンクなし");
  }

  if (key === "avg_comments_min") {
    const actual = record.avg_comments;
    if (actual == null) return unknown(policy, "avg_comments", "平均コメント数が算出できず");
    return actual < value
      ? Reason("avg_comments_too_low", `平均コメント ${actual} < 下限 ${value}`, { actual, threshold: value })
      : null;
  }

  if (key === "avg_likes_min") {
    const actual = record.avg_likes;
    if (actual == null) return unknown(policy, "avg_likes", "平均いいね数が算出できず");
    return actual < value
      ? Reason("avg_likes_too_low", `平均いいね ${actual} < 下限 ${value}`, { actual, threshold: value })
      : null;
  }

  if (key === "engagement_rate_min" || key === "engagement_rate_max") {
    const actual = record.engagement_rate;
    if (actual == null) {
      /* v2.2 §2-3 救済分岐: ER が null のときに限りコメント率で代替判定する。
         ER が取れている場合はここに来ないので、二重基準にはならない。 */
      const threshold = filters ? filters.comment_rate_min : undefined;
      if (threshold != null) {
        const rate = record.comment_rate;
        if (rate != null) {
          if (rate >= threshold) return null;  // 救済: いいね非表示でもコメント率が基準以上
          // 救済も不合格。理由は min 側からのみ出す(max と重複させない)
          if (key === "engagement_rate_max") return null;
          return Reason(
            "comment_rate_below_min",
            `ER不明(いいね非表示)。コメント率 ${rate}% < 下限 ${threshold}%`,
            { actual: rate, threshold }
          );
        }
        if (key === "engagement_rate_max") return null;
      }
      return unknown(policy, "engagement_rate", "エンゲージメント率が算出できず");
    }
    if (key === "engagement_rate_min" && actual < value) {
      return Reason("engagement_too_low", `ER ${actual}% < 下限 ${f1(value)}%`, { actual, threshold: value });
    }
    if (key === "engagement_rate_max" && actual > value) {
      return Reason("engagement_too_high", `ER ${actual}% > 上限 ${f1(value)}%`, { actual, threshold: value });
    }
    return null;
  }

  if (key === "genre_include") {
    const allowed = new Set(value.map(g => String(g).toLowerCase()));
    const found = new Set((record.genres || []).filter(g => typeof g === "string").map(g => g.toLowerCase()));
    const primary = record.genre;
    if (primary) found.add(String(primary).toLowerCase());
    if (!found.size) return unknown(policy, "genre", "ジャンルを推定できず");
    const hit = [...found].some(g => allowed.has(g));
    return hit ? null : Reason("genre_not_allowed",
      `推定ジャンル ${pyList([...found].sort())} が許可リスト ${pyList([...allowed].sort())} に不一致`,
      { actual: [...found].sort() });
  }

  if (key === "genre_exclude") {
    const denied = new Set(value.map(g => String(g).toLowerCase()));
    const found = new Set((record.genres || []).filter(g => typeof g === "string").map(g => g.toLowerCase()));
    const primary = record.genre;
    if (primary) found.add(String(primary).toLowerCase());
    const overlap = [...found].filter(g => denied.has(g)).sort();
    return overlap.length
      ? Reason("genre_excluded", `除外ジャンルに該当: ${pyList(overlap)}`, { actual: overlap })
      : null;
  }

  if (key === "following_max") {
    const following = record.following;
    if (following == null) return unknown(policy, "following", "フォロー数が取得できず(純度未評価)");
    return following > value
      ? Reason("following_too_high",
        `純度ハードゲート:フォロー ${following} > 上限 ${value}(§4-1b 判断19)`,
        { actual: following, threshold: value })
      : null;
  }

  if (key === "ff_ratio_min") {
    const ffRatio = record.ff_ratio;
    if (ffRatio == null) return unknown(policy, "ff_ratio", "FF比が算出できず(純度未評価)");
    return ffRatio < value
      ? Reason("ff_ratio_too_low",
        `純度ハードゲート:FF比 ${f1(ffRatio)} < 下限 ${f1(value)}(§4-1b 判断19)`,
        { actual: ffRatio, threshold: value })
      : null;
  }

  if (key === "language") {
    const allowed = new Set(value.map(v => String(v).toLowerCase()));
    const actual = record.language;
    if (actual == null) return unknown(policy, "language", "言語を判定できず");
    return allowed.has(String(actual).toLowerCase())
      ? null
      : Reason("language_mismatch", `言語 ${actual} が指定 ${pyList([...allowed].sort())} に不一致`, { actual });
  }

  /* 未知のキー(FILTER_SPEC に足したが check 未実装)は素通りさせず気付けるようにする */
  throw new Error(`filter '${key}' の判定ロジックが未実装です`);
}

export function evaluate(record, filters) {
  const policy = String(filters.unknown_policy || "exclude");
  const reasons = [];
  for (const key of EVALUATION_ORDER) {
    if (!Object.prototype.hasOwnProperty.call(filters, key)) continue;
    const value = filters[key];
    /* 無効化を意味するのは「未指定(null)」「フラグの False」「空リスト」だけ。
       数値 0 は有効な閾値として扱う。 */
    if (value == null) continue;
    if (typeof value === "boolean" && !value) continue;
    if (Array.isArray(value) && !value.length) continue;
    const reason = check(key, value, record, policy, filters);
    if (reason != null) reasons.push(reason);
  }
  return {
    matched: !reasons.length,
    reasons,
    first_reason: reasons.length ? reasons[0].code : null
  };
}

export function applyFilters(records, filters) {
  const matched = [], rejected = [];
  records.forEach(record => {
    const result = evaluate(record, filters);
    const enriched = { ...record };
    enriched.filter_reasons = result.reasons.map(r => ({ ...r }));
    enriched.reject_reason = result.first_reason;
    (result.matched ? matched : rejected).push(enriched);
  });
  return { matched, rejected };
}

/* 歩留まりの悪い条件を見つけるための集計(設計書6章 可観測性) */
export function reasonHistogram(rejected) {
  const histogram = {};
  rejected.forEach(record => {
    (record.filter_reasons || []).forEach(reason => {
      const code = reason.code || "unknown";
      histogram[code] = (histogram[code] || 0) + 1;
    });
  });
  return Object.fromEntries(Object.entries(histogram).sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0])));
}
