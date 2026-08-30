# Branch protection runbook (post-Pro upgrade)

State as of 2026-08-30: `mrodgersjs-web` is on the **free** plan. GitHub returns
403 "Upgrade to GitHub Pro or make this repository public" for both branch
protection and rulesets on **private** repos of free accounts. No org with a
paid plan is visible to this token, so transfer is not an option.

## What already protects main (free tier)

- CI (`ci.yml`) runs `build-test` + `security` on every push and PR.
- `weekly-catalog-refresh.yml` opens PRs only — nothing auto-merges.
- Local `rig-github-steward` pre-push guard (fail-closed on unregistered
  remotes/updates) binds every writer on this workstation.
- `scripts/verify-pins.mjs` + `catalog verify` are in the CI path, so a
  gitlink/lock drift breaks the build.

## After upgrading to GitHub Pro (one paste)

```bash
gh api repos/mrodgersjs-web/ai-user-testing-mcp/branches/main/protection -X PUT \
  -f required_status_checks='{"strict":true,"contexts":["build-test","security"]}' \
  -f enforce_admins=true \
  -F required_pull_request_reviews=null \
  -F restrictions=null
```

Verify:

```bash
gh api repos/mrodgersjs-web/ai-user-testing-mcp/branches/main/protection --jq '.required_status_checks.contexts'
# expect: ["build-test","security"]
```

Then re-seal the release ProofPacket (`scripts/build-proofpacket.mts`) so the
protection state is bound into the sealed evidence.
