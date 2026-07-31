/* アプリのシェル(設計書§5-0)。サイドバー+ハッシュルータだけを持ち、画面は js/views/* に委ねる。 */
import { ROUTES, currentRoute, onRoute, go } from "./router.js";
import { state, boot, onChange, DEFAULT_PROJECT, createProject, TOOL_VER } from "./store.js";
import { esc } from "./charts.js";

const VIEWS = {
  dash: () => import("./views/dash.js"),
  board: () => import("./views/board.js"),
  analysis: () => import("./views/analysis.js"),
  collect: () => import("./views/collect.js"),
  io: () => import("./views/io.js"),
  kanban: () => import("./views/kanban.js"),
  coverage: () => import("./views/coverage.js"),
  revive: () => import("./views/revive.js"),
  settings: () => import("./views/settings.js"),
  oplog: () => import("./views/oplog.js"),
  qual: () => import("./views/qual.js"),
};
/* 未実装の画面(設計書§12のフェーズ計画)。ナビは先に出しておく */
const PLANNED = {};

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
      + `<br><span id="verLabel" style="opacity:.6">${esc(state.conf.ver)} / ${esc(TOOL_VER)}</span>`
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
  /* 初回はウィザード(§9-1)。プロジェクトができるまで他の画面には行かせない */
  if (!state.project || (route.path === "setup")) {
    const mod = await import("./views/onboarding.js");
    view.innerHTML = mod.render();
    mod.mount();
    return;
  }
  if (VIEWS[route.path]) {
    const mod = await VIEWS[route.path]();
    view.innerHTML = mod.render(route);
    if (mod.mount) mod.mount(route);
  } else {
    view.innerHTML = stub(route.path);
  }
  view.scrollTop = 0;
}

/* 画面内ヘルプ(§9-2):docs/guide.md の該当節をモーダルで出す。外部サイトに飛ばさない */
let guideCache = null;
export async function openHelp(section) {
  if (!guideCache) guideCache = await fetch("docs/guide.md").then(r => r.text()).catch(() => "# ヘルプ\n\n読み込めませんでした。");
  let ov = document.getElementById("ovHelp");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "ovHelp"; ov.className = "overlay";
    document.body.appendChild(ov);
    ov.addEventListener("click", e => { if (e.target === ov) ov.classList.remove("open"); });
  }
  ov.innerHTML = `<div class="modal" style="max-width:760px">
    <div class="mhead"><h3>使い方ガイド</h3><button class="x" id="helpClose">×</button></div>
    <div class="mbody" style="grid-template-columns:1fr">${md2html(guideCache, section)}</div></div>`;
  ov.classList.add("open");
  document.getElementById("helpClose").onclick = () => ov.classList.remove("open");
}
/* 依存を増やさないための最小限の md → html(見出し・表・箇条書き・強調だけ) */
function md2html(md, section) {
  let text = md;
  if (section) {
    const re = new RegExp(`^##\\s*${section}[\\s\\S]*?(?=^##\\s|\\Z)`, "m");
    const m = md.match(re);
    if (m) text = m[0];
  }
  const lines = text.split("\n");
  const out = [];
  let inTable = false;
  lines.forEach(line => {
    if (/^\|/.test(line)) {
      if (/^\|[\s-:|]+\|$/.test(line)) return;
      const cells = line.split("|").slice(1, -1).map(c => c.trim());
      if (!inTable) { out.push("<table>"); inTable = true; }
      out.push("<tr>" + cells.map(c => `<td>${inline(c)}</td>`).join("") + "</tr>");
      return;
    }
    if (inTable) { out.push("</table>"); inTable = false; }
    if (/^#{1,3}\s/.test(line)) out.push(`<h4>${esc(line.replace(/^#+\s*/, ""))}</h4>`);
    else if (/^[-*]\s/.test(line)) out.push(`<div class="hint">・${inline(line.replace(/^[-*]\s*/, ""))}</div>`);
    else if (line.trim()) out.push(`<p class="hint">${inline(line)}</p>`);
  });
  if (inTable) out.push("</table>");
  return out.join("");
}
function inline(s) {
  return esc(s).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
}

onRoute(render);
onChange(() => { renderNav(); });
document.getElementById("btnHelp").onclick = () => openHelp();
boot().then(render);
