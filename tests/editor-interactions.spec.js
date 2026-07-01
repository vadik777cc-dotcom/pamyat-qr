const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const outDir = path.join(process.cwd(), 'test-results', 'interaction-screens');
function ensureDir(){ fs.mkdirSync(outDir, { recursive: true }); }
function safeName(name){ return name.replace(/[^a-z0-9а-яё_-]+/gi, '-').toLowerCase(); }
async function shot(page, name){ ensureDir(); await page.screenshot({ path: path.join(outDir, `${test.info().project.name}-${safeName(name)}.png`), fullPage: true }); }
async function login(page){
  await page.goto('/admin/login', { waitUntil: 'domcontentloaded' });
  await page.locator('input[name="login"], input[name="username"], input[type="text"]').first().fill(process.env.ADMIN_LOGIN || 'manager');
  await page.locator('input[name="password"], input[name="pass"], input[type="password"]').first().fill(process.env.ADMIN_PASSWORD || 'change-me');
  await Promise.all([
    page.waitForURL(/\/admin/, { timeout: 20000 }).catch(() => page.waitForLoadState('networkidle')),
    page.getByRole('button', { name: /войти/i }).click()
  ]);
}
async function clickIfVisible(page, role, name){
  const loc = page.getByRole(role, { name }).first();
  if (await loc.count()) {
    await loc.click().catch(() => {});
    await page.waitForTimeout(250);
    return true;
  }
  return false;
}
async function collectProblems(page, problems){
  page.on('console', msg => { if (msg.type() === 'error') problems.push({ type:'console', text: msg.text() }); });
  page.on('pageerror', err => problems.push({ type:'pageerror', text: err.message }));
  page.on('response', res => { const s=res.status(), u=res.url(); if(s>=400 && !u.includes('/favicon.ico')) problems.push({ type:'http', status:s, url:u }); });
}

test('UX: вкладки и предпросмотр редакторов', async ({ page }) => {
  const problems = [];
  await collectProblems(page, problems);
  await login(page);

  await page.goto('/admin/landing', { waitUntil: 'networkidle' });
  await shot(page, 'landing-00-initial');
  for (const tab of [/Hero/i, /Блоки/i, /Навигация/i, /Контакты/i, /FAQ/i]) {
    await clickIfVisible(page, 'button', tab);
    await shot(page, `landing-tab-${tab.source}`);
  }
  await clickIfVisible(page, 'button', /Mobile/i);
  await shot(page, 'landing-preview-mobile');
  await clickIfVisible(page, 'button', /Desktop/i);
  await shot(page, 'landing-preview-desktop');

  await page.goto('/admin/memorials', { waitUntil: 'networkidle' });
  const edit = page.getByRole('link', { name: /редактировать/i }).first();
  await expect(edit).toBeVisible();
  await edit.click();
  await page.waitForLoadState('networkidle').catch(() => {});
  await shot(page, 'memorial-00-initial');
  for (const tab of [/Основное/i, /Секции/i, /Слова/i, /Качества/i, /Моменты/i, /Альбом/i, /Финал/i]) {
    await clickIfVisible(page, 'button', tab);
    await shot(page, `memorial-tab-${tab.source}`);
  }
  await clickIfVisible(page, 'button', /Mobile/i);
  await shot(page, 'memorial-preview-mobile');
  await clickIfVisible(page, 'button', /Desktop/i);
  await shot(page, 'memorial-preview-desktop');

  fs.writeFileSync(path.join(outDir, `problems-${test.info().project.name}.json`), JSON.stringify(problems, null, 2));
  expect(problems, JSON.stringify(problems, null, 2)).toEqual([]);
});
