/* 収集(発掘と取得)— 設計書§5-2・§8。
 *
 * ★2026-08-03: 「依頼文を作って Claude に貼る」旧フローは撤去した。
 * 収集は **Casting Next 拡張(extension/)** が instagram.com のタブで行い、
 * この画面は「拡張へ渡す条件を決める」「拡張が返した結果を受け取る」だけを担う。
 *
 * 2モード:
 *  ①「発掘から始める」 プール不要。探索タグ(E1)を選ぶ → 拡張の「①発掘して収集」。初めての人の既定
 *  ②「プールから取得」 プールから rank_queue v2.6 でキューを作る → 拡張の「②プールから取得」。2周目以降
 *
 * 受け渡し口:
 *  - 渡す: localStorage の castnext_cdp_discover / castnext_cdp_queue（拡張の popup が読む）
 *  - 受ける: **`<input type="file" id="file">`**。拡張の background.js が DataTransfer で
 *    ここへ注入して自動反映する。★この input と change ハンドラを消すと収集が全部死ぬ
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
import { absorbRun, discoveryTags } from "../pipeline/discovery.js";
import { cdpQualSummary, exportCdpQual } from "../pipeline/cdpQual.js";

const PREP = [
  ["chrome", "Chrome を使っている(収集には Chrome 拡張が必要です)"],
  ["ext", "Casting Next 拡張(extension/ をデベロッパーモードで読み込み)が入っていて、instagram.com でサイト権限が有効になっている"],
  ["login", "instagram.com にご自身のアカウントでログインしている"],
];

/* localStorage に最後に書き出した時刻を「最終送信 HH:MM」で見せる。
 * 拡張へちゃんと渡っているかを、拡張を開かずに目視できるようにするため */
function lastSentAt(key) {
  try {
    const at = JSON.parse(localStorage.getItem(key) || "{}").at;
    if (!at) return "";
    const d = new Date(at);
    if (isNaN(d)) return "";
    return `最終送信 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch (e) { return ""; }
}

let preset = null;
async function loadPreset() {
  if (preset) return preset;
  try { preset = await fetch("presets/stembeaute_v26.json").then(r => r.json()); }
  catch (e) { preset = { search: { e1_tags: [], e1_life_tags: [] } }; }
  return preset;
}
/* プリセット読み込み前でも描画できるよう、直近の結果をキャッシュしておく */
let tagCache = [];

function currentMode() {
  const m = new URLSearchParams((location.hash.split("?")[1] || "")).get("mode");
  if (m) return m;
  /* 既定:プールを持っていない人は「発掘から始める」 */
  return (state.queue && state.queue.pool && state.queue.pool.length) ? "pool" : "discover";
}

export function render() {
  const mode = currentMode();
  return `
  <div class="head"><h1>収集(発掘と取得)</h1>
    <span class="meta">取得は Casting Next 拡張が、ご自身の Chrome とログイン中の Instagram アカウントで行います。DM送信・フォロー・いいねは一切しません</span>
    <div class="runsel">
      <a class="chip ${mode === "discover" ? "on" : ""}" href="#/collect?mode=discover">① 発掘から始める</a>
      <a class="chip ${mode === "pool" ? "on" : ""}" href="#/collect?mode=pool">② プールから取得</a>
    </div>
  </div>

  <div class="cols">
    <div>
      ${mode === "discover" ? discoverCard() : poolCard()}

      <div class="card">
        <h3>取得結果の取り込み<span class="r">拡張から自動で入ります</span></h3>
        <div class="drop" id="drop">
          <b>拡張が収集を終えるとここに自動で入ります。</b>手動で .jsonl を入れることもできます<br>
          <span class="hint">手動のときは <b>${esc(nextRunTag())}_compact.jsonl</b> をドラッグ&amp;ドロップ(またはクリックして選択)。
            解析はこのブラウザの中だけで行い、ファイルはどこにも送信されません。</span>
          <input type="file" id="file" accept=".jsonl,.json,.csv,.txt" multiple style="display:none">
        </div>
        <div class="hint" id="log"></div>
      </div>
    </div>

    <div>
      <div class="card">
        <h3>準備チェック(初回だけ)</h3>
        ${PREP.map(([k, label]) => `<label class="check" style="display:block"><input type="checkbox" class="prep" data-k="${k}"
          ${((state.queue && state.queue.prep) || {})[k] ? "checked" : ""}> ${esc(label)}</label>`).join("")}
        <div class="note">拡張が繋がらないときは、拡張のインストール → サイト権限 → IGログイン の3点を順に確認してください(§8-5)。</div>
      </div>

      ${historyCard()}
    </div>
  </div>`;
}

/* ---- ① 発掘から始める(プール不要) ------------------------------------ */
function discoverCard() {
  const tags = tagCache.length ? tagCache : [];
  const chosen = (state.queue && state.queue.tags) || null;   // null = プリセットの既定(off でないタグ)
  const target = (state.queue && state.queue.target) || 100;
  const done = doneSet();
  return `
  <div class="card">
    <h3>① 発掘から始める<span class="r">プールがなくても始められます</span></h3>
    <p class="hint">プロジェクトの探索タグ(E1)から候補を集め、そのままプロフィール取得まで拡張が続けて行います。
      集まったハンドルは取得後に自動でプールへ入るので、2回目からは②も使えます。</p>

    ${tags.length ? `<div class="tagpick">
      ${tags.map(t => `<label class="tagbox"><input type="checkbox" class="tagchk" value="${esc(t.tag)}"
        ${(chosen ? chosen.includes(t.tag) : !t.off) ? "checked" : ""}> ${esc(t.tag)}
        ${t.life ? `<span class="tag g">生活</span>` : ""}
        ${t.purity == null ? "" : `<span class="tag ${t.purity >= 80 ? "g" : t.purity >= 50 ? "res" : "red"}">美容${t.purity}%</span>`}</label>`).join("")}
    </div>
    <div class="toolrow" style="margin-top:6px">
      <button class="btn ghost sm" id="btnAll">全選択</button>
      <button class="btn ghost sm" id="btnLife">生活文脈タグだけ</button>
      <label class="hint">目標件数 <input type="number" id="dTarget" value="${target}" min="10" max="300" style="width:80px"></label>
    </div>
    <div class="sendbox">
      <b>拡張に渡す準備</b>
      <div class="hint">選択中のタグ ${chosen ? chosen.length : tags.filter(t => !t.off).length}件 / 目標 ${target}件 /
        取得済み ${done.size}件は拡張へ渡す対象から除外されます</div>
      <div class="hint">→ <b>拡張ポップアップの「①発掘して収集」</b>を押してください（このページは開いたままに）</div>
      <div class="hint sent" id="dSent">${esc(lastSentAt("castnext_cdp_discover"))}</div>
    </div>
    <div class="note">生活文脈タグは行動タグの2倍の帯内率・2.5倍の有効率が出ています(run#6実測)。迷ったら生活文脈タグから。<br>
      「美容○%」はそのタグから拾えた人のうち美容ジャンルだった割合(本人環境405行の実測・2026-08-07)。
      <b>当選系と#購入品紹介は美容が8〜23%しかなく、残りは懸賞垢・アフィリ垢・ペット/旅行/グルメです。
      犬アカウントが出てくる入口はここなので既定でOFFにしています。</b></div>`
    : `<div class="hint">タグを読み込んでいます…</div>`}
  </div>`;
}

/* ---- ② プールから取得(現行フロー) ------------------------------------ */
function poolCard() {
  const q = state.queue || {};
  const done = doneSet();
  const hasPool = !!(q.pool && q.pool.length);
  return `
  <div class="card">
    <h3>② プールから取得<span class="r">取得済み ${done.size}件を自動で除外します</span></h3>
    ${hasPool ? "" : `<p class="hint">プールは「①発掘から始める」で取得すると自動で貯まります。
      過去に集めたハンドル一覧(<code>handle,tags,likes</code>)があれば読み込むこともできます。</p>`}
    <div class="toolrow">
      <label class="hint">件数 <input type="number" id="qLimit" value="${q.limit || 100}" min="1" max="500" style="width:80px"></label>
      <button class="btn" id="btnQueue">キューを作る</button>
      <button class="btn ghost sm" id="btnPool">プールCSVを読み込む</button>
      <input type="file" id="filePool" accept=".csv,.txt" style="display:none">
      <button class="btn ghost sm" id="btnDone">取得済み台帳CSVを読み込む</button>
      <input type="file" id="fileDone" accept=".csv" style="display:none">
    </div>
    <div class="hint" id="qLog">${hasPool
      ? `プール ${q.pool.length}件${q.queue ? ` → 今回のキュー ${q.queue.length}件(生成 ${esc(String(q.at || "").slice(0, 16).replace("T", " "))})` : ""}`
      : "プールは空です"}</div>
    ${q.queue && q.queue.length ? `<div class="tblwrap" style="max-height:240px;overflow:auto;margin-top:8px"><table>
      <thead><tr><th>#</th><th>ハンドル</th><th class="num">score</th><th>tags</th><th>why</th></tr></thead>
      <tbody>${q.queue.slice(0, 100).map((r, i) => `<tr><td class="num">${i + 1}</td>
        <td class="handle">@${esc(r.handle)}</td><td class="num">${r.score}</td>
        <td class="hint">${esc(String(r.tags).slice(0, 24))}</td><td class="hint">${esc(String(r.why).slice(0, 42))}</td></tr>`).join("")}</tbody>
    </table></div>` : ""}
    <div class="sendbox">
      <b>拡張に渡す準備</b>
      <div class="hint">${q.queue && q.queue.length
        ? `キュー ${q.queue.length}件を拡張へ渡しています`
        : "まず「キューを作る」を押してください（作った時点で拡張へ渡ります）"}</div>
      <div class="hint">→ <b>拡張ポップアップの「②プールから取得」</b>を押してください（このページは開いたままに）</div>
      <div class="hint sent" id="qSent">${esc(lastSentAt("castnext_cdp_queue"))}</div>
    </div>
  </div>`;
}

function historyCard() {
  const runs = state.runs;
  const done = doneSet();
  const cov = state.coverage.filter(r => r.st === "完了").length;
  return `<div class="card">
    <h3>取得履歴</h3>
    ${runs.length ? `<div class="tblwrap"><table>
      <thead><tr><th>run</th><th class="num">試行</th><th class="num">成功</th><th class="num">合格</th><th class="num">rate</th><th></th></tr></thead>
      <tbody>${runs.map(r => `<tr>
        <td><b>${esc(r.runTag)}</b><br><span class="hint">${esc(String(r.ingestedAt).slice(0, 10))}</span></td>
        <td class="num">${r.attempts}</td><td class="num">${r.succeeded}</td>
        <td class="num"><b>${r.machinePassed}</b></td><td class="num">${r.rateLimited || 0}</td>
        <td><button class="btn ghost sm" data-open="${esc(r.runTag)}">分析</button></td>
      </tr>`).join("")}</tbody></table></div>
      <div class="note">取得済み台帳:${done.size}件(過去 run の全ハンドル+読み込んだ台帳CSV)。
        探索カバレッジの完了行:${cov}件。どちらも取得結果のドロップで自動更新されます。</div>`
    : `<div class="hint">まだ取得履歴がありません。</div>`}
  </div>`;
}

/* 取得済み台帳:過去 run の全ハンドル(username で照合)+ 読み込んだ台帳 */
function doneSet() {
  const s = new Set();
  state.runs.forEach(r => (r.rows || []).forEach(row => s.add(String(row.username).toLowerCase())));
  ((state.queue && state.queue.doneExtra) || []).forEach(h => s.add(String(h).toLowerCase()));
  return s;
}
function nextRunTag() {
  if (state.queue && state.queue.runTag && !state.runs.some(r => r.runTag === state.queue.runTag)) return state.queue.runTag;
  return "run" + (state.runs.length + 1);
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

  if (currentMode() === "discover") mountDiscover();
  else mountPool();
}

/* ---- ① 発掘モード ------------------------------------------------------ */
async function mountDiscover() {
  const $ = id => document.getElementById(id);
  if (!tagCache.length) {
    tagCache = discoveryTags(await loadPreset());
    if (tagCache.length) { window.dispatchEvent(new HashChangeEvent("hashchange")); return; }
  }
  const chosen = () => [...document.querySelectorAll(".tagchk:checked")].map(c => c.value);
  document.querySelectorAll(".tagchk").forEach(c => c.onchange = () => {
    state.queue = { ...(state.queue || {}), tags: chosen() };
    exportCdpDiscover(chosen());
    markDirty();
  });
  if ($("btnAll")) $("btnAll").onclick = () => {
    document.querySelectorAll(".tagchk").forEach(c => { c.checked = true; });
    state.queue = { ...(state.queue || {}), tags: chosen() }; exportCdpDiscover(chosen()); markDirty();
  };
  if ($("btnLife")) $("btnLife").onclick = () => {
    const life = tagCache.filter(t => t.life).map(t => t.tag);
    document.querySelectorAll(".tagchk").forEach(c => { c.checked = life.includes(c.value); });
    state.queue = { ...(state.queue || {}), tags: chosen() }; exportCdpDiscover(chosen()); markDirty();
  };
  if ($("dTarget")) $("dTarget").onchange = () => {
    state.queue = { ...(state.queue || {}), target: Number($("dTarget").value) || 100 };
    exportCdpDiscover(chosen());
    markDirty();
  };
  exportCdpDiscover(chosen()); // 画面表示時点の選択を拡張へ渡す
}

/* ---- ② プールモード ---------------------------------------------------- */
function mountPool() {
  const $ = id => document.getElementById(id);
  $("btnPool").onclick = () => $("filePool").click();
  $("filePool").onchange = e => { readOne(e.target.files[0], loadPool); e.target.value = ""; };
  $("btnDone").onclick = () => $("fileDone").click();
  $("fileDone").onchange = e => { readOne(e.target.files[0], loadDone); e.target.value = ""; };
  $("btnQueue").onclick = makeQueue;
}

function readFiles(files) { [...files].forEach(f => readOne(f, handleFile)); }
function readOne(f, fn) {
  if (!f) return;
  const r = new FileReader();
  r.onload = () => fn(String(r.result), f.name);
  r.readAsText(f, "utf-8");
}
function log(html) { const el = document.getElementById("qLog"); if (el) el.innerHTML = html; }

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
/* 拡張(Casting Next 収集ツール)向けに、素のハンドル列を localStorage に書き出す。
 * 拡張の popup がここを読み、instagram.com のタブでボタン1回で収集する。
 * ダッシュボード自体の動作には影響しない（読む側が居なければ無害）。 */
function exportCdpQueue(q) {
  try {
    if (!q || !q.queue || !q.queue.length) return;
    localStorage.setItem("castnext_cdp_queue", JSON.stringify({
      runTag: q.runTag || "run",
      at: q.at || "",
      handles: q.queue.map(r => ({ handle: r.handle, tags: r.tags || "" })),
    }));
  } catch (e) { /* localStorage 不可の環境では黙ってスキップ */ }
}

/* 拡張の「①発掘して収集」向けに、選択中のタグ・目標件数・取得済みを localStorage に出す。
 * ダッシュボードの動作には影響しない（読む側が居なければ無害）。 */
function exportCdpDiscover(tags) {
  try {
    const lifeSet = new Set((tagCache || []).filter(t => t.life).map(t => t.tag));
    localStorage.setItem("castnext_cdp_discover", JSON.stringify({
      tags: (tags || []).map(t => ({ tag: t, life: lifeSet.has(t) })),
      target: Number((document.getElementById("dTarget") || {}).value) || 100,
      done: [...doneSet()],
      at: new Date().toISOString(),
    }));
  } catch (e) { /* localStorage 不可なら黙ってスキップ */ }
}

function makeQueue() {
  const q = state.queue || {};
  if (!q.pool || !q.pool.length) {
    toast("プールが空です。①発掘から始めるか、プールCSVを読み込んでください", true);
    return;
  }
  const limit = Number(document.getElementById("qLimit").value) || 100;
  const res = buildQueue(q.pool, doneSet(), limit);
  state.queue = { ...q, ...res, limit, mode: "pool", runTag: nextRunTag(), at: new Date().toISOString() };
  markDirty();
  exportCdpQueue(state.queue); // 拡張(extension/)がボタン収集に使う素のハンドル列を localStorage に出す
  toast(`キューを作りました(${res.queue.length}件 / プール残 ${res.poolSize}件)`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/* エラー内容などをコピーするための最小ヘルパ。
 * Clipboard API が使えない環境(権限なし・http 等)では一時 textarea + execCommand に落とす。 */
function copy(text, msg) {
  const fallback = () => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    ta.remove();
    toast(ok ? msg : "自動コピーができませんでした。手で選択してコピーしてください", !ok);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => toast(msg), fallback);
  } else fallback();
}

/* ---- ドロップ(共通) --------------------------------------------------- */
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
  return nextRunTag();
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
      <button class="btn ghost sm" id="btnCopyErr">このエラーをコピー</button>`;
    const b = document.getElementById("btnCopyErr");
    if (b) b.onclick = () => copy(run.badLines.map(x => `${x.line}行目: ${x.why}`).join("\n"), "エラー内容をコピーしました");
    toast("この形式は読めませんでした", true);
    return;
  }
  const { raws } = parseJsonl(text);
  run.bizQuarantined = postscreen(raws).rows;
  addRun(run);

  /* 発掘由来のハンドルをプール・取得済み台帳・探索カバレッジ表に取り込む(2周目以降のため) */
  const absorbed = absorbRun(run, {
    pool: (state.queue && state.queue.pool) || [],
    coverage: state.coverage,
    done: [...doneSet()]
  });
  state.queue = { ...(state.queue || {}), pool: absorbed.pool, doneExtra: absorbed.done };
  state.coverage = absorbed.coverage;

  const csv = rowsToCsv(run.rows.filter(r => r.verdict === "passed").map(rowFromRun), EXT_COLUMNS);
  const res = importCandidateCsv(csv, state.cands, { runTag });
  rescoreAll(state.cands, state.conf);
  /* ★マージ→60点以上の再判定は「ここ」が唯一のフック。
   * 発掘で足した候補が基準に届いたかを再採点直後に拡張へ返す(拡張はこれを見て発掘を続けるか決める)。 */
  const cdp = exportCdpQual(state.cands, {
    tags: (state.queue && state.queue.tags) || [],
    done: [...doneSet()],
  });
  markDirty();
  const qualNote = ` / 精査対象:${cdpQualSummary(cdp)}`;
  const tagNote = absorbed.tags.length
    ? ` / タグ別:${absorbed.tags.slice(0, 3).map(t => `${t.tag} ${t.fetched}件`).join("・")}`
    : "";
  toast(`${runTag} を解析しました(機械合格 ${run.machinePassed}名 / 候補ボードへ ${res.added}件追加`
    + `${absorbed.addedToPool ? ` / プールに ${absorbed.addedToPool}件` : ""}${tagNote}${qualNote})`);
  const logEl = document.getElementById("log");
  if (logEl) logEl.innerHTML = esc(`${runTag}: 精査対象 ${cdpQualSummary(cdp)}`);
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
