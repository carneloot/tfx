#!/usr/bin/env bash
set -euo pipefail

git_dir=$(git rev-parse --git-dir)
original_repo=$(cd "$git_dir/../../.." && pwd)
worktree_root=$(git rev-parse --show-toplevel)

# Create symlink to shared directory
ln -s "$original_repo/.osgrep" "$worktree_root/.osgrep"

mise trust
mise up

osgrep index

bun install

rulesync generate --targets "opencode" --features "*"

opensrc effect @effect-ak/tg-bot-api @effect-ak/tg-bot-client --modify=false
