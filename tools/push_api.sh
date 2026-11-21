#!/bin/sh
# 読み取り口（gas-api）を Apps Script に送る。刻印を読む処理は本体の gas/Kokuin.js を写して使う
set -e
cd "$(dirname "$0")/../gas-api"
cp ../gas/Kokuin.js Kokuin.js
clasp push -f
