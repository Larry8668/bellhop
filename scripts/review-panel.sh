#!/usr/bin/env bash
# Run the adversarial review panel (quality, security, correctness) in parallel on the current branch.
#
# Usage: scripts/review-panel.sh "<task description>" [base-branch]
#   The diff is computed here and inlined into each reviewer's prompt, so reviewers run in
#   read-only `--mode ask` and never need shell access. Models come from each reviewer's
#   frontmatter; override with REVIEW_MODEL_QUALITY / _SECURITY / _CORRECTNESS env vars.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASK="${1:?task description required}"
BASE="${2:-main}"
BRANCH="$(git -C "$ROOT" branch --show-current)"
MAX_DIFF_BYTES="${MAX_DIFF_BYTES:-120000}"
ROLES=(review-quality review-security review-correctness)

frontmatter_model() {
  awk -F': *' '/^---$/{c++; next} c==1 && $1=="model"{print $2; exit}' "$ROOT/.cursor/agents/$1.md"
}

DIFF_STAT="$(git -C "$ROOT" diff "$BASE...HEAD" --stat)"
DIFF="$(git -C "$ROOT" diff "$BASE...HEAD")"
if [ "${#DIFF}" -gt "$MAX_DIFF_BYTES" ]; then
  DIFF="$(printf '%s' "$DIFF" | head -c "$MAX_DIFF_BYTES")"$'\n\n[diff truncated at '"$MAX_DIFF_BYTES"' bytes — read the listed files directly for the rest]'
fi

BRIEF="$(cat <<EOF
Branch: $BRANCH   Base: $BASE
Task this diff is meant to implement: $TASK

You cannot run shell commands. The full diff is below; read files directly only if a finding depends on surrounding code.

## git diff $BASE...HEAD --stat
$DIFF_STAT

## git diff $BASE...HEAD
$DIFF
EOF
)"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/bellhop-panel.XXXXXX")"
PIDS=()
cleanup() {
  for PID in "${PIDS[@]:-}"; do [ -n "$PID" ] && kill "$PID" 2>/dev/null || true; done
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

START=$(date +%s)
for ROLE in "${ROLES[@]}"; do
  KEY="$(echo "${ROLE#review-}" | tr '[:lower:]' '[:upper:]')"
  OVERRIDE_VAR="REVIEW_MODEL_$KEY"
  MODEL="${!OVERRIDE_VAR:-$(frontmatter_model "$ROLE")}"
  "$ROOT/scripts/delegate.sh" "$ROLE" "$MODEL" "$BRIEF" --readonly >"$TMP/$ROLE.out" 2>"$TMP/$ROLE.err" &
  PIDS+=($!)
done

# bash 3.2 (macOS default) has no associative arrays; STATUS is indexed in ROLES order.
STATUS=()
i=0
for ROLE in "${ROLES[@]}"; do
  if wait "${PIDS[$i]}"; then STATUS[$i]=0; else STATUS[$i]=$?; fi
  i=$((i + 1))
done

FAIL=0
echo "# Review panel — $BRANCH vs $BASE  ($(( $(date +%s) - START ))s total)"
echo
i=0
for ROLE in "${ROLES[@]}"; do
  echo "## $ROLE  (exit=${STATUS[$i]})"
  if [ "${STATUS[$i]}" -ne 0 ]; then
    FAIL=1
    echo "REVIEWER FAILED — stderr:"
    cat "$TMP/$ROLE.err"
  fi
  cat "$TMP/$ROLE.out"
  grep -h 'delegate: .* exit=' "$TMP/$ROLE.err" || true
  echo
  i=$((i + 1))
done
exit $FAIL
