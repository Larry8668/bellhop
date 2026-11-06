#!/usr/bin/env bash
# Run the adversarial review panel (quality, security, correctness) in parallel on the current branch.
#
# Usage: scripts/review-panel.sh "<task description>" [base-branch]
#   Each reviewer gets the diff range, the task description, and its role prompt.
#   Models are read from each reviewer's frontmatter; override with REVIEW_MODEL_<ROLE>=... env vars
#   (e.g. REVIEW_MODEL_QUALITY=grok-4.7-high-fast).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASK="${1:?task description required}"
BASE="${2:-main}"
BRANCH="$(git -C "$ROOT" branch --show-current)"

frontmatter_model() {
  awk -F': *' '/^---$/{c++; next} c==1 && $1=="model"{print $2; exit}' "$ROOT/.cursor/agents/$1.md"
}

BRIEF="$(cat <<EOF
Branch: $BRANCH   Base: $BASE
Diff to review: run \`git diff $BASE...HEAD\` (and \`git diff $BASE...HEAD --stat\` first to scope).
Task this diff is meant to implement: $TASK
EOF
)"

mkdir -p "$ROOT/.delegate"
START=$(date +%s)
PIDS=()
for ROLE in review-quality review-security review-correctness; do
  KEY="$(echo "${ROLE#review-}" | tr '[:lower:]' '[:upper:]')"
  OVERRIDE_VAR="REVIEW_MODEL_$KEY"
  MODEL="${!OVERRIDE_VAR:-$(frontmatter_model "$ROLE")}"
  "$ROOT/scripts/delegate.sh" "$ROLE" "$MODEL" "$BRIEF" --readonly > "$ROOT/.delegate/panel-$ROLE.tmp" 2>"$ROOT/.delegate/panel-$ROLE.err" &
  PIDS+=($!)
done

FAIL=0
for PID in "${PIDS[@]}"; do wait "$PID" || FAIL=1; done

echo "# Review panel — $BRANCH vs $BASE  ($(( $(date +%s) - START ))s total)"
echo
for ROLE in review-quality review-security review-correctness; do
  echo "## $ROLE"
  cat "$ROOT/.delegate/panel-$ROLE.tmp"
  grep -h 'finished in' "$ROOT/.delegate/panel-$ROLE.err" || true
  echo
  rm -f "$ROOT/.delegate/panel-$ROLE.tmp" "$ROOT/.delegate/panel-$ROLE.err"
done
exit $FAIL
