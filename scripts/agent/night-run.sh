#!/usr/bin/env bash
set -u

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT_DIR" || exit 1

mkdir -p .agent/eval .agent/logs

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_PATH=".agent/logs/night-run-$STAMP.log"
RESULT_PATH=".agent/eval/night-run-$STAMP.json"
LATEST_PATH=".agent/eval/latest.json"

exec > >(tee "$LOG_PATH") 2>&1

echo "=== pamyat-qr unattended night QA ==="
echo "timestamp: $STAMP"
echo "root: $ROOT_DIR"
echo "branch: $(git branch --show-current 2>/dev/null || echo unknown)"
echo "node: $(node --version 2>/dev/null || echo missing)"
echo "npm: $(npm --version 2>/dev/null || echo missing)"
echo

if [ ! -f .env ] && [ -f .env.example ]; then
  echo "Creating local .env from .env.example for QA"
  cp .env.example .env
  echo
fi

rm -rf playwright-report test-results

INSTALL_STATUS=0
if [ ! -d node_modules ]; then
  if [ -f package-lock.json ]; then
    echo "=== npm ci ==="
    npm ci
    INSTALL_STATUS=$?
  else
    echo "=== npm install ==="
    npm install
    INSTALL_STATUS=$?
  fi
  echo "install exit: $INSTALL_STATUS"
  echo
fi

echo "=== npm run check ==="
CHECK_STATUS=1
if [ "$INSTALL_STATUS" -eq 0 ]; then
  npm run check
  CHECK_STATUS=$?
else
  echo "Skipping syntax check because dependency install failed"
fi
echo "check exit: $CHECK_STATUS"
echo

echo "=== npm run seed ==="
SEED_STATUS=1
if [ "$CHECK_STATUS" -eq 0 ]; then
  npm run seed
  SEED_STATUS=$?
else
  echo "Skipping seed because syntax check failed"
fi
echo "seed exit: $SEED_STATUS"
echo

BROWSER_STATUS=1
if [ "$SEED_STATUS" -eq 0 ]; then
  echo "=== npx playwright install ==="
  npx playwright install
  BROWSER_STATUS=$?
else
  echo "Skipping Playwright browser install because seed failed"
fi
echo "playwright install exit: $BROWSER_STATUS"
echo

TEST_STATUS=1
if [ "$CHECK_STATUS" -eq 0 ] && [ "$SEED_STATUS" -eq 0 ] && [ "$BROWSER_STATUS" -eq 0 ]; then
  echo "=== npm run test:e2e ==="
  npm run test:e2e
  TEST_STATUS=$?
  echo "test:e2e exit: $TEST_STATUS"
else
  echo "Skipping Playwright QA because prerequisite step failed"
fi

OVERALL_STATUS=0
if [ "$INSTALL_STATUS" -ne 0 ] || [ "$CHECK_STATUS" -ne 0 ] || [ "$SEED_STATUS" -ne 0 ] || [ "$BROWSER_STATUS" -ne 0 ] || [ "$TEST_STATUS" -ne 0 ]; then
  OVERALL_STATUS=1
fi

NIGHT_OK=false
if [ "$OVERALL_STATUS" -eq 0 ]; then
  NIGHT_OK=true
fi

export NIGHT_OK INSTALL_STATUS CHECK_STATUS SEED_STATUS BROWSER_STATUS TEST_STATUS OVERALL_STATUS LOG_PATH RESULT_PATH LATEST_PATH STAMP
node <<'NODE'
const fs = require('fs');

const ok = process.env.NIGHT_OK === 'true';
const logPath = process.env.LOG_PATH;
const steps = [
  {
    name: 'install',
    command: Number(process.env.INSTALL_STATUS) === 0 ? 'npm ci / existing node_modules' : 'npm ci',
    status: Number(process.env.INSTALL_STATUS)
  },
  { name: 'check', command: 'npm run check', status: Number(process.env.CHECK_STATUS) },
  { name: 'seed', command: 'npm run seed', status: Number(process.env.SEED_STATUS) },
  { name: 'playwright-install', command: 'npx playwright install', status: Number(process.env.BROWSER_STATUS) },
  { name: 'e2e', command: 'npm run test:e2e', status: Number(process.env.TEST_STATUS) }
];

const failed = steps.filter((step) => step.status !== 0);
const payload = {
  ok,
  generatedAt: process.env.STAMP,
  logPath,
  steps,
  fixPrompt: ok
    ? ''
    : [
        'Unattended night QA failed.',
        `Read ${logPath} for the full command output.`,
        `Failed steps: ${failed.map((step) => `${step.name} (${step.command})`).join(', ')}.`,
        'Apply the smallest root-cause fix, then re-run: bash scripts/agent/night-run.sh'
      ].join(' ')
};

fs.writeFileSync(process.env.RESULT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
fs.copyFileSync(process.env.RESULT_PATH, process.env.LATEST_PATH);
console.log(`Wrote ${process.env.RESULT_PATH}`);
console.log(`Updated ${process.env.LATEST_PATH}`);
NODE

exit "$OVERALL_STATUS"
