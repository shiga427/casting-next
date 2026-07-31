/* SBIS移植テスト(P0の完了条件)。
 *
 * 「管制室 v1.4 の JSON書き出しを読み込み、候補件数・SBIS合計が v1.4 と一致する」ことを
 * **目視ではなくスクリプトで**確認する。期待値 tests/fixtures/v14_expected.json は
 * tools/gen_v14_expected.mjs が凍結中の v1.4 の採点コードを実際に実行して作ったもの。
 *
 * 比較対象は SBIS-1 の内訳(①〜⑤・純度減点・raw・total・得点率・足切り・ゲート)、
 * SBIS-2/3・合計、シグナル、連載枠適格、FF比・コメント率、そして基準移行ログの文言まで。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { applyData } from "../js/pipeline/schema.js";
import { scoreSbis2, scoreSbis3, totalOf, ffRatio, commentRate } from "../js/pipeline/sbis.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures");
const expected = JSON.parse(readFileSync(join(FIX, "v14_expected.json"), "utf8"));
const NOW = "2026-07-30T00:00:00.000Z";

function port(fixtureName) {
  const data = JSON.parse(readFileSync(join(FIX, fixtureName), "utf8"));
  return applyData(data, NOW);
}
function snap(c) {
  return {
    username: c.username,
    tier: c.score.tier, mode: c.score.mode, max: c.score.max,
    parts: c.score.parts, raw: c.score.raw, total: c.score.total, rate: c.score.rate,
    cut: !!c.score.cut, gated: !!c.score.gated,
    purity: c.score.purity, flags: c.score.flags,
    sbis2: scoreSbis2(c), sbis3: scoreSbis3(c), total3: totalOf(c),
    sig: c.sig, growthKind: c.growth ? c.growth.kind : null,
    ffRatio: ffRatio(c), commentRate: commentRate(c),
    legacy_s2: c.legacy_s2, legacy_checks: c.legacy_checks, checks: c.checks, s2: c.s2
  };
}

for (const [fixture, key] of [["v3_export_sample.json", "v3_export_sample"], ["legacy_v11_sample.json", "legacy_v11_sample"]]) {
  const want = expected[key];
  const state = port(fixture);

  test(`${key}: 候補件数が v1.4 と一致`, () => {
    assert.equal(state.cands.length, want.候補件数);
  });

  test(`${key}: SBIS-1合計・SBIS-2合計・総合計が v1.4 と一致`, () => {
    const sum = arr => arr.reduce((s, x) => s + (x || 0), 0);
    assert.equal(sum(state.cands.map(c => c.score.total)), sum(want.cands.map(c => c.total)));
    assert.equal(sum(state.cands.map(scoreSbis2)), sum(want.cands.map(c => c.sbis2)));
    assert.equal(sum(state.cands.map(totalOf)), sum(want.cands.map(c => c.total3)));
  });

  test(`${key}: 全候補の採点内訳(①〜⑤・純度減点・足切り・ゲート・シグナル)が v1.4 と一致`, () => {
    const got = state.cands.map(snap);
    assert.equal(got.length, want.cands.length);
    const diffs = [];
    got.forEach((g, i) => {
      const w = want.cands[i];
      if (JSON.stringify(g) !== JSON.stringify(w)) {
        Object.keys(g).forEach(k => {
          if (JSON.stringify(g[k]) !== JSON.stringify(w[k])) {
            diffs.push(`${w.username}.${k}: JS=${JSON.stringify(g[k])} v1.4=${JSON.stringify(w[k])}`);
          }
        });
      }
    });
    assert.deepEqual(diffs, [], "v1.4 との差分:\n" + diffs.slice(0, 10).join("\n"));
  });

  test(`${key}: 基準移行ログ(バージョン・理由・差分の文言)が v1.4 と一致`, () => {
    const got = state.confLog.map(l => ({ ver: l.ver, reason: l.reason, diff: l.diff }));
    assert.deepEqual(got, want.confLog);
  });

  test(`${key}: 移行後の conf が v1.4 と一致`, () => {
    assert.deepEqual(state.conf, want.conf);
  });
}
