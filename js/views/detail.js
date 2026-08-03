/* 候補詳細 — 設計書§5-4。現行 v1.4 の詳細モーダルの全要素を3カラムに再配置する。
 * 左=プロフィールとSBIS-1内訳(純度減点・救済採点が読める形)
 * 中=証言力rubric T1〜T5(証拠メモ必須・T1自動採点・T3のNG突合とロック・作法語検出)
 * 右=適合コメント(4要素テンプレート)・契約枠・連載枠適格・ステータス・精査チェック・DM下書き
 * ロジックはすべて v1.4 からの移植(js/pipeline/sbis.js)。ここは表示と入力だけを持つ。
 */
import { state, markDirty } from "../store.js";
import { esc } from "../charts.js";
import { toast } from "../app.js";
import {
  scoreSbis1, scoreSbis2, scoreSbis3, s3Active, totalOf, t1Auto, growthEval,
  ffRatio, commentRate, scanCaptions, dmDue, setStatus, fitMissing, rescoreAll
} from "../pipeline/sbis.js";
import {
  STATUSES, SLOTS, RUBRIC, RUBRIC_KEYS, CHECK_ITEMS, LEGACY_CHECK_ITEMS,
  LEGACY_S2_KEYS, LEGACY_S2_LAB, TIER_LAB, T3_SAMPLE
} from "../pipeline/conf.js";
import { numOrNull, todayISO, splitKw } from "../pipeline/util.js";
import { toMarkdown } from "../pipeline/qualReport.js";

let current = null;

export function open(username) {
  const c = state.cands.find(x => x.username === username);
  if (!c) return;
  current = username;
  let ov = document.getElementById("ovDetail");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "ovDetail";
    ov.className = "overlay";
    document.body.appendChild(ov);
    ov.addEventListener("click", e => { if (e.target === ov) close(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && ov.classList.contains("open")) close(); });
  }
  ov.innerHTML = html(c);
  ov.classList.add("open");
  bind(c);
}

export function close() {
  const ov = document.getElementById("ovDetail");
  if (!ov) return;
  save();
  ov.classList.remove("open");
  current = null;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

function html(c) {
  const sc = c.score || {};
  const P = sc.parts || {};
  const RES = sc.mode === "rescue";
  const ff = ffRatio(c);
  const g = growthEval(c, state.conf);
  const a = t1Auto(numOrNull(c.aux.t1Topic), numOrNull(c.aux.t1Tieup));
  const due = dmDue(c, todayISO());
  const s2 = scoreSbis2(c), s3 = scoreSbis3(c);
  const unconf = RUBRIC_KEYS.filter(k => c.s2[k] === "" || c.s2[k] == null).length;

  return `<div class="modal">
  <div class="mhead">
    <h3><a href="${esc(c.account_url || "#")}" target="_blank" rel="noopener">@${esc(c.username)} ↗</a></h3>
    <span class="tag st">${esc(TIER_LAB[sc.tier] || "—")}</span>
    <span id="mFlags">${badges(c, a, g)}</span>
    <span class="total">${totalOf(c) ?? "—"}点</span>
    <button class="x" id="mClose">×</button>
  </div>
  <div class="mbody">
    <div>
      <h4>プロフィール</h4>
      <dl class="kv">
        <dt>フォロワー</dt><dd>${fmt(c.followers)}</dd>
        <dt>フォロー数</dt><dd>${c.following == null ? '<span class="hint">未取得(純度未評価)</span>' : fmt(c.following)}</dd>
        <dt>FF比</dt><dd>${ff == null ? "—" : (ff < state.conf.purFfMin ? `<span style="color:var(--red)">${ff}</span>` : ff)}</dd>
        <dt>コメント率</dt><dd>${commentRate(c) == null ? "—" : commentRate(c) + "%"}</dd>
        <dt>ER</dt><dd>${c.er == null ? "不明" : Number(c.er).toFixed(2) + "%"}</dd>
        <dt>平均いいね</dt><dd>${fmt(c.avg_likes)}</dd>
        <dt>平均コメント</dt><dd>${fmt(c.avg_comments)}</dd>
        <dt>ジャンル</dt><dd>${esc(c.genre || "—")}</dd>
        <dt>外部リンク</dt><dd>${c.has_external_link === true ? "あり" : c.has_external_link === false ? "なし" : "不明"}</dd>
        <dt>発見経路</dt><dd>${esc(c.discovered_via || (c.manual ? "手動追加" : "—"))}${c.runTag ? `<span class="pill">${esc(c.runTag)}</span>` : ""}</dd>
        <dt>bio</dt><dd>${esc(c.bio || "—")}</dd>
        <dt>シグナル</dt><dd>${sigText(c)}</dd>
        <dt>選定理由(機械)</dt><dd class="hint">${esc(c.selectReason || "—")}</dd>
        <dt>語りの向き</dt><dd>${esc(c.qualStance || "—")}</dd>
      </dl>
      <div id="mNg">${ngHit(c)}</div>

      <h4>精査結果(定性評価)</h4>
      ${qualBlock(c)}

      <h4>SBIS-1 内訳(自動)</h4>
      <div class="breakdown">
        ${sc.total == null ? `<div class="ng-hit">データ不足のため自動採点不可(モードAで個別取得後、数値を更新)</div>` : `
        <div class="r"><span>${RES ? "①代替:コメント率(ティア正規化)" : "①会話の濃さ"}</span><b>${P.p1} / 30</b></div>
        <div class="r"><span>${RES ? "②ER — 配点から除外(測定不能)" : "②ER(ティア正規化)"}</span><b>${RES ? "—" : P.p2 + " / 25"}</b></div>
        <div class="r"><span>③ティア中心度</span><b>${P.p3} / 15</b></div>
        <div class="r"><span>④文脈適合</span><b>${P.p4} / 20</b></div>
        <div class="r"><span>⑤運用力</span><b>${P.p5} / 10</b></div>
        <div class="r"><span>純度減点(§4-1b)</span><b>${sc.purity && sc.purity.rated ? sc.purity.penalty : "未評価"}</b></div>
        <div class="r"><span>${RES ? "SBIS-1s 合計(②除外・75点満点)" : "SBIS-1 合計"}</span>
          <b>${sc.purity && sc.purity.rated ? sc.raw + " → " : ""}${sc.total} / ${sc.max}(得点率 ${sc.rate}%)</b></div>
        ${sc.flags && sc.flags.length ? `<div class="ng-hit">${sc.flags.map(esc).join(" / ")}</div>` : ""}`}
      </div>
      <div class="tot3">
        <span>${RES ? "SBIS-1s" : "SBIS-1"} <b>${sc.total ?? "—"}</b>/${sc.max || 100}</span>
        <span>SBIS-2 <b>${s2}</b>/50${unconf ? `<span class="pill">未確認${unconf}項目</span>` : ""}</span>
        <span>SBIS-3 <b>${s3}</b>/10${s3Active(c) ? "" : `<span class="pill">資料送付以降</span>`}</span>
        <span>合計 <b>${totalOf(c) ?? "—"}</b></span>
      </div>

      <h4>連載枠適格判定(§4-4)</h4>
      <div class="frow"><label>直近12投稿 前半6いいね中央値</label><input type="number" id="gPre" value="${esc(c.aux.gPre)}"></div>
      <div class="frow"><label>後半6いいね中央値</label><input type="number" id="gPost" value="${esc(c.aux.gPost)}"></div>
      <div class="frow"><label><input type="checkbox" id="gWeekly" ${c.aux.gWeekly ? "checked" : ""}> 週1投稿以上</label></div>
      <div class="hint" id="gCalc">${growthText(g, c)}</div>
    </div>

    <div>
      <h4>SBIS-2 証言力rubric(精査・50点)<span class="pill">§4-2</span></h4>
      <p class="hint">各項目、<b>判定根拠の実例を1つ証拠メモに書かないと点が保存されません</b>(「未確認」は証拠不要)。
        確認できない項目は0点ではなく「未確認」のまま残すこと。</p>
      <div id="mS2Warn"></div>
      ${RUBRIC.map(r => `
        <div class="rubrow">
          <div class="frow"><label>${esc(r.lab)} /${r.max}</label>
            <select id="${r.k}">${optionsFor(r.k, c.s2[r.k])}</select></div>
          ${r.k === "t1" ? `<div class="subrow">直近8投稿中
            <label>課題・成分・使い方が主語</label><input type="number" id="t1Topic" min="0" max="8" value="${esc(c.aux.t1Topic)}">
            <label>タイアップ</label><input type="number" id="t1Tieup" min="0" max="8" value="${esc(c.aux.t1Tieup)}">
            <button class="btn ghost sm" id="btnT1Calc">自動採点</button></div>
            <div id="t1Auto">${t1Text(a, c)}</div>` : ""}
          ${r.k === "t3" ? `<div id="t3Lock">${t3LockText(c)}</div>` : ""}
          <input type="text" class="ev" id="ev_${r.k}" placeholder="${esc(EV_PLACEHOLDER[r.k])}" value="${esc(c.s2ev[r.k])}">
        </div>`).join("")}

      <h4>SBIS-3(保存率実測・10点)<span class="pill">§4-3</span></h4>
      <div class="s3box ${s3Active(c) ? "" : "off"}">
        <div class="frow"><label>保存率実測(DM後)</label>
          <select id="s3save" ${s3Active(c) ? "" : "disabled"}>
            <option value="">未回収</option>
            <option value="10" ${c.s3.save === "10" ? "selected" : ""}>3%以上 +10</option>
            <option value="5" ${c.s3.save === "5" ? "selected" : ""}>2%以上 +5</option>
            <option value="0" ${c.s3.save === "0" ? "selected" : ""}>2%未満 0</option>
          </select></div>
        <p class="hint">${s3Active(c)
          ? "インサイト開示で3%以上=+10 / 2%以上=+5。<b>外部から取得不可能なため推測記入は禁止</b>。"
          : "ステータスが「資料送付」以降になると入力できます(精査時に空欄なのは異常ではありません)。"}</p>
      </div>
      ${legacyBox(c)}

      <h4>直近8投稿のキャプション貼り付け(薬機法突合)<span class="pill">§4-2 T3</span></h4>
      <p class="hint">判定母集団は<b>直近${T3_SAMPLE}投稿</b>(T1と同一)。投稿ごとに <b>---</b> だけの行で区切ってください。</p>
      <textarea id="mCaptions" rows="5" placeholder="1投稿目の本文&#10;---&#10;2投稿目の本文">${esc(c.captions)}</textarea>
      <div class="toolrow" style="margin-top:6px"><button class="btn ghost sm" id="btnScan">NG語・作法語を突合</button></div>
      <div id="mScan">${scanText(c)}</div>
    </div>

    <div>
      <h4>ステータスと契約枠</h4>
      <div class="frow"><label>ステータス</label>
        <select id="mStatus">${STATUSES.map(s => `<option ${c.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
      <div class="frow"><label>契約枠(帯とは独立)</label>
        <select id="mSlot"><option value="">未定</option>
          ${SLOTS.map(s => `<option ${c.slot === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
      <div id="mSlotWarn">${c.slot === "連載枠" && c.s2.t5 !== "5"
        ? `<div class="ng-hit">連載枠は<b>T5=5が必須要件</b>です(§4-2)。T5が5でない場合は都度枠に。</div>` : ""}</div>
      <div class="frow"><label>DM送付日</label><input type="date" id="mDmDate" value="${esc(c.dmSentAt)}"></div>
      <div class="frow"><label>リマインド送付日</label><input type="date" id="mRemindDate" value="${esc(c.remindAt)}"></div>
      <div id="mDue">${dueText(due)}</div>

      <h4>適合コメント(必須)<span class="pill">§4-5</span></h4>
      <p class="hint">数字は「どのくらい良いか」しか語りません。<b>なぜこの人がこのブランドなのか</b>を3〜5文で。空のままでは「DM送付」に進めません。</p>
      <textarea id="mFit" rows="7" placeholder="① 何をしている人か&#10;② どこが強いか(生活者としての信頼の根拠)&#10;③ 戦略との接続&#10;④ 懸念(必ず1つ)">${esc(c.fitComment)}</textarea>
      ${c.fitConcern ? `<div class="hint">機械の懸念:${esc(c.fitConcern)}</div>` : ""}
      <div id="mFitWarn"></div>

      <h4>精査チェックリスト<span class="pill">付録B v2.1</span></h4>
      <div class="check" id="mChecks">${CHECK_ITEMS.map((it, i) =>
        `<label><input type="checkbox" data-i="${i}" ${c.checks[i] ? "checked" : ""}> ${esc(it)}</label>`).join("")}</div>
      ${legacyChecks(c)}

      <h4>メモ</h4>
      <textarea id="mNotes" rows="3" placeholder="精査所感・DM反応など">${esc(c.notes)}</textarea>
    </div>

    <div class="full toolrow" style="justify-content:flex-end">
      <button class="btn ghost sm" id="mDelete" style="border-color:var(--red);color:var(--red)">候補から削除</button>
      <button class="btn" id="mSave">保存して閉じる</button>
    </div>
  </div></div>`;
}

const EV_PLACEHOLDER = {
  t1: "T1の証拠(例:7/8が成分・使い方主語)", t2: "T2の証拠(例:価格と容量の比較表を毎回入れている)",
  t3: "T3の証拠(例:「エイジングケア*¹」の注記あり)", t4: "T4の証拠(例:句点主体の静かな文体)",
  t5: "T5の証拠(例:5〜7月で週1.4本ペース)"
};
const OPTIONS = {
  t1: [["", "未確認"], ["15", "課題主語 6本以上 +15"], ["10", "4〜5本 +10"], ["5", "2〜3本 +5"], ["0", "1本以下 0"]],
  t2: [["", "未確認"], ["10", "明確(価格/比較/購入品/保存型) +10"], ["5", "部分的 +5"], ["0", "なし 0"]],
  t3: [["", "未確認"], ["15", "注記・関係明示の実在 +15"], ["5", "NG表現なしだが作法の証拠もなし +5"], ["0", "NG単発(要原稿指導) 0"], ["-15", "NG常習 −15(見送り)"]],
  t4: [["", "未確認"], ["5", "世界観と並べて違和感なし +5"], ["3", "可 +3"], ["0", "煽り文体 0"]],
  t5: [["", "未確認"], ["5", "週1以上×3ヶ月 +5"], ["0", "不安定 0"]],
};
function optionsFor(k, value) {
  return OPTIONS[k].map(([v, lab]) => `<option value="${v}" ${String(value ?? "") === v ? "selected" : ""}>${lab}</option>`).join("");
}
function fmt(n) { return n == null ? "不明" : Number(n).toLocaleString("ja-JP"); }
function sigText(c) {
  const s = c.sig; if (!s) return "—";
  const out = [];
  if (s.biz.length) out.push(`<span class="tag red">業者シグナル</span> ${esc(s.biz.join("・"))}`);
  if (s.amb.length) out.push(`<span class="tag res">他社契約</span> ${esc(s.amb.join("・"))}`);
  if (s.life.length && !s.biz.length) out.push(`<span class="tag g">生活者</span> ${esc(s.life.join("・"))}`);
  return out.length ? out.join("<br>") : "なし";
}
function badges(c, a, g) {
  let h = "";
  if (g && g.kind) h += `<span class="tag g">連載枠適格(${esc(g.kind)})</span> `;
  if (a && a.pitchman) h += `<span class="tag red">紹介者</span> `;
  if (c.scan && c.scan.habitual) h += `<span class="tag red">NG常習</span> `;
  if (c.score && c.score.mode === "rescue") h += `<span class="tag res">救済 /75</span> `;
  return h;
}
function ngHit(c) {
  const ngs = splitKw(state.conf.ngWords).filter(w => ((c.bio || "") + (c.notes || "")).includes(w));
  return ngs.length ? `<div class="ng-hit">⚠ NGワード検出:${ngs.map(esc).join("、")}(bio/メモ内 — 投稿本文も要確認)</div>` : "";
}
/* 精査結果(定性評価)。候補ボードの「精査」列 → 行クリック → ここで結論の全文が読める、という導線。
 * 人が書いた結論(役割・魅力・懸念)を出すのが要点。証拠の全文は md 書き出しで見る */
function qualBlock(c) {
  const q = c.qualReport;
  if (!q) return `<div class="hint">未精査(「精査・定性評価」タブで実施します)</div>`;
  const day = String(q.doneAt || q.generatedAt || "").slice(0, 10);  /* doneAt が無い既存レポートは生成日で代替 */
  const h = q.human || {};
  const row = (lab, v) => `<div class="r"><span>${esc(lab)}</span><b>${esc(v || "—")}</b></div>`;
  return `<div class="breakdown">
    <div class="r"><span>状態</span><b>${q.done ? `<span class="tag g">精査済</span>` : `<span class="tag res">下書き</span>`} ${esc(day)}</b></div>
    ${row("語りの向き", c.qualStance || (q.stance && q.stance.verdict))}
    ${row("戦略での役割", h.role)}
    ${row("魅力", h.charm)}
    ${row("懸念", h.concern)}
  </div>
  <div class="toolrow"><button class="btn ghost sm" id="mQualMd">mdで書き出す</button>
    <span class="hint">引用・コメントのQ&Aを含む全文は md に出ます</span></div>`;
}
function t1Text(a, c) {
  if (!a) return "";
  const rt = a.ratio == null ? "—" : (a.ratio * 100).toFixed(1) + "%";
  return a.pitchman
    ? `<div class="ng-hit">⚠ <b>紹介者</b>:タイアップ比率 ${rt}(50%超)→ T1=0点・原則見送り(§4-2)</div>`
    : `<div class="ok-hit">自動採点 T1=${a.pt}点(課題主語 ${esc(c.aux.t1Topic)}本 / タイアップ比率 ${rt})</div>`;
}
function t3LockText(c) {
  const sc = c.scan;
  if (sc && sc.habitual) return `<div class="ng-hit">NG常習を検出(NG含有投稿 ${sc.ngPosts} / ${sc.posts}投稿・2件以上)→ <b>−15のみ選択可</b>。総合点に関わらず見送り(§5)。</div>`;
  if (sc && sc.ngPosts > 0) return `<div class="ng-hit">NG単発を検出(NG含有投稿 ${sc.ngPosts} / ${sc.posts}投稿)。原稿指導を条件化するなら0点。</div>`;
  return "";
}
function growthText(g, c) {
  const lift = g.lift == null ? "—" : (g.lift * 100).toFixed(0) + "%";
  return esc([`いいね中央値 後半/前半 ${lift}${g.trend ? " ✓+30%以上" : ""}`,
    `ER${c.er == null ? "不明" : Number(c.er).toFixed(2) + "%"}×週1${c.aux.gWeekly ? "✓" : "—"}${g.dense ? " ✓高密度安定" : ""}`,
    `T5=${g.t5 == null ? "未確認" : g.t5}`].join(" / "));
}
function dueText(d) {
  if (!d) return "";
  if (d.kind === "remind") return `<div class="ng-hit">${esc(d.label)} — リマインドは1回のみ。送ったら上の欄に日付を入れてください。</div>`;
  if (d.kind === "close") return `<div class="ng-hit">${esc(d.label)} — 以後追わない(§6)。ステータスを「見送り」に。</div>`;
  return `<div class="ok-hit">${esc(d.label)} — 期限まで待機</div>`;
}
function scanText(c) {
  const s = c.scan;
  if (!s) return "";
  let h = "";
  const N = s.sample || T3_SAMPLE, pasted = s.pasted ?? s.posts;
  if (pasted < N) h += `<div class="ng-hit">⚠ 判定母集団が不足しています(${pasted}投稿しか区切られていません/仕様は直近${N}投稿)。<b>---</b> の行で区切って貼り直してください。${s.sepOk ? "" : "現在は空行区切りで判定しています。"}</div>`;
  else if (pasted > N) h += `<div class="ng-hit">${pasted}投稿が貼られています。判定は仕様どおり<b>先頭${N}投稿</b>のみで行いました。</div>`;
  h += s.hits.length
    ? `<div class="ng-hit">⚠ NG語 ${s.hits.length}種・延べ${s.total}件。<b>NG含有投稿 ${s.ngPosts} / ${s.posts}投稿</b>(同一投稿内の複数NG語は1件):${s.hits.map(x => esc(x.w) + "×" + x.n).join("、")}<br>${s.habitual ? "<b>常習(2件以上)と判定 → T3は −15 のみ選択可・総合点に関わらず見送り</b>" : "単発(1件)→ T3は 0(要原稿指導)を想定"}</div>`
    : `<div class="ok-hit">NG表現の機械検出はゼロ(判定母集団 ${s.posts}/${N}投稿)。目視でも問題なく、注記・関係明示の証拠があれば +15、証拠がなければ +5。</div>`;
  h += s.manner.length
    ? `<div class="ok-hit">作法語を検出:${s.manner.map(x => esc(x.w) + "×" + x.n).join("、")}<br>注記・関係明示の実在は T3=+15 の根拠になります(証拠メモに実例を1つ記録)。</div>`
    : `<div class="ng-hit">作法語(※注記・「いただきものを含みます」等)は検出されませんでした。NG表現がなくても作法の証拠がなければ T3=+5 です。</div>`;
  if (s.risk && (s.risk.disguised || s.risk.missing)) {
    h += `<div class="ng-hit"><b>表示リスク(§4-2b・ステマ規制/景表法 — T3とは別軸)</b>:装飾文字PR ${s.risk.disguised}件 / 提供言及ありPR表記なし ${s.risk.missing}件<br>
      <span class="hint">${s.risk.items.map(esc).join("<br>")}</span><br>
      見送り理由にはしない。契約条件に「PR表記は当社ルール(ASCII #PR+タイアップラベル)」を必須で入れ、初回投稿の原稿チェックで表記を確認すること。</div>`;
  } else if (s.risk) {
    h += `<div class="ok-hit">表示リスク(§4-2b):装飾文字PR・提供言及ありPR表記なし、ともに検出なし。</div>`;
  }
  return h;
}
function legacyBox(c) {
  const l = c.legacy_s2;
  if (!l) return "";
  return `<div class="ng-hit" style="background:#ECE6E0;color:var(--sub)">旧SBIS-2(v1.1)の入力値を保持しています。<b>基準が違うため換算していません</b>。証言力rubricは空から入力してください。<br>
    <span class="hint">${LEGACY_S2_KEYS.filter(k => l[k] !== "").map(k => esc(LEGACY_S2_LAB[k]) + ":" + esc(l[k])).join(" / ")}</span></div>`;
}
function legacyChecks(c) {
  const lc = c.legacy_checks;
  if (!(lc && lc.some(Boolean))) return "";
  return `<div class="ng-hit" style="background:#ECE6E0;color:var(--sub)">旧チェックリスト(v1.0 付録B)の記録を保持しています。<b>v2の精査は証言力rubricでの再精査が前提</b>のため、上のチェックは空から開始します。<br>
    <span class="hint">${LEGACY_CHECK_ITEMS.filter((_, i) => lc[i]).map(t => "☑ " + esc(t)).join("<br>")}</span></div>`;
}

/* ---- 保存(v1.4 の saveDetail をそのまま移植:判断16の修正を含む)---------- */
export function save() {
  const c = state.cands.find(x => x.username === current);
  if (!c || !document.getElementById("mFit")) return [];
  const $ = id => document.getElementById(id);
  c.fitComment = $("mFit").value;
  const newStatus = $("mStatus").value;
  const prevStatus = c.status;
  let statusBlocked = null;
  if (newStatus !== c.status) {
    const r = setStatus(c, newStatus, todayISO());
    if (!r.ok) { statusBlocked = r.reason; $("mStatus").value = c.status; }
  }
  const statusChangedNow = (c.status !== prevStatus);
  $("mFitWarn").innerHTML = statusBlocked ? `<div class="ng-hit">⚠ ${esc(statusBlocked)}</div>`
    : (fitMissing(c) ? `<div class="ng-hit" style="background:var(--amber-bg);color:#8F6A1F">適合コメントが未記入です。この候補は「DM送付」に進めません(§4-5)。</div>` : "");
  c.slot = SLOTS.includes($("mSlot").value) ? $("mSlot").value : "";
  /* v1.4(判断16):ステータス変更で dmSentAt=今日 をセットした直後に、空の入力欄で上書きして消すバグの修正 */
  const dmInput = $("mDmDate").value;
  if (dmInput) { if (dmInput !== c.dmSentAt) c.dmSentAt = dmInput; }
  else if (!statusChangedNow) c.dmSentAt = "";
  $("mDmDate").value = c.dmSentAt || "";
  c.remindAt = $("mRemindDate").value;
  c.notes = $("mNotes").value;
  c.captions = $("mCaptions").value;
  c.aux.t1Topic = $("t1Topic").value; c.aux.t1Tieup = $("t1Tieup").value;
  c.aux.gPre = $("gPre").value; c.aux.gPost = $("gPost").value; c.aux.gWeekly = $("gWeekly").checked;
  /* 証拠メモは常に保存する(点より先に書けるように) */
  RUBRIC_KEYS.forEach(k => { c.s2ev[k] = $("ev_" + k).value; });
  const blocked = [];
  RUBRIC_KEYS.forEach(k => {
    const v = $(k).value, ev = (c.s2ev[k] || "").trim();
    const evEl = $("ev_" + k);
    if (v !== "" && ev === "") { blocked.push(k); evEl.classList.add("bad"); }
    else { evEl.classList.remove("bad"); c.s2[k] = v; }
  });
  $("mS2Warn").innerHTML = blocked.length
    ? `<div class="ng-hit">⚠ <b>${blocked.map(k => k.toUpperCase()).join("・")} は未保存です</b>。証拠メモ(判定根拠の実例1つ)を書くまで点は保存されません。確認できない項目は「未確認」のままにしてください。</div>` : "";
  if (s3Active(c)) c.s3.save = $("s3save").value;
  document.querySelectorAll("#mChecks input").forEach(cb => { c.checks[cb.dataset.i] = cb.checked; });
  c.score = scoreSbis1(c, state.conf);
  c.growth = growthEval(c, state.conf);
  markDirty();
  return blocked;
}

function refresh() {
  const c = state.cands.find(x => x.username === current);
  if (!c) return;
  const a = t1Auto(numOrNull(c.aux.t1Topic), numOrNull(c.aux.t1Tieup));
  const g = growthEval(c, state.conf);
  document.getElementById("t1Auto").innerHTML = t1Text(a, c);
  document.getElementById("t3Lock").innerHTML = t3LockText(c);
  document.getElementById("gCalc").innerHTML = growthText(g, c);
  document.getElementById("mFlags").innerHTML = badges(c, a, g);
  document.getElementById("mDue").innerHTML = dueText(dmDue(c, todayISO()));
  document.getElementById("mSlotWarn").innerHTML = (c.slot === "連載枠" && c.s2.t5 !== "5")
    ? `<div class="ng-hit">連載枠は<b>T5=5が必須要件</b>です(§4-2)。T5が5でない場合は都度枠に。</div>` : "";
  document.querySelector(".mhead .total").textContent = (totalOf(c) ?? "—") + "点";
  /* T3 は NG突合の結果に連動して選択肢を絞る */
  const sel = document.getElementById("t3");
  [...sel.options].forEach(o => o.disabled = false);
  if (c.scan && c.scan.habitual) {
    [...sel.options].forEach(o => { if (o.value !== "-15") o.disabled = true; });
    if (sel.value !== "-15") { sel.value = "-15"; c.s2.t3 = "-15"; }
  }
}

function bind(c) {
  const $ = id => document.getElementById(id);
  $("mClose").onclick = close;
  $("mSave").onclick = () => { const b = save(); if (b && b.length) { toast("証拠メモが未記入の項目があります", true); return; } close(); };
  const qmd = $("mQualMd");
  if (qmd) qmd.onclick = () => {
    const blob = new Blob([toMarkdown(c.qualReport)], { type: "text/markdown" });
    const a2 = document.createElement("a");
    a2.href = URL.createObjectURL(blob); a2.download = `定性評価_${c.qualReport.handle}.md`; a2.click();
    setTimeout(() => URL.revokeObjectURL(a2.href), 5000);
  };
  $("mDelete").onclick = () => {
    if (!confirm(`@${c.username} を候補から削除します。よろしいですか?`)) return;
    state.cands = state.cands.filter(x => x.username !== current);
    markDirty(); current = null;
    document.getElementById("ovDetail").classList.remove("open");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  };
  RUBRIC_KEYS.forEach(k => {
    $(k).addEventListener("change", () => { save(); refresh(); });
    $("ev_" + k).addEventListener("input", () => { save(); refresh(); });
  });
  ["t1Topic", "t1Tieup"].forEach(k => $(k).addEventListener("input", () => {
    const cc = state.cands.find(x => x.username === current);
    cc.aux.t1Topic = $("t1Topic").value; cc.aux.t1Tieup = $("t1Tieup").value;
    const a = t1Auto(numOrNull(cc.aux.t1Topic), numOrNull(cc.aux.t1Tieup));
    if (a) $("t1").value = String(a.pt);
    save(); refresh();
  }));
  $("btnT1Calc").onclick = () => {
    const a = t1Auto(numOrNull($("t1Topic").value), numOrNull($("t1Tieup").value));
    if (!a) { $("t1Auto").innerHTML = `<div class="ng-hit">「課題主語」の本数を入力してください。</div>`; return; }
    $("t1").value = String(a.pt); save(); refresh();
  };
  ["gPre", "gPost", "gWeekly"].forEach(k => $(k).addEventListener("input", () => { save(); refresh(); }));
  $("mSlot").addEventListener("change", () => { save(); refresh(); });
  $("mStatus").addEventListener("change", () => {
    save();
    const cc = state.cands.find(x => x.username === current);
    if (cc) { $("mDmDate").value = cc.dmSentAt || ""; }
    refresh();
  });
  ["mDmDate", "mRemindDate"].forEach(k => $(k).addEventListener("change", () => { save(); refresh(); }));
  $("mChecks").addEventListener("change", save);
  $("mFit").addEventListener("input", save);
  $("s3save").addEventListener("change", () => { save(); refresh(); });
  $("btnScan").onclick = () => {
    const cc = state.cands.find(x => x.username === current);
    save();
    const txt = $("mCaptions").value;
    if (!txt.trim()) {
      cc.scan = null;
      $("mScan").innerHTML = `<div class="ng-hit">キャプションが空です。直近8投稿の本文を <b>---</b> 区切りで貼り付けてください。</div>`;
      markDirty(); refresh(); return;
    }
    cc.scan = scanCaptions(txt, state.conf);
    markDirty();
    $("mScan").innerHTML = scanText(cc);
    refresh();
  };
}
