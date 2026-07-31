/* 候補ボード — 設計書§5-4。P2 では「機械合格が候補ボードに入ったこと」を確認できる
 * 一覧(得点率順ソート既定・救済/紹介者/純度バッジ)までを出す。
 * 詳細画面(3カラム・rubric T1〜T5・DM下書き)は P3。 */
import { state } from "../store.js";
import { esc } from "../charts.js";
import { totalOf, scoreSbis2, scoreSbis3, ffRatio, t1Auto } from "../pipeline/sbis.js";
import { TIER_LAB } from "../pipeline/conf.js";
import { numOrNull } from "../pipeline/util.js";

export function render() {
  const showCut = location.hash.includes("cut=1");
  let list = state.cands.filter(c => showCut || !(c.score && c.score.cut));
  list.sort((a, b) => (b.score && b.score.rate != null ? b.score.rate : -1) - (a.score && a.score.rate != null ? a.score.rate : -1));

  return `
  <div class="head"><h1>候補ボード</h1>
    <span class="meta">得点率順(全候補共通の優先順位付け)。SBIS-1の役割は精査の優先順位付けであり合否ではありません(§4-1)</span>
    <div class="runsel">
      <a class="chip ${showCut ? "" : "on"}" href="#/board">有効候補のみ</a>
      <a class="chip ${showCut ? "on" : ""}" href="#/board?cut=1">足切り・純度ゲートも表示</a>
    </div>
  </div>
  <div class="card" style="padding:0">
    <div class="tblwrap"><table>
      <thead><tr><th>#</th><th>アカウント</th><th>ティア</th><th class="num">フォロワー</th>
      <th class="num">FF比</th><th class="num">ER%</th><th class="num">平均CM</th>
      <th class="num">SBIS-1</th><th class="num">得点率</th><th class="num">+S2</th><th class="num">+S3</th>
      <th class="num">合計</th><th>状態</th></tr></thead>
      <tbody>${list.map((c, i) => {
        const sc = c.score || {};
        const a = t1Auto(numOrNull(c.aux.t1Topic), numOrNull(c.aux.t1Tieup));
        return `<tr>
          <td class="num">${i + 1}</td>
          <td><a class="handle" href="${esc(c.account_url || "#")}" target="_blank" rel="noopener">@${esc(c.username)}</a>
            ${sc.mode === "rescue" ? `<span class="tag res">救済 /75</span>` : ""}
            ${a && a.pitchman ? `<span class="tag red">紹介者</span>` : ""}
            ${sigTags(c.sig)}
            ${sc.cut ? `<span class="tag red">足切り</span>` : ""}
            <br><span class="hint">${esc(c.full_name || "")}</span></td>
          <td>${esc(TIER_LAB[sc.tier] || "—")}</td>
          <td class="num">${fmt(c.followers)}</td>
          <td class="num">${ffRatio(c) ?? '<span class="hint">未評価</span>'}</td>
          <td class="num">${c.er == null ? "不明" : Number(c.er).toFixed(2)}</td>
          <td class="num">${c.avg_comments ?? "—"}</td>
          <td class="num">${sc.total ?? "—"}${sc.mode === "rescue" ? "<small>/75</small>" : ""}</td>
          <td class="num">${sc.rate == null ? "—" : sc.rate + "%"}</td>
          <td class="num">${scoreSbis2(c) || 0}</td>
          <td class="num">${scoreSbis3(c) || 0}</td>
          <td class="num"><b>${totalOf(c) ?? "—"}</b></td>
          <td>${esc(c.status)}</td>
        </tr>`;
      }).join("")}</tbody>
    </table></div>
    ${list.length ? "" : `<div class="empty">まだ候補がありません。「収集」から取得結果をドロップしてください。</div>`}
  </div>
  <div class="card"><h3>P3 で足すもの</h3>
    <p class="hint">候補詳細(左=プロフィールとSBIS-1内訳/中=証言力rubric T1〜T5(証拠メモ必須・T3のNG突合とロック)/
    右=適合コメント・契約枠・ステータス)、フィルタ、一括操作、DM下書き。ロジックは移植済みです。</p></div>`;
}

function fmt(n) { return n == null ? "不明" : Number(n).toLocaleString("ja-JP"); }
function sigTags(sig) {
  if (!sig) return "";
  let h = "";
  if (sig.biz.length) h += ` <span class="tag red">🔴業者</span>`;
  if (sig.amb.length) h += ` <span class="tag res">🟡他社契約</span>`;
  if (sig.life.length && !sig.biz.length) h += ` <span class="tag g">🟢生活者</span>`;
  return h;
}
