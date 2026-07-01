const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

async function login(page, login, password='change-me'){
  await page.goto('/admin/login', { waitUntil:'domcontentloaded' });
  await page.locator('input[name="login"], input[name="username"], input[type="text"]').first().fill(login);
  await page.locator('input[name="password"], input[name="pass"], input[type="password"]').first().fill(password);
  await page.getByRole('button', { name:/войти/i }).click();
  await page.waitForURL(/\/admin/, { timeout:20000 }).catch(()=>page.waitForLoadState('networkidle'));
}
async function shot(page, name){
  const dir = path.join('test-results','audit-impersonation');
  fs.mkdirSync(dir,{recursive:true});
  await page.screenshot({ path:path.join(dir, `${test.info().project.name}-${name}.png`), fullPage:true, timeout:45000 }).catch(()=>{});
}
async function createPartnerAndBusiness(page, stamp){
  const partnerName = `Session33 Audit Partner ${stamp}`;
  const partnerLogin = `s33_partner_${stamp}`;
  const businessName = `Session33 Audit Business ${stamp}`;
  const businessLogin = `s33_business_${stamp}`;
  await login(page, 'admin');
  await page.goto('/admin/platform', { waitUntil:'networkidle' });
  await page.locator('form[action="/admin/platform/partners/new"] input[name="name"]').fill(partnerName);
  await page.locator('form[action="/admin/platform/partners/new"] input[name="contact_name"]').fill('Audit Partner Owner');
  await page.locator('form[action="/admin/platform/partners/new"] input[name="email"]').fill(`${partnerLogin}@example.test`);
  await page.locator('form[action="/admin/platform/partners/new"] input[name="login"]').fill(partnerLogin);
  await page.locator('form[action="/admin/platform/partners/new"] button').click();
  await page.waitForURL(/\/admin\/platform/);

  await page.goto('/admin/platform', { waitUntil:'networkidle' });
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
  return { partnerName, partnerLogin, businessName, businessLogin };
}

test('audit log: impersonation is visible and scoped for platform and partner', async ({ page, browser }) => {
  const stamp = Date.now();
  const { partnerName, partnerLogin, businessName } = await createPartnerAndBusiness(page, stamp);

  await page.goto('/admin/platform/businesses', { waitUntil:'networkidle' });
  const row = page.locator('tr', { hasText: businessName });
  await row.getByRole('button', { name:/Войти как бизнес/i }).click();
  await page.waitForURL(/\/admin/);
  await expect(page.getByText(/Режим помощи/i)).toBeVisible();
  await expect(page.getByText(businessName).first()).toBeVisible();
  await shot(page, 'super-impersonation-banner');

  await page.goto('/admin/company', { waitUntil:'networkidle' });
  await page.locator('input[name="city"]').fill('Пермь — audit check');
  await page.getByRole('button', { name:/Сохранить/i }).click();
  await page.waitForLoadState('networkidle').catch(()=>{});

  await page.goto('/admin/platform/audit', { waitUntil:'networkidle' });
  await shot(page, 'platform-audit');
  await expect(page.getByRole('heading', { name:/Audit log платформы/i })).toBeVisible();
  await expect(page.locator('main')).toContainText('impersonate_business');
  await expect(page.locator('main')).toContainText('update_company');
  await expect(page.locator('main')).toContainText('impersonation');
  await expect(page.locator('main')).toContainText(businessName);

  await page.getByRole('button', { name:/Выйти из бизнеса/i }).click();
  await page.waitForURL(/\/admin\/platform/);

  const partnerContext = await browser.newContext();
  const partnerPage = await partnerContext.newPage();
  await login(partnerPage, partnerLogin);
  await partnerPage.goto('/admin/partner/businesses', { waitUntil:'networkidle' });
  await partnerPage.locator('tr', { hasText: businessName }).getByRole('button', { name:/Войти как бизнес/i }).click();
  await partnerPage.waitForURL(/\/admin/);
  await expect(partnerPage.getByText(/Режим помощи/i)).toBeVisible();
  await shot(partnerPage, 'partner-impersonation-banner');

  await partnerPage.goto('/admin/company', { waitUntil:'networkidle' });
  await partnerPage.locator('input[name="phone"]').fill('+7 999 333-00-33');
  await partnerPage.getByRole('button', { name:/Сохранить/i }).click();
  await partnerPage.waitForLoadState('networkidle').catch(()=>{});

  await partnerPage.goto('/admin/partner/audit', { waitUntil:'networkidle' });
  await shot(partnerPage, 'partner-audit');
  await expect(partnerPage.getByRole('heading', { name:/Audit log партнёра/i })).toBeVisible();
  await expect(partnerPage.locator('main')).toContainText(partnerName);
  await expect(partnerPage.locator('main')).toContainText(businessName);
  await expect(partnerPage.locator('main')).toContainText('impersonate_business');
  await expect(partnerPage.locator('main')).toContainText('update_company');
  await expect(partnerPage.locator('main')).toContainText('impersonation');
  await partnerContext.close();
});
