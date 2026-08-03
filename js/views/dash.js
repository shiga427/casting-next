/* 概要(ダッシュボード)— 設計書§5-1。モックアップ_概要画面.html の3段構成に合わせる。
 * ①KPIカード列(6枚)②自動診断アラート ③次のアクション+ミニチャート */
import { state } from "../store.js";
import { esc, donut } from "../charts.js";
import { buildAlerts } from "../alerts.js";
import { totalOf } from "../pipeline/sbis.js";
import { qualTargets } from "../pipeline/qualReport.js";
import { QUAL_MIN_SCORE } from "../pipeline/conf.js";

function activeRun() {
  if (!state.runs.length) return null;
  return state.runs.find(r => r.runTag === state.activeRunTag) || state.runs[0];
}

export function render() {
  const cs = state.cands;
  const run = activeRun();
  const prev = state.runs.length > 1 ? state.runs[1] : null;
  const inBand = cs.filter(c => c.score && (c.score.tier === "micro" || c.score.tier === "middle")).length;
  const passed = cs.length;
  /* 精査待ちの定義は精査画面と同じ1つに揃える(スコア QUAL_MIN_SCORE 点以上・高い順)。
   * 2026-08-03: ここに別条件を書いていたため、画面ごとに「対象」の人数が食い違っていた */
  const waiting = qualTargets(cs);
  const contracted = cs.filter(c => c.status === "契約");
  const serial = contracted.filter(c => c.slot === "連載枠");
  const sMid = serial.filter(c => c.score && c.score.tier === "middle").length;
  const sGrow = serial.filter(c => c.score && c.score.tier === "micro").length;
  const spot = contracted.filter(c => c.slot === "都度枠").length;
  const docSent = cs.filter(c => c.status === "資料送付").length;

  const alerts = buildAlerts({
    cands: cs, coverage: state.coverage, govLog: state.govLog, runs: state.runs, run, conf: state.conf
  });

  const stance = run ? (run.reliability.stanceBreakdown || {}) : {};
  const stanceColors = { "当事者型": "#6D2E46", "判定保留": "#C9BBAE", "権威型": "#A26769", "権威型寄り": "#B98A2E", "混在型": "#8FA3B0", "カタログ型": "#B98A2E" };

  return `
  <div class="head">
    <h1>${esc(state.project ? state.project.name : "")} キャスティング管制</h1>
    <span class="meta">${run ? `最終取込:${esc(run.runTag)}(${esc(String(run.ingestedAt).slice(0, 10))})|` : ""}${esc(state.conf.ver)}|候補 ${cs.length}件</span>
    <div class="runsel">
      ${state.runs.slice(0, 3).map(r => `<a class="chip ${run && r.runTag === run.runTag ? "on" : ""}" href="#/analysis">${esc(r.runTag)}</a>`).join("")}
    </div>
  </div>

  <div class="sec">全体サマリー${prev ? `(${esc(prev.runTag)}比)` : ""}</div>
  <div class="kpis">
    <div class="kpi"><div class="l">候補総数</div><div class="v">${passed}</div>
      <div class="d">${run ? `<span class="up">▲${run.machinePassed}</span> 機械合格の累計` : "取込済み"}</div></div>
    <div class="kpi"><div class="l">帯内(5千〜10万)</div><div class="v">${run ? run.inBand : inBand}${run ? `<small>/${run.succeeded}</small>` : ""}</div>
      <div class="d">${run ? `帯内率 ${(run.inBand / Math.max(run.succeeded, 1) * 100).toFixed(0)}%` : "—"}</div></div>
    <div class="kpi"><div class="l">機械合格</div><div class="v">${run ? run.machinePassed : 0}</div>
      <div class="d">${run ? `帯内有効率 ${(run.machinePassed / Math.max(run.inBand, 1) * 100).toFixed(1)}%` : "—"}</div></div>
    <div class="kpi"><div class="l">精査待ち</div><div class="v">${waiting.length}</div><div class="d">スコア${QUAL_MIN_SCORE}点以上・高い順</div></div>
    <div class="kpi"><div class="l">契約 連載枠</div><div class="v">${serial.length}<small>/4</small></div><div class="d">ミドル${sMid}+成長マイクロ${sGrow}</div></div>
    <div class="kpi"><div class="l">契約 都度枠</div><div class="v">${spot}<small>/10</small></div><div class="d">資料送付中 ${docSent}</div></div>
  </div>

  <div class="cols" style="margin-top:14px">
    <div>
      <div class="card">
        <h3>自動診断アラート<span class="r">${alerts.length}件</span></h3>
        ${alerts.length ? alerts.map(a => `
          <a class="alert ${a.level}" href="#/${a.to}">
            <span class="badge">${a.level === "warn" ? "要対応" : a.level === "check" ? "確認" : "情報"}</span>
            <div><div class="t">${esc(a.title)}</div><div class="b">${a.body}</div>
            ${a.go ? `<div class="go">${esc(a.go)}</div>` : ""}</div>
          </a>`).join("")
        : `<div class="hint">いま対応が必要な項目はありません。</div>`}
      </div>
    </div>

    <div>
      <div class="card">
        <h3>次のアクション:精査待ち(${QUAL_MIN_SCORE}点以上・高い順)</h3>
        ${waiting.length ? waiting.slice(0, 5).map((c, i) => `
          <div class="rowitem">
            <span class="rk">${i + 1}</span><span class="h">@${esc(c.username)}</span>
            ${c.sig && c.sig.life.length && !c.sig.biz.length ? `<span class="tag g">🟢生活者</span>` : ""}
            ${c.score.mode === "rescue" ? `<span class="tag res">救済 /75</span>` : ""}
            <span class="sc">${c.score.total}点</span>
          </div>`).join("") + `<div class="note">スコア${QUAL_MIN_SCORE}点以上を全員、高い順に精査します。</div>`
        : `<div class="hint">精査待ちはありません。</div>`}
      </div>

      ${run ? `<div class="card">
        <h3>${esc(run.runTag)} の内訳</h3>
        <div class="donuts">
          ${donut([
            { label: "生活者", value: run.signals["生活者シグナル"] || 0, color: "var(--sig-green)" },
            { label: "他社契約", value: run.signals["他社契約シグナル"] || 0, color: "var(--sig-gold)" },
            { label: "業者", value: run.signals["業者シグナル"] || 0, color: "var(--sig-red)" }
          ], { title: "シグナル", sub: `${run.succeeded}件` })}
          ${donut(Object.entries(stance).map(([k, v]) => ({ label: k, value: v, color: stanceColors[k] || "#C9BBAE" })),
            { title: "語りの向き", sub: `機械合格${run.machinePassed}` })}
        </div>
        ${String(run.reliability.verdict || "").startsWith("⚠")
          ? `<div class="note">判定保留が多いのはキャプション${run.reliability.avgCaptionLen}字取得が原因です(上の要対応アラート参照)。</div>` : ""}
      </div>` : ""}
    </div>
  </div>`;
}
