# Repository rulesets

These files are the request bodies for the GitHub rulesets API
(`POST/PUT /repos/{owner}/{repo}/rulesets`). They are applied, created or
updated by name, with `scripts/apply_repo_protection.sh` (repository admins only).

| File | Ruleset | What it does |
|------|---------|--------------|
| `protect-main.json` | Protect main | Default branch: no deletion, no force push, linear history, PR with 1 code-owner approval (stale approvals dismissed, last push approved by someone else, conversations resolved), squash merge only, required checks `Hassfest` and `Tests` from GitHub Actions (branch must be up to date). Repository admins may bypass **only through a pull request** (no direct pushes). |
| `protect-release-tags.json` | Protect release tags | `refs/tags/v*`: only repository admins can create, move or delete release tags. |

Notes:

- `integration_id` 15368 is the GitHub Actions app, so only checks reported by
  this repository's workflows satisfy the rule (a commit status with the same
  name from elsewhere does not).
- The `HACS validation` check is skipped while the repository is private (HACS
  cannot fetch files from a private repository). The apply script adds
  `{ "context": "HACS validation", "integration_id": 15368 }` to the required
  checks automatically once the repository is public.
- Signed commits (`required_signatures`) are intentionally **not** required.
  Every change reaches `main` as a squash merge made by GitHub, and GitHub signs
  those commits itself, so the rule would add almost nothing today. It would,
  however, block GitHub's own rebase merges if the merge methods are ever widened,
  and it confuses contributors who see the requirement on the branch. Enable it
  later by adding `{ "type": "required_signatures" }` to `protect-main.json`.
