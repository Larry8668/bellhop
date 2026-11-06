#!/usr/bin/env bash
# Delegate one task to a role prompt on a chosen model via the Cursor CLI (headless).
#
# Usage: scripts/delegate.sh <role> <model> "<brief>" [--readonly]
#   role   : a file in .cursor/agents/<role>.md (frontmatter stripped, body used as role prompt)
#   model  : any id from `agent models` (e.g. composer-2.5, grok-4.7-medium, claude-opus-5-5-medium)
#   brief  : the task, self-contained (plan sections to read, files in scope, acceptance criteria)
#
# Output goes to stdout and is saved under .delegate/<timestamp>-<role>.md (gitignored).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROLE="${1:?role required}"
MODEL="${2:?model required}"
BRIEF="${3:?brief required}"
READONLY="${4:-}"

ROLE_FILE="$ROOT/.cursor/agents/$ROLE.md"
[ -f "$ROLE_FILE" ] || { echo "delegate: unknown role '$ROLE' (no $ROLE_FILE)" >&2; exit 2; }

# Body = everything after the closing '---' of the YAML frontmatter.
ROLE_PROMPT="$(awk 'f{print} /^---$/{c++; if(c==2) f=1}' "$ROLE_FILE")"

GUARD=""
if [ "$READONLY" = "--readonly" ]; then
  GUARD=$'\n\nHARD CONSTRAINT: read-only. Do not create, edit, or delete any file. Do not run commands that change state.'
fi

PROMPT="$(cat <<EOF
Repository: $ROOT
You are acting as the '$ROLE' role. Follow AGENTS.md and .cursor/rules/*.mdc.

$ROLE_PROMPT$GUARD

# Task

$BRIEF
EOF
)"

mkdir -p "$ROOT/.delegate"
OUT="$ROOT/.delegate/$(date +%Y%m%d-%H%M%S)-$ROLE.md"
START=$(date +%s)

echo "delegate: role=$ROLE model=$MODEL → $OUT" >&2
agent -p --trust --model "$MODEL" --output-format text --workspace "$ROOT" "$PROMPT" | tee "$OUT"

echo "delegate: $ROLE finished in $(( $(date +%s) - START ))s" >&2
