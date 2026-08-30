// Suite-side execution glue for the TransformFit cypress lanes.
// Copied to <worktree>/cypress.config.mjs by `provision.postCheckout`, so
// Cypress (which resolves projectRoot from cwd, and no longer honors
// --project) loads it at the worktree root while every path stays relative
// to the checked-out repo. Mirrors e2e/cypress.config.ts semantics:
// demo/auth evidence lanes, source-binding sha into run-summary.json,
// and the same BLOCKED-on-systemError behavior. Videos are disabled for
// the governed lane (evidence budget); screenshots-on-failure stay.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const externalBaseUrl = process.env.CYPRESS_BASE_URL?.trim();
const evidenceLane = process.env.CYPRESS_EVIDENCE_LANE === 'auth' ? 'auth' : 'demo';
const artifactsRoot = path.resolve('artifacts/cypress', evidenceLane);
const sourceBindingPath = path.join(artifactsRoot, 'source-binding.json');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export default {
  allowCypressEnv: false,
  video: false,
  screenshotOnRunFailure: true,
  screenshotsFolder: path.join(artifactsRoot, 'screenshots'),
  videosFolder: path.join(artifactsRoot, 'videos'),
  downloadsFolder: path.join(artifactsRoot, 'downloads'),
  fixturesFolder: 'e2e/cypress/fixtures',
  trashAssetsBeforeRuns: true,
  retries: process.env.CI ? { runMode: 1, openMode: 0 } : 0,
  viewportWidth: 390,
  viewportHeight: 844,
  defaultCommandTimeout: 15000,
  pageLoadTimeout: 45000,
  requestTimeout: 15000,
  responseTimeout: 30000,
  e2e: {
    baseUrl: externalBaseUrl || 'http://127.0.0.1:7358',
    specPattern: 'e2e/cypress/e2e/**/*.cy.ts',
    supportFile: 'e2e/cypress/support/e2e.ts',
    setupNodeEvents(on) {
      on('after:run', (rawResults) => {
        fs.mkdirSync(artifactsRoot, { recursive: true });
        const sourceBindingSha256 = fs.existsSync(sourceBindingPath)
          ? sha256(sourceBindingPath)
          : null;
        if (!('runs' in rawResults)) {
          fs.writeFileSync(
            path.join(artifactsRoot, 'run-summary.json'),
            `${JSON.stringify({ status: 'BLOCKED', sourceBindingSha256, systemError: rawResults }, null, 2)}\n`,
          );
          return;
        }
        const runs = rawResults.runs.map((run) => ({
          spec: run.spec.relative,
          stats: run.stats,
          tests: run.tests.map((test) => ({
            title: test.title,
            state: test.state,
            displayError: test.displayError ?? null,
            attempts: test.attempts.map((attempt) => ({
              state: attempt.state,
            })),
          })),
          video: run.video,
          screenshots: run.screenshots,
        }));
        fs.writeFileSync(
          path.join(artifactsRoot, 'run-summary.json'),
          `${JSON.stringify(
            {
              status: rawResults.totalFailed === 0 ? 'PASS' : 'BLOCKED',
              startedTestsAt: rawResults.startedTestsAt,
              endedTestsAt: rawResults.endedTestsAt,
              totalTests: rawResults.totalTests,
              totalPassed: rawResults.totalPassed,
              totalFailed: rawResults.totalFailed,
              totalPending: rawResults.totalPending,
              totalSkipped: rawResults.totalSkipped,
              browserName: rawResults.browserName,
              browserVersion: rawResults.browserVersion,
              cypressVersion: rawResults.cypressVersion,
              sourceBindingSha256,
              runs,
            },
            null,
            2,
          )}\n`,
        );
      });
    },
  },
};
