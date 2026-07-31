/* 探索カバレッジ — 設計書§5-7。この表の目的は**「未実行」を隠さないこと**。
 * 設計の半分が黙って落ちる事故(run#1)の再発防止装置。行は書き出しJSONに含まれる。
 * 変更点(§5-7):既定行はプロジェクト設定のキーワード群から生成する(ステムボーテ固定を解消)。 */
import { state, markDirty } from "../store.js";
import { esc } from "../charts.js";
import { COV_STATES } from "../pipeline/conf.js";
import { numOrNull } from "../pipeline/util.js";

let preset = null;
async function loadPreset() {
  if (preset) return preset;
  try { preset = await fetch("presets/stembeaute_v26.json").then(r => r.json()); }
  catch (e) { preset = { search: { e1_tags: [], e1_life_tags: [], e2_keywords: [] } }; }
  return preset;
}

export function render() {
  const rows = state.coverage;
  const todo = rows.filter(r => r.st === "未実行").length;
  const run = rows.filter(r => r.st === "実行中").length;
  const done = rows.filter(r => r.st === "完了").length;
  const sumCol = rows.reduce((s, r) => s + (numOrNull(r.collected) || 0), 0);
  const sumGot = rows.reduce((s, r) => s + (numOrNull(r.fetched) || 0), 0);
  return `
  <div class="head"><h1>探索カバレッジ</h1>
    <span class="meta">毎セッション報告義務(§2-5)。未実行を隠さないための表です</span>
    <div class="runsel"><span class="meta">${rows.length ? `未実行 ${todo} / 実行中 ${run} / 完了 ${done} — 収集計 ${sumCol.toLocaleString("ja-JP")} / 取得済計 ${sumGot.toLocaleString("ja-JP")}` : ""}</span></div>
  </div>

  <div class="card">
    <div class="toolrow">
      <select id="covRoute"><option>E1</option><option>E2</option><option>E3</option><option>E4</option></select>
      <input type="text" id="covTerm" placeholder="語/タグ/シード(例 #購入品紹介)" style="width:260px">
      <button class="btn sm" id="btnCovAdd">行を追加</button>
      <button class="btn ghost sm" id="btnCovSeed">プロジェクトのキーワードから既定行を投入</button>
    </div>
    <p class="hint">E3(関連アカウント辿り)は現行経路では不可、E2は1語5件上限という既知の制限があります(§11-4・§13)。</p>
  </div>

  <div class="card" style="padding:0">
    <div class="tblwrap"><table>
      <thead><tr><th style="width:70px">経路</th><th>語/タグ</th><th class="num" style="width:110px">収集数</th>
      <th class="num" style="width:110px">取得済</th><th style="width:130px">状態</th><th style="width:60px"></th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr>
        <td>${esc(r.route)}</td>
        <td><input type="text" data-i="${i}" data-f="term" value="${esc(r.term)}" style="width:100%"></td>
        <td><input type="number" data-i="${i}" data-f="collected" value="${esc(r.collected)}" style="width:100%"></td>
        <td><input type="number" data-i="${i}" data-f="fetched" value="${esc(r.fetched)}" style="width:100%"></td>
        <td><select data-i="${i}" data-f="st">${COV_STATES.map(s => `<option ${r.st === s ? "selected" : ""}>${s}</option>`).join("")}</select></td>
        <td><button class="btn ghost sm covdel" data-i="${i}">削除</button></td>
      </tr>`).join("")}</tbody>
    </table></div>
    ${rows.length ? "" : `<div class="empty">まだ行がありません。「既定行を投入」で E1/E2 の探索計画を一括作成できます。</div>`}
  </div>

  <div class="card">
    <h3>副産物の記録</h3>
    <div class="toolrow">
      <label class="hint">brand疑いリスト件数(§2-2で隔離した数)<br><input type="number" id="covBrand" value="${esc(state.covMeta.brand)}"></label>
      <label class="hint">敗者復活件数<br><input type="number" id="covRevived" value="${esc(state.covMeta.revived)}"></label>
      <label class="hint">rate_limited件数<br><input type="number" id="covRate" value="${esc(state.covMeta.rate)}"></label>
    </div>
    <p class="hint">§2-2:ブランド公式疑いは黙って捨てず、件数をここに残します。個人の可能性があるものはキューに戻してください。</p>
  </div>`;
}

export function mount() {
  document.querySelectorAll("#view td input, #view td select").forEach(el => el.onchange = () => {
    state.coverage[+el.dataset.i][el.dataset.f] = el.value;
    markDirty();
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  document.querySelectorAll(".covdel").forEach(b => b.onclick = () => {
    state.coverage.splice(+b.dataset.i, 1); markDirty();
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  document.getElementById("btnCovAdd").onclick = () => {
    const term = document.getElementById("covTerm").value.trim();
    if (!term) return;
    state.coverage.push({ route: document.getElementById("covRoute").value, term, collected: "", fetched: "", st: "未実行" });
    markDirty();
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  };
  document.getElementById("btnCovSeed").onclick = async () => {
    const p = await loadPreset();
    const seed = [
      ...(p.search.e1_tags || []).map(t => ({ route: "E1", term: t })),
      ...(p.search.e1_life_tags || []).map(t => ({ route: "E1", term: "#" + t })),
      ...(p.search.e2_keywords || []).map(t => ({ route: "E2", term: t })),
    ];
    seed.forEach(s => {
      if (!state.coverage.some(r => r.route === s.route && r.term === s.term)) state.coverage.push({ ...s, collected: "", fetched: "", st: "未実行" });
    });
    markDirty();
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  };
  [["covBrand", "brand"], ["covRevived", "revived"], ["covRate", "rate"]].forEach(([id, f]) => {
    const el = document.getElementById(id);
    if (el) el.onchange = () => { state.covMeta[f] = el.value; markDirty(); };
  });
}
