/* 発掘(E1タグ探索)モードの取り込み。
 * 新規利用者はプールを持っていないので、取得結果から**プール・取得済み台帳・カバレッジ表**を
 * 自動で作る。ここが効かないと2周目以降に取得済み除外が働かない(run#6 不具合1と同じ事故になる)。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { absorbRun, normalizeTag, tagsOfRow, discoveryTags } from "../js/pipeline/discovery.js";
import { buildQueue } from "../js/pipeline/rankQueue.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const preset = JSON.parse(readFileSync(join(HERE, "..", "presets", "stembeaute_v26.json"), "utf8"));

const run = {
  runTag: "run1",
  rows: [
    { username: "mama_kurashi", discovered_via: "E1:#ママ美容", matched_keywords: "#ママ美容" },
    { username: "yuka_days", discovered_via: "E1:#アラサー美容|#ママ美容", matched_keywords: "#アラサー美容|#ママ美容" },
    { username: "cosme_only", discovered_via: "E1:#コスメレポ", matched_keywords: "#コスメレポ" },
  ]
};

test("タグの表記ゆれ(E1: 付き・# なし)を1つに揃える", () => {
  assert.equal(normalizeTag("E1:#ママ美容"), "#ママ美容");
  assert.equal(normalizeTag("ママ美容"), "#ママ美容");
  assert.equal(normalizeTag("#ママ美容"), "#ママ美容");
  assert.equal(normalizeTag("  "), "");
  assert.deepEqual(tagsOfRow(run.rows[1]), ["#アラサー美容", "#ママ美容"]);
});

test("経路メモ(run6:queue_v6 等)はタグとして扱わない(カバレッジ表を汚さない)", () => {
  assert.deepEqual(tagsOfRow({ discovered_via: "run6:queue_v6", matched_keywords: "購入品紹介" }), ["#購入品紹介"]);
  assert.deepEqual(tagsOfRow({ discovered_via: "run6:retry", matched_keywords: "" }), []);
  const r = absorbRun({ runTag: "run6", rows: [{ username: "x", discovered_via: "run6:retry", matched_keywords: "" }] },
    { pool: [], coverage: [], done: [] });
  assert.equal(r.coverage.length, 0, "経路メモでカバレッジ行が作られている");
  assert.equal(r.pool.length, 1, "タグが無くてもハンドルは記録する(収集の原則)");
});

test("取得結果からプールが自動で作られる(プールCSVなしで2周目に繋がる)", () => {
  const r = absorbRun(run, { pool: [], coverage: [], done: [] });
  assert.equal(r.addedToPool, 3);
  assert.equal(r.pool.length, 3);
  const y = r.pool.find(p => p.handle === "yuka_days");
  assert.equal(y.tags, "#アラサー美容|#ママ美容");
  assert.equal(y.discovered_via, "E1:#アラサー美容|#ママ美容");
  assert.equal(y.runTag, "run1");
});

test("取得済み台帳に積まれ、次回のキュー生成で除外される", () => {
  const r = absorbRun(run, { pool: [], coverage: [], done: [] });
  assert.equal(r.addedToDone, 3);
  /* 2周目:同じハンドルがプールにいてもキューには出ない */
  const q = buildQueue(r.pool, new Set(r.done), 100);
  assert.equal(q.queue.length, 0, "取得済みが除外されていない");
  /* 新しいハンドルが増えたときだけキューに出る */
  const q2 = buildQueue(r.pool.concat([{ handle: "new_mama.01", tags: "#ママ美容", likes: 500 }]), new Set(r.done), 100);
  assert.deepEqual(q2.queue.map(x => x.handle), ["new_mama.01"]);
});

test("探索カバレッジ表のタグ行が自動更新される(収集数・取得済・状態)", () => {
  const coverage = [{ route: "E1", term: "#ママ美容", collected: "10", fetched: "4", st: "実行中" }];
  const r = absorbRun(run, { pool: [], coverage, done: [] });
  const mama = r.coverage.find(x => x.term === "#ママ美容");
  assert.equal(mama.collected, "12");   // 10 + 2件(mama_kurashi, yuka_days)
  assert.equal(mama.fetched, "6");      // 4 + 2件
  assert.equal(mama.st, "完了");
  /* 表に無かったタグは行が新設される(未実行を隠さない表なので勝手に消さない) */
  const arasa = r.coverage.find(x => x.term === "#アラサー美容");
  assert.ok(arasa, "新しいタグの行が作られていない");
  assert.equal(arasa.route, "E1");
  assert.equal(arasa.fetched, "1");
});

test("2回ドロップしても同じハンドルはプールで重複しない", () => {
  const first = absorbRun(run, { pool: [], coverage: [], done: [] });
  const second = absorbRun(run, { pool: first.pool, coverage: first.coverage, done: first.done });
  assert.equal(second.pool.length, 3);
  assert.equal(second.addedToPool, 0);
  assert.equal(second.addedToDone, 0);
});

test("発掘タグはプリセットから作られ、生活文脈タグが先頭に来る(実測で帯内率2倍)", () => {
  const tags = discoveryTags(preset);
  assert.ok(tags.length >= 17, "E1タグが揃っていない: " + tags.length);
  assert.ok(tags[0].life, "生活文脈タグが先頭に来ていない");
  assert.ok(tags.every(t => t.tag.startsWith("#")));
  const life = tags.filter(t => t.life).map(t => t.tag);
  assert.ok(life.includes("#ママ美容") && life.includes("#ずぼらスキンケア"));
  /* 行動タグも落とさない */
  assert.ok(tags.some(t => t.tag === "#購入品紹介"));
});

test("懸賞・アフィリの巣になっているタグは既定OFF(タグ自体は消さない)", () => {
  const tags = discoveryTags(preset);
  const byTag = Object.fromEntries(tags.map(t => [t.tag, t]));
  /* 2026-08-07 実測(本人環境405行)で美容ジャンル率が8〜23%だった4本 */
  ["#当選報告", "#当選しました", "#モニター当選", "#購入品紹介"].forEach(t => {
    assert.ok(byTag[t], "タグが消えている: " + t);
    assert.equal(byTag[t].off, true, "既定OFFになっていない: " + t);
  });
  /* 美容率が高いタグは既定ON のまま */
  ["#使い切りコスメ", "#スキンケア記録", "#夜のスキンケア", "#アラサー美容"].forEach(t => {
    assert.equal(byTag[t].off, false, "既定ONのはずが外れている: " + t);
  });
  /* 判断材料の美容率が載っている */
  assert.equal(byTag["#当選報告"].purity, 8);
  assert.equal(byTag["#使い切りコスメ"].purity, 100);
});
