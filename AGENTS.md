# Agent instructions

## CI workflow is manual-only — do not change this

`.github/workflows/ci.yml` triggers **only** on `workflow_dispatch` (manual runs from the GitHub Actions tab or via `gh workflow run CI`).

**Do not re-add `push`, `pull_request`, or any other automatic trigger.** This is an intentional team decision, not an oversight or something left half-finished. It applies even if you are "restoring" or "fixing" the workflow: keep the trigger list exactly as `on: workflow_dispatch` alone.

If a task seems to require automatic CI runs, flag it to the user instead of silently adding triggers back.
