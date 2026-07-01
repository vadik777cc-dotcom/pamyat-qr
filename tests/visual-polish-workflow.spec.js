const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const outDir = path.join(process.cwd(), 'test-results', 'visual-polish');
function ensureDir(){ fs.mkdirSync(outDir, { recursive:true }); }
async function shot(page, name){ ensureDir(); await page.screenshot({ path:path.join(outDir, `${test.info().project.name}-${name}.png`), fullPage:true }); }
async function login(page){
  await page.goto('/admin/login', { waitUntil:'domcontentloaded' });
  await expect(page.locator('body')).not.toContainText(/manager\s*\/\s*change-me|\.env/i);
  await page.locator('input[name="login"]').fill(process.env.ADMIN_LOGIN || 'manager');
  await page.locator('input[name="password"]').fill(process.env.ADMIN_PASSWORD || 'change-me');
  await Promise.all([
    page.waitForURL(/\/admin/, { timeout:20000 }).catch(()=>page.waitForLoadState('domcontentloaded')),
    page.getByRole('button', { name:/Войти/i }).click()
  ]);
}

test('visual polish: editors and address page are calmer for managers', async ({ page }) => {
  await login(page);

  await page.goto('/admin/landing', { waitUntil:'networkidle' });
  await expect(page.getByRole('heading', { name:'Лендинг для семей', exact:true })).toBeVisible();
  await expect(page.locator('main')).not.toContainText(/EXIF|Формат:|Рабочая форма слева|слишком длинных текстах/i);
  await expect(page.locator('details.editor-advanced')).toContainText(/Дополнительные настройки/i);
  await expect(page.getByRole('button', { name:/Телефон/i })).toBeVisible();
  await shot(page, '01-landing-editor-polished');

  await page.goto('/admin/memorials', { waitUntil:'networkidle' });
  const edit = page.getByRole('link', { name:/редактировать/i }).first();
  await expect(edit).toBeVisible();
  await edit.click();
  await page.waitForLoadState('networkidle').catch(()=>{});
  await expect(page.locator('main')).not.toContainText(/Slug|EXIF|формат: статус|главное 0\/1|Desktop\s*Mobile/i);
  await expect(page.locator('main')).toContainText(/Адрес страницы|Короткая фраза|Компьютер|Телефон/i);
  await shot(page, '02-memorial-editor-polished');

  await page.goto('/admin/deploy', { waitUntil:'networkidle' });
  await expect(page.getByRole('heading', { name:'Адрес сайта', exact:true })).toBeVisible();
  await expect(page.locator('main')).toContainText(/Адрес для семей|Короткая ссылка|Что будет после \/l\//i);
  await expect(page.locator('main')).not.toContainText(/свой домен|custom domain|подключить домен/i);
  await expect(page.locator('details.technical-details')).toBeVisible();
  await shot(page, '03-address-page-polished');
});
