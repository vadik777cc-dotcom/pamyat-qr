const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

async function login(page, login, password='change-me'){
  await page.goto('/admin/login', { waitUntil: 'domcontentloaded' });
  await page.locator('input[name="login"], input[name="username"], input[type="text"]').first().fill(login);
  await page.locator('input[name="password"], input[name="pass"], input[type="password"]').first().fill(password);
  await page.getByRole('button', { name: /войти/i }).click();
  await page.waitForURL(/\/admin/, { timeout: 20000 }).catch(()=>page.waitForLoadState('networkidle'));
}
async function shot(page, name){
  const dir = path.join('test-results','partner-analytics');
  fs.mkdirSync(dir,{recursive:true});
  await page.screenshot({ path: path.join(dir, `${test.info().project.name}-${name}.png`), fullPage:true, timeout:45000 }).catch(()=>{});
}

test('partner analytics: partner sees only own businesses and scoped metrics', async ({ page }) => {
  const stamp = Date.now();
  const partnerName = `Session31 Analytics Partner ${stamp}`;
  const partnerLogin = `s31_partner_${stamp}`;
  const ownBusiness = `Session31 Partner Business ${stamp}`;
  const ownBusinessLogin = `s31_business_${stamp}`;
  const directBusiness = `Session31 Direct Business ${stamp}`;

  await login(page, 'admin');
  await page.goto('/admin/platform', { waitUntil:'networkidle' });
  await page.locator('form[action="/admin/platform/partners/new"] input[name="name"]').fill(partnerName);
  await page.locator('form[action="/admin/platform/partners/new"] input[name="contact_name"]').fill('Analytics Owner');
  await page.locator('form[action="/admin/platform/partners/new"] input[name="phone"]').fill('+7 999 310-31-31');
  await page.locator('form[action="/admin/platform/partners/new"] input[name="email"]').fill(`${partnerLogin}@example.test`);
  await page.locator('form[action="/admin/platform/partners/new"] input[name="login"]').fill(partnerLogin);
  await page.locator('form[action="/admin/platform/partners/new"] button').click();
  await page.waitForURL(/\/admin\/platform/);

  await page.goto('/admin/platform', { waitUntil:'networkidle' });
  await page.locator('form[action="/admin/platform/businesses/new"] input[name="name"]').fill(directBusiness);
  await page.locator('form[action="/admin/platform/businesses/new"] input[name="city"]').fill('Москва');
  await page.locator('form[action="/admin/platform/businesses/new"] input[name="email"]').fill(`direct_${stamp}@example.test`);
  await page.locator('form[action="/admin/platform/businesses/new"] button').click();
  await page.waitForURL(/\/admin\/platform/);

  await login(page, partnerLogin);
  await page.goto('/admin/partner', { waitUntil:'networkidle' });
  await expect(page.getByRole('link', { name:/Аналитика партнёра/i })).toBeVisible();
  await page.locator('form[action="/admin/partner/businesses/new"] input[name="name"]').fill(ownBusiness);
  await page.locator('form[action="/admin/partner/businesses/new"] input[name="city"]').fill('Пермь');
  await page.locator('form[action="/admin/partner/businesses/new"] input[name="phone"]').fill('+7 999 311-31-31');
  await page.locator('form[action="/admin/partner/businesses/new"] input[name="email"]').fill(`${ownBusinessLogin}@example.test`);
  await page.locator('form[action="/admin/partner/businesses/new"] input[name="login"]').fill(ownBusinessLogin);
  await page.locator('form[action="/admin/partner/businesses/new"] button').click();
  await page.waitForURL(/\/admin\/partner/);

  await page.goto('/admin/partner/analytics?days=30', { waitUntil:'networkidle' });
  await shot(page, 'dashboard');
  await expect(page.getByRole('heading', { name:/Аналитика партнёра/i })).toBeVisible();
  const main = page.getByRole('main');
  await expect(main.getByText(partnerName).first()).toBeVisible();
  await expect(main.getByText(ownBusiness).first()).toBeVisible();
  await expect(main.getByText(directBusiness)).toHaveCount(0);
  await expect(page.getByText(/Бизнесов/i).first()).toBeVisible();
  await expect(page.getByText(/Страниц памяти/i).first()).toBeVisible();
  await expect(page.getByText(/QR-события/i).first()).toBeVisible();
  await expect(page.getByText(/Заявки семьи/i).first()).toBeVisible();
  await expect(page.getByRole('heading', { name:/Что требует внимания/i })).toBeVisible();
  await expect(page.getByRole('heading', { name:/Динамика событий/i })).toBeVisible();

  await page.goto('/admin/platform/analytics', { waitUntil:'domcontentloaded' });
  await expect(page.locator('body')).toContainText(/Недостаточно прав|Cannot GET|404/i);
});
