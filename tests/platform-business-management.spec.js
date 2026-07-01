const { test, expect } = require('@playwright/test');

async function login(page, login, password='change-me'){
  await page.goto('/admin/login', { waitUntil: 'domcontentloaded' });
  await page.locator('input[name="login"], input[name="username"], input[type="text"]').first().fill(login);
  await page.locator('input[name="password"], input[name="pass"], input[type="password"]').first().fill(password);
  await page.getByRole('button', { name: /войти/i }).click();
  await page.waitForURL(/\/admin/, { timeout: 20000 }).catch(()=>page.waitForLoadState('networkidle'));
}

test('platform business management: super and partner business screens work', async ({ page, request }) => {
  const stamp = Date.now();
  const partnerName = `Session30 Partner ${stamp}`;
  const businessName = `Session30 Business ${stamp}`;
  const partnerLogin = `s30_partner_${stamp}`;
  const businessLogin = `s30_business_${stamp}`;

  await login(page, 'admin');
  await page.goto('/admin/platform/partners', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: /Партнёры/i })).toBeVisible();

  await page.goto('/admin/platform', { waitUntil: 'networkidle' });
  await page.locator('form[action="/admin/platform/partners/new"] input[name="name"]').fill(partnerName);
  await page.locator('form[action="/admin/platform/partners/new"] input[name="contact_name"]').fill('QA Partner Owner');
  await page.locator('form[action="/admin/platform/partners/new"] input[name="phone"]').fill('+7 999 300 30 30');
  await page.locator('form[action="/admin/platform/partners/new"] input[name="email"]').fill(`${partnerLogin}@example.test`);
  await page.locator('form[action="/admin/platform/partners/new"] input[name="login"]').fill(partnerLogin);
  await page.locator('form[action="/admin/platform/partners/new"] button').click();
  await page.waitForURL(/\/admin\/platform/);

  await page.goto('/admin/platform/partners', { waitUntil: 'networkidle' });
  await expect(page.getByText(partnerName)).toBeVisible();

  await page.goto('/admin/platform', { waitUntil: 'networkidle' });
  const partnerOption = page.locator('select[name="partner_id"] option', { hasText: partnerName });
  await expect(partnerOption).toHaveCount(1);
  const partnerId = await partnerOption.first().getAttribute('value');
  await page.locator('form[action="/admin/platform/businesses/new"] select[name="partner_id"]').selectOption(partnerId);
  await page.locator('form[action="/admin/platform/businesses/new"] input[name="name"]').fill(businessName);
  await page.locator('form[action="/admin/platform/businesses/new"] input[name="city"]').fill('Пермь');
  await page.locator('form[action="/admin/platform/businesses/new"] input[name="email"]').fill(`${businessLogin}@example.test`);
  await page.locator('form[action="/admin/platform/businesses/new"] input[name="login"]').fill(businessLogin);
  await page.locator('form[action="/admin/platform/businesses/new"] button').click();
  await page.waitForURL(/\/admin\/platform/);

  await page.goto('/admin/platform/businesses', { waitUntil: 'networkidle' });
  await expect(page.getByText(businessName)).toBeVisible();
  await expect(page.getByText(partnerName)).toBeVisible();

  const openLink = page.locator('tr', { hasText: businessName }).getByRole('link', { name: /Открыть/i }).first();
  await openLink.click();
  await expect(page.getByRole('heading', { name: new RegExp(businessName) })).toBeVisible();
  await page.locator('select[name="plan"]').selectOption('pro');
  await page.locator('select[name="account_status"]').selectOption('paused');
  await page.getByRole('button', { name: /Сохранить/i }).click();
  await page.waitForLoadState('networkidle').catch(()=>{});
  await expect(page.locator('select[name="plan"]')).toHaveValue('pro');
  await expect(page.locator('select[name="account_status"]')).toHaveValue('paused');

  await page.goto('/admin/logout', { waitUntil: 'domcontentloaded' }).catch(()=>{});
  await login(page, partnerLogin);
  await page.goto('/admin/partner/businesses', { waitUntil: 'networkidle' });
  await expect(page.getByText(businessName)).toBeVisible();
  await expect(page.getByText('Прямой клиент')).toHaveCount(0);
});
