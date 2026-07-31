/* SBIS 採点(設計書§6-1「現行HTMLから関数単位でそのまま移す」)。
 * 移植元:管制室 v1.4 の scoreSbis1 / purityPenalty / signalsOf / scoreSbis2 / scoreSbis3 /
 *         t1Auto / growthEval / ffRatio / commentRate / scanCaptions / displayRisk / dmDue / pearson。
 * 式・閾値・丸め桁を1文字も変えていない。改善案は実装せず「提案」として報告する(§6-2)。
 */
import { clamp, r1, numOrNull, splitKw, nfkc, splitPosts, POST_SEP, bizDaysSince } from "./util.js";
import { RUBRIC_KEYS, STATUSES, S3_FROM, T3_SAMPLE, MANNER_RE } from "./conf.js";

export function tierOf(f, c) {
  if (f == null) return "out";
  if (f > c.midMax) return "mega";
  if (f >= c.midMin && f <= c.midMax) return "middle";
  if (f >= c.microMin && f < c.microMax) return "micro";
  return "out";
}

/* FF比 = followers ÷ max(following,1)。followingが無ければ null(0扱いにしない) */
export function ffRatioRaw(cd) {
  if (cd.followers == null || cd.following == null) return null;
  return cd.followers / Math.max(cd.following, 1);
}
/* 表示用は小数2桁。判定は必ず ffRatioRaw を使う(0.9995 が 1.00 に丸まると減点が消えるため) */
export function ffRatio(cd) {
  const v = ffRatioRaw(cd);
  return v == null ? null : Math.round(v * 100) / 100;
}
/* コメント率 = 平均コメント ÷ フォロワー × 100(相関分析と参考表示に使う) */
export function commentRateRaw(cd) {
  if (cd.avg_comments == null || cd.followers == null || cd.followers <= 0) return null;
  return cd.avg_comments / cd.followers * 100;
}
/* 表示用は小数3桁。採点(SBIS-1sの①代替)は必ず commentRateRaw を使う
   — 丸めが足切り境界(ミドル0.09167% / マイクロ0.18333%)をまたぐため */
export function commentRate(cd) {
  const v = commentRateRaw(cd);
  return v == null ? null : Math.round(v * 1000) / 1000;
}

/* v2.2 §4-1b オーディエンス純度減点。following未取得なら「純度未評価」で減点しない */
export function purityPenalty(cd, c) {
  if (cd.following == null) return { rated: false, penalty: 0, hits: [], ff: null };
  const ffr = ffRatioRaw(cd), ff = ffRatio(cd);
  let p = 0; const hits = [];
  if (cd.following >= c.purFollow1) { p -= 15; hits.push("フォロー" + cd.following.toLocaleString("ja-JP") + "≥" + c.purFollow1); }
  else if (cd.following >= c.purFollow2) { p -= 10; hits.push("フォロー" + cd.following.toLocaleString("ja-JP") + "≥" + c.purFollow2); }
  if (ffr != null && ffr < c.purFfMin) { p -= 10; hits.push("FF比" + ff + "<" + c.purFfMin); }
  if (p < c.purCap) p = c.purCap;                  // 減点合計の上限(既定 −15)
  return { rated: true, penalty: p, hits: hits, ff: ff };
}

export function scoreSbis1(cd, c) {
  const t = tierOf(cd.followers, c);
  const out = {
    tier: t, parts: {}, flags: [], total: null, raw: null, cut: false, purity: purityPenalty(cd, c),
    mode: "full", max: 100, rate: null
  };
  /* v2.3 §4-1c:ERが算出できない(いいね非表示)候補は SBIS-1s。
     ①をコメント率で代替し、②は配点から除外して75点満点にする。
     測れない55点を推測や中立値で埋めない。100点への換算もしない。 */
  const rescue = (cd.er == null && cd.followers != null && cd.avg_comments != null && commentRateRaw(cd) != null);
  if (!rescue && (cd.followers == null || cd.avg_likes == null || cd.avg_comments == null || cd.er == null)) {
    out.flags.push("データ不足(自動採点不可)");
    if (!out.purity.rated) out.flags.push("純度未評価(フォロー数が未取得)");
    return out;
  }
  if (rescue) { out.mode = "rescue"; out.max = 75; }
  const ratio = (cd.avg_likes != null && cd.avg_likes > 0) ? cd.avg_comments / cd.avg_likes : 0;
  let p1, p2;
  if (out.mode === "rescue") {
    /* ①代替:コメント率をティア正規化(ミドル 0.05%→0.30% / マイクロ 0.10%→0.60%) */
    const cr = commentRateRaw(cd);
    const r0 = t === "micro" ? c.crMic0 : c.crMid0, rF = t === "micro" ? c.crMicFull : c.crMidFull;
    p1 = clamp((cr - r0) / (rF - r0)) * 30;
    p2 = 0;                                   /* ②は配点から除外(加算しない) */
  } else {
    const c0 = t === "micro" ? c.convMic0 : c.convMid0, cF = t === "micro" ? c.convMicFull : c.convMidFull;
    p1 = clamp((ratio - c0) / (cF - c0)) * 30;
    const e0 = t === "micro" ? c.erMic0 : c.erMid0, eF = t === "micro" ? c.erMicFull : c.erMidFull;
    p2 = clamp((cd.er - e0) / (eF - e0)) * 25;
  }
  let p3 = 0;
  if (t === "middle") { const ctr = (c.midMin + c.midMax) / 2, hw = (c.midMax - c.midMin) / 2; p3 = clamp(1 - Math.abs(cd.followers - ctr) / hw) * 15; }
  else if (t === "micro") { const ctr = (c.microMin + c.microMax) / 2, hw = (c.microMax - c.microMin) / 2; p3 = clamp(1 - Math.abs(cd.followers - ctr) / hw) * 15; }
  const text = ((cd.bio || "") + " " + (cd.matched_keywords || "")).toLowerCase();
  const has = list => splitKw(list).some(k => text.includes(k.toLowerCase()));
  /* v2.6 §4-1:④文脈適合の再配分 — 専門性(成分語)より自己開示(年代語・生活語)を重く。
     業者語(§4-1d)は−8。§0b「生活者の証言者」の機械近似 */
  let p4 = 6;
  if (has(c.kwIngredient)) p4 += 2; if (has(c.kwReview)) p4 += 2; if (has(c.kwAge)) p4 += 3;
  if (t === "micro" && has(c.kwWin)) p4 += 3;
  if (has(c.kwLife)) p4 += 4;
  if (has(c.kwPenaltyPr)) p4 -= 4; if (has(c.kwPenaltyDisc)) p4 -= 4;
  if (has(c.kwBiz)) p4 -= 8;
  p4 = Math.max(0, Math.min(20, p4));
  let p5 = 0; if (cd.has_external_link === true) p5 += 5; if ((cd.bio || "").length >= 80) p5 += 5;
  out.parts = { p1: r1(p1), p2: out.mode === "rescue" ? null : r1(p2), p3: r1(p3), p4: p4, p5: p5 };
  /* v2.2 §4-1b:オーディエンス純度減点。SBIS-1合計に適用(下限0・減点合計は−15まで) */
  const pu = out.purity;
  out.raw = r1(p1 + p2 + p3 + p4 + p5);
  out.total = r1(Math.max(0, out.raw + pu.penalty));
  out.rate = Math.round(out.total / out.max * 1000) / 10;      /* 得点率%(全候補共通の優先順位付け) */
  if (out.mode === "rescue") out.flags.push("救済採点 SBIS-1s(いいね非表示のため②ERを配点から除外・75点満点)");
  if (pu.rated && pu.penalty < 0) out.flags.push("オーディエンス純度減点 " + pu.penalty + "(" + pu.hits.join("・") + ")");
  if (!pu.rated) out.flags.push("純度未評価(フォロー数が未取得)");
  if (p1 < c.cutoffConv) { out.cut = true; out.flags.push("足切り:" + (out.mode === "rescue" ? "コメント率不足(①代替<" : "会話の濃さ不足(①<") + c.cutoffConv + ")"); }
  /* v2.6 §4-1b(判断19):純度ハードゲート。相互フォロー網の中の会話は行列の証言にならない */
  const ffr = ffRatioRaw(cd);
  if (cd.following != null && (cd.following > c.gateFollow || (ffr != null && ffr < c.gateFf))) {
    out.gated = true; out.cut = true;
    out.flags.push("純度ハードゲート(§4-1b 判断19:フォロー" + cd.following.toLocaleString("ja-JP") +
      (cd.following > c.gateFollow ? ">" + c.gateFollow.toLocaleString("ja-JP") : "") +
      (ffr != null && ffr < c.gateFf ? " / FF比" + ffRatio(cd) + "<" + c.gateFf : "") + ")");
  }
  if (t === "out") out.flags.push("対象外フォロワー帯");
  if (t === "mega") out.flags.push("第0候補(10万超・起用せずリスト保管。倍率30倍超で増枠と同時投入)");
  return out;
}

/* v2.6 §4-1d:業者/生活者/他社契約シグナル(スコアとは別軸の表示。自動見送りにはしない) */
export function signalsOf(cd, c) {
  const text = ((cd.bio || "") + " " + (cd.full_name || "")).toLowerCase();
  const hitList = list => splitKw(list).filter(w => text.includes(w.toLowerCase()));
  const biz = hitList(c.kwBiz);
  const url = (cd.external_url || "").toLowerCase();
  const linkHit = url ? splitKw(c.bizDomains).find(d => url.includes(d.toLowerCase())) : null;
  if (linkHit) biz.push("リンク先:" + linkHit);
  const amb = hitList(c.kwAmb);
  const life = hitList(c.kwLife);
  return { biz: biz, amb: amb, life: (biz.length ? [] : life) };
}

/* SBIS-2 = 証言力rubric T1〜T5 の合計(未確認は加算しない) */
export function scoreSbis2(cd) { let s = 0, any = false; RUBRIC_KEYS.forEach(k => { const v = cd.s2[k]; if (v !== "" && v != null) { s += Number(v); any = true; } }); return any ? s : 0; }
/* SBIS-3 = 保存率実測(DM後) */
export function scoreSbis3(cd) { const v = cd.s3 && cd.s3.save; return (v === "" || v == null) ? 0 : Number(v); }
export function s3Active(cd) { return STATUSES.indexOf(cd.status) >= S3_FROM; }

/* 合計(SBIS-1+2+3) */
export function totalOf(cd) { return cd.score && cd.score.total != null ? r1(cd.score.total + scoreSbis2(cd) + scoreSbis3(cd)) : null; }

/* T1 自動採点(§4-2):課題主語の本数→点。ただしタイアップ比率>50%は0点かつ「紹介者」 */
export function t1Auto(topic, tieup, sampled) {
  const N = sampled || 8;
  if (topic == null || isNaN(topic)) return null;
  const tie = (tieup == null || isNaN(tieup)) ? null : tieup;
  const ratio = (tie == null || N <= 0) ? null : tie / N;
  const pitchman = ratio != null && ratio > 0.5;
  let pt;
  if (topic >= 6) pt = 15; else if (topic >= 4) pt = 10; else if (topic >= 2) pt = 5; else pt = 0;
  if (pitchman) pt = 0;
  return { pt: pt, ratio: ratio, pitchman: pitchman };
}

/* 成長中マイクロ判定(§4-4)。スコアではなく連載枠適格フラグ */
export function growthEval(cd, c) {
  const f = cd.followers, t = cd.score ? cd.score.tier : tierOf(f, c);
  const t5 = cd.s2.t5 === "" ? null : Number(cd.s2.t5);
  const pre = numOrNull(cd.aux.gPre), post = numOrNull(cd.aux.gPost);
  const lift = (pre != null && post != null && pre > 0) ? post / pre : null;
  const trend = lift != null && lift >= c.growLift;
  const dense = cd.er != null && cd.er >= c.growEr && !!cd.aux.gWeekly;
  const inBand = f != null && f >= c.growMin && t === "micro";
  const out = { kind: null, lift: lift, trend: trend, dense: dense, t5: t5, inBand: inBand };
  if (t5 === 5 && inBand && (trend || dense)) out.kind = "成長マイクロ";
  else if (t5 === 5 && t === "middle") out.kind = "ミドル";
  return out;
}

/* 追跡ルール(§6):DM送付から5営業日無反応 → リマインド1回 → その後5営業日で終了 */
export function dmDue(c, today) {
  if (c.status !== "DM送付" || !c.dmSentAt) return null;
  if (!c.remindAt) {
    const d = bizDaysSince(c.dmSentAt, today);
    if (d == null) return null;
    if (d >= 5) return { kind: "remind", days: d, label: "リマインド期限(" + d + "営業日)" };
    return { kind: "wait", days: d, label: d + "営業日経過" };
  }
  const d2 = bizDaysSince(c.remindAt, today);
  if (d2 == null) return null;
  if (d2 >= 5) return { kind: "close", days: d2, label: "追跡終了へ(催促後" + d2 + "営業日)" };
  return { kind: "wait2", days: d2, label: "催促後" + d2 + "営業日" };
}

/* 表示リスク検出(§4-2b・T3とは別軸=ステマ規制・景表法) */
const PROVIDE_RE = /(様?から(の)?ご?提供|提供いただ|ご提供品|いただきました|ギフティング|プレゼントキャンペーン|タイアップ投稿)/;
export function displayRisk(posts) {
  const items = []; let disguised = 0, missing = 0;
  posts.forEach((p, i) => {
    const norm = nfkc(p);
    const prNorm = /#\s?PR\b/i.test(norm) || /\[\s?PR\s?\]/i.test(norm);
    const prRaw = /#\s?PR\b/i.test(p) || /\[\s?PR\s?\]/i.test(p);
    if (prNorm && !prRaw) { disguised++; items.push("投稿" + (i + 1) + ":PR表記が装飾文字(正規化後にのみ#PRが出現。ハッシュタグとして機能しない可能性)"); }
    if (PROVIDE_RE.test(norm) && !prNorm) { missing++; items.push("投稿" + (i + 1) + ":提供・ギフティング言及があるのにPR表記なし"); }
  });
  return { disguised, missing, items };
}

/* キャプション突合:NG語(常習判定つき)+作法語のポジティブ検出(付録A)
   常習の定義(v2.1 §4-2 T3):判定母集団=直近8投稿のうちNG語を含む投稿が2件以上。
   投稿単位で数え、同一投稿内の複数NG語は1件と数える。 */
export function scanCaptions(txt, conf, nowISO) {
  const all = splitPosts(txt);
  const judged = all.slice(0, T3_SAMPLE);            // 分母を仕様(8投稿)に固定する
  const ntxt = nfkc(txt);                            // NG突合はNFKC正規化後のテキストで行う(判断27)
  const ngList = splitKw(conf.ngWords).map(nfkc);
  const hits = ngList.map(w => ({ w, n: (ntxt.split(w).length - 1) })).filter(x => x.n > 0);
  const ngPosts = judged.filter(p => { const np = nfkc(p); return ngList.some(w => np.includes(w)); }).length;
  const total = hits.reduce((s, x) => s + x.n, 0);
  const habitual = ngPosts >= 2;
  const manner = [];
  splitKw(conf.mannerWords).forEach(w => { const n = ntxt.split(nfkc(w)).length - 1; if (n > 0) manner.push({ w, n }); });
  MANNER_RE.forEach(m => { const mm = ntxt.match(m.re); if (mm && mm.length) manner.push({ w: m.lab, n: mm.length }); });
  const risk = displayRisk(judged);
  return {
    posts: judged.length, pasted: all.length, sample: T3_SAMPLE, sepOk: POST_SEP.test(String(txt || "")),
    hits, total, ngPosts, habitual, manner, risk, at: nowISO || new Date().toISOString()
  };
}

/* 純度仮説の検証(§4-1b・§7-5)。相関は40件から表示する */
export function pearson(xs, ys) {
  const n = xs.length; if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx <= 0 || syy <= 0) return null;
  return Math.round(sxy / Math.sqrt(sxx * syy) * 1000) / 1000;
}
export const CORR_MIN_N = 40;

/* 全件再採点(v1.4 の rescoreAll) */
export function rescoreAll(cands, conf) {
  cands.forEach(cd => { cd.score = scoreSbis1(cd, conf); cd.growth = growthEval(cd, conf); cd.sig = signalsOf(cd, conf); });
  return cands;
}

/* v2.2 §4-5:適合コメントが空の候補は「DM送付」に進めない */
export function fitMissing(c) { return !String(c.fitComment || "").trim(); }
export function setStatus(c, s, today) {
  if (s === "DM送付" && fitMissing(c)) return { ok: false, reason: "適合コメントが空です(§4-5)。DM送付に進む前に、なぜこの人がステムボーテなのかを3〜5文で書いてください。" };
  c.status = s;
  if (s === "DM送付" && !c.dmSentAt) c.dmSentAt = today;
  if (s === "候補" || s === "精査済") { c.dmSentAt = ""; c.remindAt = ""; }
  return { ok: true };
}
