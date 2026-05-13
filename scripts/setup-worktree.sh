#!/usr/bin/env bash
#
# Set up a fresh git worktree with the dev-env files from the main checkout.
# Run once after creating a worktree under .claude/worktrees/<name>/:
#
#   bash scripts/setup-worktree.sh
#
# Idempotent — safe to re-run. Skips files that are already correctly linked.
#
# What it does:
#   - Symlinks the gitignored env files (.env.local, .env.sentry-build-plugin)
#     from the main worktree into the current one. Anything `pnpm dev` needs
#     to boot the Next.js app belongs in this list.
#   - Does NOT run `pnpm install` — node_modules is checkout-local. Run that
#     yourself if the worktree is fresh.
#
# Why symlinks (not copies): main rotates secrets; symlinks pick that up for
# free. Symlinks are absolute paths — if you move the whole repo, re-run.

set -euo pipefail

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: not inside a git work tree" >&2
  exit 1
fi

THIS_DIR="$(git rev-parse --show-toplevel)"
# `git worktree list --porcelain` always lists the main worktree first.
MAIN_DIR="$(git worktree list --porcelain | awk '/^worktree / { print $2; exit }')"

if [ -z "$MAIN_DIR" ] || [ ! -d "$MAIN_DIR" ]; then
  echo "ERROR: could not resolve main worktree path" >&2
  exit 1
fi

if [ "$MAIN_DIR" = "$THIS_DIR" ]; then
  echo "You're in the main worktree — nothing to symlink."
  exit 0
fi

FILES=(
  ".env.local"
  ".env.sentry-build-plugin"
  "ops/.env.local"
)

linked=0
skipped=0
for f in "${FILES[@]}"; do
  src="$MAIN_DIR/$f"
  dst="$THIS_DIR/$f"

  if [ ! -e "$src" ]; then
    echo "skip  $f  (not present in main)"
    skipped=$((skipped + 1))
    continue
  fi

  if [ -L "$dst" ]; then
    current="$(readlink "$dst")"
    if [ "$current" = "$src" ]; then
      echo "ok    $f  →  $src"
      continue
    fi
    rm "$dst"
  elif [ -e "$dst" ]; then
    echo "ERROR: $dst exists and is not a symlink. Move it aside and re-run." >&2
    exit 1
  fi

  ln -s "$src" "$dst"
  echo "link  $f  →  $src"
  linked=$((linked + 1))
done

echo
echo "Done. Linked $linked file(s), skipped $skipped."
if [ ! -d "$THIS_DIR/node_modules" ]; then
  echo "node_modules missing — run: pnpm install"
fi
