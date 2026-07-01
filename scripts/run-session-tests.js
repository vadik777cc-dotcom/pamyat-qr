const { spawnSync } = require('child_process');
const args = [
  'playwright',
  'test',
  // Core safety checks kept in every fast session.
  'tests/access-isolation.spec.js',
  'tests/global-product-qa.spec.js',
  'tests/media-network.spec.js',
  // Previous session regression check.
  'tests/release-readiness-workflow.spec.js',
  // Current session focused check.
  'tests/release-package-workflow.spec.js'
];
const result = spawnSync('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(result.status ?? 1);
