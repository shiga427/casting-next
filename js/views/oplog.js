/* 運用ログ — 設計書§5-7(§7-1 事前承認制)。
 * 探索・除外・採点に指示書にない判断を加えるときは、**適用前に「提案中」で登録**し、
 * 承認を得てから実行する(run#1 の243件除外の教訓)。 */
import { state, markDirty } from "../store.js";
import { esc } from "../charts.js";

const STATES = ["提案中", "承認", "却下"];

export function render() {
  const pending = state.govLog.filter(g => g.state === "提案中").length;
  return `
  <div class="head"><h1>運用ログ</h1>
    <span class="meta">指示書外判断の記録(§7-1・事前承認制)。承認待ち ${pending}件</span></div>

  <div class="card">
    <p class="hint">探索・除外・採点に指示書にない判断を加えるときは、<b>適用前に「提案中」で登録</b>し、
      承認を得てから実行します(run#1 で243件を黙って除外した事故の再発防止)。</p>
    <div class="toolrow">
      <input type="text" id="govContent" placeholder="内容(例:ハンドル名にshop/storeを含むものを取得キューから除外)" style="flex:1;min-width:260px">
      <input type="text" id="govImpact" placeholder="件数影響(例:437件中243件)" style="width:200px">
      <select id="govState">${STATES.map(s => `<option>${s}</option>`).join("")}</select>
      <button class="btn sm" id="btnGovAdd">登録</button>
    </div>
  </div>

  <div class="card">
    ${state.govLog.length ? state.govLog.slice().reverse().map((g, ri) => {
      const i = state.govLog.length - 1 - ri;
      const col = g.state === "承認" ? "var(--green)" : g.state === "却下" ? "var(--sub)" : "var(--red)";
      return `<div class="logrow">
        <b style="color:${col}">${esc(g.state)}</b> ${esc(new Date(g.at).toLocaleString("ja-JP"))} — ${esc(g.content)}
        ${g.impact ? `<span class="pill">件数影響:${esc(g.impact)}</span>` : ""}
        <select class="govsel" data-i="${i}" style="font-size:11px;padding:2px 6px">
          ${STATES.map(s => `<option ${g.state === s ? "selected" : ""}>${s}</option>`).join("")}</select>
        <button class="btn ghost sm govdel" data-i="${i}">削除</button>
      </div>`;
    }).join("") : `<p class="hint">まだ登録はありません。</p>`}
  </div>`;
}

export function mount() {
  document.getElementById("btnGovAdd").onclick = () => {
    const c = document.getElementById("govContent").value.trim();
    if (!c) return;
    state.govLog.push({
      at: new Date().toISOString(), content: c,
      impact: document.getElementById("govImpact").value.trim(),
      state: document.getElementById("govState").value
    });
    markDirty();
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  };
  document.querySelectorAll(".govsel").forEach(s => s.onchange = () => {
    state.govLog[+s.dataset.i].state = s.value; markDirty();
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  document.querySelectorAll(".govdel").forEach(b => b.onclick = () => {
    state.govLog.splice(+b.dataset.i, 1); markDirty();
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}
