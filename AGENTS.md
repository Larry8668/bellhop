# Bellhop — agent instructions

Read before doing anything in this repo. Detailed rules live in `.cursor/rules/*.mdc`; this file is the short version every agent (IDE, CLI, subagent) must honour.

## Git: PRs only

- **Nothing reaches `main` except through a pull request.** No direct commits, no direct pushes, no local merges into `main`, no `ALLOW_MAIN_PUSH` unless the user says so in the same message.
- Branch per task (`feat/`, `fix/`, `docs/`, `chore/`, `test/`), conventional commits, `gh pr create`, review panel verdicts in the PR body, `gh pr merge --rebase --delete-branch`.
- GitHub branch protection is not enabled (private repo, free plan). The `pre-push` hook and this rule are the guard. Treat them as if protection were on.

## Roles

- The parent agent plans and verifies. Implementation and tests are delegated to smaller models, by default through the headless CLI: `scripts/delegate.sh <role> <model> "<brief>"`.
- Before every PR, run the review panel: `scripts/review-panel.sh "<task>"`. Fix blockers, note deferred majors in `TODO.md`.
- Role prompts are in `.cursor/agents/*.md`. Pick the model per task by complexity (see `.cursor/rules/workflow.mdc`).

## Scope

- `docs/bellhopper-plan.md` is the source of truth. Not in the plan → ask first.
- `docs/internal/` is private; never commit or cite it.
- Update `TODO.md` / `LOGS.md` / `BUGS.md` as part of the work, not after.
