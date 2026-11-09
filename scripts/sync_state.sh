#!/usr/bin/env bash
# Bring the newest learning state (params, scoreboard, data cache, journal) into
# this checkout. Each routine run starts from a fresh clone of the default
# branch, so the state learned yesterday lives on the claude/scalper-live branch.
set -uo pipefail
LIVE="${SCALPER_LIVE_BRANCH:-claude/scalper-live}"
cd "$(git rev-parse --show-toplevel)"

if ! git fetch -q origin "$LIVE" 2>/dev/null; then
  echo "[sync] no $LIVE branch on origin yet: starting from this checkout's state"
  exit 0
fi
if git merge-base --is-ancestor "origin/$LIVE" HEAD; then
  echo "[sync] already contains origin/$LIVE"
  exit 0
fi
if git merge --no-edit -q "origin/$LIVE"; then
  echo "[sync] merged origin/$LIVE"
  exit 0
fi
# Conflicts: learning artefacts always come from the live branch; anything else is a real conflict.
conflicted=$(git diff --name-only --diff-filter=U)
others=$(echo "$conflicted" | grep -vE '^(state|data|journal|research/trials\.jsonl)' || true)
if [ -n "$others" ]; then
  git merge --abort
  echo "[sync] ERROR: code conflicts with $LIVE in: $others" >&2
  exit 1
fi
echo "$conflicted" | xargs -r git checkout --theirs --
echo "$conflicted" | xargs -r git add --
git commit -q --no-edit && echo "[sync] merged origin/$LIVE (learning artefacts taken from live)"
