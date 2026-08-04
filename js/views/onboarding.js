/* 初回セットアップウィザード — 設計書§9-1。初回アクセス時に自動起動する。
 * ① プロジェクト作成 ② 準備チェック ③ サンプルで試す(実データの前に成功体験)④ 最初の収集へ */
import { state, createProject, markDirty, DEFAULT_PROJECT } from "../store.js";
import { esc } from "../charts.js";
import { toast } from "../app.js";
import { go } from "../router.js";
import { handleFile } from "./collect.js";

let step = 1;

export function render() {
  return `
  <div class="head"><h1>はじめの設定</h1><span class="meta">3分で終わります。データはこのブラウザの中にだけ保存されます</span></div>
  <div class="card" style="max-width:720px">
    <div class="steps">${[1, 2, 3, 4].map(n => `<span class="stepdot ${n === step ? "on" : n < step ? "done" : ""}">${n}</span>`).join("")}</div>
    ${[stepProject, stepPrep, stepSample, stepGo][step - 1]()}
  </div>`;
}

function stepProject() {
  return `<h3>① プロジェクトを作る</h3>
    <p class="hint">ブランド名を入れてください。採点基準・探索キーワード・NG語辞書はプリセット(ステムボーテ v2.6)から入ります。</p>
    <div class="toolrow" style="margin-top:12px">
      <input type="text" id="wName" value="${esc(state.project ? state.project.name : "ステムボーテ")}" style="width:260px">
      <button class="btn" id="wNext1">この名前で作る</button>
    </div>
    <div class="note">辞書は日本語の美容・生活文脈に最適化されています。他業種で使う場合は「設定・基準」で差し替えてください。</div>`;
}
function stepPrep() {
  const prep = (state.queue && state.queue.prep) || {};
  const items = [
    ["chrome", "Chrome を使っている", "収集には Casting Next 拡張(Chrome 拡張)が必要です"],
    ["ext", "Casting Next 拡張が入っていて、instagram.com でサイト権限が有効", "chrome://extensions でデベロッパーモードを有効にし、リポジトリの extension/ フォルダを「パッケージ化されていない拡張機能を読み込む」で入れてください"],
    ["login", "instagram.com にご自身のアカウントでログインしている", "ページ内 fetch に Cookie が必要です"],
  ];
  return `<h3>② 準備チェック(自己申告)</h3>
    ${items.map(([k, label, why]) => `<label class="check" style="display:block">
      <input type="checkbox" class="prep" data-k="${k}" ${prep[k] ? "checked" : ""}> ${esc(label)}
      <span class="hint" style="display:block;margin-left:22px">${esc(why)}</span></label>`).join("")}
    <div class="toolrow"><button class="btn ghost sm" id="wBack">戻る</button><button class="btn" id="wNext2">次へ</button></div>`;
}
function stepSample() {
  return `<h3>③ サンプルで試す</h3>
    <p class="hint">同梱の<b>匿名化サンプル</b>(30件)を読み込んで、分析結果画面がどう出るかを先に見ます。
      実データの前に一度体験しておくと、あとの判断が速くなります。</p>
    <div class="toolrow" style="margin-top:12px">
      <button class="btn" id="wSample">サンプルを読み込んで分析結果を見る</button>
      <button class="btn ghost sm" id="wSkip">とばす</button>
    </div>
    <div class="hint" id="wSampleLog"></div>`;
}
function stepGo() {
  return `<h3>④ 最初の収集へ</h3>
    <p class="hint">収集は <b>Casting Next 拡張</b>が行います。次の順で進めてください。</p>
    <ol class="hint" style="margin:8px 0 0 18px;line-height:1.9">
      <li>chrome://extensions で「デベロッパーモード」→「パッケージ化されていない拡張機能を読み込む」→ <code>extension/</code> を選ぶ</li>
      <li>instagram.com をご自身のアカウントで開いてログインしておく</li>
      <li>収集画面（①発掘から始める）でタグを選び、<b>拡張ポップアップの「①発掘して収集」</b>を押す</li>
      <li>集め終わると<b>この画面に結果が自動で入り</b>、そのまま分析結果に切り替わります</li>
    </ol>
    <div class="note" style="margin-top:8px">間隔・件数上限・429での中断は拡張が守ります。
      DM送信・フォロー・いいね・投稿は一切しません。</div>
    <div class="toolrow" style="margin-top:12px">
      <button class="btn" id="wGoCollect">収集画面へ</button>
      <button class="btn ghost sm" id="wGoDash">概要へ</button>
    </div>
    <div class="note">この設定はいつでも「設定・基準」から変えられます。ヘルプは各画面の「?」から開けます。</div>`;
}

function finish() {
  if (state.project) { state.project.onboarded = true; markDirty(); }
}

export function mount() {
  const $ = id => document.getElementById(id);
  if ($("wNext1")) $("wNext1").onclick = async () => {
    const name = $("wName").value.trim() || "新規プロジェクト";
    if (state.project) { state.project.name = name; markDirty(); }
    else await createProject({ ...DEFAULT_PROJECT, name });
    step = 2; rerender();
  };
  if ($("wBack")) $("wBack").onclick = () => { step = Math.max(1, step - 1); rerender(); };
  if ($("wNext2")) $("wNext2").onclick = () => { step = 3; rerender(); };
  document.querySelectorAll(".prep").forEach(cb => cb.onchange = () => {
    state.queue = state.queue || {};
    state.queue.prep = { ...(state.queue.prep || {}), [cb.dataset.k]: cb.checked };
    markDirty();
  });
  if ($("wSkip")) $("wSkip").onclick = () => { step = 4; rerender(); };
  if ($("wSample")) $("wSample").onclick = async () => {
    try {
      const text = await fetch("samples/sample_run.jsonl").then(r => r.text());
      finish();
      handleFile(text, "sample_run.jsonl");   // 解析 → 分析結果画面へ自動遷移
    } catch (e) {
      $("wSampleLog").textContent = "サンプルを読み込めませんでした: " + e.message;
      toast("サンプルの読み込みに失敗しました", true);
    }
  };
  if ($("wGoCollect")) $("wGoCollect").onclick = () => { finish(); go("collect"); };
  if ($("wGoDash")) $("wGoDash").onclick = () => { finish(); go("dash"); };
}

function rerender() {
  /* ウィザードの途中で他画面に落ちないよう、隠しルート #/setup に留まる */
  if (location.hash !== "#/setup") { location.hash = "#/setup"; return; }
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}
