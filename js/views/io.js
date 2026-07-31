/* データ入出力 — 設計書§5-7。
 * v3(管制室 v1.4)JSON の読み込み=移行の入口。v4(NEXT)JSON の書き出し/読み込み=共有。
 * 自動保存データの消去もここ。**書き出したJSONの共有は利用者の責任範囲**である旨を明記する。 */
import { state, importAnyJson, exportJson, wipe, persist } from "../store.js";
import { esc } from "../charts.js";
import { toast } from "../app.js";
import { todayISO } from "../pipeline/util.js";

export function render() {
  return `
  <div class="head"><h1>データ入出力</h1>
    <span class="meta">データはこのブラウザの中(IndexedDB)にだけあります。サーバには送信しません</span></div>

  <div class="card">
    <h3>1. 管制室 v1.4 の JSON を読み込む(移行)</h3>
    <div class="drop" id="dropJson">ここに <b>stembeaute_casting_*.json</b> をドロップ(またはクリックして選択)<br>
      <span class="hint">v3(管制室 v1.4)と v4(NEXT)の両方を受けます。基準の自動移行ログもそのまま引き継ぎます。</span>
      <input type="file" id="fileJson" accept=".json" style="display:none">
    </div>
    <div class="hint" id="ioLog"></div>
  </div>

  <div class="card">
    <h3>2. 書き出し(共有・バックアップ)</h3>
    <div class="toolrow">
      <button class="btn" id="btnExport">v4 JSONで書き出す</button>
      <button class="btn ghost" id="btnSave">いますぐ保存する</button>
    </div>
    <p class="hint">v4 JSON にはプロジェクト・候補・精査入力・run(分析結果)・基準変更履歴が入ります。
      <b>v4 → 管制室 v1.4 への逆方向互換は保証しません</b>(片方向・設計書§4-4)。
      書き出したファイルの共有は利用者の責任範囲です。</p>
  </div>

  <div class="card">
    <h3>3. この端末の自動保存データ</h3>
    <div class="toolrow">
      <span class="hint">保存:${state.storageOk ? "有効" : "無効(プライベートモード等)"} /
        最終保存 ${state.savedAt ? esc(new Date(state.savedAt).toLocaleString("ja-JP")) : "—"} /
        候補 ${state.cands.length}件 / run ${state.runs.length}件</span>
      <button class="btn ghost sm" id="btnWipe" style="margin-left:auto;border-color:var(--red);color:var(--red)">自動保存データを消去</button>
    </div>
    <p class="hint">共用PCで作業した場合はここで消去してください(消去前に書き出し推奨)。</p>
  </div>`;
}

export function mount() {
  const drop = document.getElementById("dropJson");
  const file = document.getElementById("fileJson");
  drop.onclick = () => file.click();
  drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); read(e.dataTransfer.files[0]); };
  file.onchange = e => { read(e.target.files[0]); e.target.value = ""; };

  document.getElementById("btnExport").onclick = () => {
    const data = JSON.stringify(exportJson(), null, 1);
    dl(new Blob([data], { type: "application/json" }), `castnext_${todayISO()}.json`);
  };
  document.getElementById("btnSave").onclick = async () => {
    const ok = await persist();
    toast(ok ? "保存しました" : "このブラウザでは保存できません。JSON書き出しをしてください", !ok);
  };
  document.getElementById("btnWipe").onclick = async () => {
    if (!confirm("この端末の保存データを消去します。よろしいですか?(先にJSON書き出しを推奨)")) return;
    await wipe();
    toast("自動保存データを消去しました");
    location.hash = "#/dash";
  };
}

function read(f) {
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const res = importAnyJson(String(r.result));
      const log = document.getElementById("ioLog");
      log.innerHTML = `✔ ${esc(f.name)}:${esc(res.sourceVersion)} を読み込みました — 候補 ${res.count}件`
        + (res.confLog.length ? `<br>基準の自動移行:${res.confLog.map(l => esc(l.ver)).join(" → ")}` : "");
      toast(`読み込みました(候補${res.count}件)`);
    } catch (e) {
      document.getElementById("ioLog").innerHTML = `⚠ ${esc(e.message)}`;
      toast(e.message, true);
    }
  };
  r.readAsText(f, "utf-8");
}

function dl(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
