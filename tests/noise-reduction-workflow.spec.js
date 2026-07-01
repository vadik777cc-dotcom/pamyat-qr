const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const outDir = path.join('test-results','noise-reduction');
function ensure(){ fs.mkdirSync(outDir,{recursive:true}); }
async function shot(page,name){ ensure(); await page.screenshot({ path:path.join(outDir, `${test.info().project.name}-${name}.png`), fullPage:true }).catch(()=>{}); }
async function login(page){
  await page.goto('/admin/login',{waitUntil:'domcontentloaded'});
  await page.locator('input[name="login"], input[name="username"], input[type="text"]').first().fill(process.env.ADMIN_LOGIN||'manager');
  await page.locator('input[name="password"], input[name="pass"], input[type="password"]').first().fill(process.env.ADMIN_PASSWORD||'change-me');
  await page.getByRole('button',{name:/войти/i}).click();
  await page.waitForURL(/\/admin/,{timeout:20000}).catch(()=>page.waitForLoadState('domcontentloaded'));
}

test('noise reduction: finished onboarding disappears, login is clean and public landing has no raw CSS', async ({ page }) => {
  await page.goto('/admin/login',{waitUntil:'domcontentloaded'});
  await expect(page.locator('body')).not.toContainText(/Демо: manager|change-me, если/i);
  await login(page);
  await expect(page.getByRole('heading', { name:/Главная/i })).toBeVisible();
  await expect(page.locator('main')).not.toContainText(/Начало работы|Пройдите 5 простых шагов/i);
  await expect(page.locator('.sidebar')).not.toContainText(/Быстрый запуск/i);
  await shot(page,'01-dashboard-clean-after-ready');

  await page.goto('/admin/memorials/1', { waitUntil:'domcontentloaded' });
  await expect(page.locator('main')).not.toContainText(/Рабочая форма слева|Ключевые тексты можно увидеть|Админка предупредит/i);
  await shot(page,'02-memorial-copy-clean');

  await page.goto('/admin/landing/preview', { waitUntil:'domcontentloaded' });
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toMatch(/Session31\.2|brand-title::after|dynamic brand text|content:none!important/i);
  await expect(page.locator('body')).toContainText(/Сохраните память|Страница памяти|QR-код/i);
  await shot(page,'03-public-landing-no-raw-css');

  await page.goto('/admin/deploy', { waitUntil:'domcontentloaded' });
  await expect(page.locator('main')).toContainText(/Короткий адрес|\/l\//i);
  await expect(page.locator('main')).not.toContainText(/Свой адрес сайта|CNAME|HTTPS|memory-pamyat\.ru|pamyat\.perm\.ru/i);
  await shot(page,'04-address-simple-slug');
});
