/* 敗者復活 — 設計書§5-7(現行タブの移植)。
 * §3:rejected は毎回目を通す。境界例(followers_max 超過だが10.5万 等)は手動で復活させてよい。 */
import { state, markDirty } from "../store.js";
import { esc } from "../charts.js";
import { toast } from "../app.js";
import { importRejectedCsv, reviveWorthy, reviveNote, newCand } from "../pipeline/schema.js";
import { rescoreAll } from "../pipeline/sbis.js";
import { todayISO } from "../pipeline/util.js";

export function render() {
  const worthy = state.rejected.filter(r => reviveWorthy(r, state.conf, state.cands));
  const list = state.rejected;
  return `
  <div class="head"><h1>敗者復活</h1>
    <span class="meta">機械フィルタの落選者。復活検討に値するもの ${worthy.length}件 / 全 ${list.length}件</span></div>

  <div class="card">
    <div class="drop" id="dropRej">ここに <b>rejected_*.csv</b> をドラッグ&amp;ドロップ(またはクリックして選択)<br>
      <span class="hint">分析結果画面の「書き出し」で出した all_*.csv でも構いません(reject_reason 列を読みます)。</span>
      <input type="file" id="fileRej" accept=".csv" multiple style="display:none">
    </div>
    <div class="hint" id="rejLog"></div>
    <p class="hint">現在の run の落選者は「分析結果」画面の落ち理由からも辿れます。ここは過去 run の CSV を持ち込む用です。</p>
  </div>

  <div class="card" style="padding:0">
    <div class="tblwrap"><table>
      <thead><tr><th>アカウント</th><th class="num">フォロワー</th><th class="num">ER%</th>
      <th>落選理由</th><th>判定</th><th>bio</th><th style="width:90px"></th></tr></thead>
      <tbody>${list.map(r => {
        const nt = reviveNote(r, state.conf);
        const exists = !!state.cands.find(c => c.username.toLowerCase() === r.username.toLowerCase());
        return `<tr>
          <td><a class="handle" href="${esc(r.account_url || "#")}" target="_blank" rel="noopener">@${esc(r.username)}</a></td>
          <td class="num">${r.followers == null ? "不明" : Number(r.followers).toLocaleString("ja-JP")}</td>
          <td class="num">${r.er == null ? "不明" : Number(r.er).toFixed(2)}</td>
          <td class="hint">${esc(r.reason || "")}</td>
          <td>${nt.k === "ok" ? `<span class="tag res">${esc(nt.t)}</span>` : `<span class="hint">${esc(nt.t)}</span>`}</td>
          <td class="hint" style="max-width:260px">${esc(String(r.bio || "").slice(0, 70))}</td>
          <td>${exists ? `<span class="hint">取込済</span>` : `<button class="btn ghost sm revbtn" data-u="${esc(r.username)}">復活</button>`}</td>
        </tr>`;
      }).join("")}</tbody>
    </table></div>
    ${list.length ? "" : `<div class="empty">rejected CSV がまだ読み込まれていません。</div>`}
  </div>`;
}

export function mount() {
  const drop = document.getElementById("dropRej"), file = document.getElementById("fileRej");
  drop.onclick = () => file.click();
  drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); read(e.dataTransfer.files); };
  file.onchange = e => { read(e.target.files); e.target.value = ""; };
  document.querySelectorAll(".revbtn").forEach(b => b.onclick = () => revive(b.dataset.u));
}

function read(files) {
  [...files].forEach(f => {
    const r = new FileReader();
    r.onload = () => {
      const res = importRejectedCsv(String(r.result), state.rejected);
      const log = document.getElementById("rejLog");
      if (!res.ok) { log.innerHTML = `⚠ ${esc(res.message)}`; toast(res.message, true); return; }
      markDirty();
      const worthy = state.rejected.filter(x => reviveWorthy(x, state.conf, state.cands)).length;
      log.innerHTML = `✔ ${esc(f.name)}:新規 ${res.added}件 / 更新 ${res.updated}件(復活検討 ${worthy}件)`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    };
    r.readAsText(f, "utf-8");
  });
}

function revive(u) {
  const r = state.rejected.find(x => x.username === u);
  if (!r) return;
  if (state.cands.find(c => c.username.toLowerCase() === u.toLowerCase())) return;
  state.cands.push(Object.assign(newCand(), {
    account_url: r.account_url, username: r.username, full_name: r.full_name || "", followers: r.followers,
    er: r.er, avg_likes: r.avg_likes ?? null, avg_comments: r.avg_comments ?? null, following: r.following ?? null,
    genre: "", has_external_link: r.has_external_link ?? null, external_url: "", bio: r.bio || "",
    matched_keywords: "", discovered_via: "rejected復活", scraped_at: todayISO(), manual: true,
    manualWhy: `敗者復活(${r.reason || "理由不明"} / ${reviveNote(r, state.conf).t})`
  }));
  rescoreAll(state.cands, state.conf);
  markDirty();
  toast(`@${u} を候補に復活させました(手動追加として記録)`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}
