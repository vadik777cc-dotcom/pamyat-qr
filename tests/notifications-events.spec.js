const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

async function login(page, login='manager', password='change-me'){
  await page.goto('/admin/login', { waitUntil:'domcontentloaded' });
  await page.locator('input[name="login"], input[name="username"], input[type="text"]').first().fill(login);
  await page.locator('input[name="password"], input[name="pass"], input[type="password"]').first().fill(password);
  await page.getByRole('button', { name:/войти/i }).click();
  await page.waitForURL(/\/admin/, { timeout:20000 }).catch(()=>page.waitForLoadState('networkidle'));
}
async function shot(page, name){
  const dir = path.join('test-results','notifications-events');
  fs.mkdirSync(dir,{recursive:true});
  await page.screenshot({ path:path.join(dir, `${test.info().project.name}-${name}.png`), fullPage:true, timeout:45000 }).catch(()=>{});
}
async function createPartnerAndBusiness(page, stamp){
  const partnerName = `Session36 Events Partner ${stamp}`;
  const partnerLogin = `s36_partner_${stamp}`;
  const businessName = `Session36 Events Business ${stamp}`;
  const businessLogin = `s36_business_${stamp}`;
  await login(page, 'admin');
  await page.goto('/admin/platform', { waitUntil:'networkidle' });
  await page.locator('form[action="/admin/platform/partners/new"] input[name="name"]').fill(partnerName);
  await page.locator('form[action="/admin/platform/partners/new"] input[name="contact_name"]').fill('Events Partner Owner');
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

test('notifications and events: business and partner see useful scoped event feed', async ({ page, browser }) => {
  const stamp = Date.now();
  const { partnerName, partnerLogin, businessName, businessLogin } = await createPartnerAndBusiness(page, stamp);
  const fullName = `Events Family ${stamp}`;

  const businessContext = await browser.newContext();
  const businessPage = await businessContext.newPage();
  await login(businessPage, businessLogin);
  await businessPage.goto('/admin/submissions/new', { waitUntil:'networkidle' });
  await businessPage.locator('input[name="full_name"]').fill(fullName);
  await businessPage.locator('input[name="contact_phone"]').fill('+7 999 444-22-11');
  await businessPage.locator('input[name="notify_email"]').fill(`events-${stamp}@example.test`);
  await businessPage.locator('select[name="priority"]').selectOption('urgent');
  await businessPage.locator('input[name="consent_confirmed"]').check();
  await businessPage.getByRole('button', { name:/Сохранить заявку/i }).click();
  await businessPage.waitForURL(/\/admin\/submissions/);

  await businessPage.goto('/admin/crm', { waitUntil:'networkidle' });
  await expect(businessPage.locator('.crm-card', { hasText: fullName }).first()).toBeVisible();
  await businessPage.locator('.crm-card', { hasText: fullName }).first().locator('.crm-title').click();
  await businessPage.locator('textarea[name="contact_note"]').fill('Session36: семья попросила прислать ссылку после публикации.');
  await businessPage.getByRole('button', { name:/Зафиксировать контакт/i }).click();
  await businessPage.waitForLoadState('networkidle').catch(()=>{});

  await businessPage.goto('/admin/notifications', { waitUntil:'networkidle' });
  await shot(businessPage, 'business-events-feed');
  await expect(businessPage.getByRole('heading', { name:/Уведомления и события/i })).toBeVisible();
  await expect(businessPage.locator('main')).toContainText('Центр событий');
  await expect(businessPage.locator('main')).toContainText('Новая заявка семьи');
  await expect(businessPage.locator('main')).toContainText(fullName);
  await expect(businessPage.locator('main')).toContainText('Контакт с семьёй');
  await businessPage.selectOption('select[name="channel"]', 'system');
  await businessPage.getByRole('button', { name:/Фильтр/i }).click();
  await expect(businessPage.locator('main')).toContainText('Системные');
  await businessPage.getByRole('button', { name:/Отметить всё прочитанным/i }).click();
  await businessPage.waitForLoadState('networkidle').catch(()=>{});
  await expect(businessPage.locator('main')).toContainText(/0\s*непрочитанных/);
  await businessContext.close();

  const partnerContext = await browser.newContext();
  const partnerPage = await partnerContext.newPage();
  await login(partnerPage, partnerLogin);
  await partnerPage.goto('/admin/partner/events', { waitUntil:'networkidle' });
  await shot(partnerPage, 'partner-events-feed');
  await expect(partnerPage.getByRole('heading', { name:/События партнёра/i })).toBeVisible();
  await expect(partnerPage.locator('main')).toContainText(partnerName);
  await expect(partnerPage.locator('main')).toContainText(businessName);
  await expect(partnerPage.locator('main')).toContainText(fullName);
  await expect(partnerPage.locator('main')).toContainText('Новая заявка семьи');
  await expect(partnerPage.locator('main')).toContainText('Контакт с семьёй');
  await partnerContext.close();
});
