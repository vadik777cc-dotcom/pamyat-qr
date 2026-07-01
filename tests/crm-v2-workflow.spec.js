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
  const dir = path.join('test-results','crm-v2-workflow');
  fs.mkdirSync(dir,{recursive:true});
  await page.screenshot({ path:path.join(dir, `${test.info().project.name}-${name}.png`), fullPage:true, timeout:45000 }).catch(()=>{});
}
async function save(page, re=/Сохранить/i){
  await page.getByRole('button', { name: re }).first().click();
  await page.waitForLoadState('networkidle').catch(()=>{});
  await page.waitForTimeout(400);
}

test('CRM v2: filters, quick actions and timeline are useful in daily workflow', async ({ page }) => {
  const stamp = Date.now();
  const fullName = `CRM V2 Петровы ${stamp}`;
  await login(page);

  await page.goto('/admin/submissions/new', { waitUntil:'networkidle' });
  await page.locator('input[name="full_name"]').fill(fullName);
  await page.locator('input[name="contact_phone"]').fill('+7 999 555-22-11');
  await page.locator('input[name="notify_email"]').fill(`crm-v2-${stamp}@example.ru`);
  await page.locator('input[name="city"]').fill('Пермь');
  await page.locator('select[name="priority"]').selectOption('high');
  await page.locator('input[name="next_contact_at"]').fill('2030-02-03T10:30');
  await page.locator('textarea[name="client_stage_note"]').fill('CRM v2 заметка до первого звонка.');
  await page.locator('input[name="consent_confirmed"]').check();
  await save(page, /Сохранить заявку/i);

  await page.goto('/admin/crm', { waitUntil:'networkidle' });
  await shot(page, '01-board-before-live-search');
  await expect(page.getByRole('heading', { name:/CRM-доска заявок/i })).toBeVisible();
  await expect(page.locator('.crm-status-stats')).toContainText('Ожидает семью');
  await expect(page.locator('.crm-status-stats')).toContainText('Завершена');
  await expect(page.locator('.crm-status-stats')).toContainText('Отменена');

  await page.locator('input[name="q"]').fill(fullName);
  const card = page.locator('.crm-card', { hasText: fullName }).first();
  await expect(card).toBeVisible();
  await expect(card.locator('.priority-badge.high')).toContainText('Высокий');
  await expect(card.locator('.crm-quick-actions')).toContainText(/Позвонить|Написать|Открыть карточку/);
  await shot(page, '02-board-live-search-filtered');

  await card.locator('.crm-title').click();
  await expect(page.getByRole('heading', { name:/Заявка семьи/i })).toBeVisible();
  await expect(page.locator('.crm-actions-panel')).toContainText(/Позвонить|Написать email|Создать страницу памяти/);
  await expect(page.locator('.crm-timeline')).toContainText(/create_submission|История пуста|Заявка/);
  await page.locator('textarea[name="contact_note"]').fill('CRM v2: первый звонок, семья ждёт согласование текста.');
  await page.locator('form[action$="/contact-log"] input[name="next_contact_at"]').fill('2030-02-04T11:00');
  await page.getByRole('button', { name:/Зафиксировать контакт/i }).click();
  await page.waitForLoadState('networkidle').catch(()=>{});
  await expect(page.locator('.crm-timeline')).toContainText(/CRM v2: первый звонок|log_family_contact|Контакт с семьёй/);
  await expect(page.locator('select[name="status"]')).toHaveValue('in_work');
  await shot(page, '03-detail-timeline-after-contact');

  await page.goto('/admin/crm?status=in_work', { waitUntil:'networkidle' });
  await expect(page.locator('.crm-card', { hasText: fullName }).first()).toBeVisible();
});
