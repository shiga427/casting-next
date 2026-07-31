# 精査データ収集のお願い({COUNT}名)

あなた(Claude)へのお願いです。以下の{COUNT}名について、**精査(定性評価)に使う3ファイル**を作ってください。
数値ではなく、**本人が書いた文章とコメント欄のやりとり**が要ります。ここが定性評価の本体です。

## 禁止事項(最優先・1つでも破らないでください)

- **DM送信・フォロー・いいね・投稿・コメントを絶対にしない。** 閲覧と fetch だけです
- **UA(ユーザーエージェント)偽装をしない**
- **ページ遷移を最小限に。** 遷移すると `window.IGF` が消えます
- `computer` 操作(クリック・スクロール)は最終手段

## 準備

1. **instagram.com のタブを開く**(ご本人のアカウントでログイン済みであること)
2. `{KIT_URL}/ig_probe.js` を取得して、**そのまま**評価する(`window.IGF` が定義されます)
   - 精査データは**全文**が必要なので、`prof_compact.js`(140字に切り詰める方)は**使いません**

## 対象(この順で)

{HANDLES}

## 作るファイル(1人につき3つ)

ファイル名は `<handle>_captions.txt` `<handle>_comments.txt` `<handle>_profile.txt`。
**管制室はこの書式をそのまま読みます。見出し行の形を変えないでください。**

### ① `<handle>_captions.txt` — 直近12投稿のキャプション全文

- **`taken_at` の降順に整列してから直近12件**を確定してください(フィードの返却順は日時順ではありません)
- **キャプションは切り詰めない。全文をそのまま。**
- 投稿ごとに、**行全体が `---` の行**で区切る(本文中に `---` が出てくることがあるので、区切りは行全体が `---` のときだけ)

```
# handle=<handle> pk=<pk> 直近12投稿(taken_at降順) 取得 YYYY-MM-DD
# キャプションは API が返した全文をそのまま記載(切り詰めなし)

[1] YYYY-MM-DD like=272 comment=8 type=reel paid=false
code=XXXX media_id=... taken_at=... media_type=2 comments_disabled=false cap_len=492
(ここにキャプション全文)
---
[2] YYYY-MM-DD like=310 comment=12 type=carousel paid=true
code=YYYY media_id=... taken_at=... media_type=8 comments_disabled=false cap_len=210
(ここにキャプション全文)
```

- `paid=` は feed API の `is_paid_partnership` の値をそのまま
- `like=` `comment=` はその投稿の実数

### ② `<handle>_comments.txt` — コメント欄(証言力の実物)

- 対象は**いいねの多い上位4投稿**。1投稿あたり**最大50件**まで
- **本人の返信は全文**を載せる(要約しない)。ここが「会話が成立しているか」の判断材料です
- 1コメント1ブロック。見出し行の形は次のとおり

```
# handle=<handle> コメント欄(上位4投稿×最大50件) 取得 YYYY-MM-DD

--- #1  user=@reader_a  own_reply=no  post=XXXX
(読者のコメント本文)
--- #2  user=@<handle>  own_reply=YES  post=XXXX
(本人の返信本文・全文)
```

- `own_reply=YES` は**本人の返信**のときだけ。読者は `no`
- 読者の質問の**直後に本人の返信**が来る並び順を保ってください(質問→返信のペアを機械が拾います)

### ③ `<handle>_profile.txt` — プロフィール

- **bio は全文が必須**(bio を渡さないと「40代・2児のママ」等の自己開示を取りこぼし、当事者性が0件になります)

```
# handle=<handle> プロフィール 取得 YYYY-MM-DD
full_name = <表示名>
followers = <数>
following = <数>
media_count = <数>

[bio_links]
(外部リンク)

[biography 全文]
(bio 全文。改行もそのまま)
```

## ペースとエラー処理

- リクエストの間には数秒の間隔を置いてください
- HTTP 429 や rate limit の兆候が出たら、**即中断して、どこまで終わったかを報告**してください
- 取れなかった項目は「取れなかった」と書いてください。**推測で埋めないこと**

## 終わったら

3ファイル×{COUNT}名を返してください。管制室の「精査・定性評価」画面にドロップすると、
語りの向きの一次判定・本文からの引用・読者の質問と本人返信のペアが自動で並びます。
**結論(役割・魅力・懸念)は人が書きます。**

---

生成:キャスティング管制室 NEXT / プロジェクト {BRAND} / キット {KIT_VERSION}
