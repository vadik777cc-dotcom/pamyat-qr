const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

async function login(page, login, password='change-me'){
  await page.goto('/admin/login', { waitUntil:'domcontentloaded' });
  await page.locator('input[name="login"], input[type="text"]').first().fill(login);
  await page.locator('input[name="password"]').first().fill(password);
  await page.getByRole('button', { name:/войти/i }).click();
  await page.waitForURL(/\/admin/, { timeout:20000 }).catch(()=>page.waitForLoadState('networkidle'));
}
async function shot(page, name){
  const dir=path.join('test-results','partner-client-management');
  fs.mkdirSync(dir,{recursive:true});
  await page.screenshot({ path:path.join(dir, `${test.info().project.name}-${name}.png`), fullPage:true, timeout:45000 }).catch(()=>{});
}

async function csrf(page){ return await page.locator('meta[name="csrf-token"]').first().getAttribute('content'); }

test('partner client management: scoped edit, analytics and secure invite links work', async ({ page, context }) => {
  const stamp = Date.now();
  const partnerName = `S52 Partner ${stamp}`;
  const partnerLogin = `s52_partner_${stamp}`;
  const businessName = `S52 Business ${stamp}`;
  const businessLogin = `s52_business_${stamp}`;
  const updatedName = `S52 Updated Business ${stamp}`;

  await login(page, 'admin');
  await page.goto('/admin/platform', { waitUntil:'networkidle' });
  await page.locator('form[action="/admin/platform/partners/new"] input[name="name"]').fill(partnerName);
  await page.locator('form[action="/admin/platform/partners/new"] input[name="contact_name"]').fill('Partner Owner');
  await page.locator('form[action="/admin/platform/partners/new"] input[name="email"]').fill(`${partnerLogin}@example.test`);
  await page.locator('form[action="/admin/platform/partners/new"] input[name="login"]').fill(partnerLogin);
  await page.locator('form[action="/admin/platform/partners/new"] button').click();
  await page.waitForURL(/\/admin\/platform/);

  await page.goto('/admin/platform/partners', { waitUntil:'networkidle' });
  await page.getByRole('link', { name:/Открыть/i }).last().click();
  await expect(page.getByRole('heading', { name: new RegExp(partnerName) })).toBeVisible();
  await page.getByRole('button', { name:/Создать ссылку входа/i }).first().click();
  await expect(page.locator('.invite-box')).toContainText(/Ссылка подключения|одноразовая/i);
  const partnerInvite = await page.locator('.invite-box code').textContent();
  expect(partnerInvite || '').toContain('/admin/invite/');

  await page.goto(partnerInvite, { waitUntil:'domcontentloaded' });
  await page.locator('input[name="password"]').fill('change-me-52');
  await page.locator('input[name="password2"]').fill('change-me-52');
  await page.getByRole('button', { name:/Создать пароль и войти/i }).click();
  await page.waitForURL(/\/admin/, { timeout:20000 });
  await page.locator('form[action="/admin/logout"] button').click();
  await page.waitForURL(/\/admin\/login/, { timeout:20000 });

  await login(page, partnerLogin, 'change-me-52');
  await page.goto('/admin/partner', { waitUntil:'networkidle' });
  await expect(page.getByRole('heading', { name:/Партнёрская админка/i })).toBeVisible();
  await expect(page.locator('.sidebar')).toContainText(/Мои бизнесы|Аналитика партнёра/i);
  await expect(page.locator('.sidebar')).not.toContainText(/Health|Тарифы/i);

  await page.locator('form[action="/admin/partner/businesses/new"] input[name="name"]').fill(businessName);
  await page.locator('form[action="/admin/partner/businesses/new"] input[name="city"]').fill('Пермь');
  await page.locator('form[action="/admin/partner/businesses/new"] input[name="email"]').fill(`${businessLogin}@example.test`);
  await page.locator('form[action="/admin/partner/businesses/new"] input[name="login"]').fill(businessLogin);
  await page.locator('form[action="/admin/partner/businesses/new"] button').click();
  await page.waitForURL(/\/admin\/partner/);

  await page.goto('/admin/partner/businesses', { waitUntil:'networkidle' });
  await expect(page.getByText(businessName).first()).toBeVisible();
  await page.locator('tr', { hasText: businessName }).getByRole('link', { name:/Открыть/i }).first().click();
  await expect(page.getByRole('heading', { name: new RegExp(businessName) })).toBeVisible();
  await expect(page.locator('main')).toContainText(/Карточка бизнеса|Пользователи бизнеса|Страниц памяти|QR-события/i);
  await page.locator('input[name="name"]').fill(updatedName);
  await page.locator('input[name="brand_display_name"]').fill('Бренд для семей S52');
  await page.locator('input[name="public_footer_brand"]').fill('Футер S52');
  await page.locator('select[name="plan"]').selectOption('pro');
  await page.locator('select[name="account_status"]').selectOption('paused');
  await page.getByRole('button', { name:/Сохранить/i }).first().click();
  await page.waitForLoadState('networkidle').catch(()=>{});
  await expect(page.locator('input[name="name"]')).toHaveValue(updatedName);
  await expect(page.locator('select[name="plan"]')).toHaveValue('pro');
  await expect(page.locator('select[name="account_status"]')).toHaveValue('paused');
  await expect(page.locator('select[name="account_status"] option[value="archived"]')).toHaveCount(0);
  await page.getByRole('button', { name:/Создать ссылку входа/i }).first().click();
  await expect(page.locator('.invite-box')).toContainText(/Ссылка подключения|одноразовая/i);
  const invite = await page.locator('.invite-box code').textContent();
  expect(invite || '').toContain('/admin/invite/');
  await shot(page, 'partner-business-detail-invite');

  await page.goto('/admin/partner/analytics?days=30', { waitUntil:'networkidle' });
  await expect(page.locator('main')).toContainText(updatedName);
  await expect(page.locator('main')).toContainText(/Просмотры|QR-события|Заявки семьи|Последняя активность/i);
  await expect(page.locator('main')).not.toContainText(/Прямой клиент/i);

  await login(page, 'admin');
  await page.goto('/admin/platform/analytics?days=30', { waitUntil:'networkidle' });
  await expect(page.locator('main')).toContainText(/Аналитика по бизнесам|Просмотры|QR-события|Заявки семьи/i);
  await expect(page.locator('main')).toContainText(updatedName);

  const token = await csrf(page);
  const direct = await page.request.post('/admin/partner/businesses/999999/managers/1/invite', { headers:{ 'x-csrf-token': token || '' } });
  expect([403,404]).toContain(direct.status());
});
