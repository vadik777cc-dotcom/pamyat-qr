const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const outDir = path.join(process.cwd(), 'test-results', 'editor-functional-deep');
function ensureDir(){ fs.mkdirSync(outDir, { recursive:true }); }
async function shot(page, name){ ensureDir(); await page.screenshot({ path:path.join(outDir, `${test.info().project.name}-${name}.png`), fullPage:true }); }
async function login(page, login = process.env.ADMIN_LOGIN || 'manager', password = process.env.ADMIN_PASSWORD || 'change-me'){
  await page.goto('/admin/login', { waitUntil:'domcontentloaded' });
  await page.locator('input[name="login"], input[name="username"], input[type="text"]').first().fill(login);
  await page.locator('input[name="password"], input[name="pass"], input[type="password"]').first().fill(password);
  await Promise.all([
    page.waitForURL(/\/admin/, { timeout:20000 }).catch(() => page.waitForLoadState('networkidle')),
    page.getByRole('button', { name:/войти/i }).click()
  ]);
}
async function saveFirst(page, name = /сохранить/i){
  await page.getByRole('button', { name }).first().click();
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(900);
}
async function openTab(page, name){
  const tab = page.getByRole('button', { name }).first();
  if(await tab.count()) await tab.click();
}
function unique(prefix){ return `${prefix} ${Date.now().toString().slice(-6)}`; }


async function setTextareaValue(page, name, value) {
  await page.locator(`textarea[name="${name}"]`).evaluate((el, val) => {
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

test('deep editor functionality: public preview matches saved landing/company edits', async ({ page, context }) => {
  const bad = [];
  page.on('response', res => { if(res.status() >= 400 && !res.url().includes('/favicon.ico')) bad.push({ status:res.status(), url:res.url() }); });
  await login(page);

  // Full regression may run after white-label tests in another browser project.
  // This scenario validates company brand propagation, so it starts from non-white-label mode.
  await page.goto('/admin/deploy', { waitUntil:'networkidle' });
  const whiteLabelToggle = page.locator('input[name="white_label_enabled"]');
  if(await whiteLabelToggle.count()){
    if(await whiteLabelToggle.isChecked().catch(() => false)) await whiteLabelToggle.uncheck({ force:true });
    const hideToggle = page.locator('input[name="hide_platform_branding"]');
    if(await hideToggle.count() && await hideToggle.isChecked().catch(() => false)) await hideToggle.uncheck({ force:true });
    await page.getByRole('button', { name:/Сохранить (white-label|бренд компании)/i }).click();
    await page.waitForURL(/\/admin\/deploy/, { timeout:20000 }).catch(() => page.waitForLoadState('networkidle'));
    await page.reload({ waitUntil:'networkidle' }).catch(() => {});
    if(await page.locator('input[name="white_label_enabled"]').count()){
      await expect(page.locator('input[name="white_label_enabled"]')).not.toBeChecked({ timeout:10000 });
    }
  }

  const brand = unique('Память QR QA');
  const hero = unique('QA лендинг после сохранения');
  const subtitle = 'Проверка: live preview, кнопка предпросмотра и публичный сайт должны совпадать.';
  const button = 'QA кнопка связи';
  const phone = '+7 999 123-45-67';

  await page.goto('/admin/company', { waitUntil:'networkidle' });
  await page.locator('input[name="name"]').fill(brand);
  await page.locator('input[type="file"][name="logo"]').setInputFiles(path.join(process.cwd(), 'tests/fixtures/qa-hero.jpg'));
  await saveFirst(page, /сохранить компанию/i);

  await page.goto('/admin/landing', { waitUntil:'networkidle' });
  await openTab(page, /Hero/i);
  await page.locator('input[name="preloader_title"]').fill(brand);
  await page.locator('input[name="hero_title"]').fill(hero);
  await page.locator('input[name="hero_subtitle"]').fill(subtitle);
  await page.locator('input[name="hero_primary_label"]').fill(button);
  await page.locator('input[type="file"][name="hero_image"]').setInputFiles(path.join(process.cwd(), 'tests/fixtures/qa-album.jpg'));
  await openTab(page, /Навигация/i);
  await setTextareaValue(page, 'nav_lines', `Главная | #top\nКонтакты | #contact\nFAQ | #faq`);
  await openTab(page, /Контакты/i);
  await setTextareaValue(page, 'contact_lines', `phone | ${phone} | tel:+79991234567\ntelegram | Telegram QA | https://t.me/pamyat_qr`);
  await openTab(page, /FAQ/i);
  await setTextareaValue(page, 'faq_lines', 'QA вопрос? | QA ответ после сохранения.');
  await saveFirst(page, /сохранить лендинг/i);
  await shot(page, 'landing-editor-after-save');

  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    page.getByRole('link', { name:/предпросмотр/i }).first().click()
  ]);
  await popup.waitForLoadState('networkidle').catch(() => {});
  await expect(popup.locator('body')).toContainText(hero);
  await expect(popup.locator('body')).toContainText(brand);
  await expect(popup.locator('body')).toContainText(button);
  const popupBrandAfter = await popup.locator('.brand-title').first().evaluate(el => getComputedStyle(el, '::after').content).catch(() => '');
  expect([popupBrandAfter, await popup.locator('.brand-title').first().textContent().catch(() => '')].join(' ')).toContain(brand);
  const popupLogoSrc = await popup.locator('.brand-ico img, .brand-logo').first().getAttribute('src').catch(() => '');
  expect(popupLogoSrc || '').toContain('/uploads/');
  const previewImages = await popup.locator('img').evaluateAll(imgs => imgs.map(img => img.getAttribute('src') || '').filter(Boolean));
  expect(previewImages.some(src => src.includes('/uploads/')), `Preview images: ${JSON.stringify(previewImages, null, 2)}`).toBeTruthy();
  await shot(popup, 'landing-preview-popup');
  await popup.close();

  const publicLink = page.getByRole('link', { name:/публичный/i }).first();
  const publicHref = await publicLink.getAttribute('href');
  await page.goto(publicHref || '/', { waitUntil:'networkidle' });
  await expect(page.locator('body')).toContainText(hero);
  await expect(page.locator('body')).toContainText(brand);
  await expect(page.locator('body')).toContainText(button);
  await expect(page.locator('body')).toContainText('QA вопрос?');
  const publicBrandAfter = await page.locator('.brand-title').first().evaluate(el => getComputedStyle(el, '::after').content).catch(() => '');
  expect([publicBrandAfter, await page.locator('.brand-title').first().textContent().catch(() => '')].join(' ')).toContain(brand);
  const publicLogoSrc = await page.locator('.brand-ico img, .brand-logo').first().getAttribute('src').catch(() => '');
  expect(publicLogoSrc || '').toContain('/uploads/');
  await shot(page, 'landing-public-after-save');
  expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
});

test('platform and partner admin basics: roles, business creation screens and isolation', async ({ browser }) => {
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await login(admin, 'admin', 'change-me');
  await expect(admin).toHaveURL(/\/admin\/platform/);
  await expect(admin.locator('body')).toContainText('Создать партнёра');
  await expect(admin.locator('body')).toContainText('Создать бизнес');
  await shot(admin, 'platform-admin');
  await adminContext.close();

  const partnerContext = await browser.newContext();
  const partner = await partnerContext.newPage();
  await login(partner, 'partner', 'change-me');
  await expect(partner).toHaveURL(/\/admin\/partner/);
  await expect(partner.locator('body')).toContainText('Партнёрская админка');
  await expect(partner.locator('body')).toContainText('Создать бизнес');
  const forbidden = await partner.goto('/admin/platform', { waitUntil:'domcontentloaded' });
  expect(forbidden.status()).toBe(403);
  await shot(partner, 'partner-forbidden-platform');
  await partnerContext.close();
});
