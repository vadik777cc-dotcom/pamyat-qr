const { test, expect } = require('@playwright/test');

async function login(page, login, password = 'change-me'){
  await page.goto('/admin/login', { waitUntil:'domcontentloaded' });
  await page.locator('input[name="login"], input[name="username"], input[type="text"]').first().fill(login);
  await page.locator('input[name="password"], input[name="pass"], input[type="password"]').first().fill(password);
  await Promise.all([
    page.waitForURL(/\/admin/, { timeout:20000 }).catch(() => page.waitForLoadState('networkidle')),
    page.getByRole('button', { name:/войти/i }).click()
  ]);
}

async function csrf(page){
  return await page.locator('meta[name="csrf-token"]').first().getAttribute('content');
}

test('access isolation: platform, partner and business scopes are enforced by direct URLs', async ({ browser }) => {
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await login(admin, 'admin');
  await expect(admin).toHaveURL(/\/admin\/platform/);
  await expect(admin.locator('body')).toContainText('Платформа');
  const adminLanding = await admin.goto('/admin/landing', { waitUntil:'domcontentloaded' });
  expect(adminLanding.status()).toBeLessThan(400);
  await expect(admin).toHaveURL(/\/admin\/platform/);
  await adminContext.close();

  const partnerContext = await browser.newContext();
  const partner = await partnerContext.newPage();
  await login(partner, 'partner');
  await expect(partner).toHaveURL(/\/admin\/partner/);
  const platformForbidden = await partner.goto('/admin/platform', { waitUntil:'domcontentloaded' });
  expect(platformForbidden.status()).toBe(403);
  const partnerLanding = await partner.goto('/admin/landing', { waitUntil:'domcontentloaded' });
  expect(partnerLanding.status()).toBeLessThan(400);
  await expect(partner).toHaveURL(/\/admin\/partner/);
  const token = await csrf(partner);
  const directBusinessAttempt = await partner.request.post('/admin/partner/businesses/1/impersonate', {
    headers: { 'x-csrf-token': token || '' }
  });
  expect([403, 404]).toContain(directBusinessAttempt.status());
  await partnerContext.close();

  const businessContext = await browser.newContext();
  const business = await businessContext.newPage();
  await login(business, process.env.ADMIN_LOGIN || 'manager', process.env.ADMIN_PASSWORD || 'change-me');
  await expect(business).toHaveURL(/\/admin/);
  const businessPlatform = await business.goto('/admin/platform', { waitUntil:'domcontentloaded' });
  expect(businessPlatform.status()).toBe(403);
  const businessPartner = await business.goto('/admin/partner', { waitUntil:'domcontentloaded' });
  expect(businessPartner.status()).toBe(403);
  await businessContext.close();
});
