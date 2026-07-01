const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const outDir = path.join('test-results','manager-polish');
function ensure(){ fs.mkdirSync(outDir,{recursive:true}); }
async function shot(page,name){ ensure(); await page.screenshot({ path:path.join(outDir, `${test.info().project.name}-${name}.png`), fullPage:true }).catch(()=>{}); }
async function login(page){
  await page.goto('/admin/login',{waitUntil:'domcontentloaded'});
  await page.locator('input[name="login"], input[name="username"], input[type="text"]').first().fill(process.env.ADMIN_LOGIN||'manager');
  await page.locator('input[name="password"], input[name="pass"], input[type="password"]').first().fill(process.env.ADMIN_PASSWORD||'change-me');
  await page.getByRole('button',{name:/войти/i}).click();
  await page.waitForURL(/\/admin/,{timeout:20000}).catch(()=>page.waitForLoadState('domcontentloaded'));
}

test('manager polish: daily actions are clear and technical sections are explained', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('heading', { name:/Главная/i })).toBeVisible();
  await expect(page.locator('main')).toContainText(/Рабочий стол менеджера|Что сделать сейчас|Создать страницу памяти|Лендинг для семей|QR-комплект|Заявки семьи/i);
  await expect(page.locator('.sidebar')).toContainText(/Работа каждый день|Настройка для семей|Контроль и безопасность/i);
  await shot(page,'01-dashboard-manager-polish');

  await page.goto('/admin/help', { waitUntil:'domcontentloaded' });
  await expect(page.getByRole('heading', { name:/Справка для менеджера/i })).toBeVisible();
  await expect(page.locator('main')).toContainText(/Как получить готовую страницу и QR|Компания|Лендинг для семей|Страница памяти|Публикация и QR|Адрес сайта/i);
  await expect(page.locator('main')).toContainText(/Адрес для семей уже работает/i);
  await shot(page,'02-manager-help');

  await page.goto('/admin/security', { waitUntil:'domcontentloaded' });
  await expect(page.locator('main')).toContainText(/Этот раздел обычно нужен администратору|Менеджеру каждый день достаточно/i);
  await shot(page,'03-security-explained');

  await page.goto('/admin/backups', { waitUntil:'domcontentloaded' });
  await expect(page.locator('main')).toContainText(/Резервные копии — на случай проверки или восстановления|можно не открывать/i);
  await shot(page,'04-backups-explained');
});
