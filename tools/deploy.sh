#!/bin/bash
# AIkokuin（gas/）と読み取り口（gas-api/）を Apps Script に送って、公開中のURLのまま新しい版にする。
# 失敗したら止まる（clasp のログイン切れなどを見逃さない）。使い方: tools/deploy.sh "版の説明"
set -euo pipefail
desc="${1:?版の説明を付けてください}"
root="$(cd "$(dirname "$0")/.." && pwd)"
deploy() {   # $1=フォルダ $2=公開中のデプロイID
  cd "$1"
  clasp push -f > /dev/null
  ver=$(clasp create-version "$desc" | grep -o 'version [0-9]*' | grep -o '[0-9]*')
  [ -n "$ver" ] || { echo "版を作れませんでした（$1）"; exit 1; }
  clasp update-deployment "$2" -V "$ver" -d "$desc" | grep -q "@$ver" || { echo "公開できませんでした（$1）"; exit 1; }
  echo "$(basename "$1"): 版 $ver を公開しました"
}
deploy "$root" AKfycbwRPkVmInQXbMiLNT6xY3c0nVcW6WSMQmX9lUD5ouk5T6grcrLYqup1Dp5dkLLYzCA1
cp "$root/gas/Kokuin.js" "$root/gas-api/Kokuin.js"
deploy "$root/gas-api" AKfycbwrbDN92ut9DSAou6TivDpNHEQslUTZicMtdg7UfCLBHHrUXe34D33xy4_t0PpyIgI
