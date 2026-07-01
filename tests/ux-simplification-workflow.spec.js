const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { db } = require('../db');

async function login(page, login='manager'){
  await page.goto('/admin/login', { waitUntil:'domcontentloaded' });
  await page.locator('input[name="login"], input[name="username"], input[type="text"]').first().fill(login);
  await page.locator('input[name="password"], input[name="pass"], input[type="password"]').first().fill('change-me');
  await Promise.all([
    page.waitForURL(/\/admin/, { timeout:20000 }).catch(()=>page.waitForLoadState('networkidle')),
    page.getByRole('button', { name:/войти/i }).click()
  ]);
}
async function shot(page, name){
  const dir = path.join('test-results','ux-simplification-workflow');
  fs.mkdirSync(dir,{recursive:true});
  await page.screenshot({ path:path.join(dir, `${test.info().project.name}-${name}.png`), fullPage:true, timeout:45000 }).catch(()=>{});
}

test('UX simplification: onboarding, plain domain language and clean B2C landing top', async ({ page }) => {
  await login(page, 'manager');

  await page.goto('/admin', { waitUntil:'networkidle' });
  await expect(page.getByRole('heading', { name:/Главная/i })).toBeVisible();
  await expect(page.locator('main')).toContainText(/Рабочий стол менеджера|Что сделать сейчас|Создать страницу памяти|Заявки семьи/i);
  // Подсказки первого запуска могут быть скрыты, если seed уже содержит готовый бизнес.
  await shot(page, '01-dashboard-onboarding');

  await page.goto('/admin/deploy', { waitUntil:'networkidle' });
  await expect(page.getByRole('heading', { name:'Адрес сайта', exact:true })).toBeVisible();
  await expect(page.locator('main')).toContainText(/Адрес для семей|Короткая ссылка|Бренд компании|Показать технические настройки/i);
  await expect(page.locator('main')).toContainText(/Показать технические настройки/i);
  const publicLinkFromDeploy = await page.locator('a[href^="/l/"], a[href*="/l/"]').first().getAttribute('href').catch(()=>null);
  await shot(page, '02-simple-address-page');

  await page.goto('/admin/landing', { waitUntil:'networkidle' });
  await expect(page.getByRole('heading', { name:'Лендинг для семей', exact:true })).toBeVisible();
  await expect(page.locator('main')).toContainText(/Главный заголовок|Контакты для семьи|Первый экран|Предпросмотр/i);
  await shot(page, '03-landing-simple-copy');

  const currentCompany = db.prepare(`
    SELECT c.slug
    FROM managers m
    JOIN companies c ON c.id = m.company_id
    JOIN landing_pages l ON l.company_id = c.id
    WHERE m.login = 'manager' AND c.is_active = 1 AND l.status = 'published'
    ORDER BY c.id DESC
    LIMIT 1
  `).get();
  const publicUrl = currentCompany ? `/l/${currentCompany.slug}` : (publicLinkFromDeploy || '/l/pamyat-qr');
  await page.goto(publicUrl, { waitUntil:'domcontentloaded' });
  await page.waitForTimeout(500);
  await shot(page, '04-public-landing-clean-top');
  const bodyText = await page.locator('body').innerText();
  expect(bodyText.slice(0, 400)).not.toMatch(/PAMYAT_PUBLIC_LANDING_DATA|window\.PAMYAT|\{\"company\"|\"landing\":/);
  await expect(page.locator('body')).toContainText(/страница памяти|QR/i);
});
