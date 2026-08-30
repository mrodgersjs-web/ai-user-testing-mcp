# rig-testlab evidence report

| run | scenario | adapter | state | failureDetail | artifacts | credits (est/consumed) |
| --- | -------- | ------- | ----- | ------------- | --------- | ---------------------- |
| tf-ai-persona-evals-1 | tf-ai-persona-evals | promptfoo | BLOCKED | credential_missing | 0 | 0/0 |
| tf-api-coach-contract-1 | tf-api-coach-contract | bruno-openapi | FAILED | exit_code_4 | 34 | 0/0 |
| tf-data-boundary-inputs-1 | tf-data-boundary-inputs | datamimic | FAILED | exit_code_1 | 34 | 0/0 |
| tf-ios-sim-smoke-1 | tf-ios-sim-smoke | appium-xcuitest | FAILED | wall_clock_exceeded | 34 | 0/0 |
| tf-long-week-sim-1 | tf-long-week-sim | cypress | PASSED |  | 42 | 0/0 |
| tf-sec-baseline-scan-1 | tf-sec-baseline-scan | owasp-zap | FAILED | exit_code_1 | 34 | 0/0 |
| tf-tc001-workout-receipt-1 | tf-tc001-workout-receipt | testsprite | BLOCKED | credential_missing | 0 | 0/0 |
| tf-tc004-wellness-checkin-1 | tf-tc004-wellness-checkin | testsprite | BLOCKED | credential_missing | 0 | 0/0 |
| tf-tc007-pain-safety-1 | tf-tc007-pain-safety | testsprite | BLOCKED | credential_missing | 0 | 0/0 |
| tf-web-onboarding-1 | tf-web-onboarding | cypress | PASSED |  | 42 | 0/0 |
| tf-web-today-a11y-1 | tf-web-today-a11y | cypress-axe | PASSED |  | 42 | 0/0 |
| tf-web-today-vision-1 | tf-web-today-vision | cypress | PASSED |  | 108 | 0/0 |
| tf-web-workout-day-1 | tf-web-workout-day | cypress | PASSED |  | 42 | 0/0 |

## Summary (passed counts ONLY state === 'passed')

- passed: 5
- failed: 4
- blocked: 4
- not_evaluated: 0
- cancelled: 0
- running: 0
- queued: 0

## Non-passing, explicitly

- tf-ai-persona-evals-1: BLOCKED — credential_missing
- tf-tc001-workout-receipt-1: BLOCKED — credential_missing
- tf-tc004-wellness-checkin-1: BLOCKED — credential_missing
- tf-tc007-pain-safety-1: BLOCKED — credential_missing
