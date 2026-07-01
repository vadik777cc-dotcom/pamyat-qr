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
  const dir = path.join('test-results','export-backup-workflow');
  fs.mkdirSync(dir,{recursive:true});
  await page.screenshot({ path:path.join(dir, `${test.info().project.name}-${name}.png`), fullPage:true, timeout:45000 }).catch(()=>{});
}
async function createSubmission(page, fullName){
  await page.goto('/admin/submissions/new', { waitUntil:'networkidle' });
  await page.locator('input[name="full_name"]').fill(fullName);
  await page.locator('input[name="birth_date"]').fill('1949-01-02');
  await page.locator('input[name="death_date"]').fill('2024-03-04');
  await page.locator('input[name="contact_phone"]').fill('+7 999 555-44-33');
  await page.locator('input[name="notify_email"]').fill('export-family@example.test');
  await page.locator('textarea[name="comment"]').fill('Session38 export backup CRM comment');
  await page.locator('input[name="consent_confirmed"]').check();
  await page.getByRole('button', { name:/Сохранить заявку/i }).click();
  await page.waitForURL(/\/admin\/submissions/);
}

test('export and backup: CRM, memorial exports and business ZIP are scoped and logged', async ({ page }) => {
  const stamp = Date.now();
  const fullName = `Export Backup Family ${stamp}`;
  await login(page);
  await createSubmission(page, fullName);

  await page.goto('/admin/backups', { waitUntil:'networkidle' });
  await shot(page, '01-export-dashboard-before');
  await expect(page.getByRole('heading', { name:/Экспорт и резервные копии/i })).toBeVisible();
  await expect(page.locator('main')).toContainText(/Экспорт CRM CSV|Экспорт страниц CSV|Резервная копия бизнеса/);

  const crm = await page.request.get('/admin/backups/crm.csv');
  expect(crm.status()).toBe(200);
  expect(crm.headers()['content-disposition']).toMatch(/crm/i);
  const crmText = await crm.text();
  expect(crmText).toContain(fullName);
  expect(crmText).toContain('+7 999 555-44-33');

  const memorials = await page.request.get('/admin/backups/memorials.csv');
  expect(memorials.status()).toBe(200);
  expect(memorials.headers()['content-disposition']).toMatch(/memorials/i);
  const memorialText = await memorials.text();
  expect(memorialText).toContain('full_name');

  const xlsx = await page.request.get('/admin/backups/crm.xlsx');
  expect(xlsx.status()).toBe(200);
  expect(xlsx.headers()['content-disposition']).toMatch(/\.xlsx/i);

  const zip = await page.request.get('/admin/backups/business.zip');
  expect(zip.status()).toBe(200);
  expect(zip.headers()['content-type']).toMatch(/zip/i);
  expect(Number(zip.headers()['content-length'] || 1)).toBeGreaterThan(0);

  await page.goto('/admin/backups', { waitUntil:'networkidle' });
  await shot(page, '02-export-dashboard-after');
  await expect(page.locator('main')).toContainText(/CRM|Страницы памяти|Backup бизнеса/);
  await expect(page.locator('main')).toContainText(/pamyat-qr-crm|pamyat-qr-memorials|pamyat-qr-business/);

  await page.goto('/admin/notifications?event_type=export_created', { waitUntil:'networkidle' });
  await expect(page.locator('main')).toContainText(/Экспорт создан/);
  await page.goto('/admin/notifications?event_type=backup_created', { waitUntil:'networkidle' });
  await expect(page.locator('main')).toContainText(/Резервная копия создана/);
});
