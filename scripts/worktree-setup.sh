#!/usr/bin/env bash
set -euo pipefail

mise trust
mise up

bun install

rulesync generate --targets "opencode" --features "*"

opensrc effect @effect-ak/tg-bot-api @effect-ak/tg-bot-client --modify=false
