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
  const dir=path.join('test-results','client-onboarding-security');
  fs.mkdirSync(dir,{recursive:true});
  await page.screenshot({ path:path.join(dir, `${test.info().project.name}-${name}.png`), fullPage:true, timeout:45000 }).catch(()=>{});
}

test('client onboarding security: invite activates account once and opens first-start screen', async ({ page }) => {
  const stamp = Date.now();
  const businessName = `S53 Client ${stamp}`;
  const businessLogin = `s53_client_${stamp}`;
  const password = `secure-pass-${stamp}`;

  await login(page, 'admin');
  await page.goto('/admin/platform', { waitUntil:'networkidle' });
  await page.locator('form[action="/admin/platform/businesses/new"] input[name="name"]').fill(businessName);
  await page.locator('form[action="/admin/platform/businesses/new"] input[name="city"]').fill('Пермь');
  await page.locator('form[action="/admin/platform/businesses/new"] input[name="email"]').fill(`${businessLogin}@example.test`);
  await page.locator('form[action="/admin/platform/businesses/new"] input[name="login"]').fill(businessLogin);
  await page.locator('form[action="/admin/platform/businesses/new"] button').click();
  await page.waitForURL(/\/admin\/platform/);

  await page.goto('/admin/platform/businesses', { waitUntil:'networkidle' });
  await expect(page.getByText(businessName).first()).toBeVisible();
  await page.locator('tr', { hasText: businessName }).getByRole('link', { name:/Открыть/i }).first().click();
  await expect(page.getByRole('heading', { name: new RegExp(businessName) })).toBeVisible();
  await page.getByRole('button', { name:/Создать ссылку входа/i }).first().click();
  await expect(page.locator('.invite-box')).toContainText(/одноразовая|24 часа/i);
  const inviteUrl = (await page.locator('.invite-box code').textContent()) || '';
  expect(inviteUrl).toContain('/admin/invite/');

  await page.locator('form[action="/admin/logout"] button').click();
  await page.goto(inviteUrl, { waitUntil:'domcontentloaded' });
  await expect(page.locator('body')).toContainText(/Подключение аккаунта|24 часа|Создайте пароль/i);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('input[name="password2"]').fill(password);
  await page.getByRole('button', { name:/Создать пароль и войти/i }).click();
  await page.waitForURL(/\/admin\/onboarding/, { timeout:20000 });
  await expect(page.getByRole('heading', { name:/Первый запуск/i })).toBeVisible();
  await expect(page.locator('main')).toContainText(/Клиент подключён безопасно|Передавать пароль.*не нужно|Что делать каждый день/i);
  await shot(page, 'business-first-start');

  await page.locator('form[action="/admin/logout"] button').click();
  const reused = await page.goto(inviteUrl, { waitUntil:'domcontentloaded' });
  expect(reused.status()).toBe(404);

  await login(page, businessLogin, password);
  await page.goto('/admin/onboarding', { waitUntil:'networkidle' });
  await expect(page.getByRole('heading', { name:/Первый запуск/i })).toBeVisible();
  await expect(page.locator('.sidebar')).not.toContainText(/Платформа|Партнёры|Health/i);
});
