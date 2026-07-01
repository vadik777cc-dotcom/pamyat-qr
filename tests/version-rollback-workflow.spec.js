const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

async function login(page){
  await page.goto('/admin/login', { waitUntil:'domcontentloaded' });
  await page.locator('input[name="login"], input[name="username"], input[type="text"]').first().fill('manager');
  await page.locator('input[name="password"], input[name="pass"], input[type="password"]').first().fill('change-me');
  await Promise.all([
    page.waitForURL(/\/admin/, { timeout:20000 }).catch(()=>page.waitForLoadState('networkidle')),
    page.getByRole('button', { name:/войти/i }).click()
  ]);
}
async function shot(page, name){
  const dir = path.join('test-results','version-rollback-workflow');
  fs.mkdirSync(dir,{recursive:true});
  await page.screenshot({ path:path.join(dir, `${test.info().project.name}-${name}.png`), fullPage:true, timeout:45000 }).catch(()=>{});
}
async function saveLanding(page){
  await page.getByRole('button', { name:/Сохранить лендинг/i }).click();
  await page.waitForLoadState('networkidle').catch(()=>{});
  await page.waitForTimeout(500);
}

test('versions: landing snapshot compare, preview and restore work safely', async ({ page }) => {
  const stamp = Date.now();
  const firstTitle = `Версия A ${stamp}`;
  const secondTitle = `Версия B ${stamp}`;
  await login(page);
  page.on('dialog', d => d.accept());

  await page.goto('/admin/landing', { waitUntil:'networkidle' });
  await page.locator('input[name="hero_title"], textarea[name="hero_title"]').first().fill(firstTitle);
  await saveLanding(page);

  await page.locator('input[name="hero_title"], textarea[name="hero_title"]').first().fill(secondTitle);
  await saveLanding(page);

  await page.goto('/admin/versions', { waitUntil:'networkidle' });
  await shot(page, '01-versions-dashboard');
  await expect(page.getByRole('heading', { name:/Версии и откат/i })).toBeVisible();
  await expect(page.locator('main')).toContainText(/Контроль изменений|B2C-лендинг|Страницы памяти/);
  await expect(page.locator('main')).toContainText(firstTitle);
  await expect(page.locator('main')).not.toContainText(`нет версий ${stamp}`);

  const landingSection = page.locator('section.panel', { hasText:/B2C-лендинг/ }).first();
  await expect(landingSection.getByRole('link', { name:/сравнить/i }).first()).toBeVisible();
  await landingSection.getByRole('link', { name:/сравнить/i }).first().click();
  await page.waitForLoadState('networkidle').catch(()=>{});
  await shot(page, '02-landing-version-detail');
  await expect(page.getByRole('heading', { name:/Версия лендинга/i })).toBeVisible();
  await expect(page.locator('main')).toContainText(firstTitle);
  await expect(page.locator('main')).toContainText(secondTitle);
  await expect(page.getByRole('link', { name:/Открыть снимок/i })).toBeVisible();

  const previewPromise = page.context().waitForEvent('page');
  await page.getByRole('link', { name:/Открыть снимок/i }).click();
  const preview = await previewPromise;
  await preview.waitForLoadState('domcontentloaded');
  await expect(preview.locator('body')).toContainText(firstTitle);
  await preview.close();

  await page.getByRole('button', { name:/Восстановить версию/i }).click();
  await page.waitForURL(/\/admin\/landing/, { timeout:20000 });
  await expect(page.locator('input[name="hero_title"], textarea[name="hero_title"]').first()).toHaveValue(firstTitle);
  await shot(page, '03-landing-after-restore');

  await page.goto('/admin/notifications?event_type=landing_version_restored', { waitUntil:'networkidle' });
  await expect(page.locator('main')).toContainText(/Версия лендинга восстановлена/);
});
