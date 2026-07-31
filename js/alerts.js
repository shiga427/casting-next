/* 自動診断アラート(設計書§5-1b)。発火条件を1箇所に集約する。
 *
 * すべてのアラートは「バッジ / 平易な見出し / 根拠の数値 / どの画面で何をすればよいか」の
 * 4点セット。文言のトーンは「責めない・次の一歩を必ず示す・数値の根拠を添える」。
 * DOM に触れない純関数(P5でfixture単体テストを足せる形)。
 */
import { dmDue, t1Auto, commentRate, pearson, CORR_MIN_N } from "./pipeline/sbis.js";
import { numOrNull } from "./pipeline/util.js";

const DM_STAGES = ["DM送付", "資料送付", "条件交渉", "契約"];

/* ctx = { cands, coverage, govLog, runs, run(現在のrun), conf, today } */
export function buildAlerts(ctx) {
  const out = [];
  const cands = ctx.cands || [];
  const run = ctx.run || null;
  const runs = ctx.runs || [];
  const add = a => out.push(a);

  /* A1 要対応:探索カバレッジに未実行行が残っている */
  const todo = (ctx.coverage || []).filter(r => r.st === "未実行").length;
  if (todo) add({
    id: "A1", level: "warn", title: "計画した探索がまだ残っています",
    body: `探索カバレッジに<b>未実行 ${todo}行</b>。未実行を隠さないのがこの表の目的です(§2-5の報告義務)。`,
    go: "→ 探索カバレッジで実行状況を更新", to: "coverage"
  });

  /* A2 要対応:run の信頼性が ⚠(キャプション平均<140字 等) */
  if (run && run.reliability && String(run.reliability.verdict || "").startsWith("⚠")) {
    const hold = (run.reliability.stanceBreakdown || {})["判定保留"] || 0;
    add({
      id: "A2", level: "warn", title: "この取得、定性判定が実力より低く出ています…",
      body: `${run.runTag} はキャプション平均 <b>${run.reliability.avgCaptionLen}字</b>(基準140字)で取得されており、`
        + `定性列とPR件数が過小です。機械合格${run.machinePassed}名中 <b>${hold}名が「判定保留」</b>になっています。`,
      go: "→ 収集画面でプローブ設定(__CAP=140)を確認して再取得", to: "collect"
    });
  }

  /* A3 要対応:DM送付日超過(営業日計算) */
  const overdue = cands.filter(c => { const d = dmDue(c, ctx.today); return d && (d.kind === "remind" || d.kind === "close"); });
  if (overdue.length) add({
    id: "A3", level: "warn", title: "返信待ちが期限を越えています",
    body: `返信待ちが期限を越えた候補が<b>${overdue.length}名</b>います(${overdue.slice(0, 3).map(c => "@" + c.username).join("、")}${overdue.length > 3 ? " 他" : ""})。催促は1回のみです。`,
    go: "→ パイプラインで催促/追跡終了を判断", to: "kanban"
  });

  /* A4 要対応:救済(SBIS-1s)候補がコメント質確認の形跡なくDM送付以降にいる */
  const rescue = cands.filter(c => c.score && c.score.mode === "rescue" && DM_STAGES.includes(c.status)
    && !/コメント質|定型文|外国語/.test((c.s2ev.t2 || "") + (c.s2ev.t1 || "") + (c.notes || "")));
  if (rescue.length) add({
    id: "A4", level: "warn", title: "いいね非表示の候補が、コメント質の確認前に先へ進んでいます",
    body: `救済採点(SBIS-1s)のまま DM工程にいる候補が<b>${rescue.length}名</b>(${rescue.slice(0, 3).map(c => "@" + c.username).join("、")})。`
      + "§4-1c:コメント質(定型文・外国語・相互コメントの比率)を確認し、証拠メモに残すまでコメント数由来のスコアを信用しないでください。",
    go: "→ 候補詳細でコメント質を記録", to: "board"
  });

  /* A5 要対応:適合コメント空のままDM送付に動かそうとした(操作時に出すメッセージ) */
  const noFit = cands.filter(c => c.status === "精査済" && !String(c.fitComment || "").trim());
  if (noFit.length) add({
    id: "A5", level: "warn", title: "「なぜこの人か」が書かれていません",
    body: `精査済なのに適合コメントが空の候補が<b>${noFit.length}名</b>います。3〜5文・懸念1つが必須です(§4-5)。このままでは「DM送付」に進めません。`,
    go: "→ 候補ボードで適合コメントを書く", to: "board"
  });

  /* A6 確認:運用ログに「提案中」が残っている */
  const pending = (ctx.govLog || []).filter(g => g.state === "提案中").length;
  if (pending) add({
    id: "A6", level: "check", title: `承認待ちの判断が ${pending}件あります`,
    body: "指示書にない判断は、適用前に「提案中」で登録し承認を得る運用です(§7-1)。",
    go: "→ 運用ログで承認/却下を記録", to: "oplog"
  });

  /* A7 確認:review_needed(verified×カテゴリnull)の目視が未了 */
  if (run && (run.reviewNeeded || []).length) {
    const done = new Set(run.reviewChecked || []);
    const left = run.reviewNeeded.filter(u => !done.has(u));
    if (left.length) add({
      id: "A7", level: "check", title: "機械では決めきれなかった候補がいます",
      body: `review_needed(認証済み×カテゴリ不明)が <b>${left.length}名</b>。${left.slice(0, 2).map(u => "@" + u).join("、")} を含みます。目視の結果は分析結果画面に記録されます。`,
      go: `→ 分析結果 ${run.runTag} の review_needed 一覧へ`, to: "analysis"
    });
  }

  /* A8 確認:T1タイアップ比率50%超(紹介者)が候補ボードに滞留 */
  const pitch = cands.filter(c => {
    const a = t1Auto(numOrNull(c.aux.t1Topic), numOrNull(c.aux.t1Tieup));
    return a && a.pitchman && c.status !== "見送り";
  });
  if (pitch.length) add({
    id: "A8", level: "check", title: "紹介者バッジの候補が残っています",
    body: `タイアップ比率50%超の候補が<b>${pitch.length}名</b>(${pitch.slice(0, 3).map(c => "@" + c.username).join("、")})。T1=0・原則見送りです(§4-2)。`,
    go: "→ 候補ボードで扱いを決める", to: "board"
  });

  /* A9 確認:純度未評価(フォロー数なし)の候補が精査待ち上位にいる */
  const waiting = cands.filter(c => c.status === "候補" && c.score && !c.score.cut && c.score.rate != null)
    .sort((a, b) => b.score.rate - a.score.rate).slice(0, 10);
  const unrated = waiting.filter(c => c.following == null);
  if (unrated.length) add({
    id: "A9", level: "check", title: "フォロー数が取れていない候補が上位にいます",
    body: `精査待ち上位10名のうち<b>${unrated.length}名</b>が純度未評価です。再取得すると §4-1b の純度ゲート・減点が効きます。`,
    go: "→ 収集で再取得キューに入れる", to: "collect"
  });

  /* A10 確認:rate_limited > 0 の run がある */
  const limited = runs.filter(r => (r.rateLimited || 0) > 0);
  if (limited.length) add({
    id: "A10", level: "check", title: "前回の取得でレート制限が出ました",
    body: `レート制限が <b>${limited[0].rateLimited}件</b>(${limited[0].runTag})。取得ペースを落とし、残りは翌日以降に再キューしてください(取得済み除外が効くので重複しません)。`,
    go: "→ 収集画面でキューを作り直す", to: "collect"
  });

  /* A11 情報:純度評価済み40件超で相関が算出された */
  const rated = cands.filter(c => c.following != null);
  if (rated.length >= CORR_MIN_N) {
    const xs = [], ys = [];
    rated.forEach(c => { if (c.er != null) { xs.push(c.following); ys.push(c.er); } });
    const r = pearson(xs, ys);
    if (r != null) add({
      id: "A11", level: "info", title: "following × ER の相関が出ました",
      body: `純度評価済み ${rated.length}件で相関係数 <b>${r > 0 ? "+" : ""}${r.toFixed(3)}</b>(n=${xs.length})。`
        + "この減点も仮説であり、実測が審判です(§7-5)。減点幅の見直し材料にしてください。",
      go: "→ 設定・基準で純度減点を確認", to: "settings"
    });
  }

  /* A12 情報:biz疑い隔離(判断22)を自動実行した */
  if (run && run.bizQuarantined && run.bizQuarantined.length) add({
    id: "A12", level: "info", title: `業者疑い ${run.bizQuarantined.length}件を取得後に隔離しました(判断22)`,
    body: `隔離リストは分析結果 ${run.runTag} に残っています。黙って捨てていません。`,
    go: "→ 分析結果の隔離一覧へ", to: "analysis"
  });

  const order = { warn: 0, check: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}
