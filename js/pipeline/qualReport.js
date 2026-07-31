/* 精査・定性評価の構造化(設計書§6-1・§5-6)。移植元:qual_report.py(v2.7)。
 *
 * **このモジュールは「証拠を並べた下書き」を作る。結論は人が書く。**
 * md を生成するのではなく §5-6 の構造化データを返す(md 書き出しは view 側)。
 * パースは「行全体が `---` の行だけを区切りにする」修正済みロジック
 * (キャプション本文に `---` が入ると投稿が落ちる。run#6 実測で12投稿が11投稿になった)。
 */
import * as Q from "./qualsignals.js";
import { cpLen } from "./util.js";

const POST_HEAD = /^\[(\d+)\]\s*(\S+)?\s*like=(\S+)\s*comment=(\S+)/m;
const CMT_HEAD = /^---\s*#(\d+)\s+user=@(\S+)\s+own_reply=(YES|no)/gm;
const META_LINE = /^(code|media_id|taken_at)=/;
const PR_RE = /#\s*(PR|提供|ad|タイアップ)/;

export function parseCaptions(text) {
  const posts = [];
  /* 区切りは「行全体が --- の行」だけ(本文中の --- で投稿を落とさない) */
  const blocks = String(text || "").split(/^\s*-{3,}\s*$/m);
  blocks.forEach(raw => {
    let block = raw.trim();
    const head0 = POST_HEAD.exec(block);
    if (!head0) return;
    /* ファイル冒頭の # コメント行が [1] と同じブロックに入るので、見出し行から切り出す
       (run#6実測:これで両アカウントとも投稿[1]が丸ごと落ちていた) */
    block = block.slice(head0.index);
    const head = POST_HEAD.exec(block);
    const lines = block.split("\n");
    const body = [];
    lines.slice(1).forEach(line => { if (!META_LINE.test(line.trim())) body.push(line); });
    posts.push({
      no: Number(head[1]), date: head[2] || "", like: head[3], comment: head[4],
      caption: body.join("\n").trim(),
      paid: block.includes("paid=true") || block.includes("is_paid_partnership=true")
    });
  });
  return posts.sort((a, b) => a.no - b.no);
}

export function parseComments(text) {
  const t = String(text || "");
  const out = [], marks = [...t.matchAll(CMT_HEAD)];
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : t.length;
    let body = t.slice(m.index + m[0].length, end).trim();
    body = body.split("\n").filter(l => !l.startsWith("=") && !l.startsWith("[POST]")).join("\n").trim();
    out.push({ user: m[2], own: m[3] === "YES", text: body });
  });
  return out;
}

/* 読者の質問 → 直後の本人返信 のペア(定性評価の中核) */
export function qaPairs(comments, limit = 6) {
  const pairs = [];
  for (let i = 0; i < comments.length; i++) {
    const c = comments[i];
    if (c.own || !c.text) continue;
    const nxt = comments[i + 1];
    if (nxt && nxt.own && nxt.text) {
      pairs.push({ reader: `@${c.user}:${c.text}`, own: nxt.text });
      if (pairs.length >= limit) break;
    }
  }
  return pairs;
}

export function parseProfile(text) {
  const t = String(text || "");
  if (!t.trim()) return { bio: "", fullName: "" };
  let fullName = "";
  const n = t.match(/^full_name\s*=\s*(.+)$/m);
  if (n) fullName = n[1].trim();
  /* `[biography 全文]` 以降を bio とする(次の `[...]` 見出しまで)。
     `[bio_links]` を先に拾ってリンク一覧を bio と誤認しないよう biography を明示で当てる */
  const b = t.match(/\[biography[^\]]*\]\s*\n([\s\S]*?)(?=\n\[|$)/);
  if (b) return { bio: b[1].trim(), fullName };
  const b2 = t.match(/^bio\s*=\s*(.+)$/m);
  return { bio: b2 ? b2[1].trim() : t.trim(), fullName };
}

/* 3ファイル → §5-6 の構造化データ。人が書く欄は空のまま返す(埋めずに提出しないため) */
export function buildReport({ captionsText, commentsText, profileText, handle }) {
  const posts = parseCaptions(captionsText);
  const comments = parseComments(commentsText);
  const { bio, fullName } = parseProfile(profileText);
  const captions = posts.map(p => p.caption);
  const prPosts = posts.filter(p => p.paid || PR_RE.test(Q.norm(p.caption))).length;
  const qual = Q.extract({ bio_text: bio, full_name: fullName }, captions, prPosts);

  const own = comments.filter(c => c.own);
  const readers = comments.filter(c => !c.own);
  const uniq = new Set(own.map(c => c.text)).size;
  const questions = readers.filter(c => /[?？]|教えて|どこで|いくら|どれ|悩み/.test(c.text));

  return {
    handle: String(handle || "").replace(/^@/, ""),
    generatedAt: new Date().toISOString(),
    source: { posts: posts.length, comments: comments.length, hasProfile: !!String(profileText || "").trim() },
    profile: { bio, fullName, raw: String(profileText || "").trim().slice(0, 900) },
    stance: {
      verdict: qual.stance, witness: qual.witness_score, authority: qual.authority_score,
      why: qual.stance_why
    },
    quotes: qual.quotes,
    counts: qual.counts,
    pr: { posts: prPosts, total: posts.length, overGate: posts.length > 0 && prPosts / posts.length > 0.5 },
    captionAvg: qual.counts["キャプション平均文字数"],
    reliability: qual.counts["定性列の信頼性"],
    comments: {
      total: comments.length, readers: readers.length, own: own.length, uniqueOwn: uniq,
      questions: questions.length, pairs: qaPairs(comments), ownSamples: own.slice(0, 6).map(c => c.text)
    },
    posts: posts.map(p => ({
      no: p.no, date: p.date, like: p.like, comment: p.comment,
      pr: p.paid || PR_RE.test(Q.norm(p.caption))
    })),
    /* 人が書く欄(§5-6:未記入のまま「精査完了」にできない) */
    human: { agreeStance: "", bestQuote: "", replyKind: "", role: "", charm: "", concern: "" },
    done: false
  };
}

export const HUMAN_FIELDS = [
  ["agreeStance", "1. 語りの向きの判定に同意するか。しないならどの一文が根拠か"],
  ["bestQuote", "2. 引用のうち、いちばん効いている一文とその理由"],
  ["replyKind", "3. 本人の返信は宣伝の言葉か、当事者の言葉か(根拠の表現)"],
  ["role", "4. 戦略での役割(証言者 / 裏書き・監修 / 見送り)"],
  ["charm", "5. 魅力を一文で"],
  ["concern", "6. 懸念(必ず1つ)"],
];

export function isComplete(report) {
  return HUMAN_FIELDS.every(([k]) => String(report.human[k] || "").trim().length > 0);
}

/* md 書き出し(qual_report.py の出力と同じ構成) */
export function toMarkdown(r) {
  const L = [`# 定性評価:@${r.handle}`, "",
    "> **これは証拠を並べた下書きである。** 引用・コメント欄・語りの向きの一次判定までを機械が用意し、",
    "> 「この一文にこの人の魅力が出ている」という読みは人が書く(最終判断は人)。", "",
    `根拠:直近${r.source.posts}投稿の全文${r.source.comments ? ` / コメント${r.source.comments}件` : " / コメント未取得"}`, ""];
  if (r.profile.raw) L.push("## プロフィール(取得値)", "", "```", r.profile.raw, "```", "");
  L.push("## 1. 語りの向き(機械の一次判定)", "", `**${r.stance.verdict}**`, "",
    `- 当事者スコア ${r.stance.witness} / 権威スコア ${r.stance.authority}`, "");
  r.stance.why.forEach(w => L.push("- " + w));
  L.push("", "> 人が書く欄 —— この判定に同意するか:", "", r.human.agreeStance || "(未記入)", "");
  L.push("## 2. 本文からの引用(定性シグナル)", "");
  let any = false;
  Object.entries(r.quotes).forEach(([key, quotes]) => {
    if (!quotes.length) return;
    any = true;
    L.push(`**${key}**(${quotes.length}件)`, "");
    quotes.forEach(q => L.push("> " + q));
    L.push("");
  });
  if (!any) L.push("引用を1件も拾えなかった。キャプションが極端に短いか、カタログ型の可能性がある。", "");
  L.push(`- PR表記のある投稿:**${r.pr.posts}/${r.pr.total}本**${r.pr.overGate ? "(**T1の50%ゲート違反**)" : ""}`,
    `- キャプション平均 ${r.captionAvg}字(定性列の信頼性:${r.reliability})`, "",
    "> 人が書く欄 —— いちばん効いている一文とその理由:", "", r.human.bestQuote || "(未記入)", "");
  L.push("## 3. コメント欄(証言力の実物)", "");
  if (!r.source.comments) {
    L.push("コメント未取得。**定性評価はここが本体なので、必ず取ってからやり直すこと。**", "");
  } else {
    const c = r.comments;
    L.push(`- 取得 ${c.total}件 / 読者 ${c.readers}件 / 本人返信 **${c.own}件**`
      + (c.own ? `(ユニーク文 ${c.uniqueOwn}/${c.own})` : "(**0件 — 会話が成立していない**)"),
      `- 読者の質問・相談 ${c.questions}件`, "");
    if (c.pairs.length) {
      L.push("### 読者の質問 → 本人の返信", "");
      c.pairs.forEach(p => L.push(`> 読者:${p.reader}`, ">", `> **本人:${p.own}**`, ""));
    } else if (c.own) {
      L.push("### 本人の返信(質問とのペアは検出できず)", "");
      c.ownSamples.forEach(t => L.push("> " + t));
      L.push("");
    }
    L.push("> 人が書く欄 —— この返信は宣伝の言葉か、当事者の言葉か:", "", r.human.replyKind || "(未記入)", "");
  }
  L.push("## 4. 直近投稿の並び(参考)", "", "| # | 日付 | いいね | コメント | PR |", "|---|---|---|---|---|");
  r.posts.forEach(p => L.push(`| ${p.no} | ${p.date} | ${p.like} | ${p.comment} | ${p.pr ? "●" : ""} |`));
  L.push("", "## 5. 結論(人が書く)", "",
    `- 役割:${r.human.role || "(未記入)"}`, "",
    `- 魅力を一文で:${r.human.charm || "(未記入)"}`, "",
    `- 懸念(必ず1つ):${r.human.concern || "(未記入)"}`, "");
  return L.join("\n");
}
