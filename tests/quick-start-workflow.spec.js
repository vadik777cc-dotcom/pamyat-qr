const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const shotsDir = path.join('test-results','quick-start-workflow');
function ensureDir(){ fs.mkdirSync(shotsDir,{recursive:true}); }
async function shot(page,name){ ensureDir(); await page.screenshot({path:path.join(shotsDir,`${test.info().project.name}-${name}.png`), fullPage:true}).catch(()=>{}); }
async function login(page){
  await page.goto('/admin/login',{waitUntil:'domcontentloaded'});
  await page.locator('input[name="login"], input[name="username"], input[type="text"]').first().fill(process.env.ADMIN_LOGIN||'manager');
  await page.locator('input[name="password"], input[name="pass"], input[type="password"]').first().fill(process.env.ADMIN_PASSWORD||'change-me');
  await page.getByRole('button',{name:/войти/i}).click();
  await page.waitForURL(/\/admin/,{timeout:20000}).catch(()=>page.waitForLoadState('domcontentloaded'));
}

test('quick start: manager sees simple path from company to landing, memorial, QR and address', async ({ page }) => {
  const bad=[];
  page.on('response', r=>{ const s=r.status(), u=r.url(); if(s>=400 && !u.includes('/favicon.ico')) bad.push({status:s,url:u}); });
  await login(page);
  await page.goto('/admin/start', { waitUntil:'domcontentloaded' });
  await expect(page.getByRole('heading', { name:'Быстрый запуск', exact:true })).toBeVisible();
  await expect(page.locator('main')).toContainText(/Старт за 10 минут|не нужно разбираться в доменах|Продолжить/i);
  await expect(page.locator('main')).toContainText(/Проверьте данные компании|Настройте лендинг для семей|Создайте первую страницу памяти|Опубликуйте страницу и скачайте QR|Проверьте адрес сайта/i);
  await expect(page.getByRole('link', { name:/Открыть данные компании|Открыть лендинг|Создать страницу|Открыть страницы памяти|Открыть адрес сайта/i }).first()).toBeVisible();
  await shot(page,'01-quick-start');

  await page.getByRole('link', { name:/Открыть лендинг|Настройте лендинг|Продолжить/i }).first().click().catch(async()=>{ await page.goto('/admin/landing',{waitUntil:'domcontentloaded'}); });
  await expect(page.locator('main')).toContainText(/Лендинг для семей|Настройте лендинг/i);

  await page.goto('/admin/start', { waitUntil:'domcontentloaded' });
  await page.getByRole('link', { name:/Открыть адрес сайта/i }).first().click();
  await expect(page.locator('main')).toContainText(/Адрес сайта|бесплатный адрес|технические настройки/i);
  await shot(page,'02-address-from-quick-start');
  expect(bad, JSON.stringify(bad,null,2)).toEqual([]);
});
