/* 候補ボード — 設計書§5-4。P2 では「機械合格が候補ボードに入ったこと」を確認できる
 * 一覧(得点率順ソート既定・救済/紹介者/純度バッジ)までを出す。
 * 詳細画面(3カラム・rubric T1〜T5・DM下書き)は P3。
 *
 * 2026-08-03 追加:
 *  ・各列のヘッダークリックで昇順/降順を切り替える(既定は得点率の降順＝従来の初期表示のまま)
 *  ・「精査」列。精査日・語りの向き・md書き出しを出す(結論の全文は行クリック→詳細)
 *
 * 2026-08-04 追加(設計書_DM自動一括送付 §2-1):
 *  ・選択列(先頭)。**チェックした候補だけ**が一括DMの対象。ソート対象にはしない
 *  ・「選択N件にDMを送る」→ 一括DMパネル(dmpanel.js)
 */
import { state } from "../store.js";
import { esc } from "../charts.js";
import { totalOf, scoreSbis2, scoreSbis3, ffRatio, commentRate, t1Auto } from "../pipeline/sbis.js";
import { TIER_LAB } from "../pipeline/conf.js";
import { numOrNull } from "../pipeline/util.js";
import { open as openDetail } from "./detail.js";
import { RUBRIC_KEYS, CHECK_ITEMS } from "../pipeline/conf.js";
import { DM_LIST_COLUMNS, dmListRows, rowsToCsv } from "../pipeline/export.js";
import { toMarkdown } from "../pipeline/qualReport.js";
import { genreFit, fitRate, fitOrder } from "../pipeline/genrefit.js";
import { dmEligibility } from "../pipeline/dmCompose.js";
import { open as openDmPanel } from "./dmpanel.js";

/* ティアの並び順(降順で メガ→ミドル→マイクロ→対象外帯)。表示ラベルの並びでは意味を成さないので固定ランクにする */
const TIER_RANK = { mega: 3, middle: 2, micro: 1, out: 0 };


/* 列の定義。ここに1行足せばヘッダー・ソートが揃う(定義を散らさない)。
 * type: "num"=数値比較 / "str"=localeCompare("ja") / "date"=時刻比較。
 * 既定の向きは num/date=降順・str=昇順。null・未評価は dir に関わらず常に末尾 */
const COLUMNS = [
  /* 選択列(§2-1)。ソートキーを持たせない(data-sortkey を付けない)ので並べ替え対象にならない */
  { key: "sel", label: "", type: "none", cls: "sel", get: () => null, nosort: true },
  { key: "rate", label: "#", type: "num", cls: "num", get: c => scOf(c).rate },
  { key: "username", label: "アカウント", type: "str", get: c => c.username || "" },
  { key: "tier", label: "ティア", type: "num", get: c => (TIER_RANK[scOf(c).tier] == null ? null : TIER_RANK[scOf(c).tier]) },
  /* 2026-08-07 追加。SBIS-1 にジャンルの配点が無く、旅行・グルメ・ペットが上位を取っていたため */
  { key: "genre", label: "ジャンル", type: "num", get: c => fitOrder(c) },
  { key: "followers", label: "フォロワー", type: "num", cls: "num", get: c => numOrNull(c.followers) },
  { key: "ff", label: "FF比", type: "num", cls: "num", get: c => ffRatio(c) },
  { key: "er", label: "ER%", type: "num", cls: "num", get: c => numOrNull(c.er) },
  { key: "cm", label: "平均CM", type: "num", cls: "num", get: c => numOrNull(c.avg_comments) },
  { key: "total", label: "SBIS-1", type: "num", cls: "num", get: c => scOf(c).total },
  { key: "srate", label: "得点率", type: "num", cls: "num", get: c => scOf(c).rate },
  /* 適合 = SBIS-1 + ジャンル減点。**SBIS-1 の値は書き換えていない**(§ゴールデンテスト保護) */
  { key: "fit", label: "適合", type: "num", cls: "num", get: c => fitRate(c) },
  { key: "s2", label: "+S2", type: "num", cls: "num", get: c => scoreSbis2(c) || 0 },
  { key: "s3", label: "+S3", type: "num", cls: "num", get: c => scoreSbis3(c) || 0 },
  { key: "sum", label: "合計", type: "num", cls: "num", get: c => totalOf(c) },
  { key: "status", label: "状態", type: "str", get: c => c.status || "" },
  { key: "qual", label: "精査", type: "date", get: c => qualTime(c) },
];

/* 既定は「適合の降順」(2026-08-07 変更。従来は得点率の降順だったが、ジャンルが配点に無く
 * 旅行・グルメが1位・3位を占めていたため)。localStorage には持たない(セッション内だけの表示状態) */
let sortState = { key: "fit", dir: "desc" };

/* 選択状態(§2-1)。**セッション内のメモリのみ**。localStorage にも IndexedDB にも永続しない
 * (誤って前回の選択が残ったまま送る事故を作らないため。sortState と同じ扱い) */
const selected = new Set();
export function selectedCands() {
  return state.cands.filter(c => selected.has(c.username));
}

function scOf(c) { return c.score || {}; }
function qualRaw(c) {
  const q = c.qualReport;
  if (!q) return null;
  return q.doneAt || q.generatedAt || null;   /* doneAt が無い既存レポートは生成日で代替する */
}
function qualTime(c) {
  const raw = qualRaw(c);
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}
function qualDay(c) { return String(qualRaw(c) || "").slice(0, 10); }
function stanceOf(c) {
  const q = c.qualReport;
  return String(c.qualStance || (q && q.stance && q.stance.verdict) || "").split("(")[0];
}

function sortList(list) {
  const col = COLUMNS.find(x => x.key === sortState.key) || COLUMNS[0];
  const dir = sortState.dir === "asc" ? 1 : -1;
  /* 元の並びを添えて安定ソートにする */
  return list.map((c, i) => ({ c, i })).sort((A, B) => {
    const a = col.get(A.c), b = col.get(B.c);
    const an = a == null || a === "", bn = b == null || b === "";
    if (an && bn) return A.i - B.i;
    if (an) return 1;
    if (bn) return -1;
    const d = col.type === "str"
      ? String(a).localeCompare(String(b), "ja")
      : (Number(a) > Number(b) ? 1 : Number(a) < Number(b) ? -1 : 0);
    return d !== 0 ? d * dir : A.i - B.i;
  }).map(x => x.c);
}

function visibleList() {
  const showCut = location.hash.includes("cut=1");
  const beautyOnly = location.hash.includes("beauty=1");
  /* 絞り込み(有効候補のみ / 足切りも表示 / 非美容を隠す)が先。ソートはその結果に掛ける */
  return sortList(state.cands.filter(c => (showCut || !(c.score && c.score.cut))
    && (!beautyOnly || ["core", "sub"].includes(genreFit(c).klass))));
}

export function mount() {
  document.querySelectorAll("#view tr.click").forEach(tr => tr.onclick = () => openDetail(tr.dataset.u));

  /* ヘッダーのソート。thead 内で完結させ、行クリック(詳細を開く)と競合させない */
  document.querySelectorAll("#view thead th[data-sortkey]").forEach(th => th.onclick = () => {
    const key = th.dataset.sortkey;
    const col = COLUMNS.find(x => x.key === key);
    if (sortState.key === key) sortState = { key, dir: sortState.dir === "asc" ? "desc" : "asc" };
    else sortState = { key, dir: col && col.type === "str" ? "asc" : "desc" };
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });

  /* 精査列の md 書き出し。押しても行クリック(詳細)が走らないよう伝播を止める */
  document.querySelectorAll("[data-mdrow]").forEach(b => b.onclick = e => {
    e.stopPropagation();
    const c = state.cands.find(x => x.username === b.dataset.mdrow);
    if (c && c.qualReport) dlMd(c.qualReport);
  });

  /* 選択列(§2-1)。行クリック(詳細を開く)と競合させないため click の伝播を止める(md ボタンと同じ作法) */
  const syncSendBtn = () => {
    const b = document.getElementById("btnDmSend");
    if (b) { b.textContent = `選択${selected.size}件にDMを送る`; b.disabled = selected.size === 0; }
    const all = document.getElementById("selAll");
    const boxes = [...document.querySelectorAll(".rowsel")];
    if (all) all.checked = boxes.length > 0 && boxes.every(x => x.checked);
  };
  document.querySelectorAll(".rowsel").forEach(cb => {
    cb.onclick = e => e.stopPropagation();
    cb.onchange = e => {
      e.stopPropagation();
      if (cb.checked) selected.add(cb.dataset.u); else selected.delete(cb.dataset.u);
      syncSendBtn();
    };
  });
  const selAll = document.getElementById("selAll");
  if (selAll) {
    selAll.onclick = e => e.stopPropagation();
    selAll.onchange = () => {
      document.querySelectorAll(".rowsel").forEach(cb => {
        cb.checked = selAll.checked;
        if (selAll.checked) selected.add(cb.dataset.u); else selected.delete(cb.dataset.u);
      });
      syncSendBtn();
    };
  }
  const send = document.getElementById("btnDmSend");
  if (send) send.onclick = () => openDmPanel(selectedCands());
  syncSendBtn();

  const btn = document.getElementById("btnDmCsv");
  if (btn) btn.onclick = () => {
    const rows = dmListRows(visibleList(), { TIER_LAB, ffRatio, commentRate, scoreSbis2, scoreSbis3, totalOf, t1Auto, numOrNull, RUBRIC_KEYS, CHECK_ITEMS });
    dl(new Blob(["﻿" + rowsToCsv(rows, DM_LIST_COLUMNS)], { type: "text/csv" }), "dm_list.csv");
  };
}

function dlMd(report) {
  dl(new Blob([toMarkdown(report)], { type: "text/markdown" }), `定性評価_${report.handle}.md`);
}
function dl(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function render() {
  const showCut = location.hash.includes("cut=1");
  const beautyOnly = location.hash.includes("beauty=1");
  /* 2つの絞り込み(足切り表示 / 非美容を隠す)を独立に切り替えるためのURL組み立て */
  const q = (cut, beauty) => {
    const qs = [cut ? "cut=1" : "", beauty ? "beauty=1" : ""].filter(Boolean).join("&");
    return "#/board" + (qs ? "?" + qs : "");
  };
  const list = visibleList();
  const hidden = state.cands.filter(c => (showCut || !(c.score && c.score.cut))
    && !["core", "sub"].includes(genreFit(c).klass)).length;
  const sortedCol = COLUMNS.find(x => x.key === sortState.key);

  return `
  <div class="head"><h1>候補ボード</h1>
    <span class="meta">SBIS-1の役割は精査の優先順位付けであり合否ではありません(§4-1)。
      <b>既定の並びは「適合」＝SBIS-1にジャンル減点を掛けた値です(SBIS-1の値自体は変えていません)。</b>
      列見出しをクリックで並べ替え(現在:${esc(sortedCol ? sortedCol.label : "#")}の${sortState.dir === "asc" ? "昇順" : "降順"})。
      精査済みは「精査」列に日付と語りの向きが出ます。行クリックで詳細に全文。</span>
    <div class="runsel">
      <a class="chip ${showCut ? "" : "on"}" href="${q(false, beautyOnly)}">有効候補のみ</a>
      <a class="chip ${showCut ? "on" : ""}" href="${q(true, beautyOnly)}">足切り・純度ゲートも表示</a>
      <a class="chip ${beautyOnly ? "on" : ""}" href="${q(showCut, !beautyOnly)}"
        title="主ジャンルか副ジャンルが美容の候補だけにします">非美容を隠す${hidden ? `(${hidden}件)` : ""}</a>
      <button class="btn ghost sm" id="btnDmCsv">DMリストCSVを書き出す</button>
      <button class="btn sm" id="btnDmSend">選択${selected.size}件にDMを送る</button>
    </div>
  </div>
  <div class="card" style="padding:0">
    <div class="tblwrap"><table>
      <thead><tr>${COLUMNS.map(col => {
        if (col.nosort) return `<th class="sel"><input type="checkbox" id="selAll" title="表示中を全選択"></th>`;
        const on = sortState.key === col.key;
        return `<th class="${col.cls || ""} sortable${on ? " on" : ""}" data-sortkey="${esc(col.key)}" title="クリックで並べ替え"`
          + `>${esc(col.label)}${on ? `<span class="arw">${sortState.dir === "asc" ? "▲" : "▼"}</span>` : ""}</th>`;
      }).join("")}</tr></thead>
      <tbody>${list.map((c, i) => {
        const sc = c.score || {};
        const a = t1Auto(numOrNull(c.aux.t1Topic), numOrNull(c.aux.t1Tieup));
        const el = dmEligibility(c);
        return `<tr class="click" data-u="${esc(c.username)}">
          <td class="sel"><input type="checkbox" class="rowsel" data-u="${esc(c.username)}"
            ${selected.has(c.username) ? "checked" : ""}
            title="${el.ok ? "一括DMの対象にする" : "送付ガードに掛かります:" + esc(el.reasons.join(" / "))}"></td>
          <td class="num">${i + 1}</td>
          <td><a class="handle" href="${esc(c.account_url || "#")}" target="_blank" rel="noopener">@${esc(c.username)}</a>
            ${sc.mode === "rescue" ? `<span class="tag res">救済 /75</span>` : ""}
            ${a && a.pitchman ? `<span class="tag red">紹介者</span>` : ""}
            ${sigTags(c.sig)}
            ${sc.cut ? `<span class="tag red">足切り</span>` : ""}
            <br><span class="hint">${esc(c.full_name || "")}</span></td>
          <td>${esc(TIER_LAB[sc.tier] || "—")}</td>
          <td>${genreCell(c)}</td>
          <td class="num">${fmt(c.followers)}</td>
          <td class="num">${ffRatio(c) ?? '<span class="hint">未評価</span>'}</td>
          <td class="num">${c.er == null ? "不明" : Number(c.er).toFixed(2)}</td>
          <td class="num">${c.avg_comments ?? "—"}</td>
          <td class="num">${sc.total ?? "—"}${sc.mode === "rescue" ? "<small>/75</small>" : ""}</td>
          <td class="num">${sc.rate == null ? "—" : sc.rate + "%"}</td>
          <td class="num"><b>${fitRate(c) == null ? "—" : fitRate(c) + "%"}</b>${
            genreFit(c).penalty ? `<br><span class="hint">${genreFit(c).penalty}</span>` : ""}</td>
          <td class="num">${scoreSbis2(c) || 0}</td>
          <td class="num">${scoreSbis3(c) || 0}</td>
          <td class="num"><b>${totalOf(c) ?? "—"}</b></td>
          <td>${esc(c.status)}</td>
          <td>${qualCell(c)}</td>
        </tr>`;
      }).join("")}</tbody>
    </table></div>
    ${list.length ? "" : `<div class="empty">まだ候補がありません。「収集」から取得結果をドロップしてください。</div>`}
  </div>
  <div class="note">行をクリックすると候補詳細(SBIS-1内訳・証言力rubric・適合コメント・精査結果)が開きます。</div>`;
}

/* 精査列。結論の全文は詳細画面に置き、ここは「済んだか・いつ・どう読んだか」だけ出す */
function qualCell(c) {
  const q = c.qualReport;
  if (!q) return `<span class="hint">未精査</span>`;
  const day = qualDay(c);
  if (!q.done) return `<span class="tag res">下書き</span> ${esc(day)}`;
  const stance = stanceOf(c);
  return `<span class="tag g">精査済</span> ${esc(day)}`
    + (stance ? `<br><span class="hint">${esc(stance)}</span>` : "")
    + ` <button class="btn ghost sm" data-mdrow="${esc(c.username)}">md</button>`;
}

/* ジャンル列。**落とすのではなく見えるようにする**のが目的(run#6:include方式なら合格13名中8名が消えていた) */
function genreCell(c) {
  const g = genreFit(c);
  const cls = g.klass === "core" ? "g" : g.klass === "sub" ? "" : g.klass === "far" ? "red" : "res";
  const name = g.genre || "不明";
  return `<span class="tag ${cls}">${esc(name)}</span>`
    + (g.penalty ? `<br><span class="hint">${esc(g.label)}</span>` : "");
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
