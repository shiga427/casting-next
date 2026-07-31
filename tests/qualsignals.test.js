/* 定性シグナル抽出の回帰テスト(設計書§6-3「回帰10件を最優先で移植」)。
 * 移植元:igf_scripts/tests/test_qualsignals.py(v2.7)。判定条件は1つも変えていない。
 *
 * 本文は run#6 の定性評価で人が読んで出した結論を固定するためのもの。
 * **ハンドル・実名・屋号は差し替え済み**(設計書§11-2:公開リポジトリに実在アカウントの
 * 識別子を置かない)。文体・語彙は判定対象そのものなので原文どおり残している。
 *   サンプルA = 当事者型(証言者向き)と結論された候補
 *   サンプルB = 権威型(語りの終着点が自社導線)と結論された候補
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as Q from "../js/pipeline/qualsignals.js";
import { build } from "../js/pipeline/fitcomment.js";

/* --- サンプルA(41歳・産後・アラフォー垢抜け美容)--------------------------- */
const A_BIO = "˗ˏˋ 41歳 垢抜け美容✨ˎˊ˗\n"
  + "▫️「なんか老けたかも」を解決する-５歳メイク\n"
  + "▫️産後ボロボロ肌からツヤ肌になれたスキンケア\n"
  + "イエベ春/158cm";
const A_CAPS = [
  "アラフォーになってからなんとなく「前と同じアイラインがしっくりこないな…」って感じること、ない？"
  + "まぶたが少しずつ下がってくるから、同じラインが似合わなくなるんだよね",
  "クマ🐻とたるみ😮‍💨アラフォーになって気になり出した。毎日クマ消しに使ってるリップ&チーク 660円",
  "40代のひよっこ🐣だよ ４１歳なんてまだまだ始まったばかり。スキンケアもコスメも色々試して正直にレビューしていくね",
  "子連れ海外旅行✈️ 去年行った台湾🇹🇼旅行をまとめてみたよ！海外旅行、子連れは無理だと思ってたけど",
  "休日だけ盛りたい人、全員集合〜！👀💕 マツエクはお手入れ大変だし、仕事柄できない…🥹 #PR #新作コスメ",
];

/* --- サンプルB(小顔サロン 代表)------------------------------------------- */
const B_BIO = "40歳💎小顔サロン/スクール/化粧品開発の会社経営。\n"
  + "正解より“好き”でいられる美容を届けたい";
const B_CAPS = [
  "その\"\"三日坊主\"\"、あなたのせいじゃないかも🤔❓ 続かないのは、あなたがダメなんじゃなくて、"
  + "その工程が\"\"合わなかっただけ\"\"。無理してやらなくていいと思うんです。続かない自分を、どうか責めないでください🌿"
  + "▼ サロンのご予約・詳細はリンクから",
  "悩み続けるならすぐに当店でご相談下さい🤗 現在のお顔状態を分析し、しっかりアドバイスさせて頂きます！"
  + "ご新規様のご予約は、毎月15日と月末に、翌月の予約枠をご案内しています。"
  + "サンプルB｜小顔サロン 代表 ▼ サロンのご予約・詳細はリンクから",
  "美容家ですが、ポテチもミスドも、普通に食べます。「美容家って、ジャンクフード食べないんでしょ？」"
  + "あとで見返せるように「保存」してお守りにしてください👇 ▼ サロンのご予約・詳細はリンクから",
];

function rec(bio, name = "") {
  return {
    bio_text: bio, full_name: name, followers: 14238, following: 267,
    ff_ratio: 53.33, engagement_rate: 4.04, avg_comments: 3.7, genre: "beauty"
  };
}

test("1. サンプルAは当事者型(証言者向き)", () => {
  const r = Q.extract(rec(A_BIO, "サンプルA"), A_CAPS);
  assert.ok(r.stance.startsWith("当事者型"), r.stance);
  assert.equal(r.authority_score, 0);
  assert.ok(r.counts["自己開示"] >= 1);
  assert.ok(r.counts["当事者の悩み"] >= 1);
  assert.ok(r.counts["価格の明示"] >= 1);
});

test("2. サンプルBは温かい語りでも権威型(営業導線は当事者性で相殺されない)", () => {
  const r = Q.extract(rec(B_BIO, "サンプルB｜小顔サロン 代表"), B_CAPS);
  assert.ok(r.stance.startsWith("権威型"), r.stance);
  assert.ok(r.counts["営業導線"] >= 2);
  assert.ok(r.counts["権威の提示"] >= 1);
  /* 当事者側の引用は「拾えている」こと(拾えずに権威型になったのでは意味がない) */
  assert.ok(r.counts["自己否定の解除"] >= 1);
  assert.ok(r.counts["完璧を演じない"] >= 1);
});

test("3. 引用は語ではなく文で返る(定性コメントに貼れる形)", () => {
  const r = Q.extract(rec(A_BIO), A_CAPS);
  for (const quotes of Object.values(r.quotes)) {
    for (const q of quotes) {
      assert.ok(Array.from(q).length >= 6, q);
      assert.ok(!q.startsWith("#"), q);
    }
  }
});

test("4. 件数は表示上限(3件)と独立に数える", () => {
  const caps = Array(5).fill("ご予約はこちら").concat(Array(5).fill("当店にご来店ください"));
  const r = Q.extract(rec("サロン代表"), caps);
  assert.ok(r.quotes["営業導線"].length <= 3);
  assert.ok(r.counts["営業導線"] >= 2);
});

test("5. PR件数は全文判定(prl)を優先する", () => {
  const truncated = Array(4).fill("新作コスメを試してみたよ、めっちゃ良かった"); // #PR が切れて消えた状態
  const weak = Q.extract(rec(""), truncated);
  assert.equal(weak.counts["PR表記のある投稿"], 0);
  assert.ok(weak.counts["PR判定の出所"].includes("過小"));
  const strong = Q.extract(rec(""), truncated, 3);
  assert.equal(strong.counts["PR表記のある投稿"], 3);
  assert.equal(strong.counts["PR判定の出所"], "全文(ブラウザ側判定)");
});

test("6. 短いキャプションは信頼性を落として警告する", () => {
  const r = Q.extract(rec(""), Array(5).fill("短いキャプション"));
  assert.ok(r.counts["定性列の信頼性"].includes("低い"));
  assert.ok(r.counts["定性列の信頼性"].includes("140"));
});

test("7. 適合コメントに本文の引用が入る(4要素が壊れていない)", () => {
  const parts = build(rec(A_BIO, "サンプルA"), A_CAPS, 1);
  assert.ok(parts.fit_comment.includes("「") && parts.fit_comment.includes("」"));
  assert.ok(parts.fit_comment.includes("声の特徴"));
  assert.ok(parts.qual_stance.startsWith("当事者型"));
  assert.ok((parts.qual_evidence.match(/\|/g) || []).length >= 2);
  assert.ok(parts.fit_comment.includes("懸念") && parts.fit_concern);
});

test("8. 生活・当事者性の引用が1件も無ければカタログ型", () => {
  const caps = ["新作パレットのスウォッチ比較", "限定色の全色レビュー", "発売日と品番まとめ"];
  const r = Q.extract(rec(""), caps);
  assert.ok(r.stance.startsWith("カタログ型"), r.stance);
});

test("9. 生活者の「予約」は営業導線にしない(run#6の誤判定回帰)", () => {
  const consumer = ["(かなちゃん予約ありがと)", "土日は予約がオススメだよ",
    "こちらはオンラインで7月入荷で受付でした"];
  assert.equal(Q._count(Q.P_FUNNEL, Q.sentences(consumer.join(" "))), 0);
  const seller = ["ご予約はこちらのリンクから", "ご新規様のご予約は毎月15日にご案内しています",
    "悩み続けるならすぐに当店でご相談下さい"];
  const pool = seller.flatMap(c => Q.sentences(c));
  assert.ok(Q._count(Q.P_FUNNEL, pool) >= 2);
});

test("10. 「¥649」形式の価格も価格の明示として拾う", () => {
  const r = Q.extract({ bio_text: "" }, ["スナップタンク ¥649(ブラックドット/Lサイズ)"]);
  assert.ok(r.counts["価格の明示"] >= 1);
});
