# キャスティング管制室 NEXT — 実装ルール

インフルエンサー発掘・精査の管理画面を、GitHub Pages で配布できる静的SPAとして作るプロジェクト。
実装の正は `../設計書_キャスティング管制室NEXT_v1.0.md`(このリポジトリには置かない)。
見た目の正は `../モックアップ_概要画面.html`。移植元は `../reference/`。

## 絶対ルール

- **ロジックは発明せず移植する。** 判定式・閾値・評価順・丸め桁は reference/ の現行実装と1文字単位で一致させる。改善したい点が出たら実装せず「提案」として報告する(設計書§6-2 の7項目は特に厳守)
- **`reference/` と実在アカウントのデータは新リポジトリに一切コミットしない。** これは公開リポジトリになる。tests/fixtures に入れるデータは必ずハンドル置換+数値摂動で匿名化する(設計書§11-2)。.gitignore に `../reference` 相当の防護と、`*_run[0-9]*.csv` `*.jsonl` の除外を最初のコミットで入れる
- **ビルド工程・外部CDN・フレームワークを導入しない。** vanilla JS + ES Modules のみ(設計書§3)
- `js/pipeline/` は DOM 非依存の純関数のみ。`node --test` で回る形を維持する
- 各フェーズは完了条件(検証)が通るまで完了と言わない。検証は目視でなくスクリプトで行い、結果を報告に含める

## 判定ロジックで絶対に守ること(設計書§6-2・run#1〜6 の血で書かれたルール)

1. 営業導線は当事者性で相殺されない(run#6の権威型ケース)
2. 「予約」単体では導線にしない(run#6の生活者ケース)
3. PR判定は**全文で判定済みの真偽値(`prl`)を使う**。切り詰め後テキストから `#PR` を数え直さない
4. いいね非表示(`lv`)の投稿の likes は null。0で埋めない。ER不能なら SBIS-1s(/75)へ
5. タイアップ比率50%超で紹介者(ちょうど50%は該当しない)/ NG含有投稿2件以上で常習(同一投稿内の複数NG語は1件)
6. フィードの返却順は taken_at 順ではない。**taken_at 降順に整列してから直近12件を確定**(取得側=依頼文にも明記)
7. 判定不能は「不明」であり0ではない(純度未評価は減点しない、SBIS-3 は推測記入禁止)

## 環境

- Node は PATH に無い。`export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"` してから `node --test tests/`
- ローカル確認は `python3 -m http.server 8765` → `http://localhost:8765/`(file:// は ES Modules が CORS で落ちるため不可)

## ディレクトリ

```
index.html          シェル(サイドバー+ルータのみ)
css/                tokens.css = ブランドパレット / app.css
js/app.js router.js store.js
js/views/           画面ごとに1ファイル
js/pipeline/        DOM非依存の純関数(node --test の対象)
js/alerts.js        自動診断アラートの発火条件を1箇所に集約
js/charts.js        自前SVG(donut/hbar/sparkline)
kit/                収集キット(ig_probe.js / prof_compact.js / request_template.md)
presets/            stembeaute_v26.json = 現行値の正
tests/              node --test(回帰10件+ゴールデン+SBIS移植)
tools/              fixture 生成スクリプト(reference/ を読むだけ。出力は匿名化済)
```
