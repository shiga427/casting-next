/* 拡張の「④DM送付」へ渡す送付キューを作る(設計書_DM自動一括送付_v1.0 §3・§5)。
 * cdpQual.js と同型: DOM を触らない純関数(buildCdpDm)と、localStorage に書くだけの薄い出口(exportCdpDm)。
 *
 * ダッシュボード側は localStorage を書くだけで、Instagram へのアクセスは一切しない。
 * 送るかどうかの最終判断・実際の送信は拡張(instagram.com のタブ)側で行う。
 */
import { DM_DAILY_CAP, DM_MAX_WAIT, DM_MIN_WAIT, DM_PER_MIN_MAX } from "./conf.js";
import { composeDmBatch } from "./dmCompose.js";
import { setStatus } from "./sbis.js";

export const CDP_DM_KEY = "castnext_cdp_dm";
/* 拡張 → ダッシュボード の戻り(§5-5・§7)。成功ハンドルと時刻が入る */
export const CDP_DM_RESULT_KEY = "castnext_dm_result";

/* §6-1/§6-2 の安全側クランプ。**緩める向きの指定を受け付けない**。
 *   待機時間 … 既定より長くする指定だけ通す(短縮は不可)
 *   上限     … 既定より小さくする指定だけ通す(引き上げは不可) */
export function clampDmOpts(opts) {
  const o = opts || {};
  const num = (v, d) => (v == null || isNaN(Number(v)) ? d : Number(v));
  const minWaitMs = Math.max(DM_MIN_WAIT, num(o.minWaitMs, DM_MIN_WAIT));
  const maxWaitMs = Math.max(minWaitMs, Math.max(DM_MAX_WAIT, num(o.maxWaitMs, DM_MAX_WAIT)));
  return {
    minWaitMs, maxWaitMs,
    perMinMax: Math.max(1, Math.min(DM_PER_MIN_MAX, num(o.perMinMax, DM_PER_MIN_MAX))),
    dailyCap: Math.max(0, Math.min(DM_DAILY_CAP, num(o.dailyCap, DM_DAILY_CAP))),
  };
}

/* 送付キューの本体。opts:
 *   { mode:"semi"|"auto", dryRun, texts:{handle:本文}, drop:[handle], conf, brand, at,
 *     minWaitMs, maxWaitMs, perMinMax, dailyCap } */
export function buildCdpDm(cands, opts) {
  const o = opts || {};
  const rate = clampDmOpts(o);
  const { items, excluded } = composeDmBatch(cands, o);
  /* 日次上限を超えたぶんは「次回」に回す。黙って切らない(cdpQual の deferred と同じ作法) */
  const send = items.slice(0, rate.dailyCap);
  const deferredItems = items.slice(rate.dailyCap);
  const mode = o.mode === "auto" ? "auto" : "semi";   /* 既定は半自動(§5-1) */
  return {
    items: send.map(it => ({ handle: it.handle, userId: it.userId, text: it.text, tier: it.tier, slot: it.slot })),
    basis: send.map(it => ({ handle: it.handle, basis: it.basis, edited: it.edited })),
    excluded,
    eligible: items.length,
    deferred: deferredItems.length,
    deferredHandles: deferredItems.map(it => it.handle),
    mode,
    perMinMax: rate.perMinMax,
    minWaitMs: rate.minWaitMs,
    maxWaitMs: rate.maxWaitMs,
    dailyCap: rate.dailyCap,
    dryRun: !!o.dryRun,
    at: o.at || new Date().toISOString(),
  };
}

/* 全自動を封鎖している理由(2026-08-04 実機検証)。
 * 設計書§5-3 の送信エンドポイント `/api/v1/direct_v2/threads/broadcast/text/` は、
 * 実機で叩くとJSONではなく**ログインページ**が返り、セッションが飛ぶ挙動が出た。
 * 人が手で送ったDMを webRequest で観測しても、このエンドポイントへのPOSTは**1件も出なかった**。
 * ＝現行のInstagram webはこの経路を使っていない可能性が高い。
 *
 * 残る経路はモバイル私設API（§5-3・§10 が明確に禁止）か画面操作だけで、後者は半自動そのもの。
 * 実装で押し切れる問題ではないので、**新しい根拠が出るまで全自動は選べないようにする**。
 * 解除するときは、実際の送信リクエストを観測した記録を根拠として添えること。 */
export const AUTO_BLOCKED_REASON =
  "全自動は現在使えません。設計書§5-3 の送信APIが実機で機能せず（ログインページが返り、"
  + "セッションが切れる挙動を確認）、手動送信を観測してもこのエンドポイントは使われていませんでした。"
  + "半自動（下書き＋人が送信）でお使いください。";

/* auto を選んでよいか(§5-1)。満たさない条件を全て理由で返す(1つに丸めない) */
export function autoAllowed(payload, opts) {
  const o = opts || {};
  const why = [];
  const p = payload || {};
  /* ★実機で送信APIが機能しないことが分かっている間は、他の条件を満たしても許可しない */
  if (!o.endpointVerified) why.push(AUTO_BLOCKED_REASON);
  if ((p.items || []).length === 0) why.push("送付対象が0件です");
  if ((p.items || []).length > (p.dailyCap == null ? DM_DAILY_CAP : p.dailyCap)) why.push(`対象が日次上限(${p.dailyCap})を超えています`);
  if ((p.excluded || []).length > 0 && o.requireAllPass !== false) why.push(`ガードで除外された候補が ${p.excluded.length}件あります(§6-3)`);
  if (!o.dryRunPassed) why.push("直近のドライランが成功していません(§6-4。auto の前に必ず1回通す)");
  return { ok: why.length === 0, why };
}

/* 人向けの1行サマリ。除外・繰り越しを必ず言う(黙って切り捨てない) */
export function cdpDmSummary(p) {
  const n = (p.items || []).length;
  const head = `${p.mode === "auto" ? "全自動" : "半自動"}${p.dryRun ? "・ドライラン" : ""} ${n}件`;
  const ex = (p.excluded || []).length ? `（ガードで除外 ${p.excluded.length}件）` : "";
  const df = p.deferred > 0 ? `（日次上限 ${p.dailyCap}件のため 残り ${p.deferred}名は次回）` : "";
  return head + ex + df;
}

/* localStorage への出口。読む側(拡張)が居なければ無害。localStorage 不可なら黙ってスキップ */
export function exportCdpDm(cands, opts) {
  const payload = buildCdpDm(cands, opts);
  try { localStorage.setItem(CDP_DM_KEY, JSON.stringify(payload)); } catch (e) { /* noop */ }
  return payload;
}

/* 拡張から返ってきた結果をステータスに反映する(§7)。新しい仕組みを作らず setStatus に載せる。
 *   results[] … { handle, result:"ok"|"draft"|"skipped"|"failed:...", at, threadId, mode, dryRun, textHash }
 * ・ドライランは何も進めない(送っていないため)
 * ・semi の "draft" は status を進めず c.dm.result="draft" に留める(人が送ったか不明なため)
 * ・"ok" のみ setStatus(c,"DM送付",today)。適合コメント未記入で弾かれたら blocked に残す */
export function applyDmResults(cands, payload, today) {
  const p = payload || {};
  const rows = p.results || [];
  const applied = [], drafts = [], blocked = [], failed = [];
  rows.forEach(r => {
    const h = String(r.handle || "").replace(/^@/, "").toLowerCase();
    const c = (cands || []).find(x => String(x.username || "").toLowerCase() === h);
    if (!c) return;
    c.dm = Object.assign({ lastText: "", sentAt: "", threadId: "", result: "", mode: "" }, c.dm, {
      result: String(r.result || ""), mode: String(r.mode || p.mode || ""),
    });
    if (r.textHash) c.dm.lastText = String(r.textHash);
    if (r.dryRun || p.dryRun) return;                       /* ドライランは記録もステータスも進めない */
    if (r.result === "ok") {
      c.dm.sentAt = String(r.at || "");
      c.dm.threadId = String(r.threadId || "");
      const res = setStatus(c, "DM送付", today);
      if (res.ok) applied.push(c.username); else blocked.push({ handle: c.username, reason: res.reason });
    } else if (r.result === "draft") {
      drafts.push(c.username);
    } else if (String(r.result || "").startsWith("failed")) {
      failed.push({ handle: c.username, reason: String(r.result) });
    }
  });
  return { applied, drafts, blocked, failed, stopped: p.stopped || "" };
}

/* localStorage から結果を1回だけ読んで反映し、読んだら消す(二重反映しない) */
export function consumeDmResult(cands, today) {
  let raw = null;
  try { raw = localStorage.getItem(CDP_DM_RESULT_KEY); } catch (e) { return null; }
  if (!raw) return null;
  try { localStorage.removeItem(CDP_DM_RESULT_KEY); } catch (e) { /* noop */ }
  let payload = null;
  try { payload = JSON.parse(raw); } catch (e) { return null; }
  return applyDmResults(cands, payload, today);
}
