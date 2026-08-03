/* 拡張の「③精査データ収集」へ渡す指示を作る(2026-08-03 追加)。
 *
 * 旧: 精査画面を開いたときだけ「上位N名」を localStorage に出していた。
 * 新: **スコア QUAL_MIN_SCORE 点以上**を対象にし、QUAL_FILL_TARGET に足りない人数(shortfall)と
 *     不足を埋めるための発掘プラン(discover)まで渡す。拡張はこれを見て発掘→再判定を回す。
 *
 * ここは DOM を触らない純関数(buildCdpQual)と、localStorage に書くだけの薄い出口(exportCdpQual)に分ける。
 * ダッシュボード側は localStorage を書くだけで、Instagram へのアクセスは一切しない。
 */
import {
  COV_SEED,
  QUAL_DISCOVER_MAX_ROUNDS,
  QUAL_FILL_TARGET,
  QUAL_MAX_COLLECT,
  QUAL_MIN_SCORE,
} from "./conf.js";
import { qualTargets } from "./qualReport.js";

export const CDP_QUAL_KEY = "castnext_cdp_qual";

/* 発掘タグの既定。①で選択中のタグが無いときは探索カバレッジの種(E1)を使う。 */
export function seedDiscoverTags() {
  return COV_SEED.filter(s => s.route === "E1").map(s => ({ tag: s.term, life: false }));
}

function normTags(tags) {
  const out = [];
  (tags || []).forEach(t => {
    const tag = typeof t === "string" ? t : (t && t.tag);
    if (!tag) return;
    const s = String(tag).startsWith("#") ? String(tag) : "#" + String(tag);
    if (!out.some(x => x.tag === s)) out.push({ tag: s, life: !!(t && t.life) });
  });
  return out;
}

/* 精査指示の本体。opts: { tags, done, at, minScore, fillTarget, maxCollect, maxRounds } */
export function buildCdpQual(cands, opts) {
  const o = opts || {};
  const minScore = o.minScore == null ? QUAL_MIN_SCORE : o.minScore;
  const fillTarget = o.fillTarget == null ? QUAL_FILL_TARGET : o.fillTarget;
  const maxCollect = o.maxCollect == null ? QUAL_MAX_COLLECT : o.maxCollect;
  const maxRounds = o.maxRounds == null ? QUAL_DISCOVER_MAX_ROUNDS : o.maxRounds;

  const eligible = qualTargets(cands, { minScore })
    .map(c => String(c.username || "").replace(/^@/, ""))
    .filter(Boolean);
  const handles = eligible.slice(0, maxCollect);
  const tags = normTags(o.tags && o.tags.length ? o.tags : seedDiscoverTags());

  return {
    handles,
    eligible: eligible.length,          /* 基準到達の総数 */
    deferred: eligible.length - handles.length, /* 今回渡さず次回に回すぶん(黙って捨てない) */
    minScore,
    fillTarget,
    maxCollect,
    shortfall: Math.max(0, fillTarget - eligible.length),
    discover: { tags, maxRounds, done: (o.done || []).map(h => String(h).replace(/^@/, "")) },
    at: o.at || new Date().toISOString(),
  };
}

/* 人向けの1行サマリ。対象人数と、不足・繰り越しを必ず言う(黙って切り捨てない)。
 * 「今回」「◯名/回」という語は使わない(1回あたりの人数上限という概念は無いため)。 */
export function cdpQualSummary(p) {
  const base = `スコア${p.minScore}点以上 ${p.eligible}名`;
  const rest = p.deferred > 0 ? `（1回に渡せるのは ${p.handles.length}名まで。残り ${p.deferred}名は次回）` : "";
  const short = p.shortfall > 0 ? `（${p.fillTarget}名に ${p.shortfall}名不足。拡張③が自動発掘で補充）` : "";
  return base + rest + short;
}

/* localStorage への出口。読む側(拡張)が居なければ無害。localStorage 不可なら黙ってスキップ。 */
export function exportCdpQual(cands, opts) {
  const payload = buildCdpQual(cands, opts);
  try { localStorage.setItem(CDP_QUAL_KEY, JSON.stringify(payload)); } catch (e) { /* noop */ }
  return payload;
}
