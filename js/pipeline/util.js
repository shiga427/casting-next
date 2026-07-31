/* 共通ユーティリティ(設計書§6-1)。
 * 移植元:管制室 v1.4(stembeaute_casting_control.html)の parseCsv / nfkc / toNum / toBool /
 *         splitKw / todayISO / bizDaysSince / splitPosts / clamp / r1 / numOrNull。
 * DOM に触れない純関数のみ。ブラウザと Node の両方で import できる ES Modules。
 */

/* --- 数値・文字の整形 ------------------------------------------------- */

/* v1.4 の toNum をそのまま。"不明"/none/null/nan は null(0で埋めない=§6-2 の7) */
export function toNum(v) {
  if (v == null) return null;
  v = String(v).trim();
  if (v === "" || v === "不明" || v.toLowerCase() === "none" || v.toLowerCase() === "null" || v.toLowerCase() === "nan") return null;
  const n = Number(v.replace(/,/g, ""));
  return isFinite(n) ? n : null;
}

/* v1.4 の toBool をそのまま。判定できない値は null(false ではない) */
export function toBool(v) {
  if (v == null) return null;
  v = String(v).trim().toLowerCase();
  if (["true", "1", "yes", "あり"].includes(v)) return true;
  if (["false", "0", "no", "なし"].includes(v)) return false;
  return null;
}

/* v1.4 の numOrNull / clamp / r1 */
export function numOrNull(v) { if (v === "" || v == null) return null; const n = Number(v); return isFinite(n) ? n : null; }
export function clamp(x) { return Math.max(0, Math.min(1, x)); }
export function r1(x) { return Math.round(x * 10) / 10; }

/* v1.4 の splitKw:カンマ区切り設定値 → 配列 */
export function splitKw(s) { return (s || "").split(",").map(x => x.trim()).filter(Boolean); }

/* v1.4 の nfkc(判断27):NG突合の前に必須。装飾文字・全角半角の揺れによるすり抜けを解除 */
export function nfkc(s) { try { return String(s ?? "").normalize("NFKC"); } catch (e) { return String(s ?? ""); } }

/* サロゲート単体の除去(run#6 の落とし穴対策・設計書§3)。
 * ペアになっていない D800-DFFF は JSON 化・IndexedDB 保存で壊れるため落とす。 */
export function stripLoneSurrogates(s) {
  return String(s ?? "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "").replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "$1");
}

/* --- コードポイント単位の長さ・切り出し ------------------------------- */
/* Python の len()/スライスは**コードポイント単位**。JS の .length は UTF-16 単位なので、
 * 絵文字を含むキャプションで数が食い違う(run#6 のキャプション平均57字の再現に効く)。 */
export function cpLen(s) { return Array.from(String(s ?? "")).length; }
export function cpSlice(s, start, end) { return Array.from(String(s ?? "")).slice(start, end).join(""); }

/* --- CSV ------------------------------------------------------------- */

/* v1.4 の parseCsv をそのまま(BOM・引用符・CRLF 対応。実績あり) */
export function parseCsv(text) {
  text = text.replace(/^﻿/, "");
  const rows = []; let row = [], cur = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") { row.push(cur); cur = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(cur); cur = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
      } else cur += ch;
    }
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

/* CSV行 → ヘッダ名アクセスできるオブジェクト列。ヘッダは小文字化して突合(v1.4 の importCsv と同じ) */
export function csvToObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { head: [], rows: [] };
  const head = rows[0].map(h => h.trim().toLowerCase());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const o = {};
    head.forEach((h, j) => { o[h] = r[j] ?? ""; });
    /* v1.4 の importCsv は「セルが2つ未満の行」を不正行として飛ばす。
       1列だけの台帳CSV(job_in_done.csv の username 列)も読めるよう、
       ここでは飛ばさずセル数だけ渡し、判断は呼び出し側に委ねる。 */
    Object.defineProperty(o, "_cells", { value: r.length, enumerable: false });
    out.push(o);
  }
  return { head, rows: out };
}

/* 書き出し用。Excel の文字化けを避けるため呼び出し側で BOM を付ける */
export function toCsv(columns, rows) {
  const q = s => '"' + String(s ?? "").replace(/"/g, '""') + '"';
  return [columns.join(",")].concat(rows.map(r => columns.map(c => q(r[c])).join(","))).join("\r\n");
}

/* --- 日付・営業日 ----------------------------------------------------- */

export function todayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/* v1.4 の bizDaysSince。祝日非対応は既知の制限(設計書§11-4) */
export function bizDaysSince(iso, today) {
  if (!iso) return null;
  const from = new Date(iso + "T00:00:00"), to = new Date((today || todayISO()) + "T00:00:00");
  if (isNaN(from)) return null;
  let n = 0; const cur = new Date(from);
  while (cur < to) { cur.setDate(cur.getDate() + 1); const w = cur.getDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}

/* --- 投稿本文の分割(v2.1 §9 判断2) ---------------------------------- */
/* 「行全体が --- の行だけを区切りにする」。無ければ空行区切りを許容 */
export const POST_SEP = /^[ \t]*-{3,}[ \t]*$/m;
export function splitPosts(txt) {
  const t = String(txt || "");
  const arr = POST_SEP.test(t) ? t.split(/^[ \t]*-{3,}[ \t]*$/m) : t.split(/\n\s*\n/);
  return arr.map(s => s.trim()).filter(Boolean);
}
