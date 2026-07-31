/* 収集(キューと依頼文)— 設計書§5-2。
 * P2 で実装するのは③結果ドロップ(ドロップ即解析 → 分析結果画面へ自動遷移)と④取得履歴。
 * ①キュー生成・②依頼文の生成は P4。
 */
import { state, addRun, markDirty } from "../store.js";
import { esc } from "../charts.js";
import { go } from "../router.js";
import { toast } from "../app.js";
import { analyzeRun } from "../pipeline/ingest.js";
import { postscreen } from "../pipeline/postscreenBiz.js";
import { parseJsonl } from "../pipeline/ingest.js";
import { importCandidateCsv } from "../pipeline/schema.js";
import { rescoreAll } from "../pipeline/sbis.js";
import { extRow, EXT_COLUMNS, rowsToCsv } from "../pipeline/export.js";

export function render() {
  const runs = state.runs;
  return `
  <div class="head"><h1>収集(キューと依頼文)</h1>
    <span class="meta">取得は利用者ご自身の Claude と Instagram アカウントで行います(設計書§8)</span></div>

  <div class="card">
    <h3>③ 取得結果のドロップ<span class="r">.jsonl / 25列CSV</span></h3>
    <div class="drop" id="drop">
      ここに <b>run&lt;N&gt;_compact.jsonl</b> をドラッグ&amp;ドロップ(またはクリックして選択)<br>
      <span class="hint">ドロップした瞬間にブラウザ内で解析します。ファイルはどこにも送信されません。</span>
      <input type="file" id="file" accept=".jsonl,.json,.csv,.txt" multiple style="display:none">
    </div>
    <div class="hint" id="log"></div>
  </div>

  <div class="card">
    <h3>① キュー生成 / ② 依頼文の生成<span class="r">P4</span></h3>
    <p class="hint">rank_queue v2.6 の並べ替え(取得済み除外込み・列名バグ修正済み)と、
      プローブ入手先・手順・禁止事項を内蔵した依頼文の自動生成は <b>P4</b> で実装します。
      移植済みのロジックは <code>js/pipeline/rankQueue.js</code> にあります。</p>
  </div>

  <div class="card">
    <h3>④ 取得履歴</h3>
    ${runs.length ? `<div class="tblwrap"><table>
      <thead><tr><th>run</th><th>取込日時</th><th class="num">試行</th><th class="num">成功</th>
      <th class="num">帯内</th><th class="num">機械合格</th><th class="num">rate_limited</th><th>信頼性</th><th></th></tr></thead>
      <tbody>${runs.map(r => `<tr class="click" data-run="${esc(r.runTag)}">
        <td><b>${esc(r.runTag)}</b><br><span class="hint">${esc(r.sourceFile || "")}</span></td>
        <td>${esc(String(r.ingestedAt).slice(0, 16).replace("T", " "))}</td>
        <td class="num">${r.attempts}</td><td class="num">${r.succeeded}</td>
        <td class="num">${r.inBand}</td><td class="num"><b>${r.machinePassed}</b></td>
        <td class="num">${r.rateLimited || 0}</td>
        <td>${String(r.reliability.verdict || "").startsWith("⚠") ? `<span class="tag red">⚠ 低い(平均${r.reliability.avgCaptionLen}字)</span>` : "十分"}</td>
        <td><button class="btn ghost sm" data-open="${esc(r.runTag)}">分析結果を見る</button></td>
      </tr>`).join("")}</tbody></table></div>`
      : `<div class="empty">まだ取得履歴がありません。上の枠に取得結果をドロップしてください。</div>`}
  </div>`;
}

export function mount() {
  const drop = document.getElementById("drop");
  const file = document.getElementById("file");
  if (!drop) return;
  drop.onclick = () => file.click();
  drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); readFiles(e.dataTransfer.files); };
  file.onchange = e => { readFiles(e.target.files); e.target.value = ""; };
  document.querySelectorAll("[data-open]").forEach(b => b.onclick = () => {
    state.activeRunTag = b.dataset.open; go("analysis");
  });
}

function readFiles(files) {
  [...files].forEach(f => {
    const r = new FileReader();
    r.onload = () => handleFile(String(r.result), f.name);
    r.readAsText(f, "utf-8");
  });
}

function log(html) { const el = document.getElementById("log"); if (el) el.innerHTML = html; }

export function handleFile(text, name) {
  if (/\.csv$/i.test(name)) return handleCsv(text, name);
  return handleJsonl(text, name);
}

/* 過去 run の取り込み用に 25列CSV も引き続き受ける(§4-4) */
function handleCsv(text, name) {
  const res = importCandidateCsv(text, state.cands, { runTag: guessTag(name) });
  if (!res.ok) { toast(res.message, true); log(`⚠ ${esc(res.message)}`); return; }
  rescoreAll(state.cands, state.conf);
  markDirty();
  log(`✔ ${esc(name)}:新規 ${res.added}件 / 更新 ${res.updated}件(候補 ${res.total}件)`);
  toast(`CSVを取り込みました(新規${res.added}件)`);
}

function guessTag(name) {
  const m = String(name).match(/run\s*_?(\d+)/i);
  return m ? "run" + m[1] : "run" + (state.runs.length + 1);
}

function handleJsonl(text, name) {
  const runTag = guessTag(name);
  let run;
  try {
    run = analyzeRun(text, { runTag, sourceFile: name, now: new Date().toISOString() });
  } catch (e) {
    toast("解析に失敗しました: " + e.message, true);
    log(`⚠ ${esc(e.message)}`);
    return;
  }
  if (!run.succeeded) {
    const why = run.badLines.slice(0, 3).map(b => `${b.line}行目:${b.why}`).join(" / ");
    log(`⚠ 読めるレコードが1件もありません。${esc(why)}`);
    toast("この形式は読めませんでした", true);
    return;
  }
  /* 判断22:取得後の業者疑い隔離。**破棄せず**run に残して画面に出す */
  const { raws } = parseJsonl(text);
  const biz = postscreen(raws);
  run.bizQuarantined = biz.rows;

  addRun(run);
  /* 機械合格は候補ボードへ自動追加(§2 の1周の流れ⑤) */
  const csv = rowsToCsv(run.rows.filter(r => r.verdict === "passed").map(r => rowFromRun(r)), EXT_COLUMNS);
  const res = importCandidateCsv(csv, state.cands, { runTag });
  rescoreAll(state.cands, state.conf);
  markDirty();
  log(`✔ ${esc(name)}:試行 ${run.attempts} / 成功 ${run.succeeded} / 機械合格 ${run.machinePassed}件を候補ボードに追加(新規${res.added}・更新${res.updated})`);
  toast(`${runTag} を解析しました(機械合格 ${run.machinePassed}名)`);
  go("analysis");
}

/* run.rows(画面用)→ 拡張CSV行(候補ボードの取り込み形式)。列名で読ませる */
function rowFromRun(r) {
  return {
    account_url: r.account_url, username: "@" + r.username, full_name: r.full_name,
    followers: r.followers ?? "", engagement_rate: r.engagement_rate ?? "",
    avg_likes: r.avg_likes ?? "", avg_comments: r.avg_comments ?? "",
    genre: r.genre || "", has_external_link: r.has_external_link ? "TRUE" : "FALSE",
    external_url: r.external_url || "", bio: r.bio || "",
    matched_keywords: r.matched_keywords || "", discovered_via: r.discovered_via || "",
    scraped_at: "", following: r.following ?? "", ff_ratio: r.ff_ratio ?? "",
    select_reason: r.select_reason, fit_comment: r.fit_comment, fit_concern: r.fit_concern,
    qual_stance: r.qual_stance, qual_voice: r.qual_voice, qual_evidence: r.qual_evidence,
    qual_pr_posts: r.qual_pr_posts, qual_caption_len: r.qual_caption_len ?? "", qual_reliability: r.qual_reliability
  };
}
