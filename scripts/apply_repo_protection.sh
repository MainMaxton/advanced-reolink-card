#!/usr/bin/env bash
# Apply (or re-apply) the repository protections for reolink-camera-audiohook.
#
# Idempotent: every step is a PUT/PATCH, and rulesets are created or updated by
# name. Safe to run again at any time, e.g. right after making the repo public.
#
#   bash scripts/apply_repo_protection.sh         # default repo (from a checkout)
#   REPO=owner/name bash apply_repo_protection.sh
#
# Needs: gh (logged in with repo + workflow scope; admin on the repo) and jq.
# Never prints the token. Exit code 0 = every step applied, 1 = some failed.
set -uo pipefail

REPO="${REPO:-MainMaxton/reolink-camera-audiohook}"
export GH_CONFIG_DIR="${GH_CONFIG_DIR:-/workspace/.gh-config}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -n "${RULESET_DIR:-}" ]]; then :
elif [[ -d "$HERE/rulesets" ]]; then RULESET_DIR="$HERE/rulesets"
elif [[ -d "$HERE/../.github/rulesets" ]]; then RULESET_DIR="$HERE/../.github/rulesets"
else echo "ruleset JSON directory not found (set RULESET_DIR)" >&2; exit 2; fi
GHA_APP_ID=15368   # GitHub Actions app: required checks must come from our workflows

command -v gh >/dev/null || { echo "gh not found" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq not found" >&2; exit 2; }

OK=(); FAILED=()
step() {  # step "description" gh-api-args...   (JSON body on stdin when --input -)
  local desc="$1"; shift
  local out
  if out=$(gh api "$@" 2>&1); then
    OK+=("$desc"); printf '  OK      %s\n' "$desc"
  else
    local msg; msg=$(printf '%s' "$out" | tr '\n' ' ' | sed -E 's/ +/ /g' | cut -c1-220)
    FAILED+=("$desc :: $msg"); printf '  FAILED  %s\n          %s\n' "$desc" "$msg"
  fi
}

VIS=$(gh api "repos/$REPO" -q .visibility) || { echo "cannot read $REPO" >&2; exit 2; }
echo "Repository: $REPO (visibility: $VIS)"

echo "== Repository settings"
step "merge: squash only, PR title/body, delete branch on merge, update branch; wiki off, issues on, discussions off, no web sign-off" \
  -X PATCH "repos/$REPO" --input - <<JSON
{
  "allow_squash_merge": true,
  "allow_merge_commit": false,
  "allow_rebase_merge": false,
  "allow_auto_merge": false,
  "squash_merge_commit_title": "PR_TITLE",
  "squash_merge_commit_message": "PR_BODY",
  "delete_branch_on_merge": true,
  "allow_update_branch": true,
  "has_wiki": false,
  "has_issues": true,
  "has_discussions": false,
  "has_projects": false,
  "web_commit_signoff_required": false
}
JSON

echo "== GitHub Actions"
step "actions: enabled, selected actions only, actions must be pinned to a full commit SHA" \
  -X PUT "repos/$REPO/actions/permissions" --input - <<JSON
{ "enabled": true, "allowed_actions": "selected", "sha_pinning_required": true }
JSON
step "actions: allow GitHub-owned, verified creators, hacs/action, home-assistant/actions/hassfest" \
  -X PUT "repos/$REPO/actions/permissions/selected-actions" --input - <<JSON
{
  "github_owned_allowed": true,
  "verified_allowed": true,
  "patterns_allowed": ["hacs/action@*", "home-assistant/actions/hassfest@*"]
}
JSON
step "actions: default GITHUB_TOKEN read-only, cannot approve PRs" \
  -X PUT "repos/$REPO/actions/permissions/workflow" --input - <<JSON
{ "default_workflow_permissions": "read", "can_approve_pull_request_reviews": false }
JSON
if [[ "$VIS" == "public" ]]; then
  step "actions: fork PR workflows need approval for all external contributors" \
    -X PUT "repos/$REPO/actions/permissions/fork-pr-contributor-approval" --input - <<JSON
{ "approval_policy": "all_external_contributors" }
JSON
else
  step "actions (private): fork PR workflows need approval, no write token, no secrets" \
    -X PUT "repos/$REPO/actions/permissions/fork-pr-workflows-private-repos" --input - <<JSON
{
  "run_workflows_from_fork_pull_requests": true,
  "send_write_tokens_to_workflows": false,
  "send_secrets_and_variables": false,
  "require_approval_for_fork_pr_workflows": true
}
JSON
fi

echo "== Security"
step "Dependabot alerts (vulnerability alerts)" -X PUT "repos/$REPO/vulnerability-alerts"
step "Dependabot security updates (automated security fixes)" -X PUT "repos/$REPO/automated-security-fixes"
step "private vulnerability reporting" -X PUT "repos/$REPO/private-vulnerability-reporting"
step "secret scanning + push protection" -X PATCH "repos/$REPO" --input - <<JSON
{ "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" } } }
JSON
step "CodeQL default setup (actions, python)" \
  -X PATCH "repos/$REPO/code-scanning/default-setup" --input - <<JSON
{ "state": "configured", "languages": ["actions", "python"], "query_suite": "default" }
JSON

echo "== Rulesets"
apply_ruleset() {
  local file="$1" body name id
  body=$(cat "$file")
  if [[ "$VIS" == "public" ]]; then
    # HACS validation only runs (and can pass) once the repository is public.
    body=$(jq --argjson app "$GHA_APP_ID" '
      (.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks) |=
        (if any(.[]; .context == "HACS validation") then . else . + [{"context": "HACS validation", "integration_id": $app}] end)' <<<"$body")
  fi
  name=$(jq -r .name <<<"$body")
  local list
  if ! list=$(gh api "repos/$REPO/rulesets?includes_parents=false" --paginate 2>&1); then
    FAILED+=("ruleset '$name' :: $(printf '%s' "$list" | tr '\n' ' ' | cut -c1-220)")
    printf '  FAILED  ruleset %s\n          %s\n' "$name" "$(printf '%s' "$list" | tr '\n' ' ' | cut -c1-220)"
    return
  fi
  id=$(jq -r --arg n "$name" '[.[] | select(.name == $n)][0].id // empty' <<<"$list")
  if [[ -n "$id" ]]; then
    step "ruleset '$name' (update id $id)" -X PUT "repos/$REPO/rulesets/$id" --input - <<<"$body"
  else
    step "ruleset '$name' (create)" -X POST "repos/$REPO/rulesets" --input - <<<"$body"
  fi
}
for f in "$RULESET_DIR"/protect-main.json "$RULESET_DIR"/protect-release-tags.json; do
  apply_ruleset "$f"
done

echo
echo "Applied: ${#OK[@]}   Failed: ${#FAILED[@]}"
for f in "${FAILED[@]}"; do echo "  - $f"; done
[[ ${#FAILED[@]} -eq 0 ]]
