#!/usr/bin/env bash
# GitHub に public リポジトリを作って push し、Pages(Deploy from branch / main / root)を有効化する。
#
#   1) 認証(初回だけ・ブラウザが開きます)
#        gh auth login
#   2) 公開
#        bash tools/publish_github.sh [リポジトリ名]
#
# 公開前に必ず漏れ検査を通す(実在ハンドル・表示名が1件でもあれば中止する)。
set -euo pipefail

REPO="${1:-casting-next}"
export PATH="/opt/homebrew/bin:$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
cd "$(dirname "$0")/.."

echo "== 1. 公開前チェック =="
node --test tests/*.test.js > /tmp/castnext_test.log 2>&1 || { echo "✖ テストが落ちています。/tmp/castnext_test.log を確認してください"; exit 1; }
echo "  テスト: $(grep -E '^# pass' /tmp/castnext_test.log || grep -c '^ok' /tmp/castnext_test.log) 件パス"
node tools/check_no_leak.mjs || { echo "✖ 実在アカウントの識別子が含まれています。公開を中止しました"; exit 1; }

echo "== 2. 認証確認 =="
gh auth status >/dev/null 2>&1 || { echo "✖ 未認証です。先に  gh auth login  を実行してください"; exit 1; }

echo "== 3. リポジトリ作成と push =="
if gh repo view "$REPO" >/dev/null 2>&1; then
  echo "  既存のリポジトリを使います: $REPO"
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "$(gh repo view "$REPO" --json sshUrl -q .sshUrl)"
  git push -u origin main
else
  gh repo create "$REPO" --public --source=. --remote=origin --push \
    --description "インフルエンサー発掘・精査の管制室(静的SPA・データはブラウザ内のみ)"
fi

echo "== 4. GitHub Pages を有効化 =="
OWNER="$(gh api user -q .login)"
gh api -X POST "repos/$OWNER/$REPO/pages" -f "source[branch]=main" -f "source[path]=/" >/dev/null 2>&1 \
  || gh api -X PUT "repos/$OWNER/$REPO/pages" -f "source[branch]=main" -f "source[path]=/" >/dev/null

echo
echo "公開URL: https://$OWNER.github.io/$REPO/"
echo "(初回は反映まで1〜2分かかります)"
