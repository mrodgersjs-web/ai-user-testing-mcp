#!/usr/bin/env bash
# setup-human-steps.sh — the TWO human-only steps remaining for full
# mrodgersjs-web setup. Everything else is already done by the agent.
# Resumable: each step verifies itself and can be re-run safely.
set -euo pipefail

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓ %s\033[0m\n' "$*"; }
wait() { printf '  \033[33m… %s\033[0m\n' "$*"; }

say "Step 1/2 — Upgrade mrodgersjs-web to GitHub Pro (unlocks branch protection on private repos)"
echo "  Open:  https://github.com/settings/billing/plan"
echo "  Click: 'Upgrade to Pro' (\$4/mo) and complete checkout."
printf '  Press ENTER when done (or s to skip): '
read -r ans
if [ "$ans" != "s" ]; then
  plan="$(gh api user --jq .plan.name 2>/dev/null || echo free)"
  if [ "$plan" = "pro" ]; then
    ok "plan is now 'pro'"
  else
    wait "plan still reads '$plan' — GitHub can take a minute; re-run this script to re-check."
  fi
else
  wait "skipped Pro upgrade"
fi

say "Step 2/2 — Add mrodgersjs-web to the Rodgers-Intelligence-Group org"
echo "  As rodgemd1-lgtm (org admin), open:"
echo "    https://github.com/orgs/Rodgers-Intelligence-Group/people"
echo "  Click 'Invite member', enter: mrodgersjs-web, role: Member."
printf '  Press ENTER when the invite is sent (or s to skip): '
read -r ans
if [ "$ans" != "s" ]; then
  # Agent-executable part: accept the invitation as mrodgersjs-web.
  if gh api user/memberships/orgs/Rodgers-Intelligence-Group -X PATCH -f state=active --jq .state 2>/dev/null | grep -q active; then
    ok "invitation accepted (membership active)"
  else
    wait "no pending invitation found yet — accept it from the GitHub notification/email, then re-run."
  fi
  vis="$(gh api repos/Rodgers-Intelligence-Group/transformfit-flutter --jq .visibility 2>/dev/null || echo inaccessible)"
  if [ "$vis" = "private" ]; then
    ok "transformfit-flutter visible as private to mrodgersjs-web (steward will PASS)"
  else
    wait "repo not yet visible ($vis)"
  fi
else
  wait "skipped org invite"
fi

say "Done. Tell the agent 'continue' — it will apply branch protection, verify the steward, and re-seal the packet."
