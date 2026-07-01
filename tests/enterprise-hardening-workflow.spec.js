const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

async function login(page, login='admin'){
  await page.goto('/admin/login', { waitUntil:'domcontentloaded' });
  await page.locator('input[name="login"], input[name="username"], input[type="text"]').first().fill(login);
  await page.locator('input[name="password"], input[name="pass"], input[type="password"]').first().fill('change-me');
  await Promise.all([
    page.waitForURL(/\/admin/, { timeout:20000 }).catch(()=>page.waitForLoadState('networkidle')),
    page.getByRole('button', { name:/войти/i }).click()
  ]);
}
async function shot(page, name){
  const dir = path.join('test-results','enterprise-hardening-workflow');
  fs.mkdirSync(dir,{recursive:true});
  await page.screenshot({ path:path.join(dir, `${test.info().project.name}-${name}.png`), fullPage:true, timeout:45000 }).catch(()=>{});
}

test('enterprise hardening: platform health is visible, scoped and audit logged', async ({ page, browser }) => {
  await login(page, 'admin');
  await page.goto('/admin/platform/health', { waitUntil:'networkidle' });
  await expect(page.getByRole('heading', { name:/Enterprise health/i })).toBeVisible();
  await expect(page.locator('main')).toContainText(/Готовность платформы|Hardening checklist/i);
  await expect(page.locator('main')).toContainText(/SESSION_SECRET|SQLite WAL|Role isolation|Uploads directory/i);
  await shot(page, '01-platform-health');

  const jsonResponse = await page.request.get('/admin/platform/health.json');
  expect(jsonResponse.status()).toBe(200);
  const json = await jsonResponse.json();
  expect(json).toHaveProperty('metrics');
  expect(json).toHaveProperty('checks');
  expect(Array.isArray(json.checks)).toBe(true);
  expect(json.checks.map(c => c.key)).toEqual(expect.arrayContaining(['session_secret','database_wal','role_isolation','uploads']));
  expect(json.metrics.companies).toBeGreaterThanOrEqual(1);

  await page.goto('/admin/platform/audit', { waitUntil:'networkidle' });
  await expect(page.locator('main')).toContainText(/platform_health_checked|platform_health_json_checked/i);

  const partnerContext = await browser.newContext();
  const partnerPage = await partnerContext.newPage();
  await login(partnerPage, 'partner');
  const partnerDenied = await partnerPage.goto('/admin/platform/health', { waitUntil:'domcontentloaded' });
  expect([403, 404]).toContain(partnerDenied.status());
  await partnerContext.close();

  const businessContext = await browser.newContext();
  const businessPage = await businessContext.newPage();
  await login(businessPage, 'manager');
  const businessDenied = await businessPage.goto('/admin/platform/health', { waitUntil:'domcontentloaded' });
  expect([403, 404]).toContain(businessDenied.status());
  await businessContext.close();
});
