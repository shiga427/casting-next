/* 収集ロジックの正本(kit/)と、拡張が読むコピー(extension/igf/)の一致検証。
 *
 * ★なぜ要るか: この2組は**手動コピーの二重管理**になっている。
 * 片方だけ直すと、拡張の取得結果が静かに変わって「昨日と同じ条件なのに数字が違う」事故になる。
 * どちらを直しても、もう片方を揃えるまでこのテストが落ちる。
 *
 * 直し方: 正本は kit/ 側。`cp kit/<file> extension/igf/<file>` で揃える。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const SHARED = ["ig_probe.js", "prof_compact.js"];

const sha256 = path => createHash("sha256").update(readFileSync(path)).digest("hex");

SHARED.forEach(name => {
  test(`kit/${name} と extension/igf/${name} が完全一致している`, () => {
    const kit = join(ROOT, "kit", name);
    const igf = join(ROOT, "extension", "igf", name);
    assert.equal(
      sha256(igf), sha256(kit),
      `${name} が乖離しています。正本は kit/ 側です:\n  cp kit/${name} extension/igf/${name}`
    );
  });
});

test("共有ファイルの一覧が実体とずれていない(片方にだけファイルが増えていない)", () => {
  /* 新しい共有ファイルを足したらここにも足す。足し忘れると検証の網から漏れる */
  SHARED.forEach(name => {
    assert.doesNotThrow(() => readFileSync(join(ROOT, "kit", name)), `kit/${name} が無い`);
    assert.doesNotThrow(() => readFileSync(join(ROOT, "extension", "igf", name)), `extension/igf/${name} が無い`);
  });
});
