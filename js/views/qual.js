/* 精査・定性評価 — 設計書§5-6(qual_report.py の画面化)。
 * ・対象は **スコア QUAL_MIN_SCORE 点以上の全員**(得点率の高い順)。1回あたりの人数上限は無い
 *   (2026-08-03: 旧「2名/回のレビュー枠」を撤廃。収集対象と精査対象が食い違い、
 *    同じ人が「対象」かつ「対象外」に見える自己矛盾を起こしていたため。人数の充足は拡張③の自動発掘の役目)
 * ・入力:captions / comments / profile の3ファイルをドロップ
 * ・自動生成部:語りの向き一次判定+引用+コメントのQ&Aペア+投稿の並び
 * ・人が書く欄:**未記入のまま「精査完了」にできない**(「空欄のまま提出しない」の強制化)
 *   ↑これは1人あたりの質の担保。人数上限とは別物なので残す
 */
import { state, markDirty } from "../store.js";
import { esc } from "../charts.js";
import { toast } from "../app.js";
import { buildReport, HUMAN_FIELDS, isComplete, toMarkdown, qualTargets } from "../pipeline/qualReport.js";
import { buildCdpQual, cdpQualSummary, exportCdpQual } from "../pipeline/cdpQual.js";
import { QUAL_MAX_COLLECT, QUAL_MIN_SCORE } from "../pipeline/conf.js";

const REQUEST_LIMIT = QUAL_MAX_COLLECT;   /* 依頼文1本にまとめる人数の上限(依頼文の長さの都合。精査人数の上限ではない) */
let draft = { handle: "", captionsText: "", commentsText: "", profileText: "", report: null };

function targets() {
  /* 対象 = スコア QUAL_MIN_SCORE 点以上(得点率の高い順)。収集対象も精査対象もこれ1つ */
  return qualTargets(state.cands);
}
function doneCount() {
  return state.cands.filter(c => c.qualReport && c.qualReport.done).length;
}

export function render() {
  const list = targets();
  const cdp = buildCdpQual(state.cands, { tags: (state.queue && state.queue.tags) || [] });
  const reports = state.cands.filter(c => c.qualReport);
  const r = draft.report;
  return `
  <div class="head"><h1>精査・定性評価</h1>
    <span class="meta">対象 スコア${QUAL_MIN_SCORE}点以上 ${list.length}名 / 精査完了 ${doneCount()}名</span></div>

  <div class="cols">
    <div>
      <div class="card">
        <h3>⓪ 精査データを集めてもらう<span class="r">${Math.min(REQUEST_LIMIT, list.length)}名ぶんをまとめて依頼</span></h3>
        <p class="hint">精査には「キャプション全文・コメント欄・bio全文」が要ります(取得時の140字では足りません)。
          <b>${esc(cdpQualSummary(cdp))}</b><br>
          この依頼文に載るのは<b>現在の${QUAL_MIN_SCORE}点以上だけ</b>です(不足分の自動発掘は拡張③の経路でのみ動きます)。</p>
        <div class="toolrow">
          <button class="btn" id="btnQualReq" ${list.length ? "" : "disabled"}>精査データ依頼文を作ってコピー</button>
          <span class="hint">${list.length ? `対象:${list.slice(0, REQUEST_LIMIT).map(c => "@" + esc(c.username)).join("、")}` : `${QUAL_MIN_SCORE}点以上の候補がいません（発掘で母数を足してください）`}</span>
        </div>
        <textarea id="qualReqText" rows="8" placeholder="ボタンを押すとここに出ます(コピー済み)"></textarea>
      </div>

      <div class="card">
        <h3>① 精査データ(3ファイル)をドロップ<span class="r">captions / comments / profile</span></h3>
        <div class="drop" id="dropQual">
          <b>&lt;handle&gt;_captions.txt</b> / <b>_comments.txt</b> / <b>_profile.txt</b> をまとめてドロップ<br>
          <span class="hint">形式は依頼文の「精査データの収集」で指定したもの。ファイル名からハンドルを読みます。</span>
          <input type="file" id="fileQual" accept=".txt,.md" multiple style="display:none">
        </div>
        <div class="hint" id="qLog">${draft.handle ? `対象:@${esc(draft.handle)} / captions ${draft.captionsText ? "✓" : "—"} comments ${draft.commentsText ? "✓" : "—"} profile ${draft.profileText ? "✓" : "—"}` : ""}</div>
        ${draft.captionsText ? `<div class="toolrow" style="margin-top:8px"><button class="btn" id="btnBuild">下書きを作る</button></div>` : ""}
      </div>

      ${r ? reportCard(r) : ""}
    </div>

    <div>
      <div class="card">
        <h3>精査待ち(${QUAL_MIN_SCORE}点以上・高い順)</h3>
        ${list.slice(0, QUAL_MAX_COLLECT).map((c, i) => `<div class="rowitem">
          <span class="rk">${i + 1}</span><span class="h">@${esc(c.username)}</span>
          ${c.qualReport ? `<span class="tag ${c.qualReport.done ? "g" : "res"}">${c.qualReport.done ? "精査済" : "下書き"}</span>` : ""}
          <span class="sc">${c.score.total}点</span></div>`).join("") || `<div class="hint">${QUAL_MIN_SCORE}点以上の精査待ちはいません。①発掘で母数を足してください。</div>`}
        ${list.length > QUAL_MAX_COLLECT ? `<div class="hint">…他 ${list.length - QUAL_MAX_COLLECT} 名</div>` : ""}
        <div class="note">スコア${QUAL_MIN_SCORE}点以上を全員、得点率の高い順に精査します。</div>
      </div>

      ${reports.length ? `<div class="card">
        <h3>保存済みの定性評価</h3>
        ${reports.map(c => `<div class="rowitem"><span class="h">@${esc(c.username)}</span>
          <span class="tag ${c.qualReport.done ? "g" : "res"}">${c.qualReport.done ? "完了" : "未完了"}</span>
          <span class="sc"><button class="btn ghost sm" data-md="${esc(c.username)}">md書き出し</button></span></div>`).join("")}
      </div>` : ""}
    </div>
  </div>`;
}

function reportCard(r) {
  const complete = isComplete(r);
  return `
  <div class="card">
    <h3>② 機械が用意した証拠:@${esc(r.handle)}<span class="r">結論は人が書きます</span></h3>
    <div class="breakdown">
      <div class="r"><span>語りの向き(一次判定)</span><b>${esc(r.stance.verdict)}</b></div>
      <div class="r"><span>当事者スコア / 権威スコア</span><b>${r.stance.witness} / ${r.stance.authority}</b></div>
      <div class="r"><span>PR表記のある投稿</span><b>${r.pr.posts}/${r.pr.total}${r.pr.overGate ? "(T1の50%ゲート違反)" : ""}</b></div>
      <div class="r"><span>キャプション平均</span><b>${r.captionAvg}字(${esc(r.reliability)})</b></div>
      <div class="r"><span>コメント</span><b>読者${r.comments.readers} / 本人返信${r.comments.own}(ユニーク${r.comments.uniqueOwn})</b></div>
    </div>
    ${r.stance.why.length ? `<div class="hint">${r.stance.why.map(esc).join("<br>")}</div>` : ""}

    <h4 style="margin-top:14px">本文からの引用</h4>
    ${Object.entries(r.quotes).filter(([, q]) => q.length).map(([k, q]) =>
      `<div style="margin:6px 0"><b style="font-size:11.5px">${esc(k)}</b>(${q.length}件)
      ${q.map(s => `<div class="hint" style="margin-left:8px">「${esc(s)}」</div>`).join("")}</div>`).join("")
      || `<div class="hint">引用を1件も拾えませんでした(キャプションが短い/カタログ型の可能性)。</div>`}

    ${r.comments.pairs.length ? `<h4>読者の質問 → 本人の返信</h4>
      ${r.comments.pairs.map(p => `<div class="rowitem" style="display:block">
        <div class="hint">読者:${esc(p.reader)}</div>
        <div><b>本人:${esc(p.own)}</b></div></div>`).join("")}`
      : (r.source.comments ? "" : `<div class="ng-hit">コメント未取得。<b>定性評価はここが本体です。</b>必ず取ってからやり直してください。</div>`)}

    <h4>③ 人が書く欄(未記入では完了にできません)</h4>
    ${HUMAN_FIELDS.map(([k, label]) => `<div style="margin:8px 0">
      <label class="hint">${esc(label)}</label>
      <textarea data-human="${k}" rows="${k === "charm" || k === "concern" ? 2 : 3}">${esc(r.human[k])}</textarea>
    </div>`).join("")}
    <div class="toolrow">
      <button class="btn" id="btnDone" ${complete ? "" : "disabled"}>精査完了にする</button>
      <button class="btn ghost sm" id="btnSaveDraft">下書きを保存</button>
      <button class="btn ghost sm" id="btnMd">mdで書き出す</button>
      ${complete ? "" : `<span class="hint">未記入の欄があります(${HUMAN_FIELDS.filter(([k]) => !String(r.human[k] || "").trim()).length}件)</span>`}
    </div>
  </div>`;
}

/* 精査データ収集の依頼文(§8-3 の精査データ収集節を上位N名で埋めたもの) */
async function makeQualRequest() {
  const list = targets().slice(0, REQUEST_LIMIT);
  if (!list.length) { toast(`${QUAL_MIN_SCORE}点以上の候補がいません`, true); return; }
  const [tpl, ver] = await Promise.all([
    fetch("kit/qual_request_template.md").then(r => r.text()),
    fetch("kit/version.json").then(r => r.json()).catch(() => ({ kit: "?" }))
  ]);
  const base = location.origin + location.pathname.replace(/[^/]*$/, "") + "kit";
  const handles = list.map((c, i) => {
    const sc = c.score || {};
    const stance = c.qualStance ? ` / 語りの向き(一次判定): ${String(c.qualStance).split("(")[0]}` : "";
    return `${i + 1}. @${c.username}(得点率 ${sc.rate}%${sc.mode === "rescue" ? "・救済採点" : ""}`
      + ` / フォロワー ${c.followers == null ? "不明" : Number(c.followers).toLocaleString("ja-JP")}${stance})`;
  }).join("\n");
  const text = tpl
    .replaceAll("{COUNT}", String(list.length))
    .replaceAll("{HANDLES}", handles)
    .replaceAll("{KIT_URL}", base)
    .replaceAll("{BRAND}", (state.project && state.project.name) || "")
    .replaceAll("{KIT_VERSION}", ver.kit || "?");
  document.getElementById("qualReqText").value = text;
  copyText(text, `精査データ依頼文をコピーしました(${list.length}名ぶん)`);
}

function copyText(text, msg) {
  const fallback = () => {
    const ta = document.getElementById("qualReqText");
    if (ta) {
      ta.value = text; ta.focus(); ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      if (ok) { toast(msg); return; }
    }
    toast("自動コピーができませんでした。下のテキスト欄を選択してコピーしてください", true);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast(msg), fallback);
  else fallback();
}

export function mount() {
  /* 拡張の「③精査データ収集」向けに、精査待ち・不足人数・発掘プランを localStorage に出す。
   * 本体は js/pipeline/cdpQual.js（取得結果のマージ直後にも同じものが呼ばれる）。 */
  exportCdpQual(state.cands, { tags: (state.queue && state.queue.tags) || [] });
  const qreq = document.getElementById("btnQualReq");
  if (qreq) qreq.onclick = makeQualRequest;
  const drop = document.getElementById("dropQual"), file = document.getElementById("fileQual");
  drop.onclick = () => file.click();
  drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); read(e.dataTransfer.files); };
  file.onchange = e => { read(e.target.files); e.target.value = ""; };

  const build = document.getElementById("btnBuild");
  if (build) build.onclick = () => {
    draft.report = buildReport(draft);
    const existing = state.cands.find(c => c.username === draft.handle);
    if (existing && existing.qualReport) draft.report.human = { ...draft.report.human, ...existing.qualReport.human };
    rerender();
  };

  document.querySelectorAll("[data-human]").forEach(t => t.oninput = () => {
    if (draft.report) draft.report.human[t.dataset.human] = t.value;
    const btn = document.getElementById("btnDone");
    if (btn) btn.disabled = !isComplete(draft.report);
  });
  const done = document.getElementById("btnDone");
  if (done) done.onclick = () => {
    if (!isComplete(draft.report)) { toast("人が書く欄を全部埋めてください(空欄のまま提出しない)", true); return; }
    draft.report.done = true;
    saveReport();
    toast(`@${draft.report.handle} の定性評価を保存しました`);
    rerender();
  };
  const sd = document.getElementById("btnSaveDraft");
  if (sd) sd.onclick = () => { saveReport(); toast("下書きを保存しました"); };
  const md = document.getElementById("btnMd");
  if (md) md.onclick = () => dlMd(draft.report);
  document.querySelectorAll("[data-md]").forEach(b => b.onclick = () => {
    const c = state.cands.find(x => x.username === b.dataset.md);
    if (c && c.qualReport) dlMd(c.qualReport);
  });
}

function saveReport() {
  const c = state.cands.find(x => x.username === draft.report.handle);
  if (!c) { toast("候補ボードにいないハンドルです。先に取得結果を取り込んでください", true); return; }
  c.qualReport = draft.report;
  /* 語りの向きの履歴(再取得で変わったとき追跡できるように・§4-2) */
  c.stanceHistory = c.stanceHistory || [];
  c.stanceHistory.push({ at: draft.report.generatedAt, stance: draft.report.stance.verdict });
  c.qualStance = draft.report.stance.verdict;
  if (draft.report.done && c.status === "候補") c.status = "精査済";
  markDirty();
}

function dlMd(report) {
  const blob = new Blob([toMarkdown(report)], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `定性評価_${report.handle}.md`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function read(files) {
  const arr = [...files];
  arr.forEach(f => {
    const m = f.name.match(/^(?:定性_|精査_)?(.+?)_(captions|comments|profile)\.txt$/i);
    if (!m) { toast(`ファイル名から種別が読めません: ${f.name}`, true); return; }
    const [, handle, kind] = m;
    if (draft.handle && draft.handle !== handle) draft = { handle: "", captionsText: "", commentsText: "", profileText: "", report: null };
    draft.handle = handle;
    const r = new FileReader();
    r.onload = () => {
      draft[kind + "Text"] = String(r.result);
      rerender();
    };
    r.readAsText(f, "utf-8");
  });
}

function rerender() { window.dispatchEvent(new HashChangeEvent("hashchange")); }
