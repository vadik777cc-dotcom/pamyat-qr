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
  const dir = path.join('test-results','restore-backup-workflow');
  fs.mkdirSync(dir,{recursive:true});
  await page.screenshot({ path:path.join(dir, `${test.info().project.name}-${name}.png`), fullPage:true, timeout:45000 }).catch(()=>{});
}
async function createSubmission(page, fullName, phone){
  await page.goto('/admin/submissions/new', { waitUntil:'networkidle' });
  await page.locator('input[name="full_name"]').fill(fullName);
  await page.locator('input[name="birth_date"]').fill('1941-01-02');
  await page.locator('input[name="death_date"]').fill('2024-03-04');
  await page.locator('input[name="contact_phone"]').fill(phone);
  await page.locator('textarea[name="comment"]').fill(`Restore QA comment ${fullName}`);
  await page.locator('input[name="consent_confirmed"]').check();
  await page.getByRole('button', { name:/Сохранить заявку/i }).click();
  await page.waitForURL(/\/admin\/submissions/);
}

test('restore backup: preview, confirmation and scoped CRM restore work safely', async ({ page }) => {
  const stamp = Date.now();
  const original = `Restore Original Family ${stamp}`;
  const extra = `Restore Extra Family ${stamp}`;
  const tmp = path.join('test-results','restore-backup-workflow',`backup-${stamp}.zip`);
  fs.mkdirSync(path.dirname(tmp), { recursive:true });

  await login(page);
  await createSubmission(page, original, '+7 999 700-00-01');

  await page.goto('/admin/backups', { waitUntil:'networkidle' });
  const businessName = (await page.locator('aside b, .brand b, h1').first().innerText().catch(()=>'')) || 'Светлая Память';
  const zip = await page.request.get('/admin/backups/business.zip');
  expect(zip.status()).toBe(200);
  fs.writeFileSync(tmp, Buffer.from(await zip.body()));

  await createSubmission(page, extra, '+7 999 700-00-02');
  await page.goto('/admin/submissions', { waitUntil:'networkidle' });
  await expect(page.locator('main')).toContainText(extra);

  await page.goto('/admin/backups', { waitUntil:'networkidle' });
  await page.locator('input[type="file"][name="backup_zip"]').setInputFiles(tmp);
  await page.getByRole('button', { name:/Предпросмотр восстановления/i }).click();
  await page.waitForURL(/\/admin\/backups\/restore\/preview|\/admin\/backups/i).catch(()=>{});
  await shot(page, '01-restore-preview');
  await expect(page.getByRole('heading', { name:/Предпросмотр восстановления/i })).toBeVisible();
  await expect(page.locator('main')).toContainText(/CRM-заявки/);

  await page.locator('input[name="restore_memorials"]').uncheck();
  await page.locator('input[name="restore_settings"]').uncheck();
  await page.locator('input[name="confirm_business_name"]').fill(businessName.trim());
  await page.getByRole('button', { name:/Восстановить/i }).click();
  await expect(page.getByRole('heading', { name:/Backup восстановлен/i })).toBeVisible();
  await shot(page, '02-restore-report');
  await expect(page.locator('main')).toContainText(/Restore report|CRM-заявки|Ошибок: 0/i);

  await page.goto('/admin/submissions', { waitUntil:'networkidle' });
  await expect(page.locator('main')).toContainText(original);
  await expect(page.locator('main')).not.toContainText(extra);

  await page.goto('/admin/notifications?event_type=backup_restored', { waitUntil:'networkidle' });
  await expect(page.locator('main')).toContainText(/Резервная копия восстановлена|Backup восстановлен/i);
});
