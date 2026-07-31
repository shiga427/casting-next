/* 情報漏れの検査(設計書§11-2)。公開前に必ず通す。
 *
 *   node tools/check_no_leak.mjs [--ref ../reference]
 *
 * リポジトリで git 管理されている全ファイルを走査し、
 *   ・reference/ に出てくる**実在ハンドル**
 *   ・reference/ に出てくる**実在の表示名(full_name)**
 *   ・instagram.com/<実在ハンドル> 形式のURL
 * が1つも含まれていないことを確認する。1件でも見つかったら異常終了する。
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv } from "../js/pipeline/util.js";
import { NAMES } from "../js/pipeline/screenBrand.js";
import { GENRE_KEYWORDS } from "../js/pipeline/genres.js";
import { KW_LIFE, KW_BIZ, KW_AMB, KW_AGE, KW_WIN, KW_INGREDIENT, KW_REVIEW } from "../js/pipeline/fitcomment.js";
import { COV_SEED } from "../js/pipeline/conf.js";
import { E1_TAGS, LIFE_TAGS, CORP_WORDS } from "../js/pipeline/rankQueue.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const argRef = process.argv.indexOf("--ref");
const REF = argRef > 0 ? process.argv[argRef + 1] : join(ROOT, "..", "reference");

function csvCol(path, name) {
  const rows = parseCsv(readFileSync(path, "utf8"));
  const head = rows[0].map(h => h.trim());
  const i = head.indexOf(name);
  return i < 0 ? [] : rows.slice(1).filter(r => r.length > 1).map(r => (r[i] || "").trim());
}

const handles = new Set();
const names = new Set();
for (const f of ["all_run6.csv", "matched_run6.csv", "rejected_run6.csv"]) {
  try {
    csvCol(join(REF, "成果物_run6", f), "username").forEach(u => { if (u) handles.add(u.replace(/^@/, "")); });
    csvCol(join(REF, "成果物_run6", f), "full_name").forEach(n => { if (n && n.length >= 3) names.add(n); });
  } catch (e) { /* そのファイルが無い環境ではスキップ */ }
}
try {
  csvCol(join(REF, "job_in_done.csv"), "username").forEach(u => { if (u) handles.add(u.replace(/^@/, "")); });
} catch (e) { }

if (!handles.size) {
  console.log("⚠ reference/ が見つからないため照合できませんでした(--ref でパスを指定してください)");
  process.exit(2);
}

/* 移植した辞書・検索キーワードと同じ文字列は「表示名としても実在した」だけで漏れではない。
   例:screen_brand.py のローマ字人名辞書(yuki/keiko…)、探索タグ「アラサー美容」。 */
const DICT_OK = new Set([
  ...NAMES, ...CORP_WORDS, ...E1_TAGS, ...LIFE_TAGS,
  ...KW_LIFE, ...KW_BIZ, ...KW_AMB, ...KW_AGE, ...KW_WIN, ...KW_INGREDIENT, ...KW_REVIEW,
  ...Object.values(GENRE_KEYWORDS).flat(),
  ...COV_SEED.map(c => c.term.replace(/^#/, "")),
].map(x => String(x).toLowerCase()));

const files = execSync("git ls-files", { cwd: ROOT }).toString().split("\n").filter(Boolean);
const hits = [];
for (const rel of files) {
  let text;
  try { text = readFileSync(join(ROOT, rel), "utf8"); } catch (e) { continue; }
  const lower = text.toLowerCase();
  for (const h of handles) {
    if (h.length < 4) continue;                       // 短すぎるハンドルは誤検知になるので除く
    if (lower.includes(h.toLowerCase())) hits.push(`${rel}: 実在ハンドル "${h}"`);
  }
  for (const n of names) {
    if (n.length < 4) continue;
    if (DICT_OK.has(n.toLowerCase())) continue;      // 移植辞書と同綴りは対象外
    if (text.includes(n)) hits.push(`${rel}: 実在の表示名 "${n}"`);
  }
}

if (hits.length) {
  console.error(`✖ 実在アカウントの識別子が ${hits.length}件 見つかりました。公開してはいけません:`);
  hits.slice(0, 20).forEach(h => console.error("   " + h));
  process.exit(1);
}
console.log(`✔ 漏れなし:git管理下 ${files.length}ファイルに実在ハンドル(${handles.size}件)・表示名(${names.size}件)の混入はありません`);
