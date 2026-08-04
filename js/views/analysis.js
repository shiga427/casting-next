/* 分析結果(run別)— 設計書§5-3。CSV廃止の中核。
 * summary_<tag>.json が持っていた内容 + 落ちた全件の内訳を画面化する。
 * 「黙って捨てない」原則:隔離(判断22)と review_needed を必ず出す。
 */
import { state, markDirty } from "../store.js";
import { esc, donut, hbar, funnel } from "../charts.js";
import { go } from "../router.js";
import { toSummaryJson } from "../pipeline/ingest.js";
import { EXT_COLUMNS, rowsToCsv } from "../pipeline/export.js";

const REASON_LABEL = {
  avg_comments_too_low: "平均コメントが下限未満", followers_too_low: "フォロワーが下限未満",
  ff_ratio_too_low: "純度ゲート:FF比が下限未満", engagement_too_low: "ERが下限未満",
  followers_too_high: "フォロワーが上限超過", genre_excluded: "除外ジャンル",
  following_too_high: "純度ゲート:フォロー数が上限超過", unknown_avg_comments: "平均コメントが不明",
  language_mismatch: "言語が対象外", comment_rate_below_min: "ER不明・コメント率が下限未満",
  private: "非公開アカウント", unknown_engagement_rate: "ERが不明",
  unknown_ff_ratio: "FF比が不明(純度未評価)", unknown_following: "フォロー数が不明(純度未評価)",
  unknown_language: "言語を判定できず", verified: "認証済み(除外指定)",
  genre_not_allowed: "推定ジャンルが許可リスト外", no_external_link: "外部リンクなし",
  avg_likes_too_low: "平均いいねが下限未満", unknown_followers: "フォロワー数が不明",
  engagement_too_high: "ERが上限超過", unknown_is_private: "公開/非公開が不明", unknown_is_verified: "認証有無が不明",
};

function currentRun() {
  if (!state.runs.length) return null;
  return state.runs.find(r => r.runTag === state.activeRunTag) || state.runs[0];
}

export function render() {
  const run = currentRun();
  if (!run) {
    return `<div class="head"><h1>分析結果(run別)</h1></div>
      <div class="stub">まだ取得結果がありません。<br>
      <span class="hint">「収集」画面で <b>run&lt;N&gt;_compact.jsonl</b> をドロップすると、その場で分析結果が出ます。</span>
      <div class="toolrow" style="justify-content:center;margin-top:14px"><a class="btn" href="#/collect">収集画面へ</a></div></div>`;
  }
  const s = run.reliability || {};
  const dropItems = Object.entries(run.dropReasons || {}).map(([code, n]) =>
    ({ key: code, label: `${REASON_LABEL[code] || code}(${code})`, value: n }));
  const stance = s.stanceBreakdown || {};
  const stanceColors = { "当事者型": "#6D2E46", "判定保留": "#C9BBAE", "権威型": "#A26769", "権威型寄り": "#B98A2E", "混在型": "#8FA3B0", "カタログ型": "#B98A2E" };
  const passed = run.rows.filter(r => r.verdict === "passed");
  const missing = run.attempts - run.succeeded;

  return `
  <div class="head">
    <h1>分析結果</h1>
    <span class="meta">${esc(run.sourceFile || "")} / 取込 ${esc(String(run.ingestedAt).slice(0, 16).replace("T", " "))}</span>
    <div class="runsel">
      ${state.runs.map(r => `<span class="chip ${r.runTag === run.runTag ? "on" : ""}" data-run="${esc(r.runTag)}">${esc(r.runTag)}</span>`).join("")}
      <button class="btn ghost sm" id="btnExport">CSV/JSONで書き出す</button>
    </div>
  </div>

  <div class="sec">取得成績</div>
  <div class="kpis">
    <div class="kpi"><div class="l">取得試行</div><div class="v">${run.attempts}</div><div class="d">キューに入れた件数</div></div>
    <div class="kpi"><div class="l">取得成功</div><div class="v">${run.succeeded}</div><div class="d">成功率 ${(run.succeeded / Math.max(run.attempts, 1) * 100).toFixed(0)}%</div></div>
    <div class="kpi"><div class="l">欠測</div><div class="v">${missing}</div><div class="d">${missing ? "再取得で復旧できます" : "なし"}</div></div>
    <div class="kpi"><div class="l">帯内(5千〜10万)</div><div class="v">${run.inBand}<small>/${run.succeeded}</small></div><div class="d">帯内率 ${(run.inBand / Math.max(run.succeeded, 1) * 100).toFixed(0)}%</div></div>
    <div class="kpi"><div class="l">機械合格</div><div class="v">${run.machinePassed}</div><div class="d">帯内有効率 ${(run.machinePassed / Math.max(run.inBand, 1) * 100).toFixed(1)}%</div></div>
    <div class="kpi"><div class="l">rate_limited</div><div class="v">${run.rateLimited || 0}</div><div class="d">${run.rateLimited ? "ペースを落としてください" : "制限なし"}</div></div>
  </div>
  ${missing ? `<div class="card" style="margin-top:12px"><h3>欠測 ${missing}件の復旧手順</h3>
    <p class="hint">拡張で同じ対象をもう一度収集すると users_info 経路で復旧します(run#6 で 20/20 復旧の実績)。</p></div>` : ""}

  <div class="cols" style="margin-top:14px">
    <div>
      <div class="card">
        <h3>ファネル(どこで減っているか)</h3>
        ${funnel([
          { label: "取得成功", value: run.succeeded },
          { label: "帯内(5千〜10万)", value: run.inBand },
          { label: "純度ゲート通過", value: run.succeeded - run.purityExcluded, note: `除外 ${run.purityExcluded}` },
          { label: "機械合格", value: run.machinePassed }
        ])}
        <div class="note">機械合格は「botフロアを超えた」という意味であり、良い候補という意味ではありません(§3)。</div>
      </div>

      <div class="card">
        <h3>落ち理由の内訳<span class="r">バーをクリックすると該当ハンドルが出ます</span></h3>
        ${hbar(dropItems)}
      </div>

      <div class="card">
        <h3>機械合格 ${passed.length}名<span class="r">得点は候補ボードのSBISで付きます</span></h3>
        <div class="tblwrap"><table>
          <thead><tr><th>アカウント</th><th class="num">F</th><th class="num">ER%</th><th class="num">平均CM</th>
          <th class="num">FF比</th><th>語りの向き</th><th>声の特徴(引用)</th></tr></thead>
          <tbody>${passed.map(r => `<tr>
            <td><a class="handle" href="${esc(r.account_url)}" target="_blank" rel="noopener">@${esc(r.username)}</a>
              ${sigTags(r.sig)}<br><span class="hint">${esc(r.full_name || "")}</span></td>
            <td class="num">${fmt(r.followers)}</td>
            <td class="num">${r.engagement_rate == null ? "不明" : r.engagement_rate}</td>
            <td class="num">${r.avg_comments ?? "—"}</td>
            <td class="num">${r.ff_ratio ?? "—"}</td>
            <td><span class="tag st">${esc(String(r.qual_stance).split("(")[0])}</span></td>
            <td class="hint" style="max-width:340px">${esc(String(r.qual_voice).slice(0, 120))}</td>
          </tr>`).join("")}</tbody></table></div>
      </div>
    </div>

    <div>
      <div class="card ${String(s.verdict || "").startsWith("⚠") ? "" : ""}" style="${String(s.verdict || "").startsWith("⚠") ? "border:1.5px solid #EBC7D2" : ""}">
        <h3>定性列の信頼性(v2.7 の自己申告)</h3>
        <dl class="kv">
          <dt>キャプション平均</dt><dd>${s.avgCaptionLen}字</dd>
          <dt>PR判定の出所</dt><dd>${esc(s.prSource || "")}</dd>
        </dl>
        <div class="note" style="${String(s.verdict || "").startsWith("⚠") ? "color:#9E3A52;font-weight:700" : ""}">${esc(s.verdict || "")}</div>
      </div>

      <div class="card">
        <h3>内訳</h3>
        <div class="donuts">
          ${donut([
            { label: "生活者", value: run.signals["生活者シグナル"] || 0, color: "var(--sig-green)" },
            { label: "他社契約", value: run.signals["他社契約シグナル"] || 0, color: "var(--sig-gold)" },
            { label: "業者", value: run.signals["業者シグナル"] || 0, color: "var(--sig-red)" }
          ], { title: "シグナル", sub: `全${run.succeeded}件` })}
          ${donut(Object.entries(stance).map(([k, v]) => ({ label: k, value: v, color: stanceColors[k] || "#C9BBAE" })),
            { title: "語りの向き", sub: `機械合格${run.machinePassed}` })}
        </div>
        <div class="note">シグナルは表示用で、自動見送りには使いません(判断は人間・§4-1d)。</div>
      </div>

      <div class="card">
        <h3>目視が必要な候補(review_needed)<span class="r">${(run.reviewNeeded || []).length}名</span></h3>
        <p class="hint">認証済み × カテゴリ不明は機械で決めきれません(§2-2 の3値判定)。個人か媒体かを目視で確認してください。</p>
        ${(run.reviewNeeded || []).map(u => `<div class="rowitem"><span class="h">@${esc(u)}</span>
          <span class="sc"><label class="hint"><input type="checkbox" class="rvchk" data-u="${esc(u)}" ${(run.reviewChecked || []).includes(u) ? "checked" : ""}> 確認した</label></span></div>`).join("")
        || `<div class="hint">該当なし</div>`}
      </div>

      <div class="card">
        <h3>業者疑いの隔離(判断22)<span class="r">${(run.bizQuarantined || []).length}件</span></h3>
        <p class="hint">表示名・IGカテゴリ・リンク先ドメインだけで判定しています(bioは使いません=個人の誤爆防止)。
          <b>破棄していません。</b>人が最終判断します。</p>
        ${(run.bizQuarantined || []).slice(0, 20).map(r => `<div class="rowitem">
          <span class="h">@${esc(r.handle)}</span><span class="hint" style="flex:1">${esc(r.reason)}</span></div>`).join("")
        || `<div class="hint">該当なし</div>`}
      </div>
    </div>
  </div>`;
}

function fmt(n) { return n == null ? "不明" : Number(n).toLocaleString("ja-JP"); }
function sigTags(sig) {
  if (!sig) return "";
  let h = "";
  if (sig.biz && sig.biz.length) h += ` <span class="tag red">🔴業者</span>`;
  if (sig.amb && sig.amb.length) h += ` <span class="tag res">🟡他社契約</span>`;
  if (sig.life && sig.life.length && !(sig.biz && sig.biz.length)) h += ` <span class="tag g">🟢生活者</span>`;
  return h;
}

export function mount() {
  const run = currentRun();
  if (!run) return;
  document.querySelectorAll("[data-run]").forEach(el => el.onclick = () => {
    state.activeRunTag = el.dataset.run; markDirty(); rerender();
  });
  /* 落ち理由バーのクリックで該当ハンドルを展開(黙って捨てない) */
  document.querySelectorAll(".hbar .row").forEach(row => row.onclick = () => {
    const key = row.dataset.key;
    const box = document.querySelector(`[data-detail="${CSS.escape(key)}"]`);
    if (!box) return;
    if (!box.dataset.filled) {
      const hits = run.rows.filter(r => (r.reasons || []).some(x => x.code === key));
      box.innerHTML = hits.map(r => `@${esc(r.username)}<span class="pill">${esc((r.reasons.find(x => x.code === key) || {}).message || "")}</span>`).join("<br>");
      box.dataset.filled = "1";
    }
    box.hidden = !box.hidden;
  });
  document.querySelectorAll(".rvchk").forEach(cb => cb.onchange = () => {
    const set = new Set(run.reviewChecked || []);
    cb.checked ? set.add(cb.dataset.u) : set.delete(cb.dataset.u);
    run.reviewChecked = [...set];
    markDirty();
  });
  const btn = document.getElementById("btnExport");
  if (btn) btn.onclick = () => exportRun(run);
}

function rerender() { window.dispatchEvent(new HashChangeEvent("hashchange")); }

function exportRun(run) {
  const rows = run.rows.map(r => ({
    account_url: r.account_url, username: "@" + r.username, full_name: r.full_name,
    followers: r.followers ?? "", engagement_rate: r.engagement_rate ?? "", avg_likes: r.avg_likes ?? "",
    avg_comments: r.avg_comments ?? "", genre: r.genre || "", has_external_link: r.has_external_link ? "TRUE" : "FALSE",
    external_url: r.external_url || "", bio: r.bio || "", matched_keywords: r.matched_keywords || "",
    discovered_via: r.discovered_via || "", scraped_at: "", following: r.following ?? "", ff_ratio: r.ff_ratio ?? "",
    select_reason: r.select_reason, fit_comment: r.fit_comment, fit_concern: r.fit_concern,
    qual_stance: r.qual_stance, qual_voice: r.qual_voice, qual_evidence: r.qual_evidence,
    qual_pr_posts: r.qual_pr_posts, qual_caption_len: r.qual_caption_len ?? "", qual_reliability: r.qual_reliability
  }));
  dl(new Blob(["﻿" + rowsToCsv(rows, EXT_COLUMNS)], { type: "text/csv" }), `all_${run.runTag}.csv`);
  dl(new Blob([JSON.stringify(toSummaryJson(run), null, 2)], { type: "application/json" }), `summary_${run.runTag}.json`);
}
function dl(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
