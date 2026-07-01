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
  const dir=path.join('test-results','release-readiness');
  fs.mkdirSync(dir,{recursive:true});
  await page.screenshot({ path:path.join(dir, `${test.info().project.name}-${name}.png`), fullPage:true, timeout:45000 }).catch(()=>{});
}

test('release readiness: super admin sees final checks and scoped clients cannot', async ({ page }) => {
  await login(page, 'admin');
  await page.goto('/admin/platform/release', { waitUntil:'networkidle' });
  await expect(page.getByRole('heading', { name:/Релизная готовность/i })).toBeVisible();
  await expect(page.locator('main')).toContainText(/Финальная панель|Что проверено|Команды перед релизом|Порядок показа клиенту/i);
  await expect(page.locator('main')).toContainText(/SESSION_SECRET|SQLite WAL|Role isolation|Безопасная активация клиентов|Документация запуска/i);
  await expect(page.locator('pre')).toContainText(/npm run check|npm run test:e2e:full|npm run test:debug-pack/i);
  await shot(page, '01-release-center');

  const json = await page.goto('/admin/platform/release.json', { waitUntil:'domcontentloaded' });
  expect(json.status()).toBe(200);
  const data = await page.evaluate(() => JSON.parse(document.body.innerText));
  expect(Array.isArray(data.checks)).toBeTruthy();
  expect(data.commands).toContain('npm run test:e2e:full');

  await page.context().clearCookies();
  await login(page, 'manager');
  const denied = await page.goto('/admin/platform/release', { waitUntil:'domcontentloaded' });
  expect(denied.status()).toBe(403);
});
