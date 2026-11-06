#!/usr/bin/env bash
# Delegate one task to a role prompt on a chosen model via the Cursor CLI (headless).
#
# Usage: scripts/delegate.sh <role> <model> "<brief>" [--readonly]
#   role       : a file in .cursor/agents/<role>.md (frontmatter stripped, body used as role prompt)
#   model      : any id from `agent models` (e.g. composer-2.5, grok-4.7-medium, claude-opus-5-5-medium)
#   brief      : the task, self-contained (plan sections to read, files in scope, acceptance criteria)
#   --readonly : run in `--mode ask` (CLI-enforced read-only). Implied when the role's frontmatter
#                has a `readonly` key that is not `false`. Otherwise runs with `--force`.
#
# Guards for non-readonly runs (deny patterns in .cursor/cli.json are prefix-based and bypassable):
#   - git/gh credentials are removed from the delegate's environment, so any push fails to authenticate
#   - after the run, .husky/, .cursor/ and core.hooksPath are checked; changes fail the run loudly
# Output goes to stdout and .delegate/<timestamp>-<pid>-<role>.md (gitignored, mode 0600).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROLE="${1:?role required}"
MODEL="${2:?model required}"
BRIEF="${3:?brief required}"
shift 3

# Flags: --readonly | --worktree=<name>  (isolated worktree + branch off the current branch; for parallel delegates)
FLAG=""
WORKTREE=""
for ARG in "$@"; do
  case "$ARG" in
    --readonly) FLAG="--readonly" ;;
    --worktree=*) WORKTREE="${ARG#--worktree=}"
                  [[ "$WORKTREE" =~ ^[a-z0-9][a-z0-9._/-]*$ ]] || { echo "delegate: invalid worktree name '$WORKTREE'" >&2; exit 2; } ;;
    *) echo "delegate: unknown flag '$ARG' (accepted: --readonly, --worktree=<name>)" >&2; exit 2 ;;
  esac
done

[[ "$ROLE" =~ ^[a-z][a-z0-9-]*$ ]] || { echo "delegate: invalid role name '$ROLE'" >&2; exit 2; }
ROLE_FILE="$ROOT/.cursor/agents/$ROLE.md"
[ -f "$ROLE_FILE" ] || { echo "delegate: unknown role '$ROLE' (no $ROLE_FILE)" >&2; exit 2; }

# Frontmatter is between the first two '---' lines; body is everything after.
ROLE_PROMPT="$(awk 'f{print} /^---$/{c++; if(c==2) f=1}' "$ROLE_FILE")"
ROLE_READONLY="$(awk -F': *' '/^---$/{c++; next} c==1 && $1=="readonly"{gsub(/[ \t\r]+$/, "", $2); print $2; exit}' "$ROLE_FILE")"

# Fail closed: readonly unless the key is absent or explicitly false.
READONLY=0
if [ "$FLAG" = "--readonly" ] || { [ -n "$ROLE_READONLY" ] && [ "$ROLE_READONLY" != "false" ]; }; then
  READONLY=1
fi

WT_ARGS=()
WT_NOTE=""
if [ -n "$WORKTREE" ]; then
  BASE_BRANCH="$(git -C "$ROOT" branch --show-current)"
  WT_ARGS=(-w "$WORKTREE" --worktree-base "$BASE_BRANCH")
  WT_NOTE=$'\n'"You are running in an isolated git worktree on a new branch based on '$BASE_BRANCH'. Work ONLY inside that worktree (your current working directory), never in $ROOT. Run \`npm install\` there first (node_modules are not shared). Do not commit; the parent commits."
fi

PROMPT="$(cat <<EOF
Repository: $ROOT$WT_NOTE
You are acting as the '$ROLE' role. Follow AGENTS.md and .cursor/rules/*.mdc.

$ROLE_PROMPT

# Task

$BRIEF
EOF
)"

umask 077
mkdir -p "$ROOT/.delegate"
OUT="$ROOT/.delegate/$(date +%Y%m%d-%H%M%S)-$$-$ROLE.md"
START=$(date +%s)

guard_snapshot() { git -C "$ROOT" diff --quiet -- .husky .cursor && git -C "$ROOT" config --get core.hooksPath; }

if [ "$READONLY" -eq 1 ]; then
  MODE_ARGS=(--mode ask)
  ENV_ARGS=()
else
  MODE_ARGS=(--force)
  # No push/gh credentials for writers. Empty credential.helper resets git's helper list.
  ENV_ARGS=(env GIT_ASKPASS=/bin/false GIT_TERMINAL_PROMPT=0
            GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=
            GH_TOKEN= GITHUB_TOKEN= GH_CONFIG_DIR=/nonexistent)
  HOOKS_BEFORE="$(guard_snapshot || true)"
fi

echo "delegate: role=$ROLE model=$MODEL mode=${MODE_ARGS[*]}${WORKTREE:+ worktree=$WORKTREE} → $OUT" >&2
set +e
"${ENV_ARGS[@]+"${ENV_ARGS[@]}"}" agent -p --trust "${MODE_ARGS[@]}" "${WT_ARGS[@]+"${WT_ARGS[@]}"}" --model "$MODEL" --output-format text --workspace "$ROOT" "$PROMPT" | tee "$OUT"
PIPE=("${PIPESTATUS[@]}")
set -e
STATUS=${PIPE[0]}
[ "${PIPE[1]}" -eq 0 ] || { echo "delegate: failed to write $OUT" >&2; STATUS=1; }

if [ "$READONLY" -eq 0 ]; then
  HOOKS_AFTER="$(guard_snapshot || true)"
  if ! git -C "$ROOT" diff --quiet -- .husky .cursor || [ "$HOOKS_BEFORE" != "$HOOKS_AFTER" ]; then
    echo "delegate: GUARD FILES CHANGED (.husky/, .cursor/ or core.hooksPath) — inspect before trusting this run" >&2
    STATUS=3
  fi
fi

if [ -n "$WORKTREE" ]; then
  echo "delegate: worktrees now:" >&2
  git -C "$ROOT" worktree list >&2
fi
echo "delegate: $ROLE exit=$STATUS in $(( $(date +%s) - START ))s" >&2
exit "$STATUS"
