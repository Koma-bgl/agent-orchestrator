#!/usr/bin/env bash
# Regenerate the skill's embedded deploy snapshot from the repo's deploy/ tree.
# Run from anywhere inside the repo after changing deploy/; commit the result so
# the skill folder stays shareable as a self-contained unit.
set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel)"
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$SKILL_DIR/assets/deploy"

rm -rf "$DEST"
mkdir -p "$DEST"
# --exclude .env: real secrets must never enter the skill. node_modules: the
# Docker build reinstalls deps; local ones are dev-only bulk.
rsync -a --exclude='.env' --exclude='node_modules' "$REPO_ROOT/deploy/" "$DEST/"

# Provenance stamp so an operator (and a future sync) can tell what they're running.
{
  echo "branch: $(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
  echo "commit: $(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  echo "synced: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$SKILL_DIR/assets/VERSION"

echo "synced deploy/ -> $DEST"
cat "$SKILL_DIR/assets/VERSION"
