/* DM自動一括送付の検証(設計書_DM自動一括送付 §9-1・§9-2・§9-3)。
 *
 * ★ここが落ちている間は auto を有効化しない。送ったDMは取り消せない(§0-1)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDm, composeDmBatch, dmEligibility, DM_EXCLUDE, scanDmText } from "../js/pipeline/dmCompose.js";
import { applyDmResults, autoAllowed, AUTO_BLOCKED_REASON, buildCdpDm, cdpDmSummary, clampDmOpts } from "../js/pipeline/cdpDm.js";
import { migrate, newCand } from "../js/pipeline/schema.js";
import {
  DEFAULT_CONF, DM_BRAND, DM_DAILY_CAP, DM_MAX_WAIT, DM_MIN_WAIT, DM_PER_MIN_MAX, DM_SLOT_LINE,
} from "../js/pipeline/conf.js";
import { splitKw } from "../js/pipeline/util.js";

/* 送れる状態の候補を作る。ここから1項目ずつ壊してガードを確かめる */
function cand(username, over) {
  return Object.assign(newCand(), {
    username, full_name: "", followers: 12000,
    fitComment: "生活文脈で語れる人。懸念は投稿頻度。",
    score: { rate: 78, total: 78, max: 100, cut: false, tier: "micro", mode: "full" },
  }, over || {});
}
const MID = { score: { rate: 80, total: 80, max: 100, cut: false, tier: "middle", mode: "full" } };
const MEGA = { score: { rate: 90, total: 90, max: 100, cut: false, tier: "mega", mode: "full" } };

/* ---------------- §9-1 案内文 ---------------- */

test("ティアで分岐する。mega は文面を作らず「対象外」を返す(§4-2)", () => {
  const micro = buildDm(cand("m"), DM_BRAND, {});
  assert.equal(micro.ok, true);
  assert.ok(micro.basis.some(b => b.includes("micro")), "basis にティアが無い: " + micro.basis.join("/"));
  assert.ok(micro.text.includes("体験を"), "マイクロは experience_word=体験");
  assert.ok(!micro.text.includes(DM_SLOT_LINE), "マイクロに継続契約の文が入っている");

  const middle = buildDm(cand("d", MID), DM_BRAND, {});
  assert.equal(middle.ok, true);
  assert.ok(middle.basis.some(b => b.includes("middle")));
  assert.ok(middle.text.includes("体験レビューを"), "ミドルは experience_word=体験レビュー");
  assert.ok(middle.text.includes(DM_SLOT_LINE), "ミドル×連載枠に継続契約の文が無い");
  assert.notEqual(micro.text, middle.text, "ティアで文面が変わっていない");

  const mega = buildDm(cand("g", MEGA), DM_BRAND, {});
  assert.equal(mega.ok, false);
  assert.equal(mega.text, "");
  assert.equal(mega.reason, DM_EXCLUDE.MEGA);
});

test("精査ありなら charm/role が差し込まれ、無ければ作文しない(§4-3)", () => {
  const withQual = cand("q", {
    qualReport: { human: { charm: "ずぼら主婦の等身大な語り", role: "生活者の証言者" } },
  });
  const a = buildDm(withQual, DM_BRAND, {});
  assert.ok(a.text.includes("ずぼら主婦の等身大な語り"), "charm が本文に入っていない");
  assert.ok(a.text.includes("生活者の証言者"), "role が本文に入っていない");
  assert.ok(a.basis.some(b => b.includes("charm")) && a.basis.some(b => b.includes("role")));

  /* 素材が無い候補ではテンプレのまま。selectReason(機械の選定理由)を本文に転記しない */
  const plain = cand("p", { selectReason: "E1:#購入品紹介 由来・生活語ヒット" });
  const b = buildDm(plain, DM_BRAND, {});
  assert.ok(b.ok);
  assert.ok(!b.text.includes("E1:"), "機械の選定理由が本文に漏れている");
  assert.ok(!b.text.includes("購入品紹介"), "機械の選定理由が本文に漏れている");
  assert.ok(b.basis.some(x => x.includes("ティア既定")), "フォールバックが basis に残っていない");
  /* 素材が無い2人の本文は同一(＝推測で褒めていない) */
  assert.equal(b.text, buildDm(cand("p2"), DM_BRAND, {}).text.replace("@p2", "@p"));
});

test("生成文に薬機法NG語が絶対に入らない。入る入力は弾く(§4-4)", () => {
  /* まず既定テンプレ自体がNG語を含まないこと */
  const base = buildDm(cand("n"), DM_BRAND, {});
  assert.equal(scanDmText(base.text, DEFAULT_CONF).ok, true, "既定テンプレがNG語を含んでいる");

  /* 人が書いた読みにNG語が混ざったら、丸めず生成失敗にする */
  splitKw(DEFAULT_CONF.ngWords).slice(0, 6).forEach(w => {
    const bad = cand("x", { qualReport: { human: { charm: `${w}を語れる人`, role: "" } } });
    const r = buildDm(bad, DM_BRAND, {});
    assert.equal(r.ok, false, `NG語「${w}」が通ってしまった`);
    assert.equal(r.text, "", "弾いたのに本文を返している");
    assert.ok(r.reason.includes(w), "理由にNG語が出ていない");
  });
});

test("「限定」の断定が出ない。#PR と事前チェックの案内は必ず入る(§4-4)", () => {
  ["micro", "middle"].forEach(tier => {
    const c = cand("t", { score: { rate: 80, total: 80, max: 100, cut: false, tier, mode: "full" } });
    const r = buildDm(c, DM_BRAND, {});
    assert.ok(r.ok);
    assert.ok(!r.text.includes("限定"), `${tier}: 「限定」の断定が入っている`);
    assert.ok(r.text.includes("#PR"), `${tier}: #PR の案内が無い`);
    assert.ok(r.text.includes("薬機法チェック"), `${tier}: 事前チェックの案内が無い`);
    assert.ok(r.text.includes("毎週の抽選"), `${tier}: 抽選枠の事実記述が無い`);
    assert.ok(r.text.includes(`週${DM_BRAND.weeklyMin}〜${DM_BRAND.weeklyMax}名`), `${tier}: 購入枠の実値が無い`);
    assert.ok(r.text.includes(`${DM_BRAND.oddsMin}〜${DM_BRAND.oddsMax}倍`), `${tier}: 当選倍率の実値が無い`);
  });
  /* 「限定」を人が書き足しても弾く */
  const bad = buildDm(cand("l", { qualReport: { human: { charm: "限定コスメに強い", role: "" } } }), DM_BRAND, {});
  assert.equal(bad.ok, false);
});

test("宛名は full_name があれば実名、無ければ @handle(§4-5)", () => {
  assert.ok(buildDm(cand("h", { full_name: "山田 花子" }), DM_BRAND, {}).text.startsWith("山田 花子 様"));
  assert.ok(buildDm(cand("h"), DM_BRAND, {}).text.startsWith("@h 様"));
});

/* ---------------- §9-2 ガード ---------------- */

test("送らない相手を送らない。理由が必ず付く(§6-3)", () => {
  assert.equal(dmEligibility(cand("ok")).ok, true);
  const cases = [
    [{ dmSentAt: "2026-08-01" }, DM_EXCLUDE.SENT],
    [{ dm: { sentAt: "2026-08-01T00:00:00.000Z" } }, DM_EXCLUDE.SENT],
    [{ fitComment: "   " }, DM_EXCLUDE.FIT_MISSING],
    [{ status: "見送り" }, DM_EXCLUDE.DROPPED],
    [{ aux: { t1Topic: "6", t1Tieup: "5" } }, DM_EXCLUDE.PITCHMAN],   /* 5/8=62.5% > 50% */
    [{ scan: { habitual: true } }, DM_EXCLUDE.HABITUAL],
    [MEGA, DM_EXCLUDE.MEGA],
    [{ score: { rate: 10, total: 10, max: 100, cut: false, tier: "out", mode: "full" } }, DM_EXCLUDE.OUT_BAND],
    [{ score: {} }, DM_EXCLUDE.NO_SCORE],
  ];
  cases.forEach(([over, reason]) => {
    const e = dmEligibility(cand("x", over));
    assert.equal(e.ok, false, `除外されていない: ${reason}`);
    assert.ok(e.reasons.includes(reason), `理由が違う: ${JSON.stringify(e.reasons)} / 期待 ${reason}`);
  });
  /* ちょうど50%は紹介者にしない(既存 t1Auto の仕様。ここで丸めない) */
  assert.equal(dmEligibility(cand("half", { aux: { t1Topic: "6", t1Tieup: "4" } })).ok, true);
});

test("除外された候補は黙って落とさず、理由付きで excluded に残る(§2-1・§6-3)", () => {
  const list = [cand("a"), cand("b", { status: "見送り" }), cand("c", { fitComment: "" })];
  const { items, excluded } = composeDmBatch(list, {});
  assert.deepEqual(items.map(i => i.handle), ["a"]);
  assert.deepEqual(excluded.map(e => e.handle), ["b", "c"]);
  excluded.forEach(e => assert.ok(e.reasons.length > 0, "理由の無い除外がある"));
});

/* ---------------- §9-3 送付キュー ---------------- */

test("送付キューが popup の読取形と一致し、上限超過は deferred に残る(§3・§6-2)", () => {
  const many = Array.from({ length: DM_DAILY_CAP + 5 }, (_, i) => cand("u" + i));
  const p = buildCdpDm(many, { at: "2026-08-04T00:00:00.000Z" });
  /* §3 のペイロード形 */
  ["items", "mode", "perMinMax", "minWaitMs", "maxWaitMs", "dailyCap", "dryRun", "at"].forEach(k =>
    assert.ok(k in p, `キーが無い: ${k}`));
  p.items.forEach(it => ["handle", "userId", "text", "tier", "slot"].forEach(k =>
    assert.ok(k in it, `item のキーが無い: ${k}`)));
  assert.equal(p.mode, "semi", "既定が半自動でない(§5-1)");
  assert.equal(p.dryRun, false);
  assert.equal(p.eligible, DM_DAILY_CAP + 5);
  assert.equal(p.items.length, DM_DAILY_CAP);
  assert.equal(p.deferred, 5, "上限超過が黙って切られている");
  assert.equal(p.deferredHandles.length, 5);
  assert.ok(cdpDmSummary(p).includes("残り 5名"), "繰り越しを言っていない: " + cdpDmSummary(p));
});

test("レート設定は緩められない。伸ばす/下げる方向だけ通る(§6-1・§6-2)", () => {
  const loose = clampDmOpts({ minWaitMs: 1000, maxWaitMs: 2000, perMinMax: 20, dailyCap: 999 });
  assert.equal(loose.minWaitMs, DM_MIN_WAIT);
  assert.equal(loose.maxWaitMs, DM_MAX_WAIT);
  assert.equal(loose.perMinMax, DM_PER_MIN_MAX);
  assert.equal(loose.dailyCap, DM_DAILY_CAP);
  const safe = clampDmOpts({ minWaitMs: 120000, maxWaitMs: 300000, dailyCap: 3 });
  assert.equal(safe.minWaitMs, 120000, "待機を伸ばす指定が通らない");
  assert.equal(safe.maxWaitMs, 300000);
  assert.equal(safe.dailyCap, 3, "上限を下げる指定が通らない");
});

test("auto はガード全通過＋直近ドライラン成功のときだけ選べる(§5-1)", () => {
  /* endpointVerified は「送信APIが実機で動くと確認済み」の意。
     2026-08-04 現在この条件は満たせない(下のテスト参照)ので、他の条件を見るときは true を渡す */
  const V = { endpointVerified: true };
  const clean = buildCdpDm([cand("a"), cand("b")], {});
  assert.equal(autoAllowed(clean, { ...V, dryRunPassed: false }).ok, false, "ドライラン無しで auto が通った");
  assert.ok(autoAllowed(clean, { ...V, dryRunPassed: false }).why.some(w => w.includes("ドライラン")));
  assert.equal(autoAllowed(clean, { ...V, dryRunPassed: true }).ok, true);

  const dirty = buildCdpDm([cand("a"), cand("b", { status: "見送り" })], {});
  const r = autoAllowed(dirty, { ...V, dryRunPassed: true });
  assert.equal(r.ok, false, "ガード除外があるのに auto が通った");
  assert.ok(r.why.some(w => w.includes("除外")));
});

/* 2026-08-04 実機検証: 設計書§5-3 の送信エンドポイントは現行のInstagram webに存在しない。
 * 人が手で送ったDMをネットワーク層で観測しても、あのエンドポイントへのPOSTは0件だった
 * (実際は /api/graphql の Relay ミューテーション)。全自動はこの事実が覆るまで選ばせない。 */
test("送信APIが未検証のあいだは、他の条件を全て満たしても auto を選べない", () => {
  const clean = buildCdpDm([cand("a"), cand("b")], {});
  const r = autoAllowed(clean, { dryRunPassed: true });   /* endpointVerified を渡さない＝既定 */
  assert.equal(r.ok, false, "送信APIが使えないのに auto が通った");
  assert.ok(r.why.some(w => w.includes("全自動は現在使えません")), JSON.stringify(r.why));
  assert.equal(r.why.includes(AUTO_BLOCKED_REASON), true);
});

/* ---------------- §7 ステータス連動 ---------------- */

test("送付成功だけが status を進める。ドライラン・下書きは進めない(§7)", () => {
  const cands = [cand("ok"), cand("dr"), cand("df"), cand("ng", { fitComment: "" })];
  /* ドライランは何も進めない */
  const dry = applyDmResults(cands, {
    dryRun: true, results: [{ handle: "dr", result: "dryrun", dryRun: true }],
  }, "2026-08-04");
  assert.deepEqual(dry.applied, []);
  assert.equal(cands[1].status, "候補");
  assert.equal(cands[1].dmSentAt, "");

  const r = applyDmResults(cands, {
    mode: "auto",
    results: [
      { handle: "ok", result: "ok", at: "2026-08-04T01:00:00.000Z", threadId: "t1", textHash: "len=10:…" },
      { handle: "df", result: "draft" },
      { handle: "ng", result: "ok", at: "2026-08-04T01:01:00.000Z" },
    ],
  }, "2026-08-04");
  assert.deepEqual(r.applied, ["ok"]);
  assert.equal(cands[0].status, "DM送付");
  assert.equal(cands[0].dmSentAt, "2026-08-04", "既存の dmDue が効く形になっていない");
  assert.equal(cands[0].dm.threadId, "t1");
  assert.equal(cands[0].dm.sentAt, "2026-08-04T01:00:00.000Z");
  /* semi の下書きは status を進めない(人が送ったか不明なため) */
  assert.deepEqual(r.drafts, ["df"]);
  assert.equal(cands[2].status, "候補");
  assert.equal(cands[2].dm.result, "draft");
  /* 適合コメント未記入は setStatus の既存ガードで弾かれ、理由が残る(§4-5・二重に安全) */
  assert.equal(r.blocked.length, 1);
  assert.equal(cands[3].status, "候補");
});

test("schema に c.dm が入り、既存データにも補われる(§3)", () => {
  assert.deepEqual(newCand().dm, { lastText: "", sentAt: "", threadId: "", result: "", mode: "" });
  const old = migrate({ username: "old", s2: {} });
  assert.deepEqual(old.dm, { lastText: "", sentAt: "", threadId: "", result: "", mode: "" });
  const kept = migrate({ username: "k", s2: {}, dm: { sentAt: "2026-08-01T00:00:00.000Z", result: "ok" } });
  assert.equal(kept.dm.sentAt, "2026-08-01T00:00:00.000Z");
  assert.equal(kept.dm.result, "ok");
  assert.equal(kept.dm.threadId, "", "既存値を残しつつ不足キーが補われていない");
});
