const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

async function login(page, login='admin', password='change-me'){
  await page.goto('/admin/login', { waitUntil:'domcontentloaded' });
  await page.locator('input[name="login"], input[type="text"]').first().fill(login);
  await page.locator('input[name="password"]').first().fill(password);
  await page.getByRole('button', { name:/войти/i }).click();
  await page.waitForURL(/\/admin/, { timeout:20000 }).catch(()=>page.waitForLoadState('networkidle'));
}
async function shot(page, name){
  const dir=path.join('test-results','release-package');
  fs.mkdirSync(dir,{recursive:true});
  await page.screenshot({ path:path.join(dir, `${test.info().project.name}-${name}.png`), fullPage:true, timeout:45000 }).catch(()=>{});
}

test('release package: docs, demo script and full QA commands are ready', async ({ page }) => {
  const required = [
    'docs/RELEASE_RUNBOOK.md',
    'docs/FIRST_CLIENT_CHECKLIST.md',
    'docs/CLIENT_DEMO_SCRIPT.md',
    'docs/ROLES_AND_ACCESS.md',
    'docs/CLIENT_HANDOFF_MESSAGE.md',
    'docs/RELEASE_CHECKLIST.md'
  ];
  for (const rel of required) {
    expect(fs.existsSync(path.join(process.cwd(), rel)), `${rel} missing`).toBeTruthy();
    expect(fs.readFileSync(path.join(process.cwd(), rel), 'utf8').length, `${rel} is empty`).toBeGreaterThan(400);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  expect(pkg.scripts['test:e2e:full']).toBeTruthy();
  expect(pkg.scripts['test:debug-pack']).toBeTruthy();
  expect(pkg.scripts['check']).toBeTruthy();

  await login(page, 'admin');
  await page.goto('/admin/platform/release', { waitUntil:'networkidle' });
  await expect(page.getByRole('heading', { name:/Релизная готовность/i })).toBeVisible();
  await expect(page.locator('main')).toContainText(/RELEASE_RUNBOOK|FIRST_CLIENT_CHECKLIST|CLIENT_DEMO_SCRIPT|ROLES_AND_ACCESS/i);
  await expect(page.locator('pre')).toContainText(/npm run test:e2e:full/i);
  await shot(page, '01-release-package');

  const json = await page.goto('/admin/platform/release.json', { waitUntil:'domcontentloaded' });
  expect(json.status()).toBe(200);
  const data = await page.evaluate(() => JSON.parse(document.body.innerText));
  expect(data.commands).toContain('npm run test:e2e:full');
  expect(data.checks.find(c => c.key === 'release_docs')?.ok).toBeTruthy();
});
