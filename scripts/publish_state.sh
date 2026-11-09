#!/usr/bin/env bash
# Commit today's learning artefacts and push them to the session branch and to
# claude/scalper-live, where tomorrow's run will pick them up.
# Usage: scripts/publish_state.sh "commit message"
set -euo pipefail
LIVE="${SCALPER_LIVE_BRANCH:-claude/scalper-live}"
MSG="${1:-scalper: daily update}"
cd "$(git rev-parse --show-toplevel)"

for p in state data journal research scalper tests scripts CLAUDE.md README.md config.json; do
  [ -e "$p" ] && git add -A -- "$p"
done
if git diff --cached --quiet; then
  echo "[publish] nothing to commit"
else
  git commit -q -m "$MSG"
fi
branch=$(git rev-parse --abbrev-ref HEAD)
push() { # retry transient network failures: 2s, 4s, 8s, 16s
  local d=2
  for _ in 1 2 3 4 5; do
    git push "$@" && return 0
    sleep $d; d=$((d * 2))
  done
  return 1
}
if [ "$branch" != "$LIVE" ]; then
  push -u origin "$branch"
fi
if ! push origin "HEAD:refs/heads/$LIVE"; then
  # Someone else advanced the live branch: merge and retry once.
  scripts/sync_state.sh && push origin "HEAD:refs/heads/$LIVE"
fi
echo "[publish] pushed $(git rev-parse --short HEAD) to $branch and $LIVE"
