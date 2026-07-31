/* 候補スキーマと移行(設計書§4-2・§4-4)。
 * 移植元:管制室 v1.4 の newCand / migrate / applyData / importCsv / importRejected /
 *         reviveWorthy / reviveNote。DOM 依存を外して純関数にしただけで、
 *         legacy_s2・legacy_checks の温存仕様と基準移行ログの文言は1文字も変えていない。
 */
import { toNum, toBool, csvToObjects, todayISO } from "./util.js";
import {
  DEFAULT_CONF, SBIS_VER, CHECK_ITEMS, CHECKS_VER, LEGACY_CHECK_ITEMS, LEGACY_S2_KEYS,
  LEGACY_ERMIC0, LEGACY_CONV, RUBRIC_KEYS, SLOTS, COV_STATES
} from "./conf.js";
import { scoreSbis1, rescoreAll } from "./sbis.js";

export function newCand() {
  return {
    status: "候補", notes: "", manual: false, manualWhy: "", slot: "", following: null, fitComment: "", selectReason: "", fitConcern: "",
    checks: CHECK_ITEMS.map(() => false), checksVer: CHECKS_VER, legacy_checks: null,
    s2: { t1: "", t2: "", t3: "", t4: "", t5: "" },
    s2ev: { t1: "", t2: "", t3: "", t4: "", t5: "" },
    s3: { save: "" },
    aux: { t1Topic: "", t1Tieup: "", gPre: "", gPost: "", gWeekly: false },
    legacy_s2: null, scan: null,
    dmName: "", dmMention: "", captions: "", dmSentAt: "", remindAt: "",
    /* NEXT 追加(設計書§4-2):runTag / stanceHistory / qualReport */
    runTag: "", stanceHistory: [], qualReport: null
  };
}

export function blankCovMeta() { return { brand: "", revived: "", rate: "" }; }

/* v1.1→v1.2 移行:旧s2は legacy_s2 に温存し、新rubricは空から入力(換算しない。基準が違うため) */
export function migrate(c) {
  const base = newCand();
  const blank = { s2: { ...base.s2 }, s2ev: { ...base.s2ev }, s3: { ...base.s3 }, aux: { ...base.aux } };
  const m = Object.assign(base, c);          // ← この時点で base.s2 は c.s2(旧形式)を指す
  const raw = c.s2 || {};
  const isLegacy = LEGACY_S2_KEYS.some(k => k in raw);
  m.s2 = { ...blank.s2 };                      // 新rubricのキーだけを持つ器を作り直す
  if (isLegacy) {
    RUBRIC_KEYS.forEach(k => { m.s2[k] = ""; });                       // 新rubricは空
    if (!c.legacy_s2) {
      const lg = {}; let any = false;
      LEGACY_S2_KEYS.forEach(k => { const v = raw[k]; lg[k] = (v == null ? "" : String(v)); if (lg[k] !== "") any = true; });
      m.legacy_s2 = any ? lg : null;
    }
  } else {
    RUBRIC_KEYS.forEach(k => { m.s2[k] = (raw[k] == null ? "" : String(raw[k])); });
  }
  if (c.legacy_s2) m.legacy_s2 = c.legacy_s2;
  m.s2ev = Object.assign({ ...blank.s2ev }, c.s2ev || {});
  m.s3 = Object.assign({ ...blank.s3 }, c.s3 || {});
  m.aux = Object.assign({ ...blank.aux }, c.aux || {});
  m.scan = c.scan || null;
  m.slot = SLOTS.includes(c.slot) ? c.slot : "";
  /* v1.2以前の候補には following が無い → null のまま「純度未評価」(0で埋めない) */
  m.following = (typeof c.following === "number") ? c.following : null;
  m.fitComment = typeof c.fitComment === "string" ? c.fitComment : "";
  /* v1.4(判断25):拡張CSV由来の機械生成フィールド */
  m.selectReason = typeof c.selectReason === "string" ? c.selectReason : "";
  m.fitConcern = typeof c.fitConcern === "string" ? c.fitConcern : "";
  /* 精査チェックリストの移行(v2.1 §9 判断1):
     旧基準のチェック済み表示が「精査完了」に見えるのが危険なので、
     旧チェックは legacy_checks として温存し、新チェックは空から開始する。 */
  if (c.checksVer === CHECKS_VER) {
    m.checks = CHECK_ITEMS.map((_, i) => Array.isArray(c.checks) ? !!c.checks[i] : false);
    m.legacy_checks = Array.isArray(c.legacy_checks) ? c.legacy_checks : null;
  } else {
    const old = Array.isArray(c.checks) ? LEGACY_CHECK_ITEMS.map((_, i) => !!c.checks[i]) : null;
    m.legacy_checks = (old && old.some(Boolean)) ? old : (Array.isArray(c.legacy_checks) ? c.legacy_checks : null);
    m.checks = CHECK_ITEMS.map(() => false);
  }
  m.checksVer = CHECKS_VER;
  if (typeof m.captions !== "string") m.captions = "";
  if (typeof m.dmSentAt !== "string") m.dmSentAt = "";
  if (typeof m.remindAt !== "string") m.remindAt = "";
  if (typeof m.runTag !== "string") m.runTag = "";
  if (!Array.isArray(m.stanceHistory)) m.stanceHistory = [];
  if (m.qualReport === undefined) m.qualReport = null;
  return m;
}

/* v3 JSON(管制室 v1.4 の書き出し)を読み込む。戻り値がそのまま NEXT の state になる。
 * conf のバージョン移行ログ(v1.2/v1.3/v1.4 相当)は文言ごと移植している。 */
export function applyData(d, nowISO) {
  const at = nowISO || new Date().toISOString();
  const state = {
    conf: Object.assign({ ...DEFAULT_CONF }, d.conf || {}),
    confLog: d.confLog || [],
    cands: [], rejected: [], coverage: [], covMeta: blankCovMeta(), govLog: []
  };
  /* v1.1データの基準移行(§7-3)。自動更新は erMic0 が旧既定値3.5のままの場合のみ(v2.1 §9 判断3) */
  if (!/^SBIS v2/.test(String(state.conf.ver || ""))) {
    const diff = []; const oldVer = state.conf.ver; const oldEr = state.conf.erMic0;
    let reason;
    if (oldEr === LEGACY_ERMIC0) {
      state.conf.erMic0 = 3.0;
      diff.push("②マイクロER0点%:3.5→3");
      reason = "ツールv1.2への自動移行:設計指示書v2.0 §2-3/§4-1(マイクロERの正規化起点を3.5→3.0に緩和)。旧基準は " + oldVer + "。";
    } else if (oldEr !== 3.0) {
      diff.push("②マイクロER0点%:" + oldEr + "(据え置き・自動更新をスキップ)");
      reason = "ツールv1.2への自動移行:erMic0 が旧既定値(3.5)でないため自動更新をスキップしました(現在 " + oldEr +
        ")。指示書§2-3の 3.0 への変更が必要か確認してください(v2.1 §9 判断3)。旧基準は " + oldVer + "。";
    } else {
      reason = "ツールv1.2への自動移行:erMic0 は既に3.0のため変更なし。旧基準は " + oldVer + "。";
    }
    diff.push("バージョン:" + oldVer + "→SBIS v2.0");
    state.conf.ver = "SBIS v2.0";
    state.confLog.push({ at, ver: "SBIS v2.0", reason: reason, diff: diff });
  }
  /* v1.2(SBIS v2.0/v2.1)→v1.3(SBIS v2.2)の移行。再採点の影響件数を出すため移行前スケールの SBIS-1 を控える */
  let preScores = null, migLog = null;
  if (!/^SBIS v2\.[2-9]/.test(String(state.conf.ver || ""))) {
    const oldConf = Object.assign({}, state.conf);
    if (d.conf && d.conf.convFloor != null) {
      oldConf.convMid0 = d.conf.convFloor; oldConf.convMidFull = d.conf.convFull;
      oldConf.convMic0 = d.conf.convFloor; oldConf.convMicFull = d.conf.convFull;
    } else {
      oldConf.convMid0 = LEGACY_CONV[0]; oldConf.convMidFull = LEGACY_CONV[1];
      oldConf.convMic0 = LEGACY_CONV[0]; oldConf.convMicFull = LEGACY_CONV[1];
    }
    preScores = {};
    (d.cands || []).forEach(c => {
      const probe = {
        followers: c.followers, avg_likes: c.avg_likes, avg_comments: c.avg_comments, er: c.er,
        bio: c.bio, matched_keywords: c.matched_keywords, has_external_link: c.has_external_link, following: null
      };
      const s = scoreSbis1(probe, oldConf);
      if (c.username) preScores[String(c.username).toLowerCase()] = { total: s.total, cut: s.cut };
    });
  }
  if (!/^SBIS v2\.[2-9]/.test(String(state.conf.ver || ""))) {
    const diff = []; const oldVer = state.conf.ver; const notes = [];
    const hadLegacyConv = (d.conf && d.conf.convFloor != null) ?
      (d.conf.convFloor === LEGACY_CONV[0] && d.conf.convFull === LEGACY_CONV[1]) : true;
    if (hadLegacyConv) {
      diff.push("①会話の濃さ:全帯共通 0.5%→3% を廃止し、ミドル 0.4%→2.0% / マイクロ 0.6%→3.0% に分離");
    } else {
      state.conf.convMid0 = d.conf.convFloor; state.conf.convMidFull = d.conf.convFull;
      state.conf.convMic0 = d.conf.convFloor; state.conf.convMicFull = d.conf.convFull;
      diff.push("①会話の濃さ:カスタム値(" + d.conf.convFloor + "→" + d.conf.convFull + ")を検出したためティア別に自動再校正せず、両帯に旧値を引き継ぎ");
      notes.push("①のスケールが旧カスタム値のままです。指示書§4-1のティア別値(ミドル0.004→0.02 / マイクロ0.006→0.03)に合わせるか確認してください。");
    }
    delete state.conf.convFloor; delete state.conf.convFull;
    diff.push("オーディエンス純度減点を新設(following≥5000 −15 / ≥3000 −10 / FF比<1 −10、上限−15)");
    diff.push("バージョン:" + oldVer + "→" + SBIS_VER);
    state.conf.ver = SBIS_VER;
    state.confLog.push({
      at, ver: SBIS_VER,
      reason: "ツールv1.3への自動移行:設計指示書v2.2 §4-1(①のティア正規化・run#2合格2名が旧スケールで全員足切りになる事実による再校正)および§4-1b(オーディエンス純度減点の新設)。" +
        (notes.length ? " ※" + notes.join(" ") : "") + " 旧基準は " + oldVer + "。",
      diff: diff
    });
    migLog = state.confLog[state.confLog.length - 1];
  }
  /* v1.3.x(SBIS v2.2)→v1.4(SBIS v2.6)の移行。数値基準の上書きはなし */
  if (!/^SBIS v2\.6/.test(String(state.conf.ver || ""))) {
    const oldVer = state.conf.ver;
    state.conf.ver = SBIS_VER;
    state.confLog.push({
      at, ver: SBIS_VER,
      reason: "ツールv1.4への自動移行:設計指示書v2.6(生活者シフト)。④文脈適合を再配分(専門性より自己開示・生活語を重く、業者語に減点)、" +
        "純度ハードゲート(判断19)を足切り扱いで表示、業者/生活者/他社契約シグナルを新設(§4-1d)。旧基準は " + oldVer + "。",
      diff: ["④文脈適合:基礎8→6・成分+3→+2・レビュー+3→+2/生活語+4・業者語−8を新設",
        "純度ハードゲート:フォロー>3,000 または FF比<2.0 を足切り扱いに(§4-1b)",
        "業者/生活者/他社契約シグナルの表示を新設(§4-1d・スコアとは別軸)",
        "バージョン:" + oldVer + "→" + SBIS_VER]
    });
  }
  state.cands = (d.cands || []).map(c => migrate(c));
  state.rejected = d.rejected || [];
  state.coverage = (d.coverage || []).map(r => ({
    route: r.route || "E1", term: r.term || "",
    collected: r.collected ?? "", fetched: r.fetched ?? "", st: COV_STATES.includes(r.st) ? r.st : "未実行"
  }));
  state.covMeta = Object.assign(blankCovMeta(), d.covMeta || {});
  state.govLog = d.govLog || [];
  rescoreAll(state.cands, state.conf);
  /* ①再正規化で SBIS-1 が変わった件数を履歴に残す(v1.3改修指示書 C) */
  if (preScores && migLog) {
    let changed = 0, cutIn = 0, cutOut = 0;
    state.cands.forEach(c => {
      const p = preScores[String(c.username).toLowerCase()]; if (!p || !c.score) return;
      if (p.total !== c.score.total) changed++;
      if (!p.cut && c.score.cut) cutIn++;
      if (p.cut && !c.score.cut) cutOut++;
    });
    migLog.diff.push("再採点の影響:SBIS-1が変化 " + changed + "件 / 新たに足切り " + cutIn + "件 / 足切り解除 " + cutOut + "件(全" + state.cands.length + "件中)");
  }
  return state;
}

/* 25列 CSV(matched_run6.csv 形式)の取り込み。v1.4 の importCsv と同じ突合規則。
 * 既存ハンドルは重複登録せず、CSV由来の数値だけ更新(精査入力・ステータスは保持)。 */
export function importCandidateCsv(text, cands, opts) {
  const o = opts || {};
  const { head, rows } = csvToObjects(text);
  if (!head.length) return { ok: false, message: "空のファイルです", added: 0, updated: 0, skipped: 0 };
  if (!head.includes("username") || !head.includes("followers")) {
    return { ok: false, message: "matched.csv 形式ではありません(username/followers列なし)", added: 0, updated: 0, skipped: 0 };
  }
  let added = 0, updated = 0, skipped = 0;
  rows.forEach(r => {
    const g = n => r[n] ?? "";
    if (r._cells < 2) { skipped++; return; }        // v1.4 と同じ不正行スキップ
    const uname = (g("username") || "").trim().replace(/^@/, "");
    if (!uname) { skipped++; return; }
    const rec = {
      account_url: g("account_url") || ("https://www.instagram.com/" + uname + "/"),
      username: uname, full_name: g("full_name"), followers: toNum(g("followers")),
      er: toNum(g("engagement_rate")), avg_likes: toNum(g("avg_likes")), avg_comments: toNum(g("avg_comments")),
      following: toNum(g("following")),   /* v2.2列。無い旧CSVは null=純度未評価 */
      genre: g("genre"), has_external_link: toBool(g("has_external_link")), external_url: g("external_url"),
      bio: g("bio"), matched_keywords: g("matched_keywords"), discovered_via: g("discovered_via"), scraped_at: g("scraped_at")
    };
    /* v1.4(判断25):拡張CSV(select_reason / fit_comment / fit_concern)を直接取込 */
    const mSelect = (g("select_reason") || "").trim(), mFit = (g("fit_comment") || "").trim(), mConcern = (g("fit_concern") || "").trim();
    const ex = cands.find(c => c.username.toLowerCase() === uname.toLowerCase());
    if (ex) {
      if (rec.following == null && ex.following != null) delete rec.following;
      Object.assign(ex, rec);
      if (mSelect) ex.selectReason = mSelect;
      if (mConcern) ex.fitConcern = mConcern;
      if (mFit && !String(ex.fitComment || "").trim()) ex.fitComment = mFit;   /* 人が書いた適合コメントは上書きしない */
      if (o.runTag) ex.runTag = ex.runTag || o.runTag;
      updated++;
    } else {
      cands.push(Object.assign(newCand(), rec, { selectReason: mSelect, fitConcern: mConcern, fitComment: mFit, runTag: o.runTag || "" }));
      added++;
    }
  });
  return { ok: true, added, updated, skipped, total: cands.length };
}

const REASON_KEYS = ["reject_reason", "rejected_reason", "reason", "filter_failed", "failed_filter", "rejection_reason", "status"];
export function importRejectedCsv(text, rejected) {
  const { head, rows } = csvToObjects(text);
  if (!head.length) return { ok: false, message: "空のファイルです", added: 0, updated: 0 };
  if (!head.includes("username")) return { ok: false, message: "username 列がありません", added: 0, updated: 0 };
  const rKey = REASON_KEYS.find(k => head.includes(k));
  let added = 0, updated = 0;
  rows.forEach(r => {
    const g = n => r[n] ?? "";
    const uname = (g("username") || "").trim().replace(/^@/, "");
    if (!uname) return;
    const rec = {
      username: uname, full_name: g("full_name"), followers: toNum(g("followers")),
      er: toNum(g("engagement_rate")), avg_likes: toNum(g("avg_likes")), avg_comments: toNum(g("avg_comments")),
      following: toNum(g("following")),
      bio: g("bio"), has_external_link: toBool(g("has_external_link")),
      reason: (rKey ? g(rKey) : "") || "(理由列なし)", account_url: g("account_url") || ("https://www.instagram.com/" + uname + "/")
    };
    const ex = rejected.find(x => x.username.toLowerCase() === uname.toLowerCase());
    if (ex) { Object.assign(ex, rec); updated++; } else { rejected.push(rec); added++; }
  });
  return { ok: true, added, updated };
}

/* 復活検討に値するか(§3):帯の境界±20%以内、またはERが不明で落ちたがbioが適合 */
export function reviveWorthy(r, conf, cands) {
  if (cands.find(c => c.username.toLowerCase() === r.username.toLowerCase())) return false;
  const c = conf, f = r.followers, rs = (r.reason || "").toLowerCase();
  if (f != null) {
    if (f > c.midMax && f <= c.midMax * 1.2) return true;
    if (f < c.microMin && f >= c.microMin * 0.8) return true;
    if (f > c.microMax && f < c.midMin) return true;
  }
  if (/unknown|nan|不明/.test(rs) && (r.bio || "").length > 0) return true;
  return false;
}
export function reviveNote(r, conf) {
  const c = conf, f = r.followers;
  if (f != null) {
    if (f > c.midMax && f <= c.midMax * 1.2) return { k: "ok", t: "ミドル上限を僅少超過" };
    if (f < c.microMin && f >= c.microMin * 0.8) return { k: "ok", t: "マイクロ下限に僅少不足" };
    if (f > c.microMax && f < c.midMin) return { k: "ok", t: "帯の谷間(3万前後)" };
  }
  if (/unknown|nan|不明/.test((r.reason || "").toLowerCase()) && (r.bio || "").length > 0) return { k: "ok", t: "数値不明・bio適合 → モードAで判断" };
  return { k: "no", t: "基準どおり除外" };
}

/* v4 書き出し(プロジェクト単位の全量JSON)。v4→v1.4 の逆方向互換は保証しない(片方向・設計書§4-4) */
export function exportV4(state, meta) {
  return {
    app: "castnext", v: 4, exported: (meta && meta.now) || new Date().toISOString(),
    tool: (meta && meta.tool) || "",
    project: state.project || null,
    conf: state.conf, cands: state.cands, rejected: state.rejected, confLog: state.confLog,
    coverage: state.coverage, covMeta: state.covMeta, govLog: state.govLog,
    runs: state.runs || [], queue: state.queue || null
  };
}

/* 読み込みは v3(管制室 v1.4)と v4(NEXT)の両方を受ける */
export function readAnyExport(d, nowISO) {
  if (!d || typeof d !== "object") throw new Error("JSONの形式が不正です");
  if (d.app === "stembeaute-casting") { const s = applyData(d, nowISO); s.sourceVersion = "v3(管制室 v1.4)"; return s; }
  if (d.app === "castnext") {
    const s = applyData(d, nowISO);
    s.project = d.project || null; s.runs = d.runs || []; s.queue = d.queue || null;
    s.sourceVersion = "v4(NEXT)";
    return s;
  }
  throw new Error("このアプリのバックアップJSONではありません(app が stembeaute-casting / castnext のいずれでもない)");
}

export { todayISO };
