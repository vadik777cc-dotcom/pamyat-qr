const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const shotsDir = path.join('test-results','b2c-trust-conversion');
function ensureDir(){ fs.mkdirSync(shotsDir,{recursive:true}); }
async function shot(page,name){ ensureDir(); await page.screenshot({path:path.join(shotsDir,`${test.info().project.name}-${name}.png`), fullPage:true}).catch(()=>{}); }
async function login(page){
  await page.goto('/admin/login',{waitUntil:'domcontentloaded'});
  await page.locator('input[name="login"], input[name="username"], input[type="text"]').first().fill(process.env.ADMIN_LOGIN||'manager');
  await page.locator('input[name="password"], input[name="pass"], input[type="password"]').first().fill(process.env.ADMIN_PASSWORD||'change-me');
  await page.getByRole('button',{name:/войти/i}).click();
  await page.waitForURL(/\/admin/,{timeout:20000}).catch(()=>page.waitForLoadState('domcontentloaded'));
}

test('B2C trust conversion: landing speaks to families and first screen is clean', async ({ page }) => {
  const bad=[];
  page.on('response', r=>{ const s=r.status(), u=r.url(); if(s>=400 && !u.includes('/favicon.ico')) bad.push({status:s,url:u}); });
  await login(page);

  await page.goto('/admin/landing',{waitUntil:'domcontentloaded'});
  await expect(page.getByRole('heading', { name:'Лендинг для семей', exact:true })).toBeVisible();
  await page.locator('input[name="hero_title"], textarea[name="hero_title"]').first().fill('Сохраните память о близком человеке');
  await page.locator('input[name="hero_subtitle"], textarea[name="hero_subtitle"]').first().fill('После сканирования QR-кода откроется страница с фотографиями, историей жизни и воспоминаниями семьи.');
  await page.locator('input[name="hero_primary_label"], textarea[name="hero_primary_label"]').first().fill('Посмотреть пример страницы');
  await page.locator('input[name="hero_primary_url"], textarea[name="hero_primary_url"]').first().fill('#example');
  await page.locator('input[name="hero_secondary_label"], textarea[name="hero_secondary_label"]').first().fill('Как это работает');
  await page.locator('input[name="hero_secondary_url"], textarea[name="hero_secondary_url"]').first().fill('#how-create');
  const faq = page.locator('textarea[name="faq_lines"]');
  const faqText = 'Нужно ли устанавливать приложение? | Нет. Страница открывается в обычном браузере телефона.\nМожно ли добавить фотографии позже? | Да. Фотографии и историю можно дополнить после публикации.\nКто может просматривать страницу? | Любой человек, получивший ссылку или отсканировавший QR-код.';
  if(await faq.count()) {
    const firstFaq = faq.first();
    if (await firstFaq.isVisible().catch(() => false)) {
      await firstFaq.fill(faqText);
    } else {
      await firstFaq.evaluate((el, value) => {
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, faqText);
    }
  }
  await shot(page,'01-editor-human-copy');
  await page.getByRole('button', { name:/Сохранить лендинг/i }).first().click();
  await page.waitForURL(/\/admin\/landing/, { timeout:20000 }).catch(()=>page.waitForLoadState('domcontentloaded'));

  await page.goto('/admin/landing/preview', { waitUntil:'domcontentloaded' });
  await expect(page.locator('h1').first()).toContainText('Сохраните память о близком человеке');
  await expect(page.locator('body')).toContainText('После сканирования QR-кода откроется страница');
  await expect(page.locator('body')).toContainText('Что может храниться на странице памяти');
  await expect(page.locator('body')).toContainText('Фотографии разных лет');
  await expect(page.locator('body')).toContainText('Нужно ли устанавливать приложение?');
  await expect(page.locator('body')).toContainText('Наведите камеру телефона на QR-код');
  const firstVisible = await page.locator('body').innerText();
  expect(firstVisible.slice(0,500)).not.toMatch(/\{\"|window\.|PAMYAT_PUBLIC|seo_title|canonical_url|undefined|null/i);
  await shot(page,'02-public-preview-clean-human');

  expect(bad, JSON.stringify(bad,null,2)).toEqual([]);
});
