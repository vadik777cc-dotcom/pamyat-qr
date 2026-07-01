const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');

async function login(page, login='manager'){
  await page.goto('/admin/login', { waitUntil:'domcontentloaded' });
  await page.locator('input[name="login"], input[name="username"], input[type="text"]').first().fill(login);
  await page.locator('input[name="password"], input[name="pass"], input[type="password"]').first().fill('change-me');
  await Promise.all([
    page.waitForURL(/\/admin/, { timeout:20000 }).catch(()=>page.waitForLoadState('networkidle')),
    page.getByRole('button', { name:/войти/i }).click()
  ]);
}
async function shot(page, name){
  const dir = path.join('test-results','plan-limits-workflow');
  fs.mkdirSync(dir,{recursive:true});
  await page.screenshot({ path:path.join(dir, `${test.info().project.name}-${name}.png`), fullPage:true, timeout:45000 }).catch(()=>{});
}
function ensureTrialLimitReached(companyId){
  const current = db.prepare("SELECT COUNT(*) AS n FROM memorials WHERE company_id=? AND status != 'archived'").get(companyId).n;
  const need = Math.max(0, 3 - current);
  for(let i=0;i<need;i++){
    const suffix = `${Date.now()}-${i}`;
    db.prepare(`INSERT INTO memorials (uuid,company_id,full_name,slug,public_token,birth_date,death_date,quote,epitaph,biography,main_photo,status,privacy_status,noindex,consent_confirmed,footer_text)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      uuidv4(), companyId, `Лимитный тест ${suffix}`, `limit-test-${suffix}`, `lt-${suffix}`,
      '1940-01-01', '2020-01-01', 'Память жива.', 'Тестовая запись для проверки лимитов.',
      'Эта запись создаётся автоматическим QA для проверки тарифного лимита.',
      '/static/assets/memory/hero-portrait-bg.webp', 'draft', 'unlisted', 1, 1, 'Тестовый footer'
    );
  }
}
function cleanup(companyId){
  db.prepare("DELETE FROM memorials WHERE company_id=? AND slug LIKE 'limit-test-%'").run(companyId);
  db.prepare("UPDATE companies SET plan='standard', account_status='active', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(companyId);
}

test('plan limits: platform sees tariff matrix and business creation is blocked at limit', async ({ page }) => {
  await login(page, 'admin');
  await page.goto('/admin/platform/plans', { waitUntil:'networkidle' });
  await expect(page.getByRole('heading', { name:/Тарифы и лимиты/i })).toBeVisible();
  await expect(page.locator('main')).toContainText(/Trial|Standard|Pro|Enterprise/i);
  await expect(page.locator('main')).toContainText(/White-label|Домен|Backup/i);
  await shot(page, '01-platform-plans');

  const company = db.prepare(`
    SELECT c.* FROM companies c
    JOIN managers m ON m.company_id = c.id
    WHERE m.login='manager'
    ORDER BY c.id LIMIT 1
  `).get() || db.prepare("SELECT * FROM companies ORDER BY id LIMIT 1").get();
  expect(company).toBeTruthy();
  try{
    db.prepare("UPDATE companies SET plan='trial', account_status='trial', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(company.id);
    ensureTrialLimitReached(company.id);

    await login(page, 'manager');
    await page.goto('/admin/plan', { waitUntil:'networkidle' });
    await expect(page.getByRole('heading', { name:/Тариф и лимиты/i })).toBeVisible();
    await expect(page.locator('main')).toContainText(/Trial|Лимит страниц памяти|Страницы памяти/i);
    await expect(page.locator('main')).toContainText(/3\s*\/\s*3|3\/3/i);
    await shot(page, '02-business-plan-limit');

    const blocked = await page.goto('/admin/memorials/new', { waitUntil:'domcontentloaded' });
    expect(blocked.status()).toBe(403);
    await expect(page.locator('body')).toContainText(/Лимит тарифа исчерпан|Посмотреть тариф/i);
    await shot(page, '03-limit-blocked');
  } finally {
    cleanup(company.id);
  }
});
