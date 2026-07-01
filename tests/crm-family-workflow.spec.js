const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

async function login(page, login='manager', password='change-me'){
  await page.goto('/admin/login', { waitUntil:'domcontentloaded' });
  await page.locator('input[name="login"], input[name="username"], input[type="text"]').first().fill(login);
  await page.locator('input[name="password"], input[name="pass"], input[type="password"]').first().fill(password);
  await Promise.all([
    page.waitForURL(/\/admin/, { timeout:20000 }).catch(()=>page.waitForLoadState('networkidle')),
    page.getByRole('button', { name:/войти/i }).click()
  ]);
}
async function shot(page, name){
  const dir = path.join('test-results','crm-family-workflow');
  fs.mkdirSync(dir,{recursive:true});
  await page.screenshot({ path:path.join(dir, `${test.info().project.name}-${name}.png`), fullPage:true, timeout:45000 }).catch(()=>{});
}
async function save(page, re=/Сохранить/i){
  await page.getByRole('button', { name: re }).first().click();
  await page.waitForLoadState('networkidle').catch(()=>{});
  await page.waitForTimeout(500);
}

test('CRM family workflow: assignment, priority, contact log and conversion links work', async ({ page }) => {
  const stamp = Date.now();
  const fullName = `CRM Семья Ивановых ${stamp}`;
  await login(page);

  await page.goto('/admin/submissions/new', { waitUntil:'networkidle' });
  await expect(page.getByRole('heading', { name:/Заявка семьи/i })).toBeVisible();
  await page.locator('input[name="full_name"]').fill(fullName);
  await page.locator('input[name="birth_date"]').fill('1955-03-12');
  await page.locator('input[name="death_date"]').fill('2024-09-18');
  await page.locator('input[name="contact_name"]').fill('Иванова Анна');
  await page.locator('input[name="contact_phone"]').fill('+7 999 777-77-77');
  await page.locator('input[name="city"]').fill('Пермь');
  await page.locator('select[name="priority"]').selectOption('urgent');
  await page.locator('input[name="next_contact_at"]').fill('2030-01-10T12:30');
  await page.locator('textarea[name="epitaph"]').fill('Тёплая фраза из CRM-теста.');
  await page.locator('textarea[name="biography"]').fill('История жизни, переданная семьёй через CRM-тест.');
  await page.locator('textarea[name="memories_text"]').fill('Первое воспоминание CRM\nВторое воспоминание CRM');
  await page.locator('textarea[name="client_stage_note"]').fill('Первичная заметка менеджера.');
  await page.locator('input[name="consent_confirmed"]').check();
  await shot(page, '01-new-submission-filled');
  await save(page, /Сохранить заявку/i);

  await page.goto('/admin/crm?priority=urgent', { waitUntil:'networkidle' });
  await shot(page, '02-crm-board-urgent-filter');
  await expect(page.getByRole('heading', { name:/CRM-доска заявок/i })).toBeVisible();
  await expect(page.getByText(fullName).first()).toBeVisible();
  const crmCard = page.locator('.crm-card', { hasText: fullName }).first();
  await expect(crmCard.locator('.priority-badge.urgent')).toContainText('Срочно');
  await expect(crmCard).toContainText(/Следующий контакт: 2030-01-10T12:30|Следующий контакт: 2030-01-10 12:30/i);

  await page.getByText(fullName).first().click();
  await expect(page.getByRole('heading', { name:/Заявка семьи/i })).toBeVisible();
  await shot(page, '03-submission-detail');
  await expect(page.locator('select[name="priority"]')).toHaveValue('urgent');
  await expect(page.locator('textarea[name="client_stage_note"]')).toContainText('Первичная заметка менеджера');

  await page.locator('textarea[name="contact_note"]').fill('Созвонились с семьёй, ждём ещё две фотографии.');
  await page.locator('form[action$="/contact-log"] input[name="next_contact_at"]').fill('2030-01-11T15:00');
  await page.getByRole('button', { name:/Зафиксировать контакт/i }).click();
  await page.waitForLoadState('networkidle').catch(()=>{});
  await expect(page.locator('textarea[name="admin_note"]')).toContainText('Созвонились с семьёй');
  await expect(page.locator('select[name="status"]')).toHaveValue('in_work');

  await page.getByRole('link', { name:/Заполнить страницу/i }).click();
  await expect(page).toHaveURL(/\/admin\/memorials\/new\?from_submission=/);
  await expect(page.locator('input[name="full_name"]')).toHaveValue(fullName);
  await shot(page, '04-memorial-prefill-from-submission');
});
