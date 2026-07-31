/* CSV/JSON 書き出し(設計書§5-3「補助機能に降格」)。移植元:igfinder/export.py + ingest_compact.py。
 * 列名・列順・値の見え方(TRUE/FALSE・bio 200字要約・float の .0)を Python と一致させる。
 * ゴールデンテストはこの行データで Python 版と1文字単位の突合を行う。
 */
import { build as buildFitComment } from "./fitcomment.js";
import { cpLen, cpSlice } from "./util.js";

/* 設計書 Phase5 の列設計(順序も仕様) */
export const COLUMNS = [
  "account_url", "username", "full_name", "followers", "engagement_rate", "avg_likes",
  "avg_comments", "genre", "has_external_link", "external_url", "bio", "matched_keywords",
  "discovered_via", "scraped_at",
  /* v2.2 追加。既存14列の順序は変えず**末尾に**足す(ツールはヘッダ名で読む) */
  "following", "ff_ratio"
];
export const REJECTED_COLUMNS = [...COLUMNS, "reject_reason", "reject_detail"];
/* 判断25:拡張CSV(19列)= 既存16列 + 一次適合コメント3列。v2.7 で定性6列を追加 */
export const EXT_COLUMNS = [...COLUMNS, "select_reason", "fit_comment", "fit_concern",
  "qual_stance", "qual_voice", "qual_evidence", "qual_pr_posts", "qual_caption_len", "qual_reliability"];

export const BIO_EXCERPT_LEN = 200;

/* Python の str(float) と同じ見え方にする(5 → "5.0")。int はそのまま */
function cell(v) {
  if (v == null) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  return String(v);
}
/* float であることが分かっている列(round で作られた値)は .0 を保つ */
function floatCell(v) {
  if (v == null) return "";
  return Number.isInteger(v) ? v.toFixed(1) : String(v);
}
function boolCell(v) { return v == null ? "" : (v ? "TRUE" : "FALSE"); }
/* 平均値は Python 側で int になることがある(statistics.mean が int を返す場合)。
   ingest が _pyInt で判定しているのでそれに従う。 */
function numCell(record, field) {
  const v = record[field];
  if (v == null) return "";
  return (record._pyInt && record._pyInt[field]) ? String(v) : floatCell(v);
}
function join(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return v.filter(x => x !== null && x !== "").map(String).join(", ");
  return String(v);
}
function excerpt(text, limit = BIO_EXCERPT_LEN) {
  if (typeof text !== "string") return "";
  const single = text.split(/\s+/).filter(Boolean).join(" ");
  return cpLen(single) <= limit ? single : cpSlice(single, 0, limit - 1) + "…";
}

export function toRow(record) {
  const handle = record.username || "";
  return {
    account_url: record.account_url || (handle ? `https://www.instagram.com/${handle}/` : ""),
    username: handle ? `@${handle}` : "",
    full_name: record.full_name || "",
    followers: cell(record.followers),
    engagement_rate: floatCell(record.engagement_rate),
    avg_likes: numCell(record, "avg_likes"),
    avg_comments: numCell(record, "avg_comments"),
    genre: record.genre || "",
    has_external_link: boolCell(record.has_external_link),
    external_url: record.external_url_resolved || record.external_url || "",
    bio: excerpt(record.bio_text),
    matched_keywords: join(record.matched_keywords),
    discovered_via: join(record.discovered_via),
    scraped_at: record.scraped_at || "",
    following: cell(record.following),
    ff_ratio: floatCell(record.ff_ratio)
  };
}

export function toRejectedRow(record) {
  const row = toRow(record);
  const reasons = record.filter_reasons || [];
  row.reject_reason = record.reject_reason || "";
  row.reject_detail = reasons.map(r => String(r.message ?? r.code ?? "")).join(" / ");
  return row;
}

/* 16列 + 一次適合コメント3列(判断25)+ 定性6列(v2.7) */
export function extRow(record) {
  const row = toRow(record);
  const parts = buildFitComment(record, record._captions, record._pr_posts);
  ["select_reason", "fit_comment", "fit_concern", "qual_stance", "qual_voice",
    "qual_evidence", "qual_pr_posts", "qual_caption_len", "qual_reliability"].forEach(k => {
      row[k] = cell(parts[k]);
    });
  return row;
}

/* ER 降順(空は末尾)。目で見て上から当たれる順にする */
export function sortRows(rows, key = "engagement_rate") {
  return rows.slice().sort((a, b) => {
    const va = a[key], vb = b[key];
    const ka = (va === null || va === "" || va === undefined) ? [1, 0] : [0, -Number(va)];
    const kb = (vb === null || vb === "" || vb === undefined) ? [1, 0] : [0, -Number(vb)];
    return (ka[0] - kb[0]) || (ka[1] - kb[1]);
  });
}

/* Excel の文字化けを避けるため BOM 付き。改行は CRLF(Python の csv と同じ) */
export function rowsToCsv(rows, columns = COLUMNS) {
  const q = s => {
    const t = String(s ?? "");
    return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  return [columns.join(",")].concat(rows.map(r => columns.map(c => q(r[c])).join(","))).join("\r\n") + "\r\n";
}
