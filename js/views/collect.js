/* 収集(キューと依頼文)— 設計書§5-2・§8。AIブラウザ操作の入口。
 * ①キュー生成(rank_queue v2.6 移植・取得済み除外込み)
 * ②依頼文の生成とコピー(手順・禁止事項・ペース・中間チェックを内蔵)
 * ③結果ドロップ(ドロップ即解析 → 分析結果画面へ)
 * ④取得履歴(取得済み台帳はここで管理し、キュー生成時の除外に使う)
 */
import { state, addRun, markDirty } from "../store.js";
import { esc } from "../charts.js";
import { go } from "../router.js";
import { toast } from "../app.js";
import { analyzeRun, parseJsonl } from "../pipeline/ingest.js";
import { postscreen } from "../pipeline/postscreenBiz.js";
import { importCandidateCsv } from "../pipeline/schema.js";
import { rescoreAll } from "../pipeline/sbis.js";
import { EXT_COLUMNS, rowsToCsv } from "../pipeline/export.js";
import { buildQueue, readDoneHandles } from "../pipeline/rankQueue.js";
import { csvToObjects } from "../pipeline/util.js";

const PREP = [
  ["chrome", "Chrome を使っている(収集には Chrome 拡張が必要です)"],
  ["ext", "Claude の Chrome 拡張が入っていて、instagram.com でサイト権限が有効になっている"],
  ["login", "instagram.com にご自身のアカウントでログインしている"],
];

export function render() {
  const runs = state.runs;
  const q = state.queue || {};
  const done = doneSet();
  return `
  <div class="head"><h1>収集(キューと依頼文)</h1>
    <span class="meta">取得は利用者ご自身の Claude と Instagram アカウントで行います(設計書§8)。DM送信・フォロー・いいねは一切しません</span></div>

  <div class="cols">
    <div>
      <div class="card">
        <h3>① 今回の取得キュー<span class="r">取得済み ${done.size}件を自動で除外します</span></h3>
        <div class="toolrow">
          <label class="hint">件数 <input type="number" id="qLimit" value="${q.limit || 100}" min="1" max="500" style="width:80px"></label>
          <button class="btn" id="btnQueue">キューを作る</button>
          <button class="btn ghost sm" id="btnPool">プールCSVを読み込む</button>
          <input type="file" id="filePool" accept=".csv,.txt" style="display:none">
          <button class="btn ghost sm" id="btnDone">取得済み台帳CSVを読み込む</button>
          <input type="file" id="fileDone" accept=".csv" style="display:none">
        </div>
        <p class="hint">プールCSVは <code>handle,tags,likes</code> の列(探索で集めたハンドル一覧)。
          並べ替えは rank_queue v2.6(判断24:生活語+2 / レビュアー専業−2 / 法人語−8。除外はせず後回し)。</p>
        <div class="hint" id="qLog">${q.queue ? `プール ${q.poolSize}件 → 今回のキュー ${q.queue.length}件(生成 ${esc(String(q.at || "").slice(0, 16).replace("T", " "))})` : "プール未読み込み"}</div>
        ${q.queue && q.queue.length ? `<div class="tblwrap" style="max-height:260px;overflow:auto;margin-top:8px"><table>
          <thead><tr><th>#</th><th>ハンドル</th><th class="num">score</th><th>tags</th><th>why</th></tr></thead>
          <tbody>${q.queue.slice(0, 100).map((r, i) => `<tr><td class="num">${i + 1}</td>
            <td class="handle">@${esc(r.handle)}</td><td class="num">${r.score}</td>
            <td class="hint">${esc(String(r.tags).slice(0, 24))}</td><td class="hint">${esc(String(r.why).slice(0, 42))}</td></tr>`).join("")}</tbody>
        </table></div>` : ""}
      </div>

      <div class="card">
        <h3>② 依頼文<span class="r">これ1つで手順・禁止事項・ペース・中間チェックが全部入ります</span></h3>
        <div class="toolrow">
          <button class="btn" id="btnReq" ${q.queue && q.queue.length ? "" : "disabled"}>依頼文を作ってコピー</button>
          <button class="btn ghost sm" id="btnProbe">プローブ全文をコピー</button>
          <span class="hint">コピーしたら、ご自身の Claude に貼り付けてください</span>
        </div>
        <textarea id="reqText" rows="10" placeholder="「キューを作る」→「依頼文を作ってコピー」の順に押してください"></textarea>
      </div>

      <div class="card">
        <h3>③ 取得結果のドロップ<span class="r">.jsonl / 25列CSV</span></h3>
        <div class="drop" id="drop">
          ここに <b>${esc((state.queue && state.queue.runTag) || "run")}_compact.jsonl</b> をドラッグ&amp;ドロップ(またはクリックして選択)<br>
          <span class="hint">ドロップした瞬間にブラウザ内で解析します。ファイルはどこにも送信されません。</span>
          <input type="file" id="file" accept=".jsonl,.json,.csv,.txt" multiple style="display:none">
        </div>
        <div class="hint" id="log"></div>
      </div>
    </div>

    <div>
      <div class="card">
        <h3>準備チェック(初回だけ)</h3>
        ${PREP.map(([k, label]) => `<label class="check" style="display:block"><input type="checkbox" class="prep" data-k="${k}"
          ${(state.queue && state.queue.prep || {})[k] ? "checked" : ""}> ${esc(label)}</label>`).join("")}
        <div class="note">拡張が繋がらないときは、拡張のインストール → サイト権限 → IGログイン の3点を順に確認してください(§8-5)。</div>
      </div>

      <div class="card">
        <h3>④ 取得履歴</h3>
        ${runs.length ? `<div class="tblwrap"><table>
          <thead><tr><th>run</th><th class="num">試行</th><th class="num">成功</th><th class="num">合格</th><th class="num">rate</th><th></th></tr></thead>
          <tbody>${runs.map(r => `<tr>
            <td><b>${esc(r.runTag)}</b><br><span class="hint">${esc(String(r.ingestedAt).slice(0, 10))}</span></td>
            <td class="num">${r.attempts}</td><td class="num">${r.succeeded}</td>
            <td class="num"><b>${r.machinePassed}</b></td><td class="num">${r.rateLimited || 0}</td>
            <td><button class="btn ghost sm" data-open="${esc(r.runTag)}">分析</button></td>
          </tr>`).join("")}</tbody></table></div>
          <div class="note">取得済み台帳:${done.size}件(過去 run の全ハンドル+読み込んだ台帳CSV)。キュー生成時に自動で除外されます。</div>`
        : `<div class="hint">まだ取得履歴がありません。</div>`}
      </div>
    </div>
  </div>`;
}

/* 取得済み台帳:過去 run の全ハンドル(username で照合。run#6 不具合1の修正を固定)+ 読み込んだ台帳 */
function doneSet() {
  const s = new Set();
  state.runs.forEach(r => (r.rows || []).forEach(row => s.add(String(row.username).toLowerCase())));
  ((state.queue && state.queue.doneExtra) || []).forEach(h => s.add(String(h).toLowerCase()));
  return s;
}

export function mount() {
  const $ = id => document.getElementById(id);
  const drop = $("drop"), file = $("file");
  drop.onclick = () => file.click();
  drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); readFiles(e.dataTransfer.files); };
  file.onchange = e => { readFiles(e.target.files); e.target.value = ""; };
  document.querySelectorAll("[data-open]").forEach(b => b.onclick = () => { state.activeRunTag = b.dataset.open; go("analysis"); });
  document.querySelectorAll(".prep").forEach(cb => cb.onchange = () => {
    state.queue = state.queue || {};
    state.queue.prep = { ...(state.queue.prep || {}), [cb.dataset.k]: cb.checked };
    markDirty();
  });

  $("btnPool").onclick = () => $("filePool").click();
  $("filePool").onchange = e => { readOne(e.target.files[0], loadPool); e.target.value = ""; };
  $("btnDone").onclick = () => $("fileDone").click();
  $("fileDone").onchange = e => { readOne(e.target.files[0], loadDone); e.target.value = ""; };
  $("btnQueue").onclick = makeQueue;
  $("btnReq").onclick = makeRequest;
  $("btnProbe").onclick = copyProbe;
}

function readFiles(files) { [...files].forEach(f => readOne(f, handleFile)); }
function readOne(f, fn) {
  if (!f) return;
  const r = new FileReader();
  r.onload = () => fn(String(r.result), f.name);
  r.readAsText(f, "utf-8");
}
function log(html) { const el = document.getElementById("qLog"); if (el) el.innerHTML = html; }

/* --- ①キュー ---------------------------------------------------------- */
function loadPool(text, name) {
  const { rows } = csvToObjects(text);
  const pool = rows.map(r => ({ handle: r.handle || r.username || "", tags: r.tags || "", likes: r.likes || "" }))
    .filter(r => r.handle);
  state.queue = { ...(state.queue || {}), pool, poolFile: name };
  markDirty();
  log(`✔ ${esc(name)}:プール ${pool.length}件を読み込みました。「キューを作る」を押してください`);
}
function loadDone(text, name) {
  const done = [...readDoneHandles(text)];
  state.queue = { ...(state.queue || {}), doneExtra: done };
  markDirty();
  log(`✔ ${esc(name)}:取得済み ${done.length}件を読み込みました${done.length ? "" : "(⚠ 1件も読めていません。列名 handle / username を確認してください)"}`);
}
function makeQueue() {
  const q = state.queue || {};
  if (!q.pool || !q.pool.length) { toast("先にプールCSVを読み込んでください", true); return; }
  const limit = Number(document.getElementById("qLimit").value) || 100;
  const res = buildQueue(q.pool, doneSet(), limit);
  const n = state.runs.length + 1;
  state.queue = { ...q, ...res, limit, runTag: "run" + n, at: new Date().toISOString() };
  markDirty();
  toast(`キューを作りました(${res.queue.length}件 / プール残 ${res.poolSize}件)`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/* --- ②依頼文 ---------------------------------------------------------- */
async function makeRequest() {
  const q = state.queue;
  if (!q || !q.queue || !q.queue.length) { toast("先にキューを作ってください", true); return; }
  const [tpl, ver] = await Promise.all([
    fetch("kit/request_template.md").then(r => r.text()),
    fetch("kit/version.json").then(r => r.json()).catch(() => ({ kit: "?" }))
  ]);
  const base = location.origin + location.pathname.replace(/[^/]*$/, "") + "kit";
  const handles = q.queue.map((r, i) => `${i + 1}. @${r.handle}${r.tags ? `(tags: ${String(r.tags).trim()})` : ""}`).join("\n");
  const text = tpl
    .replaceAll("{RUN_TAG}", q.runTag)
    .replaceAll("{COUNT}", String(q.queue.length))
    .replaceAll("{KIT_URL}", base)
    .replaceAll("{HANDLES}", handles)
    .replaceAll("{BAND_MIN}", (state.conf.microMin || 5000).toLocaleString("ja-JP"))
    .replaceAll("{BAND_MAX}", (state.conf.midMax || 100000).toLocaleString("ja-JP"))
    .replaceAll("{BRAND}", (state.project && state.project.name) || "")
    .replaceAll("{KIT_VERSION}", ver.kit || "?");
  document.getElementById("reqText").value = text;
  copy(text, "依頼文をコピーしました。ご自身の Claude に貼り付けてください");
}
async function copyProbe() {
  const [probe, prof] = await Promise.all([
    fetch("kit/ig_probe.js").then(r => r.text()),
    fetch("kit/prof_compact.js").then(r => r.text())
  ]);
  copy(`/* ① ig_probe.js — そのまま評価してください */\n${probe}\n\n/* ② prof_compact.js — そのまま評価してください */\n${prof}`,
    "プローブ全文をコピーしました(fetch できない環境用の代替経路です)");
}
function copy(text, msg) {
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast(msg), () => toast("コピーできませんでした。テキスト欄から手動でコピーしてください", true));
  else toast("このブラウザではコピーできません。テキスト欄から手動でコピーしてください", true);
}

/* --- ③ドロップ -------------------------------------------------------- */
export function handleFile(text, name) {
  if (/\.csv$/i.test(name)) return handleCsv(text, name);
  return handleJsonl(text, name);
}
function handleCsv(text, name) {
  const res = importCandidateCsv(text, state.cands, { runTag: guessTag(name) });
  if (!res.ok) { toast(res.message, true); return; }
  rescoreAll(state.cands, state.conf);
  markDirty();
  toast(`CSVを取り込みました(新規${res.added}件 / 更新${res.updated}件)`);
}
function guessTag(name) {
  const m = String(name).match(/run\s*_?(\d+)/i);
  if (m) return "run" + m[1];
  if (state.queue && state.queue.runTag && !state.runs.some(r => r.runTag === state.queue.runTag)) return state.queue.runTag;
  return "run" + (state.runs.length + 1);
}
function handleJsonl(text, name) {
  const runTag = guessTag(name);
  let run;
  try { run = analyzeRun(text, { runTag, sourceFile: name, now: new Date().toISOString() }); }
  catch (e) { toast("解析に失敗しました: " + e.message, true); return; }
  if (!run.succeeded) {
    const why = run.badLines.slice(0, 3).map(b => `${b.line}行目:${b.why}`).join(" / ");
    const el = document.getElementById("log");
    if (el) el.innerHTML = `⚠ 読めるレコードが1件もありません。${esc(why)}
      <button class="btn ghost sm" id="btnCopyErr">このエラーをコピー(Claudeに渡す用)</button>`;
    const b = document.getElementById("btnCopyErr");
    if (b) b.onclick = () => copy(run.badLines.map(x => `${x.line}行目: ${x.why}`).join("\n"), "エラー内容をコピーしました");
    toast("この形式は読めませんでした", true);
    return;
  }
  const { raws } = parseJsonl(text);
  run.bizQuarantined = postscreen(raws).rows;
  addRun(run);
  const csv = rowsToCsv(run.rows.filter(r => r.verdict === "passed").map(rowFromRun), EXT_COLUMNS);
  const res = importCandidateCsv(csv, state.cands, { runTag });
  rescoreAll(state.cands, state.conf);
  /* 取得済み台帳に積む(次回キューから自動で外れる) */
  markDirty();
  toast(`${runTag} を解析しました(機械合格 ${run.machinePassed}名 / 候補ボードへ ${res.added}件追加)`);
  go("analysis");
}
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
