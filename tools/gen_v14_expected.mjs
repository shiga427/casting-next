/* SBIS移植テストの期待値を **凍結中の管制室 v1.4 そのもの** から作る。
 *
 *   node tools/gen_v14_expected.mjs [--ref ../reference]
 *
 * reference/tool/stembeaute_casting_control.html の <script> のうち、
 * 「定数〜scanCaptions」までの純ロジック部分だけを切り出して Node 上で評価し、
 * fixture(v3書き出しJSON)を applyData() に食わせた結果を期待値として書き出す。
 * v1.4 のコードは1行もこのリポジトリにコピーしない(期待値の数値だけを残す)。
 *
 * 出力: tests/fixtures/v14_expected.json
 *   { 候補件数, conf, confLog(ver/diff/reason), cands:[{username, score…, sbis2, sbis3, total, sig, growth}] }
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const argRef = process.argv.indexOf("--ref");
const REF = argRef > 0 ? process.argv[argRef + 1] : join(ROOT, "..", "reference");
const HTML = join(REF, "tool", "stembeaute_casting_control.html");

const html = readFileSync(HTML, "utf8");
const scriptBody = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
/* 純ロジック部分 = 先頭から importCsv(=DOM操作の始まり)の直前まで */
const cut = scriptBody.indexOf("function importCsv(");
if (cut < 0) throw new Error("v1.4 の importCsv が見つかりません。切り出し位置を確認してください");
const pure = scriptBody.slice(0, cut);

/* DOM/localStorage は使わないので最小のスタブを与える(評価を通すためだけ) */
const noop = () => { };
const elStub = new Proxy({}, { get: () => "", set: () => true });
const documentStub = { getElementById: () => elStub, addEventListener: noop, querySelectorAll: () => [], querySelector: () => null, visibilityState: "visible" };
const windowStub = { addEventListener: noop };
const localStorageStub = { setItem: noop, getItem: () => null, removeItem: noop };

const factory = new Function("document", "window", "localStorage", `
  ${pure}
  return { applyData, scoreSbis1, scoreSbis2, scoreSbis3, growthEval, signalsOf, t1Auto,
           ffRatio, commentRate, migrate, newCand, DEFAULT_CONF, getState: () => state,
           totalOfLike: (cd) => (cd.score && cd.score.total != null) ? r1(cd.score.total + scoreSbis2(cd) + scoreSbis3(cd)) : null };
`);
const v14 = factory(documentStub, windowStub, localStorageStub);

function snapshot(fixturePath) {
  const data = JSON.parse(readFileSync(fixturePath, "utf8"));
  v14.applyData(data);
  const st = v14.getState();
  return {
    候補件数: st.cands.length,
    conf: st.conf,
    confLog: st.confLog.map(l => ({ ver: l.ver, reason: l.reason, diff: l.diff })),
    cands: st.cands.map(c => ({
      username: c.username,
      tier: c.score.tier, mode: c.score.mode, max: c.score.max,
      parts: c.score.parts, raw: c.score.raw, total: c.score.total, rate: c.score.rate,
      cut: !!c.score.cut, gated: !!c.score.gated,
      purity: c.score.purity, flags: c.score.flags,
      sbis2: v14.scoreSbis2(c), sbis3: v14.scoreSbis3(c), total3: v14.totalOfLike(c),
      sig: c.sig, growthKind: c.growth ? c.growth.kind : null,
      ffRatio: v14.ffRatio(c), commentRate: v14.commentRate(c),
      legacy_s2: c.legacy_s2, legacy_checks: c.legacy_checks, checks: c.checks, s2: c.s2
    }))
  };
}

const out = {
  _生成: "tools/gen_v14_expected.mjs が reference/tool/stembeaute_casting_control.html(v1.4)の採点部を実行した出力",
  v3_export_sample: snapshot(join(ROOT, "tests", "fixtures", "v3_export_sample.json")),
  legacy_v11_sample: snapshot(join(ROOT, "tests", "fixtures", "legacy_v11_sample.json")),
};
writeFileSync(join(ROOT, "tests", "fixtures", "v14_expected.json"), JSON.stringify(out, null, 1), "utf8");
const a = out.v3_export_sample;
console.log(`書き出し: tests/fixtures/v14_expected.json`);
console.log(`  v3_export_sample: 候補 ${a.候補件数}件 / SBIS-1合計 ${a.cands.reduce((s, c) => s + (c.total || 0), 0)} / 移行ログ ${a.confLog.length}件`);
console.log(`  legacy_v11_sample: 候補 ${out.legacy_v11_sample.候補件数}件 / 移行ログ ${out.legacy_v11_sample.confLog.length}件`);
