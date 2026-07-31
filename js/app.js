/* アプリのシェル(設計書§5-0)。サイドバー+ハッシュルータだけを持ち、画面は js/views/* に委ねる。 */
import { ROUTES, currentRoute, onRoute, go } from "./router.js";
import { state, boot, onChange, DEFAULT_PROJECT, createProject } from "./store.js";
import { esc } from "./charts.js";

const VIEWS = {
  dash: () => import("./views/dash.js"),
  board: () => import("./views/board.js"),
  analysis: () => import("./views/analysis.js"),
  collect: () => import("./views/collect.js"),
  io: () => import("./views/io.js"),
};
/* P3以降で実装する画面(設計書§12のフェーズ計画)。ナビは先に出しておく */
const PLANNED = {
  kanban: ["パイプライン(カンバン)", "P3", "ステータス列へのドラッグ、DM送付日の営業日カウント、適合コメント空のブロック"],
  qual: ["精査・定性評価", "P6", "captions/comments/profile の3ファイルをドロップ → 自動生成部+人が書く欄のフォーム"],
  coverage: ["探索カバレッジ", "P5", "未実行を隠さない表。プロジェクト設定のキーワードから既定行を生成"],
  revive: ["敗者復活", "P5", "rejected の取り込みと境界例の復活"],
  settings: ["設定・基準", "P5", "採点パラメータ(理由+バージョン必須)とプロジェクト設定"],
  oplog: ["運用ログ", "P5", "指示書外判断の事前承認制(提案中/承認/却下)"],
};

function renderNav() {
  const groups = { "実績": "nav1", "分析": "nav2", "運用": "nav3" };
  const cur = currentRoute();
  const counts = {
    qual: state.cands.filter(c => c.status === "候補" && c.score && !c.score.cut).length ? 0 : 0,
    coverage: state.coverage.filter(r => r.st === "未実行").length,
    oplog: state.govLog.filter(g => g.state === "提案中").length,
  };
  Object.entries(groups).forEach(([g, id]) => {
    const el = document.getElementById(id);
    el.innerHTML = ROUTES.filter(r => r.group === g).map(r => {
      const n = counts[r.path];
      return `<a href="#/${r.path}" class="${r.path === cur.path ? "on" : ""}">${esc(r.label)}`
        + (n ? `<span class="cnt">${n}</span>` : "") + `</a>`;
    }).join("");
  });
  const p = state.project;
  document.getElementById("projLabel").innerHTML = p
    ? `${esc(p.name)}<br><span style="opacity:.75">プリセット ${esc(p.preset || "-")}</span>`
    : "プロジェクト未設定";
  const saved = document.getElementById("savedState");
  if (state.storageOk) {
    const t = state.savedAt ? new Date(state.savedAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "—";
    saved.className = "saved";
    saved.innerHTML = `<b></b>自動保存が有効です<br><span style="opacity:.7">最終保存 ${t}</span>`;
  } else {
    saved.className = "saved off";
    saved.innerHTML = `<b></b>このブラウザでは自動保存が使えません<br><span style="opacity:.7">作業前に「データ入出力」からJSON書き出しを</span>`;
  }
}

export function toast(message, isError) {
  const el = document.createElement("div");
  el.className = "toast" + (isError ? " err" : "");
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), isError ? 8000 : 4000);
}

function stub(path) {
  const [label, phase, detail] = PLANNED[path];
  return `<div class="head"><h1>${esc(label)}</h1></div>
    <div class="stub"><b>${esc(phase)} で実装します</b><br><span class="hint">${esc(detail)}</span>
    <div class="note">いまは P0〜P2(足場・パイプライン移植・分析結果画面)まで動いています。</div></div>`;
}

async function render() {
  const route = currentRoute();
  const view = document.getElementById("view");
  renderNav();
  if (!state.ready) { view.innerHTML = `<div class="stub">読み込み中…</div>`; return; }
  if (!state.project) { view.innerHTML = welcome(); bindWelcome(); return; }
  if (VIEWS[route.path]) {
    const mod = await VIEWS[route.path]();
    view.innerHTML = mod.render(route);
    if (mod.mount) mod.mount(route);
  } else {
    view.innerHTML = stub(route.path);
  }
  view.scrollTop = 0;
}

/* 初回セットアップ(§9-1 の最小版。ウィザード本体は P7) */
function welcome() {
  return `<div class="head"><h1>ようこそ</h1><span class="meta">キャスティング管制室 NEXT</span></div>
  <div class="card" style="max-width:640px">
    <h3>プロジェクトを作る</h3>
    <p class="hint">データはこのブラウザの中(IndexedDB)にだけ保存されます。サーバには何も送信しません。</p>
    <div class="toolrow" style="margin-top:12px">
      <input id="wName" type="text" value="ステムボーテ" style="padding:8px 10px;border:1px solid var(--line);border-radius:8px;font-family:inherit;font-size:13px">
      <button class="btn" id="wGo">このブランドで始める(プリセット v2.6)</button>
    </div>
    <div class="note">プリセットには帯定義・機械フィルタ・SBISパラメータ・NG語辞書が入っています(設計書§10)。</div>
  </div>`;
}
function bindWelcome() {
  document.getElementById("wGo").onclick = async () => {
    const name = document.getElementById("wName").value.trim() || "新規プロジェクト";
    await createProject({ ...DEFAULT_PROJECT, name });
    toast("プロジェクトを作成しました");
    go("collect");
    render();
  };
}

onRoute(render);
onChange(() => { renderNav(); });
boot().then(render);
