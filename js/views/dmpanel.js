/* 一括DMパネル(設計書_DM自動一括送付 §2-2)。detail.js の overlay と同じ作法で #ovDm を作る。
 *
 * ★送る前に人が全文を確認・修正できることが、この画面の存在理由(§0-1 不可逆性)。
 * ★ガードで外れた候補は「黙って落とさず」理由付きで見せる(§6-3)。
 * ★このパネルは localStorage に送付キューを書くだけ。Instagram には一切アクセスしない。
 */
import { state } from "../store.js";
import { esc } from "../charts.js";
import { toast } from "../app.js";
import { autoAllowed, buildCdpDm, cdpDmSummary, exportCdpDm } from "../pipeline/cdpDm.js";
import { composeDmBatch } from "../pipeline/dmCompose.js";
import { DM_DAILY_CAP, DM_MAX_WAIT, DM_MIN_WAIT, DM_PER_MIN_MAX, TIER_LAB } from "../pipeline/conf.js";
import { totalOf } from "../pipeline/sbis.js";

let cands = [];
const texts = new Map();     /* handle → 人が直した本文。セッション内のみ */
const drop = new Set();      /* 「この候補を送付から外す」 */
let mode = "semi";           /* 既定は半自動(§5-1) */
/* 直近のドライランが通ったか(§5-1 の auto 解禁条件)。拡張から結果が返ったときだけ true になる */
let dryRun = { passed: false, at: "", n: 0 };

/* app.js が拡張の結果を反映したときに呼ぶ。ドライランの成否をここで覚える */
export function noteDmResult(payload) {
  const p = payload || {};
  if (!p.dryRun) return;
  const rows = p.results || [];
  const bad = rows.filter(r => String(r.result || "").startsWith("failed")).length;
  dryRun = { passed: rows.length > 0 && bad === 0 && !p.stopped, at: p.at || "", n: rows.length };
}

export function open(list) {
  cands = (list || []).slice();
  if (!cands.length) { toast("候補ボードで候補をチェックしてください", true); return; }
  texts.clear(); drop.clear(); mode = "semi";
  let ov = document.getElementById("ovDm");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "ovDm";
    ov.className = "overlay";
    document.body.appendChild(ov);
    ov.addEventListener("click", e => { if (e.target === ov) close(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && ov.classList.contains("open")) close(); });
  }
  render();
  ov.classList.add("open");
}

export function close() {
  const ov = document.getElementById("ovDm");
  if (ov) ov.classList.remove("open");
}

function current() {
  return composeDmBatch(cands, { texts: Object.fromEntries(texts), drop: [...drop], conf: state.conf });
}

function render() {
  const ov = document.getElementById("ovDm");
  if (!ov) return;
  const { items, excluded } = current();
  const payload = buildCdpDm(cands, { texts: Object.fromEntries(texts), drop: [...drop], conf: state.conf, mode, at: "preview" });
  /* endpointVerified は実機検証で false 固定（cdpDm.AUTO_BLOCKED_REASON）。
   全自動は送信APIが存在しないため選べない。半自動が上限 */
  const auto = autoAllowed(payload, { dryRunPassed: dryRun.passed, endpointVerified: false });

  ov.innerHTML = `<div class="modal">
    <div class="mhead">
      <h3>一括DM ${items.length}件</h3>
      <span class="tag st">${mode === "auto" ? "全自動" : "半自動"}</span>
      ${excluded.length ? `<span class="tag red">除外 ${excluded.length}件</span>` : ""}
      <button class="x" id="dmClose">×</button>
    </div>
    <div class="mbody" style="grid-template-columns:1fr">
      <div class="ng-hit" style="background:var(--amber-bg);color:#8F6A1F">
        <b>送ったDMは取り消せません。</b>全文を読んでから進めてください。
        レートは ${DM_MIN_WAIT / 1000}〜${DM_MAX_WAIT / 1000}秒間隔・1分あたり${DM_PER_MIN_MAX}通・1日${DM_DAILY_CAP}件が上限で、パネルから緩めることはできません(§6-1/§6-2)。
      </div>

      <h4>1. 送付対象(${items.length}件)</h4>
      ${items.length ? items.map(it => card(it)).join("") : `<div class="empty">送付できる候補がありません。下の除外理由をご確認ください。</div>`}

      <h4>2. 除外された候補(${excluded.length}件)</h4>
      ${excluded.length ? `<div class="breakdown">${excluded.map(x =>
        `<div class="r"><span>@${esc(x.handle)}${drop.has(x.handle.toLowerCase()) || drop.has(x.handle)
          ? ` <button class="btn ghost sm" data-dmundrop="${esc(x.handle)}">戻す</button>` : ""}</span>
          <b>${esc(x.reasons.join(" / "))}</b></div>`).join("")}</div>`
        : `<div class="hint">除外された候補はありません。</div>`}

      <h4>3. 送付モード</h4>
      <div class="frow"><label><input type="radio" name="dmMode" value="semi" ${mode === "semi" ? "checked" : ""}>
        半自動(既定) — 拡張は下書きを入れるところまで。<b>送信ボタンは人が押します</b></label></div>
      <div class="frow"><label><input type="radio" name="dmMode" value="auto" ${mode === "auto" ? "checked" : ""} ${auto.ok ? "" : "disabled"}>
        全自動 — 送信まで拡張が行います</label></div>
      ${auto.ok ? `<div class="ok-hit">全自動の条件を満たしています。それでも初回は1件から始めてください(§9-5)。</div>`
      : `<div class="ng-hit">全自動が選べない理由:${auto.why.map(esc).join(" / ")}</div>`}

      <div class="full toolrow" style="justify-content:flex-end">
        <span class="hint" style="margin-right:auto">${esc(cdpDmSummary(payload))}</span>
        <button class="btn ghost sm" id="dmDry" ${items.length ? "" : "disabled"}>ドライラン(送らずに検証)</button>
        <button class="btn" id="dmExport" ${items.length ? "" : "disabled"}>送付キューを書き出す</button>
      </div>
      <div class="note">書き出したキューは拡張の「④ DM」タブから実行します。ダッシュボードは Instagram にアクセスしません。</div>
    </div></div>`;
  bind();
}

function card(it) {
  const c = cands.find(x => String(x.username).toLowerCase() === it.handle.toLowerCase()) || {};
  const sc = c.score || {};
  return `<div class="breakdown" style="margin-bottom:12px">
    <div class="r"><span><b>@${esc(it.handle)}</b> ${esc(TIER_LAB[sc.tier] || "")} / ${esc(it.slot || "枠未定")}</span>
      <b>${totalOf(c) ?? "—"}点</b></div>
    <div class="hint" style="margin:4px 0">差し込んだ最適化根拠:${it.basis.map(esc).join(" ／ ")}</div>
    <textarea rows="14" data-dmtext="${esc(it.handle)}">${esc(it.text)}</textarea>
    <label class="hint"><input type="checkbox" data-dmdrop="${esc(it.handle)}"> この候補を送付から外す</label>
  </div>`;
}

function bind() {
  const $ = id => document.getElementById(id);
  $("dmClose").onclick = close;
  document.querySelectorAll("[data-dmtext]").forEach(ta => {
    ta.oninput = () => texts.set(ta.dataset.dmtext, ta.value);
  });
  document.querySelectorAll("[data-dmdrop]").forEach(cb => {
    cb.onchange = () => { drop.add(cb.dataset.dmdrop); render(); };
  });
  document.querySelectorAll("[data-dmundrop]").forEach(b => {
    b.onclick = () => { drop.delete(b.dataset.dmundrop); render(); };
  });
  document.querySelectorAll('input[name="dmMode"]').forEach(r => {
    r.onchange = () => { if (r.checked) { mode = r.value; render(); } };
  });
  $("dmDry").onclick = () => write(true);
  $("dmExport").onclick = () => write(false);
}

function write(isDry) {
  const p = exportCdpDm(cands, {
    texts: Object.fromEntries(texts), drop: [...drop], conf: state.conf, mode, dryRun: isDry,
  });
  if (!p.items.length) { toast("送付できる候補がありません", true); return; }
  toast(isDry
    ? `ドライランのキューを書き出しました(${p.items.length}件・送信しません)。拡張の「④ DM」タブで実行してください`
    : `送付キューを書き出しました(${cdpDmSummary(p)})。拡張の「④ DM」タブで実行してください`);
  close();
}
