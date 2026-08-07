/* 案内文の最適化(設計書_DM自動一括送付_v1.0 §4)。**DOM を触らない純関数**。
 *
 * ★LLM は運用経路に一切登場しない(同§1)。
 *   「最適化」＝ティア・枠・精査で人が読んだ役割/魅力を決定的テンプレートに差し込むことであって、
 *   実行時の生成ではない。オフラインで完結し、外部送信もしない。
 *
 * ★個別化に使えるのは精査(qualReport)に**実在する読みだけ**(§4-3)。
 *   無い情報を作文しない。素材が無ければティア別テンプレのままにする。
 *
 * ★生成後に薬機法NG語・「限定」の断定をスキャンし、含んだら生成失敗として弾く(§4-4)。
 *   弾く側に倒す。丸めて通さない。
 */
import {
  DM_ANGLE, DM_BRAND, DM_CHARM_ANGLE, DM_EXPERIENCE_WORD, DM_FORBIDDEN_WORDS,
  DM_ROLE_LINE, DM_SLOT_LINE, DM_TEMPLATE, DM_TIER_SLOT, DEFAULT_CONF, TIER_LAB,
} from "./conf.js";
import { nfkc, numOrNull, splitKw } from "./util.js";
import { fitMissing, t1Auto } from "./sbis.js";

/* 除外理由のコード(§6-3)。パネルに理由を出すためラベルとセットで持つ。黙って落とさない */
export const DM_EXCLUDE = {
  SENT: "既にDM送付済み(二重送信になるため除外)",
  FIT_MISSING: "適合コメントが未記入(§4-5。なぜこの人がステムボーテなのかを書いてから)",
  DROPPED: "ステータスが「見送り」",
  PITCHMAN: "紹介者(タイアップ比率50%超・§4-2)",
  HABITUAL: "薬機法NG常習(NG含有投稿2件以上)",
  MEGA: "第0候補(10万超・初期は起用しない帯)",
  OUT_BAND: "対象外フォロワー帯",
  NO_SCORE: "SBIS-1が未採点(データ不足)",
};

/* 送付対象にしてよいか(§6-3)。チェックされていても、ここで落ちた候補は送らない。
 * 判定は候補オブジェクトだけで決まる純関数。理由は必ず配列で返す(1つに丸めない) */
export function dmEligibility(c) {
  const reasons = [];
  const sc = (c && c.score) || {};
  if (String(c.dmSentAt || "").trim() || String((c.dm && c.dm.sentAt) || "").trim()) reasons.push(DM_EXCLUDE.SENT);
  if (fitMissing(c || {})) reasons.push(DM_EXCLUDE.FIT_MISSING);
  if (c && c.status === "見送り") reasons.push(DM_EXCLUDE.DROPPED);
  const a = t1Auto(numOrNull(c && c.aux && c.aux.t1Topic), numOrNull(c && c.aux && c.aux.t1Tieup));
  if (a && a.pitchman) reasons.push(DM_EXCLUDE.PITCHMAN);
  if (c && c.scan && c.scan.habitual) reasons.push(DM_EXCLUDE.HABITUAL);
  if (sc.tier === "mega") reasons.push(DM_EXCLUDE.MEGA);
  else if (sc.tier === "out") reasons.push(DM_EXCLUDE.OUT_BAND);
  else if (!sc.tier) reasons.push(DM_EXCLUDE.NO_SCORE);
  return { ok: reasons.length === 0, reasons };
}

function fill(tpl, vars) {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
}

/* 生成文の禁止語スキャン(§4-4)。突合は NFKC 正規化後(scanCaptions と同じ作法・判断27) */
export function scanDmText(text, conf) {
  const n = nfkc(String(text || ""));
  const ng = splitKw((conf || DEFAULT_CONF).ngWords).map(nfkc).filter(w => w && n.includes(w));
  const forbidden = DM_FORBIDDEN_WORDS.map(nfkc).filter(w => w && n.includes(w));
  return { ng, forbidden, ok: ng.length === 0 && forbidden.length === 0 };
}

/* 宛名。full_name があれば実名、無ければ @handle(§4-5 {{full_name or @handle}}) */
function addressee(c) {
  const name = String((c && c.full_name) || "").trim();
  return name || ("@" + String((c && c.username) || "").replace(/^@/, ""));
}

/* 案内文の本体。戻り値 { ok, text, basis[], reason }。
 *   basis … なぜこの文面になったかの根拠配列(UI表示・監査用。使った分岐を全て記録する)
 *   reason … ok:false のときだけ。対象外・生成失敗の理由
 * brand を省略すると DM_BRAND(§4-1 の実値)を使う。opts.conf で ngWords を差し替えられる。 */
export function buildDm(cand, brand, opts) {
  const c = cand || {};
  const b = brand || DM_BRAND;
  const o = opts || {};
  const conf = o.conf || DEFAULT_CONF;
  const basis = [];
  const sc = c.score || {};
  const tier = sc.tier;

  /* ① 帯のガード。mega(第0候補)は文面を作らず「対象外」を返す(§4-2) */
  if (tier === "mega") return { ok: false, text: "", basis, reason: DM_EXCLUDE.MEGA };
  if (tier === "out") return { ok: false, text: "", basis, reason: DM_EXCLUDE.OUT_BAND };
  if (tier !== "micro" && tier !== "middle") return { ok: false, text: "", basis, reason: DM_EXCLUDE.NO_SCORE };
  basis.push(`ティア=${TIER_LAB[tier]}(${tier})`);

  /* ② 個別化(§4-3)。精査に実在する読みだけを使い、無ければティア既定の一般文にとどめる */
  const human = (c.qualReport && c.qualReport.human) || {};
  const charm = String(human.charm || "").trim();
  const role = String(human.role || "").trim();
  let angleLine;
  if (charm) { angleLine = fill(DM_CHARM_ANGLE, { charm }); basis.push(`アングル=精査の魅力(qualReport.human.charm)を差し込み`); }
  else {
    angleLine = DM_ANGLE[tier];
    basis.push(String(c.selectReason || "").trim()
      ? "アングル=ティア既定の一般文(精査未実施のため。機械の選定理由は本文に転記しない)"
      : "アングル=ティア既定の一般文(個別化の素材なし)");
  }
  const roleLine = role ? fill(DM_ROLE_LINE, { role }) : "";
  if (roleLine) basis.push("起用意図=精査の役割(qualReport.human.role)を差し込み");

  /* ③ 枠(§4-3:候補の slot がティア既定より優先)。
   *    slot_line の文言は「ミドル層の方には〜」なので、ミドル×連載枠のときだけ入れる(§4-5)。 */
  const tierSlot = DM_TIER_SLOT[tier];
  const slot = (c.slot === "連載枠" || c.slot === "都度枠") ? c.slot : tierSlot;
  basis.push(`枠=${slot}(${c.slot === slot && c.slot ? "候補の設定を優先" : "ティア既定"})`);
  const slotLine = (tier === "middle" && slot === "連載枠") ? DM_SLOT_LINE : "";
  if (slotLine) basis.push("継続の言及=月2回・インサイト提出(ミドル×連載枠)");
  else if (tier === "micro" && slot === "連載枠") basis.push("⚠ マイクロだが連載枠指定。継続条件の文は入れていない(文面は人が加筆すること)");

  /* ④ 組み立て(§4-5) */
  const vars = {
    name: addressee(c), brand: b.name,
    angle_line: angleLine, experience_word: DM_EXPERIENCE_WORD[tier],
    weekly_min: b.weeklyMin, weekly_max: b.weeklyMax, odds_min: b.oddsMin, odds_max: b.oddsMax,
    slot_line: slotLine,
  };
  const intro = fill(DM_TEMPLATE.intro, vars) + (roleLine ? "\n" + roleLine : "");
  const text = [
    fill(DM_TEMPLATE.greeting, vars), intro, fill(DM_TEMPLATE.brandFact, vars),
    fill(DM_TEMPLATE.offer, vars), fill(DM_TEMPLATE.compliance, vars), fill(DM_TEMPLATE.closing, vars),
  ].join("\n\n");

  /* ⑤ 生成後スキャン(§4-4)。効能断定・「限定」の断定が入ったら**生成失敗として弾く**。
   *    差し込んだ人の文言にNG語が入っていた場合もここで落ちる。丸めて通さない。 */
  const scan = scanDmText(text, conf);
  if (!scan.ok) {
    const parts = [];
    if (scan.ng.length) parts.push(`薬機法NG語:${scan.ng.join("・")}`);
    if (scan.forbidden.length) parts.push(`断定を避ける語:${scan.forbidden.join("・")}`);
    return {
      ok: false, text: "", basis,
      reason: `文面に使えない語が入ったため生成を中止しました(${parts.join(" / ")})。`
        + "精査の魅力・役割の記述を書き直してください(§4-4)。",
    };
  }
  return { ok: true, text, basis, reason: "" };
}

/* 対象一覧を一度に作る。除外(§6-3)と生成失敗(§4-4)を分けて返す。どちらも理由付きで残す */
export function composeDmBatch(cands, opts) {
  const o = opts || {};
  const texts = o.texts || {};
  const drop = new Set((o.drop || []).map(h => String(h).replace(/^@/, "").toLowerCase()));
  const items = [], excluded = [];
  (cands || []).forEach(c => {
    const handle = String(c.username || "").replace(/^@/, "");
    const key = handle.toLowerCase();
    if (drop.has(key)) { excluded.push({ handle, reasons: ["パネルで送付から外した"] }); return; }
    const el = dmEligibility(c);
    if (!el.ok) { excluded.push({ handle, reasons: el.reasons }); return; }
    const built = buildDm(c, o.brand || DM_BRAND, { conf: o.conf });
    if (!built.ok) { excluded.push({ handle, reasons: [built.reason] }); return; }
    /* 人がパネルで直した本文があればそれを優先する。ただし禁止語スキャンは編集後にも掛ける */
    const edited = typeof texts[handle] === "string" ? texts[handle]
      : (typeof texts[key] === "string" ? texts[key] : null);
    let text = built.text, editedFlag = false;
    if (edited != null && edited.trim() && edited !== built.text) {
      const s = scanDmText(edited, o.conf);
      if (!s.ok) {
        excluded.push({ handle, reasons: [`編集後の本文に使えない語があります(${[...s.ng, ...s.forbidden].join("・")})`] });
        return;
      }
      text = edited; editedFlag = true;
    }
    items.push({
      handle, userId: String(c.userId || c.pk || ""), text,
      tier: (c.score || {}).tier || "", slot: c.slot || DM_TIER_SLOT[(c.score || {}).tier] || "",
      basis: built.basis, edited: editedFlag,
    });
  });
  return { items, excluded };
}
