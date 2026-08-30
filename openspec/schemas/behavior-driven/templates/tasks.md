## 1. First-time setup — skip this whole section if `acceptance-tests/` already exists

- [ ] 1.1 Set up the application skeleton (entry point, dependencies, run script) so the app can boot
- [ ] 1.2 Create `acceptance-tests/` at the repo root as an independent Node project that boots the app before the suite and shuts it down after
- [ ] 1.3 Copy the four acceptance-test-authoring skill reference files verbatim into `acceptance-tests/` (`extract-gherkin.cjs`, `cucumber.cjs`, `openspec-effective-paths.cjs`, and `gherkin-lintrc.json` as `.gherkin-lintrc`) so the runner extracts the Gherkin from every `spec.md` under `openspec/` into `acceptance-tests/.extracted/` and discovers the extracted features, excluding `openspec/changes/archive/`
- [ ] 1.4 Make the test command always generate an HTML report from the test tool
- [ ] 1.5 Add the `lint:specs` script (extract, then `gherkin-lint .extracted`) and gitignore `acceptance-tests/.extracted/` and `acceptance-tests/reports/`
- [ ] 1.6 Write `acceptance-tests/README.md` with instructions for running the suite and where the HTML report is written

## 2. Step definitions — one task per pending step; each = fails for the right reason → implement → passes → commit

- [ ] 2.1 <!-- feature: step --> — red → green → commit
- [ ] 2.2 <!-- feature: step --> — red → green → commit

## 3. Completion

- [ ] 3.1 Run the full suite: every scenario passes, zero pending/undefined steps, HTML report generated
