const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const outDir = path.join(process.cwd(), 'test-results', 'form-persistence');
function ensureDir(){ fs.mkdirSync(outDir, { recursive:true }); }
async function shot(page, name){ ensureDir(); await page.screenshot({ path:path.join(outDir, `${test.info().project.name}-${name}.png`), fullPage:true }); }

async function login(page) {
  await page.goto('/admin/login', { waitUntil: 'domcontentloaded' });
  await page.locator('input[name="login"], input[name="username"], input[type="text"]').first().fill(process.env.ADMIN_LOGIN || 'manager');
  await page.locator('input[name="password"], input[name="pass"], input[type="password"]').first().fill(process.env.ADMIN_PASSWORD || 'change-me');
  await Promise.all([
    page.waitForURL(/\/admin/, { timeout: 20000 }).catch(() => page.waitForLoadState('networkidle')),
    page.getByRole('button', { name: /войти/i }).click()
  ]);
}

async function clickSave(page) {
  await page.getByRole('button', { name: /сохранить/i }).first().click();
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(900);
}


async function clickTab(page, name) {
  const btn = page.getByRole('button', { name: new RegExp(name, 'i') }).first();
  if (await btn.count()) {
    await btn.click();
    await page.waitForTimeout(250);
  }
}

async function clearBrowserDrafts(page) {
  await page.evaluate(() => {
    try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}
  });
}

test('form persistence: landing fields survive save and reload', async ({ page }) => {
  const bad = [];
  page.on('response', res => { if (res.status() >= 400 && !res.url().includes('/favicon.ico')) bad.push({ status: res.status(), url: res.url() }); });

  await login(page);
  await page.goto('/admin/landing', { waitUntil:'networkidle' });
  await shot(page, 'landing-before-edit');

  const stamp = Date.now().toString().slice(-6);
  const title = `QA лендинг сохранение ${stamp}`;
  const subtitle = `QA подзаголовок сохраняется после перезагрузки ${stamp}`;
  const cta = `QA кнопка ${stamp}`;

  await page.locator('input[name="hero_title"], textarea[name="hero_title"]').first().fill(title);
  await page.locator('input[name="hero_subtitle"], textarea[name="hero_subtitle"]').first().fill(subtitle);
  await page.locator('input[name="hero_primary_label"], textarea[name="hero_primary_label"]').first().fill(cta);
  await clickSave(page);
  await shot(page, 'landing-after-save');

  await clearBrowserDrafts(page);
  await page.goto('/admin/landing', { waitUntil:'networkidle' });
  await shot(page, 'landing-after-reload');

  await expect(page.locator('input[name="hero_title"], textarea[name="hero_title"]').first()).toHaveValue(title);
  await expect(page.locator('input[name="hero_subtitle"], textarea[name="hero_subtitle"]').first()).toHaveValue(subtitle);
  await expect(page.locator('input[name="hero_primary_label"], textarea[name="hero_primary_label"]').first()).toHaveValue(cta);
  expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
});

test('form persistence: memorial fields survive save and reload', async ({ page }) => {
  const bad = [];
  page.on('response', res => { if (res.status() >= 400 && !res.url().includes('/favicon.ico')) bad.push({ status: res.status(), url: res.url() }); });

  await login(page);
  await page.goto('/admin/memorials', { waitUntil:'networkidle' });
  await page.getByRole('link', { name: /редактировать/i }).first().click();
  await page.waitForLoadState('networkidle').catch(() => {});
  await shot(page, 'memorial-before-edit');

  const editorUrl = page.url();
  const stamp = Date.now().toString().slice(-6);
  const fullName = `QA Сохранение Орлов ${stamp}`;
  const quote = `QA цитата сохраняется ${stamp}`;
  const epitaph = `QA эпитафия сохраняется после повторного открытия ${stamp}`;
  const biography = `QA история жизни сохраняется после перезагрузки редактора. Проверка ${stamp}.`;
  const footer = `QA финальная фраза ${stamp}`;

  await page.locator('input[name="full_name"]').first().fill(fullName);
  const birth = page.locator('input[name="birth_date"]');
  const death = page.locator('input[name="death_date"]');
  if (await birth.count()) await birth.fill('1951-03-14');
  if (await death.count()) await death.fill('2023-08-22');
  await page.locator('input[name="quote"], textarea[name="quote"]').first().fill(quote);
  await page.locator('input[name="epitaph"], textarea[name="epitaph"]').first().fill(epitaph);
  await page.locator('textarea[name="biography"], input[name="biography"]').first().fill(biography);
  await clickTab(page, 'Финал');
  const footerField = page.locator('textarea[name="footer_text"], input[name="footer_text"]').first();
  if (await footerField.count()) await footerField.fill(footer);

  await clickSave(page);
  await shot(page, 'memorial-after-save');

  await clearBrowserDrafts(page);
  await page.goto(editorUrl, { waitUntil:'networkidle' });
  await shot(page, 'memorial-after-reload');

  await expect(page.locator('input[name="full_name"]').first()).toHaveValue(fullName);
  await expect(page.locator('input[name="birth_date"]').first()).toHaveValue('1951-03-14');
  await expect(page.locator('input[name="death_date"]').first()).toHaveValue('2023-08-22');
  await expect(page.locator('input[name="quote"], textarea[name="quote"]').first()).toHaveValue(quote);
  await expect(page.locator('input[name="epitaph"], textarea[name="epitaph"]').first()).toHaveValue(epitaph);
  await expect(page.locator('textarea[name="biography"], input[name="biography"]').first()).toHaveValue(biography);
  await clickTab(page, 'Финал');
  const footerReloaded = page.locator('textarea[name="footer_text"], input[name="footer_text"]').first();
  if (await footerReloaded.count()) await expect(footerReloaded).toHaveValue(footer);

  expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
});
