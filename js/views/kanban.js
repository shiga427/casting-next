/* パイプライン(カンバン)— 設計書§5-5。現行踏襲(ステータス列でのドラッグ)。
 * ・DM送付へのドラッグは適合コメント空でブロック(A5)
 * ・DM送付日から営業日カウントで返信期限を表示(祝日非対応は既知の制限として注記) */
import { state, markDirty } from "../store.js";
import { esc } from "../charts.js";
import { toast } from "../app.js";
import { totalOf, dmDue, setStatus } from "../pipeline/sbis.js";
import { STATUSES, TIER_LAB, STAGE_COLORS } from "../pipeline/conf.js";
import { todayISO } from "../pipeline/util.js";
import { open as openDetail } from "./detail.js";

export function render() {
  const cs = state.cands;
  return `
  <div class="head"><h1>パイプライン</h1>
    <span class="meta">カードはドラッグで隣の列に移せます。「DM送付」に入れた日が自動で記録され、5営業日で催促アラートが出ます</span></div>
  <div class="card" style="padding:12px">
    <div class="pbar">${STATUSES.map((s, i) => {
      const n = cs.filter(c => c.status === s).length;
      return `<div title="${esc(s)} ${n}" style="width:${(n / Math.max(cs.length, 1) * 100)}%;background:${STAGE_COLORS[i]}"></div>`;
    }).join("")}</div>
    <div class="plegend">${STATUSES.map((s, i) => {
      const n = cs.filter(c => c.status === s).length;
      return `<span><span class="sw" style="background:${STAGE_COLORS[i]}"></span>${esc(s)} <b>${n}</b></span>`;
    }).join("")}</div>
  </div>
  <div class="kanban">${STATUSES.map(s => {
    const cards = cs.filter(c => c.status === s).sort((a, b) => (totalOf(b) ?? -1) - (totalOf(a) ?? -1));
    return `<div class="kcol" data-s="${esc(s)}">
      <h4>${esc(s)}<span>${cards.length}</span></h4>
      ${cards.map(c => {
        const d = dmDue(c, todayISO());
        return `<div class="kcard" draggable="true" data-u="${esc(c.username)}">
          <div class="h">@${esc(c.username)}</div>
          <div class="m">${esc(c.score ? TIER_LAB[c.score.tier] : "")}${c.slot ? " · " + esc(c.slot) : ""} / ${totalOf(c) ?? "—"}点</div>
          ${c.growth && c.growth.kind ? `<div class="m" style="color:var(--green);font-weight:600">連載枠適格(${esc(c.growth.kind)})</div>` : ""}
          ${d && (d.kind === "remind" || d.kind === "close") ? `<div class="m" style="color:var(--red);font-weight:600">${esc(d.label)}</div>` : ""}
        </div>`;
      }).join("")}
    </div>`;
  }).join("")}</div>
  <div class="note">営業日カウントは祝日非対応です(既知の制限・設計書§11-4)。</div>`;
}

export function mount() {
  document.querySelectorAll(".kcard").forEach(k => {
    k.onclick = () => openDetail(k.dataset.u);
    k.ondragstart = e => { e.dataTransfer.setData("text/plain", k.dataset.u); e.dataTransfer.effectAllowed = "move"; k.classList.add("drag"); };
    k.ondragend = () => k.classList.remove("drag");
  });
  document.querySelectorAll(".kcol").forEach(col => {
    col.ondragover = e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; col.classList.add("over"); };
    col.ondragleave = () => col.classList.remove("over");
    col.ondrop = e => {
      e.preventDefault(); col.classList.remove("over");
      const u = e.dataTransfer.getData("text/plain");
      const c = state.cands.find(x => x.username === u);
      if (!c || c.status === col.dataset.s) return;
      const r = setStatus(c, col.dataset.s, todayISO());
      if (!r.ok) { toast("@" + c.username + ": " + r.reason, true); return; }
      markDirty();
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    };
  });
}
