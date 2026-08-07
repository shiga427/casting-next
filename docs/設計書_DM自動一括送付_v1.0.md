# 設計書 — DM自動一括送付機能（キャスティング管制室 NEXT）v1.0

作成日: 2026-08-04 ／ 宛先: 実装担当（Opus / Claude Code）
設計の正: このファイル。実装は本書に従い、判定ロジック・数値・文言は発明せず本書の値を移植する。
移植元の作法: `docs/設計書_キャスティング管制室NEXT_v1.0.md` の章立て・検証主義を踏襲する。

---

## 0. この機能が「既存の大原則」を上書きすることの明示（最重要・先に読む）

キャスティング管制室 NEXT は、設計当初から **「DM送信・フォロー・いいね・投稿は絶対にしない。取得までがシステムの範囲。DMは人が手で送る」** を三原則級のルールとして持っている（manifest の description・`casting-control-room` の「やってはいけないこと」）。

本機能は、この禁止を **オーナー（YUSUKE）の明示指示により、DM送付に限って解除する** ものである。実装前に必ず理解しておくこと:

- 解除するのは **DM（ダイレクトメッセージ）の送付のみ**。**フォロー・いいね・投稿・UA偽装は引き続き絶対にしない**。
- 送付対象は **候補ボードで人が明示的にチェックした候補だけ**。全件自動送信・巡回送信はしない。
- したがって manifest の description と各ドキュメントの「DMは一切しない」の記述は、本機能の実装と同時に **「チェックした候補にのみDMを送る。それ以外の書き込み操作（フォロー/いいね/投稿）はしない」** に改訂する（§8 に改訂箇所一覧）。

### 0-1. 技術リスク（実装者が必ず認識すること）

DM送付は **読み取り（収集・精査）とは危険度が根本的に異なる書き込み操作**であり、Instagram の自動化検知・スパム判定の直接対象になる。以下は「動けばよい」で済ませてよい箇所ではない。

- **アカウント凍結・BAN リスク。** 短時間の連続DM、同一文面の一斉送信、未フォロー相手への大量DMは、Instagram のスパムフィルタに最も引っかかりやすいパターン。凍結されるのは収集にも使っている本人のIGアカウント。
- **レート制限。** 送信は取得より厳しく制限される。本書 §6 のレート制御は「推奨」ではなく **必須要件**。
- **不可逆性。** 送ったDMは取り消せない。ドライラン（§6-4）と重複送信防止（§6-3）を実装しないまま本送信を走らせない。

このリスクを踏まえ、本書は既定を **半自動（human-in-the-loop）モード** とし、全自動モードはガードレール群を満たしたうえでオーナーが明示的に選んだときだけ有効化する設計にする（§5-1）。

---

## 1. 目的と全体像

**目的:** 候補ボードでチェックした候補に対し、候補ごとに最適化されたステムボーテ・アンバサダーの案内文を生成し、Instagram DM で一括送付する。オペレーターの手作業（1人ずつプロフィールを開いてDM画面を出し、文面を組み立てて貼る）を消す。

**構成は3コンポーネント。既存の「収集／発掘／精査」と同じ二層（ダッシュボード＝判断・生成、拡張＝IGアクセス）を踏襲する。**

```
┌─ ダッシュボード（GitHub Pages SPA・オフライン・IndexedDB） ──────────────┐
│  ① 候補ボードでチェック（board.js に選択列を追加）                        │
│  ② 候補ごとに案内文を生成（dmCompose.js＝純関数）                          │
│  ③ プレビュー／編集（送る前に人が全文を確認・修正できる）                  │
│  ④ 送付キューを localStorage `castnext_cdp_dm` に書き出す（cdpDm.js）      │
└───────────────────────────────────────────────┘
                         │ localStorage 橋渡し（既存 castnext_cdp_qual と同型）
                         ▼
┌─ 拡張（MV3・instagram.com のログインセッションで動く） ──────────────────┐
│  ⑤ popup「④DM送付」タブがキューを読む                                     │
│  ⑥ content_ig.js の IGF_DM が1件ずつ送付（レート制御・キルスイッチ）        │
│  ⑦ 送付結果を background 経由でダッシュボードへ反映（status→DM送付）        │
└───────────────────────────────────────────────┘
```

**LLM は運用経路に一切登場しない。** 案内文はダッシュボード側の決定的テンプレート（候補の属性で変数を埋める）で生成する。オフラインで完結し、外部送信もしない。「最適化」＝ティア・枠・精査で読んだ役割/魅力・適合コメントを差し込むこと（§4）であって、実行時のLLM生成ではない。

---

## 2. UI 設計（ダッシュボード）

### 2-1. 候補ボードに選択列を追加（`js/views/board.js`）

- `COLUMNS` の先頭に選択列を1つ足す（ヘッダーは全選択チェックボックス、各行はチェックボックス）。ソート対象にはしない（`data-sortkey` を付けない）。
- 選択状態は **セッション内のメモリのみ**（`Set<username>`。localStorage にも IndexedDB にも永続しない。ソート状態 `sortState` と同じ扱い）。
- 行クリックで詳細が開く既存挙動と競合させない。チェックボックスの `click` は `e.stopPropagation()` する（既存の md ボタンと同じ作法）。
- ヘッダーのDMボタン群（既存の「DMリストCSVを書き出す」の隣）に **「選択N件にDMを送る」** ボタンを追加。押すと §2-2 のパネルを開く。
- **送付ガード（UIレベル）:** 適合コメント未記入（`fitMissing(c)`）／`status === "見送り"`／既に `dmSentAt` あり の候補は、チェックしても送付対象から外し、パネルに「除外理由」として明示する（黙って落とさない。§6-3）。

### 2-2. 一括DMパネル（新規 `js/views/dmpanel.js`・overlay）

`detail.js` の overlay 実装（`#ovDetail`）と同じ作法で `#ovDm` を作る。中身:

1. **対象一覧** — チェックした候補を、生成された案内文の全文プレビュー付きで縦に並べる。各候補に:
   - ハンドル・ティア・枠・得点、機械が付けた「差し込んだ最適化根拠」（例: 「マイクロ／当選体験アングル／魅力=ずぼら主婦の等身大」）
   - **編集可能な textarea**（生成文が初期値。人がその場で直せる）
   - 「この候補を送付から外す」チェック
2. **除外された候補** — §2-1 のガードで外れた候補を理由付きで表示。
3. **送付モード選択**（§5-1）: 既定＝半自動。全自動はガード全通過時のみ選べる。
4. **フッター:** 「ドライラン（送らずに検証）」ボタンと「送付キューを書き出す」ボタン。後者で `castnext_cdp_dm` に書き、拡張で受け取れる状態にする（§5）。

---

## 3. データモデル

候補（`cand`）に送付管理フィールドを追加する。既存の `dmSentAt` / `remindAt` / `status` を再利用し、送付の事実は既存の `setStatus`/`dmDue` の仕組み（§7）に載せる。追加は最小限:

```js
// cand に追加（schema.js の migrate でデフォルトを補う）
c.dm = c.dm || {
  lastText: "",        // 最後に送付/生成した本文（監査・再送防止の参照用）
  sentAt: "",          // ISO。送付成功時刻。既存 dmSentAt(YYYY-MM-DD) と別に厳密時刻を残す
  threadId: "",        // 送付先スレッド（あれば）
  result: "",          // "ok" | "skipped" | "failed:<reason>"
  mode: "",            // "semi" | "auto"
};
```

送付キュー（localStorage `castnext_cdp_dm`）のペイロード:

```js
{
  items: [ { handle, userId, text, tier, slot } ],  // userId は取得済みなら同梱（無ければ拡張が解決）
  mode: "semi" | "auto",
  perMinMax: 1,          // §6-1 レート上限（1分あたり最大送付数）
  minWaitMs, maxWaitMs,  // §6-1 送信間の待機（既定 45,000〜90,000）
  dailyCap: 30,          // §6-2 その日の送付上限（拡張側でも二重チェック）
  dryRun: false,
  at: "<ISO>",
}
```

---

## 4. 案内文の最適化ロジック（`js/pipeline/dmCompose.js`・純関数・node --test 対象）

`buildDm(cand, brand, opts) → { text, basis[] }` を実装する。**DOM を触らない。** `basis` は「なぜこの文面になったか」の根拠配列（UI表示・監査用）。

### 4-1. 素材（ブランド概要 pptx より・不変の事実）

案内文に使ってよいブランド事実（`presets/stembeaute_v26.json` か dmCompose 内の定数として持つ。数値は pptx 記載の実値）:

- 完全紹介制／一般販売なし／紹介と抽選のみ
- 毎週の抽選、購入枠 30〜50名、当選倍率 5〜7倍、会員の100%が紹介・抽選経由
- 「行列がブランドをつくる」「行列は、最初の30人から始まる。」
- アンバサダーに用意するもの: **ギフティング（本品プレゼント）／特別紹介コード（1人あたり10〜50名分）／固定報酬（お支払いあり・属性と内容で個別提示）**
- 依頼内容: 「効果ではなく体験（届いた瞬間・開梱・デジタル会員証・同梱カード）」／#PR 表記必須／原稿は事前に薬機法チェック

### 4-2. ティア別のアングル（差し込む骨子を切り替える）

`score.tier`（sbis.js が付与）で分岐:

| ティア | 相当フォロワー | アングル | 枠の既定 | 継続の言及 |
|---|---|---|---|---|
| micro（マイクロ） | 〜3万 | 「応募した・落ちた・当たった・届いた」を **日常の文脈で** 語れる方として。広告らしくない熱量を評価している旨 | 都度枠 | 都度 |
| middle（ミドル） | 3〜10万 | **体験レビューの軸** になる方として。丁寧で保存されやすい投稿を評価。月2回程度の継続契約が理想／インサイト提出のお願い | 連載枠 | 月2回・継続 |
| mega（第0候補） | 10万〜 | **初期は起用しない帯**。原則 DM 対象にしない（§6-3 でガード）。誤ってチェックされたら除外し理由表示 | — | — |

### 4-3. 候補ごとの個別化（精査データがあれば差し込む）

精査済み（`c.qualReport`）の候補は、人が書いた読みを一文入れて「あなたを見て連絡している」を成立させる。無ければ機械の選定理由でフォールバック:

- `c.qualReport.human.charm`（魅力）→「〜な発信を拝見しました」の一文に使う。
- `c.qualReport.human.role`（戦略での役割）→ 起用意図の一文に使う。
- `c.slot`（連載枠/都度枠）→ 枠の案内に反映（ティア既定より優先）。
- 精査未実施なら `c.selectReason`（機械の選定理由）→「生活文脈での発信」等の一般文に丸める。
- **個別化に使えるのは vault/精査に実在する読みだけ。** 無い情報を作文しない（推測で褒めない）。素材が無ければティア別テンプレのままにする。

### 4-4. ガードレール（文面に必ず効かせる）

- **薬機法:** DM本文に効能効果の断定を入れない（「シワが消える」「再生」「若返る」等は §conf の `ngWords` を流用して生成後スキャンし、含んだら生成失敗として弾く）。案内は「完全紹介制／抽選／体験を投稿してほしい」の枠に留め、成分効果を語らない。
- **景表法・限定の建付け:** 「週30〜50名限定」の根拠（案B: サポート人数）が法務未確定である点は §stembeaute のクリティカルパス。**文面に「限定」の断定を書かず**、「毎週の抽選枠」という事実記述に留める。断定表現はテンプレから除外する。
- **ステマ規制:** DM段階では #PR 義務は発生しないが、**「投稿時は #PR 表記と事前の原稿チェックをお願いする」旨を案内文に明記**しておく（後出しにしない）。
- **紹介者（pitchman）判定済み**（`t1Auto(...).pitchman`）や **NG常習**（`c.scan.habitual`）の候補は §6-3 で送付ガード。文面生成の前に弾く。

### 4-5. 文面テンプレート（既定・敬体・営業色を抑える）

`basis` に使った分岐を全て記録する。以下は骨子（実装時に一文ずつ定数化。`{{}}` は候補変数）:

```
{{full_name or @handle}} 様

はじめてご連絡します。スキンケアブランド「ステムボーテ」のアンバサダーを
お願いできる方を探しており、{{angle_line}} ご連絡しました。

ステムボーテは一般販売をしていない完全紹介制のブランドで、毎週の抽選に
当たった方だけが購入できます（購入枠 週30〜50名／当選倍率 5〜7倍）。
「効果」ではなく、応募した・当たった・届いたという{{experience_word}}を
投稿していただく起用です。

ご用意しているのは、本品のギフティング／フォロワーの方を抽選なしでご招待
いただける特別紹介コード／固定報酬の3点です{{slot_line}}。

投稿は #PR 表記をお願いし、公開前に弊社で薬機法チェックを行います
（差し戻しの手間を減らすためのものです）。

ご興味をお持ちいただけましたら、この投稿への返信でお知らせください。
```

- `{{angle_line}}` … ティア＋精査の読みから（例: micro「普段の暮らしの中でコスメを等身大に紹介されている発信を拝見し、」／middle「丁寧で保存されやすいレビューを拝見し、」）
- `{{experience_word}}` … micro「体験」／middle「体験レビュー」
- `{{slot_line}}` … middle かつ連載枠「（ミドル層の方には月2回程度の継続契約と、フォロワー属性インサイトのご提出をお願いしています）」／micro は空

**文面は初期値であって最終ではない。** §2-2 のプレビューで人が直せることを前提に、無難で短い既定を置く。

---

## 5. 拡張のDM送付モード

### 5-1. 送付モード（既定＝半自動）

| モード | 挙動 | ban リスク | いつ使う |
|---|---|---|---|
| **半自動（semi・既定）** | 拡張が候補ごとに **DMスレッドを開き、本文を入力欄に流し込むところまで**を自動化。**送信ボタンの押下は人が1クリック**。1件送るごとに次へ進む | 低（実際の送信は人の操作） | 既定。少数・重要候補 |
| **全自動（auto）** | 送信まで拡張が行う。§6 のレート制御・日次上限・キルスイッチ・ドライラン合格が **全て前提** | 高 | ガード全通過をオーナーが確認し明示選択したときのみ |

- パネル（§2-2）で auto を選べるのは、対象が dailyCap 以内・全員 §6-3 ガード通過・直近ドライラン成功、の全条件を満たすときだけ。satisfない場合は auto を disabled にし理由を出す。
- どちらも **instagram.com のタブ内で走り、そのタブを閉じる・遷移すると停止**（既存の収集と同じ制約）。

### 5-2. content_ig.js に `IGF_DM` を追加

既存の `IGF_COLLECT/IGF_DISCOVER/IGF_QUAL` と同じ `chrome.runtime.onMessage` 分岐に `IGF_DM` を足す。`runDm(payload, onProgress)` の骨子:

```
runDm(payload):
  v = ensureViewer()  // 既存。未ログインなら中止
  csrf = document.cookie の csrftoken を読む
  sent = 0
  for i, it in payload.items:
    if sent >= payload.dailyCap: stop("daily_cap"); break
    if window.__CASTNEXT_DM_ABORT: stop("aborted"); break   // §6-5 キルスイッチ
    if i>0: sleep( jitter(minWaitMs, maxWaitMs) )           // §6-1
    userId = it.userId || await resolveUserId(it.handle)    // web_profile_info の pk（既存 IGF を流用）
    if payload.dryRun:
      record ok（送らない）; onProgress(dry)
      continue
    if payload.mode == "semi":
      // スレッドを開き本文を流し込む。送信はしない。人の1クリックを待つ設計にするか、
      // もしくは「開いて下書きを入れた」時点で ok 扱いにし、人がタブで送る運用でもよい（実装時に選択）
      openThreadWithDraft(userId, it.text)
      record "draft"; onProgress
      continue
    // === auto: 実送信 ===
    res = await sendDirect(userId, it.text, csrf)   // §5-3
    if res.spam_or_challenge:  stop("challenge"); break   // スパム判定/チェックポイントを踏んだら全停止
    if res.ok: sent++; record ok(threadId)
    else: record failed(res.reason)
    onProgress({phase:"dm", i, n, handle, ok:res.ok})
  return { ok:true, results, stats }
```

### 5-3. 送信API（実装時に現行仕様を実機で確認する。ハードコードしない）

- 送信先の user_id は **収集済みデータに含まれていればそれを使う**。無ければ `IGF` 経由で web_profile_info を1回引いて pk を取る（新規のIGアクセスを最小化）。
- 送信は Instagram web の direct broadcast エンドポイント（例: `POST /api/v1/direct_v2/threads/broadcast/text/`、body に `recipient_users=[[user_id]]`・`text`・`client_context`(uuid)・`mutation_token`、header に `X-CSRFToken`(cookie csrftoken)・`X-IG-App-ID`）。**エンドポイント名・必須フィールドは変わりうるので、収集の `ig_probe.js` と同じ方針で「現行の実応答を1件で確認してから」実装する。引き継ぎ書のスニペットを鵜呑みにしない。**
- レスポンスに status=ok 以外、または `challenge`/`checkpoint`/`spam`/`feedback_required` を検出したら **その場で全ループ停止**（1件でも踏んだら以降は送らない）。
- **UA偽装・モバイル専用エンドポイントの回避はしない**（既存の禁止事項を継承）。

### 5-4. popup「④DM送付」タブ

`popup.js` の既存タブ（②プール／①発掘／③精査）に④を追加。`runQual` と同じ作法で:

- 「ダッシュボードから送付キューを取り込む」= `readDashboard('castnext_cdp_dm')`。
- 対象件数・モード・レート設定・ドライランか を表示してから「送付を開始」。
- 進捗は `IGF_PROGRESS`（phase:"dm"）でバー表示。**「停止」ボタン**（§6-5）を常設。
- 完了時は結果を `IGF_DM_DONE` で background に渡し、ダッシュボードへ status 反映（§7）。

### 5-5. background.js

- `IGF_PROGRESS`(phase:"dm") でツールバーバッジに送付中件数。
- `IGF_DM_DONE` を受けたら:
  - 送付ログ（handle・result・時刻）を `chrome.downloads` で `casting-next/dm/<日付>_dm_log.jsonl` に保存（監査証跡・§6-6）。
  - ダッシュボードのタブがあれば `castnext_dm_result`（成功handleと時刻）を localStorage 経由で書き、ダッシュボードが status を "DM送付"・`dmSentAt` を更新（§7）。ダッシュボード無改変で載せられるよう、既存の autoImport と同型の inject を使う。

---

## 6. 安全設計（本機能の中核・実装必須）

### 6-1. レート制御（送信間隔）
- 送信間の待機は既定 **45,000〜90,000ms のランダム**（収集の 4〜12秒より大幅に長く）。`perMinMax=1`（1分あたり最大1通）を上限とし、パネルからの短縮は不可（下げる方向のみ許可）。

### 6-2. 日次上限（dailyCap）
- 既定 **1日30通**。拡張側でも「本日 `casting-next/dm/` に記録済みの送付数」を数えて二重にガードし、超えたら停止。ダッシュボードのカウントを信用しきらない。

### 6-3. 重複・不適格ガード（送らない相手を送らない）
以下は **チェックされていても送付対象から除外**し、パネルに理由を明示（黙って落とさない）:
- 既に `dmSentAt`（または `c.dm.sentAt`）あり → 二重送信防止。
- `fitMissing(c)`（適合コメント未記入）→ 既存 §4-5 の「DM送付に進めない」を踏襲。
- `status === "見送り"` ／ 紹介者（pitchman）／ NG常習（`c.scan.habitual`）。
- `score.tier === "mega"`（第0候補・初期起用しない帯）。

### 6-4. ドライラン
- `dryRun:true` で「user_id 解決・文面確定・レート待機まで行い、送信APIだけ呼ばない」。auto を初めて使う前に必ず1回通す。ドライランのログも §6-6 に残す。

### 6-5. キルスイッチ
- popup の「停止」ボタンが content_ig の `window.__CASTNEXT_DM_ABORT=true` を立て、ループ先頭で検査して即停止。送信中の1件は完了まで、以降は送らない。

### 6-6. 監査ログ（送った事実を必ず残す）
- 全送付（ドライラン含む）を `casting-next/dm/<日付>_dm_log.jsonl` に1行1件で保存: `{at, handle, userId, mode, dryRun, result, textHash}`。本文は長いので `textHash`（先頭120字＋長さでよい）。**隔離・除外系の操作はリストを残す**という既存ルールの送付版。

---

## 7. ステータス連動（既存の仕組みに載せる・新設しない）

- 送付成功（auto の ok、または semi で人が送ったと確定した分）→ ダッシュボードで `setStatus(c, "DM送付", today)` を呼ぶ。これで `dmSentAt=today` が入り、既存の `dmDue()`（5営業日でリマインド期限・催促後5営業日で追跡終了）がそのまま効く。
- `setStatus` は適合コメント未記入だと "DM送付" を弾く既存ガードを持つ。§6-3 で事前に除外しているので二重に安全。
- semi モードで「下書きを入れただけ／人が送ったか不明」の場合は status を自動で進めず、`c.dm.result="draft"` に留める。人がボードで確定する。

---

## 8. 実装ファイル一覧（新規・変更）

**新規:**
- `js/pipeline/dmCompose.js` — `buildDm(cand, brand, opts)`（純関数）。§4。
- `js/pipeline/cdpDm.js` — `buildCdpDm(cands, opts)` / `exportCdpDm(...)`（localStorage `castnext_cdp_dm` へ）。`cdpQual.js` と同型。
- `js/views/dmpanel.js` — 一括DMパネル overlay。§2-2。
- `tests/dmcompose.test.js` — §9。

**変更:**
- `js/views/board.js` — 選択列・「選択N件にDMを送る」ボタン・除外ガード。§2-1。
- `js/pipeline/schema.js` — `migrate` に `c.dm` デフォルト補完。
- `js/pipeline/conf.js` — DM既定値（`DM_MIN_WAIT=45000` `DM_MAX_WAIT=90000` `DM_PER_MIN_MAX=1` `DM_DAILY_CAP=30` と、案内文で使うブランド事実定数）。**この4つ＋文面骨子がDMの数値・文言の正本。散らさない。**
- `extension/content_ig.js` — `IGF_DM`／`runDm`／`resolveUserId`／`sendDirect`／`openThreadWithDraft`。§5-2, 5-3。
- `extension/popup.js` / `extension/popup.html` — ④DM送付タブ・停止ボタン。§5-4。
- `extension/background.js` — phase:"dm" バッジ・`IGF_DM_DONE`・監査ログDL・status反映 inject。§5-5。
- `extension/manifest.json` — description を §0 の改訂文に。permissions は現状（scripting/downloads/tabs/storage）で足りる想定（host_permissions も現状のまま）。
- ドキュメント改訂: `casting-control-room`（vault）／リポジトリ README／`docs/設計書_…NEXT_v1.0.md` の「DMは一切しない」記述を「チェックした候補にのみDMを送る。フォロー/いいね/投稿はしない」に。

---

## 9. 検証条件（スクリプトで検証・目視で終わらせない）

各項目が通るまで完了と言わない。

1. **dmCompose 純関数テスト（`node --test`）:**
   - micro/middle/mega の3ティアで `basis` の分岐が正しい。mega は生成せず「対象外」を返す。
   - 精査あり候補で `charm`/`role` が本文に差し込まれる。無い候補では作文されない（テンプレのまま）。
   - 生成文に `ngWords`（再生・シワが消える 等）が **絶対に含まれない**（含む入力を与えても弾く）。
   - 「限定」の断定・効能断定が出ない。#PR と事前チェックの案内が必ず入る。
2. **ガードテスト:** dmSentAt済み・fitMissing・見送り・pitchman・NG常習・mega が送付対象から除外され、理由が付く。
3. **cdpDm ラウンドトリップ:** `buildCdpDm` の出力が popup の読取形と一致。dailyCap 超過分が deferred として残る（黙って切らない）。
4. **拡張ドライラン E2E（`tools/` に stub で）:** IGF_DM を dryRun で流し、送信APIが1度も呼ばれず、レート待機とログ生成が起きることを確認。既存の e2e_smoke と同じ枠組み。
5. **実機は最小で1件・半自動から。** auto の初回は必ずドライラン→1件→少数、の順。いきなり dailyCap まで流さない。

---

## 10. やってはいけないこと（DM送付版）

- **フォロー・いいね・投稿・UA偽装は引き続き一切しない**（解除したのはDMだけ）。
- **チェックされていない候補に送らない。** 巡回・全件・自動継続送信をしない。
- レート制御・日次上限・キルスイッチ・重複ガード・監査ログの **どれか1つでも未実装のまま auto を有効化しない**。
- スパム判定/チェックポイント（challenge/feedback_required 等）を1件でも踏んだら **その回は全停止**。踏んだ事実を握りつぶさない。
- 送信APIのエンドポイント・フィールドを引き継ぎスニペットのまま信用しない。**実応答を1件で確認してから**実装する（収集の血の教訓の継承）。
- 文面に効能効果の断定・「限定」の断定を入れない（薬機法・景表法・法務未確定のクリティカルパス）。
- 監査ログに本文全文や個人情報を過剰に残さない（textHash と handle に留める。公開リポジトリにコミットしない＝ `casting-next/dm/` は `.gitignore`）。

---

## 11. 参考（実装者向け・既存パターンの所在）

- localStorage 橋渡しの手本: `js/pipeline/cdpQual.js`（`exportCdpQual`）＋ `extension/popup.js` の `readDashboard`/`readQualCfg`。
- 拡張の送付ループの手本: `extension/content_ig.js` の `runQual`（レート待機 `jitter`・`ensureViewer`・rate_limited 即停止・onProgress）。
- ダッシュボード無改変での反映: `extension/background.js` の `injectResult`/`autoImportQual`。
- 候補ボードの列追加・チェックの stopPropagation: `js/views/board.js` の `COLUMNS` と md ボタンの `e.stopPropagation()`。
- ステータス・DM期限: `js/pipeline/sbis.js` の `setStatus`/`dmDue`/`fitMissing`。
