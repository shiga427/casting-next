/* 収集キットと依頼文(P4)。依頼文は「引き継ぎ書の役割を果たす」必要がある(設計書§8-1)ので、
 * 章立て・禁止事項・落とし穴対策が1つでも欠けたら落ちるようにする。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const tpl = readFileSync(join(ROOT, "kit", "request_template.md"), "utf8");
const prof = readFileSync(join(ROOT, "kit", "prof_compact.js"), "utf8");
const probe = readFileSync(join(ROOT, "kit", "ig_probe.js"), "utf8");
const version = JSON.parse(readFileSync(join(ROOT, "kit", "version.json"), "utf8"));

test("依頼文テンプレートに §8-3 の9章がすべて入っている", () => {
  [
    "禁止事項", "手順", "対象リスト", "ペースとエラー処理", "データの規則",
    "30件時点の中間チェック", "成果物の形式", "精査データの収集"
  ].forEach(sec => assert.ok(tpl.includes(sec), sec + " の節がない"));
});

test("禁止事項が最上部にあり、DM・フォロー・いいね・UA偽装を明示している", () => {
  const banIdx = tpl.indexOf("禁止事項"), stepIdx = tpl.indexOf("## 手順");
  assert.ok(banIdx > 0 && banIdx < stepIdx, "禁止事項が手順より後ろにある");
  ["DM送信", "フォロー", "いいね", "投稿", "UA", "ページ遷移"].forEach(w =>
    assert.ok(tpl.includes(w), w + " の禁止が書かれていない"));
});

test("run#1〜6 の落とし穴対策が依頼文に内蔵されている", () => {
  assert.ok(tpl.includes("__CAP"), "キャプション上限の確認がない");
  assert.ok(tpl.includes("140"), "140字以上の指定がない");
  assert.ok(tpl.includes("__PRRE"), "PR判定の正規表現の確認がない");
  assert.ok(tpl.includes("taken_at"), "taken_at 降順の整列指示がない");
  assert.ok(tpl.includes("15〜20"), "15〜20件ずつのダンプ指示がない");
  assert.ok(tpl.includes("schema_error"), "schema_error の復旧手順がない");
  assert.ok(tpl.includes("429") || tpl.includes("rate limit"), "レート制限時の中断指示がない");
  assert.ok(tpl.includes("サロゲート"), "サロゲート単体の除去指示がない");
});

test("プレースホルダが管制室側の埋め込みと一致している", () => {
  ["{RUN_TAG}", "{COUNT}", "{KIT_URL}", "{HANDLES}", "{BAND_MIN}", "{BAND_MAX}", "{BRAND}", "{KIT_VERSION}"]
    .forEach(k => assert.ok(tpl.includes(k), k + " がテンプレートにない"));
});

test("プローブは改変せずに配置されている(キー名が ingest と1対1)", () => {
  assert.ok(prof.includes("window.__CAP = 140"), "__CAP が140でない(定性列が過小になる)");
  assert.ok(prof.includes("window.__PRRE"), "__PRRE がない(PR判定が切り詰め後テキストになる)");
  ["cap", "capl", "prl", "lv", "cd"].forEach(k =>
    assert.ok(new RegExp(`\\b${k}\\b`).test(prof), `キー ${k} がプローブにない`));
  assert.ok(probe.includes("window.IGF"), "ig_probe が IGF を定義していない");
  assert.equal(version.cap, 140);
});
