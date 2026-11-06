#!/usr/bin/env bash
# Delegate one task to a role prompt on a chosen model via the Cursor CLI (headless).
#
# Usage: scripts/delegate.sh <role> <model> "<brief>" [--readonly]
#   role       : a file in .cursor/agents/<role>.md (frontmatter stripped, body used as role prompt)
#   model      : any id from `agent models` (e.g. composer-2.5, grok-4.7-medium, claude-opus-5-5-medium)
#   brief      : the task, self-contained (plan sections to read, files in scope, acceptance criteria)
#   --readonly : run in `--mode ask` (CLI-enforced read-only). Implied when the role's frontmatter
#                has `readonly: true`. Otherwise runs with `--force` so commands execute.
#
# Delegates cannot push, commit, merge, use gh, or read docs/internal: see .cursor/cli.json (deny
# rules survive --force). Output goes to stdout and .delegate/<timestamp>-<pid>-<role>.md (gitignored).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROLE="${1:?role required}"
MODEL="${2:?model required}"
BRIEF="${3:?brief required}"
FLAG="${4:-}"

[[ "$ROLE" =~ ^[a-z][a-z0-9-]*$ ]] || { echo "delegate: invalid role name '$ROLE'" >&2; exit 2; }
ROLE_FILE="$ROOT/.cursor/agents/$ROLE.md"
[ -f "$ROLE_FILE" ] || { echo "delegate: unknown role '$ROLE' (no $ROLE_FILE)" >&2; exit 2; }

# Frontmatter is between the first two '---' lines; body is everything after.
ROLE_PROMPT="$(awk 'f{print} /^---$/{c++; if(c==2) f=1}' "$ROLE_FILE")"
ROLE_READONLY="$(awk -F': *' '/^---$/{c++; next} c==1 && $1=="readonly"{print $2; exit}' "$ROLE_FILE")"

MODE_ARGS=(--force)
if [ "$FLAG" = "--readonly" ] || [ "$ROLE_READONLY" = "true" ]; then
  MODE_ARGS=(--mode ask)
fi

PROMPT="$(cat <<EOF
Repository: $ROOT
You are acting as the '$ROLE' role. Follow AGENTS.md and .cursor/rules/*.mdc.

$ROLE_PROMPT

# Task

$BRIEF
EOF
)"

mkdir -p "$ROOT/.delegate"
OUT="$ROOT/.delegate/$(date +%Y%m%d-%H%M%S)-$$-$ROLE.md"
START=$(date +%s)

echo "delegate: role=$ROLE model=$MODEL mode=${MODE_ARGS[*]} → $OUT" >&2
set +e
agent -p --trust "${MODE_ARGS[@]}" --model "$MODEL" --output-format text --workspace "$ROOT" "$PROMPT" | tee "$OUT"
STATUS=${PIPESTATUS[0]}
set -e

echo "delegate: $ROLE exit=$STATUS in $(( $(date +%s) - START ))s" >&2
exit "$STATUS"
