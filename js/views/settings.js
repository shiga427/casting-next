/* 設定・基準 — 設計書§5-7・§10。
 * **採点パラメータの変更には「理由+バージョン表記」を強制する**(§7-3 再現性の担保)。
 * プロジェクト設定(ブランド名・プリセット)もここに統合する。 */
import { state, markDirty } from "../store.js";
import { esc } from "../charts.js";
import { toast } from "../app.js";
import { rescoreAll, pearson, commentRate, CORR_MIN_N } from "../pipeline/sbis.js";
import { toNum } from "../pipeline/util.js";

const CONF_FIELDS = [
  ["midMin", "ミドル下限F"], ["midMax", "ミドル上限F"], ["microMin", "マイクロ下限F"], ["microMax", "マイクロ上限F"],
  ["convMid0", "①ミドル 0点比率(例0.004)"], ["convMidFull", "①ミドル 満点比率(例0.02)"],
  ["convMic0", "①マイクロ 0点比率(例0.006)"], ["convMicFull", "①マイクロ 満点比率(例0.03)"],
  ["erMid0", "②ミドルER0点%"], ["erMidFull", "②ミドルER満点%"], ["erMic0", "②マイクロER0点%"], ["erMicFull", "②マイクロER満点%"],
  ["cutoffConv", "足切り:①最低点"],
  ["crMid0", "①代替 ミドル0点コメント率%"], ["crMidFull", "①代替 ミドル満点%"],
  ["crMic0", "①代替 マイクロ0点コメント率%"], ["crMicFull", "①代替 マイクロ満点%"],
  ["purFollow1", "純度 −15のフォロー数"], ["purFollow2", "純度 −10のフォロー数"],
  ["purFfMin", "純度 FF比の下限"], ["purCap", "純度 減点の上限(負値)"],
  ["gateFollow", "純度ゲート:フォロー数上限(§4-1b)"], ["gateFf", "純度ゲート:FF比下限(§4-1b)"],
  ["growMin", "成長マイクロ下限F"], ["growMax", "成長マイクロ上限F(参照)"],
  ["growLift", "成長判定:後半/前半の倍率"], ["growEr", "成長判定:高密度ER%"]
];
const KW_FIELDS = [
  ["kwIngredient", "成分語(+2)"], ["kwReview", "レビュー語(+2)"], ["kwAge", "年代語(+3)"], ["kwWin", "当選語(+3マイクロ)"],
  ["kwLife", "生活語(+4・v2.6 §4-1)"], ["kwBiz", "業者語(−8+業者シグナル・§4-1d)"],
  ["kwAmb", "他社契約シグナル語(§4-1d)"], ["bizDomains", "集客導線ドメイン(§4-1d)"],
  ["kwPenaltyPr", "減点:案件募集系"], ["kwPenaltyDisc", "減点:割引訴求"], ["mannerWords", "作法語(付録A)"]
];

export function render() {
  const rated = state.cands.filter(c => c.following != null);
  const xs = [], ys = [], xs2 = [], ys2 = [];
  rated.forEach(c => {
    if (c.er != null) { xs.push(c.following); ys.push(c.er); }
    const cr = commentRate(c);
    if (cr != null) { xs2.push(c.following); ys2.push(cr); }
  });
  const rEr = pearson(xs, ys), rCr = pearson(xs2, ys2);
  const enough = Math.max(xs.length, xs2.length) >= CORR_MIN_N;

  return `
  <div class="head"><h1>設定・基準</h1>
    <span class="meta">${esc(state.conf.ver)} — 変更したらバージョンを上げ、理由を記録します(§7 再現性の担保)</span></div>

  <div class="card">
    <h3>プロジェクト</h3>
    <div class="toolrow">
      <label class="hint">ブランド名<br><input type="text" id="pName" value="${esc(state.project ? state.project.name : "")}"></label>
      <label class="hint">プリセット<br><input type="text" id="pPreset" value="${esc(state.project ? state.project.preset : "")}" disabled></label>
      <button class="btn ghost sm" id="btnProj">保存</button>
    </div>
    <p class="hint">辞書(qualsignals のシグナル語)は日本語の美容・生活文脈に最適化されています。
      他業種で使う場合は NG語・作法語の差し替えが前提です(§10 注)。</p>
  </div>

  <div class="card">
    <h3>SBIS-1 採点基準<span class="r">変更には理由とバージョンが必須</span></h3>
    <div class="settings-grid">
      ${CONF_FIELDS.map(([k, l]) => `<div><label class="hint">${esc(l)}</label>
        <input type="number" step="any" id="cf_${k}" value="${esc(state.conf[k])}" style="width:100%"></div>`).join("")}
      ${KW_FIELDS.map(([k, l]) => `<div style="grid-column:span 2"><label class="hint">${esc(l)}</label>
        <input type="text" id="cf_${k}" value="${esc(state.conf[k])}" style="width:100%"></div>`).join("")}
      <div style="grid-column:span 2"><label class="hint">薬機法NGワード(精査時の突合リスト・カンマ区切り)</label>
        <textarea id="ngWords" rows="3">${esc(state.conf.ngWords)}</textarea></div>
    </div>
    <div class="toolrow" style="margin-top:12px">
      <label class="hint">バージョン表記</label><input type="text" id="confVer" value="${esc(state.conf.ver)}" style="width:130px">
      <input type="text" id="confReason" placeholder="変更理由(必須・履歴に残ります)" style="flex:1;min-width:240px">
      <button class="btn sm" id="btnApplyConf">基準を適用して全件再採点</button>
    </div>
    <div class="hint" id="confMsg"></div>
    <p class="hint">足切り:①会話の濃さが ${state.conf.cutoffConv} 点未満の候補は合計に関わらず「足切り」表示になります(§4)。</p>
  </div>

  <div class="card">
    <h3>純度仮説の検証(§4-1b・§7-5)</h3>
    ${enough ? `<div class="breakdown">
      <div class="r"><span>following × ER(n=${xs.length})</span><b>${fmtR(rEr)} ${judge(rEr)}</b></div>
      <div class="r"><span>following × コメント率(n=${xs2.length})</span><b>${fmtR(rCr)} ${judge(rCr)}</b></div>
    </div>` : `<p class="hint">蓄積中 n=${Math.max(xs.length, xs2.length)}/${CORR_MIN_N}
      (フォロー数が取れている候補が${CORR_MIN_N}件に達したら相関を表示します。現在 純度評価済み ${rated.length}件 / 全${state.cands.length}件)</p>`}
    <p class="hint"><b>この減点も仮説であり、実測が審判です。</b>相関が確認できたら減点幅を、なければ撤廃を検討してください。</p>
  </div>

  <div class="card">
    <h3>基準の変更履歴</h3>
    ${state.confLog.length ? state.confLog.slice().reverse().map(l => `<div class="logrow">
      <b>${esc(l.ver)}</b> ${esc(new Date(l.at).toLocaleString("ja-JP"))} — ${esc(l.reason)}
      ${l.diff && l.diff.length ? `<br><span class="hint">${esc(l.diff.join(" / "))}</span>` : ""}</div>`).join("")
    : `<p class="hint">まだ変更はありません。</p>`}
  </div>`;
}

function fmtR(r) { return r == null ? "算出不可" : (r > 0 ? "+" : "") + r.toFixed(3); }
function judge(r) { return r == null ? "" : (Math.abs(r) >= 0.4 ? "(相関あり)" : Math.abs(r) >= 0.2 ? "(弱い相関)" : "(ほぼ無相関)"); }

export function mount() {
  document.getElementById("btnProj").onclick = () => {
    if (!state.project) return;
    state.project.name = document.getElementById("pName").value.trim() || state.project.name;
    markDirty();
    toast("プロジェクト設定を保存しました");
  };
  document.getElementById("btnApplyConf").onclick = () => {
    const diff = [];
    CONF_FIELDS.forEach(([k, l]) => {
      const v = toNum(document.getElementById("cf_" + k).value);
      if (v != null && v !== state.conf[k]) diff.push(`${l}:${state.conf[k]}→${v}`);
    });
    KW_FIELDS.forEach(([k, l]) => {
      if (document.getElementById("cf_" + k).value !== state.conf[k]) diff.push(l + "を変更");
    });
    if (document.getElementById("ngWords").value !== state.conf.ngWords) diff.push("NGワードを変更");
    const newVer = document.getElementById("confVer").value || state.conf.ver;
    if (newVer !== state.conf.ver) diff.push(`バージョン:${state.conf.ver}→${newVer}`);
    const reason = document.getElementById("confReason").value.trim();
    const msg = document.getElementById("confMsg");
    if (diff.length && !reason) {
      msg.innerHTML = `<span style="color:var(--red)">⚠ 変更理由が未入力です(§7:変更するときは必ずバージョンを上げ、理由を記録)。</span>`;
      return;
    }
    if (diff.length && newVer === state.conf.ver) {
      msg.innerHTML = `<span style="color:var(--red)">⚠ 基準を変えたらバージョン表記も上げてください(例 SBIS v2.7)。</span>`;
      return;
    }
    CONF_FIELDS.forEach(([k]) => { const v = toNum(document.getElementById("cf_" + k).value); if (v != null) state.conf[k] = v; });
    KW_FIELDS.forEach(([k]) => { state.conf[k] = document.getElementById("cf_" + k).value; });
    state.conf.ngWords = document.getElementById("ngWords").value;
    state.conf.ver = newVer;
    if (diff.length) state.confLog.push({ at: new Date().toISOString(), ver: newVer, reason, diff });
    rescoreAll(state.cands, state.conf);
    markDirty();
    msg.innerHTML = `<span style="color:var(--green)">✔ 基準を適用し全件再採点しました(${esc(state.conf.ver)})${diff.length ? " — 履歴に記録" : " — 変更なし"}</span>`;
    toast("全件を再採点しました");
  };
}
