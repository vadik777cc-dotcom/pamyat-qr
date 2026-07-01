const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const outDir = path.join('test-results','client-materials');
function ensure(){ fs.mkdirSync(outDir,{recursive:true}); }
async function shot(page,name){ ensure(); await page.screenshot({ path:path.join(outDir, `${test.info().project.name}-${name}.png`), fullPage:true }).catch(()=>{}); }
async function login(page){
  await page.goto('/admin/login',{waitUntil:'domcontentloaded'});
  await page.locator('input[name="login"], input[name="username"], input[type="text"]').first().fill(process.env.ADMIN_LOGIN||'manager');
  await page.locator('input[name="password"], input[name="pass"], input[type="password"]').first().fill(process.env.ADMIN_PASSWORD||'change-me');
  await page.getByRole('button',{name:/войти/i}).click();
  await page.waitForURL(/\/admin/,{timeout:20000}).catch(()=>page.waitForLoadState('domcontentloaded'));
}

test('client materials: manager has printable family explanation and QR wording', async ({ page }) => {
  const bad=[];
  page.on('response', r=>{ const s=r.status(), u=r.url(); if(s>=400 && !u.includes('/favicon.ico')) bad.push({status:s,url:u}); });
  await login(page);
  await expect(page.locator('.sidebar')).toContainText(/Материалы/i);
  await page.goto('/admin/materials', { waitUntil:'domcontentloaded' });
  await expect(page.getByRole('heading', { name:'Материалы для работы', exact:true })).toBeVisible();
  await expect(page.locator('main')).toContainText(/Готовые подсказки для общения с семьёй|Короткая инструкция менеджеру|Как объяснить услугу семье/i);
  await expect(page.locator('main')).toContainText(/Наведите камеру телефона на QR-код|Что попросить у семьи|Фотографии|История жизни|Слова близких/i);
  await expect(page.getByRole('button', { name:/Распечатать/i })).toBeVisible();
  await expect(page.getByRole('button', { name:/Скопировать текст/i }).first()).toBeVisible();
  await expect(page.getByRole('link', { name:/Открыть лендинг для семей/i })).toBeVisible();
  await shot(page,'01-client-materials');
  expect(bad, JSON.stringify(bad,null,2)).toEqual([]);
});
