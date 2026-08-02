const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(process.cwd(), 'test-results', 'global-product-qa');
function ensureDir(){ fs.mkdirSync(OUT_DIR, { recursive: true }); }
function safeName(name){ return String(name).replace(/[^a-z0-9а-яё_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase(); }
async function screenshot(page, name){
  ensureDir();
  const shotPath = path.join(OUT_DIR, `${test.info().project.name}-${safeName(name)}.png`);
  const options = { path: shotPath, timeout: 60000, animations: 'disabled' };
  try {
    await page.screenshot({ ...options, fullPage: true });
  } catch (error) {
    if(!/Cannot take screenshot larger than 32767 pixels/i.test(error.message || '')) throw error;
    await page.screenshot({ ...options, fullPage: false });
  }
}
function writeReport(name, data){ ensureDir(); fs.writeFileSync(path.join(OUT_DIR, `${test.info().project.name}-${safeName(name)}.json`), JSON.stringify(data, null, 2), 'utf8'); }
function unique(prefix){ return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`; }

async function login(page, login, password = 'change-me'){
  await page.goto('/admin/login', { waitUntil: 'domcontentloaded' });
  await page.locator('input[name="login"], input[name="username"], input[type="text"]').first().fill(login);
  await page.locator('input[name="password"], input[name="pass"], input[type="password"]').first().fill(password);
  await Promise.all([
    page.waitForURL(/\/admin/, { timeout: 20000 }).catch(() => page.waitForLoadState('networkidle')),
    page.getByRole('button', { name: /войти/i }).click()
  ]);
}

async function logout(page){
  await page.goto('/admin/logout', { waitUntil: 'domcontentloaded' }).catch(() => {});
}

async function saveFirst(page, buttonName = /сохранить/i){
  await page.getByRole('button', { name: buttonName }).first().click();
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(900);
}

async function openTab(page, name){
  const tab = page.getByRole('button', { name }).first();
  if(await tab.count()){
    await tab.click();
    await page.waitForTimeout(250);
  }
}

async function setTextareaValue(page, name, value){
  await page.locator(`textarea[name="${name}"]`).evaluate((el, val) => {
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

function attachProblemCollectors(page, problems, label){
  page.on('response', response => {
    const status = response.status();
    const url = response.url();
    if(status >= 400 && !url.includes('/favicon.ico')) problems.push({ type: 'http', label, status, url });
  });
  page.on('requestfailed', request => {
    const url = request.url();
    if(!url.includes('/favicon.ico')) problems.push({ type: 'requestfailed', label, url, failure: request.failure()?.errorText || '' });
  });
  page.on('pageerror', error => problems.push({ type: 'pageerror', label, text: error.message }));
  page.on('console', msg => {
    if(msg.type() === 'error' && !/favicon|ResizeObserver/i.test(msg.text())) problems.push({ type: 'console', label, text: msg.text() });
  });
}

async function expectNoBrokenImages(page, label, report){
  const broken = await page.locator('img').evaluateAll(imgs => imgs
    .filter(img => !img.complete || img.naturalWidth === 0)
    .map(img => ({ src: img.getAttribute('src') || '', alt: img.getAttribute('alt') || '' }))
  ).catch(() => []);
  report.checks.push({ check: `broken-images:${label}`, count: broken.length, broken });
  expect(broken, `Broken images on ${label}: ${JSON.stringify(broken, null, 2)}`).toEqual([]);
}

async function smokeVisibleButtons(page, label, report){
  let buttons = [];
  try {
    buttons = await page.locator('button:visible, a.btn:visible, a.print-card:visible, .link-button:visible').evaluateAll(items => items.map((el, idx) => ({
      idx,
      text: (el.innerText || el.textContent || '').trim().slice(0, 80),
      href: el.getAttribute('href') || '',
      disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true'
    })));
  } catch (error) {
    report.checks.push({ check: `visible-buttons:${label}:collector-error`, error: error.message });
    buttons = [];
  }
  report.checks.push({ check: `visible-buttons:${label}`, count: buttons.length, buttons });
  expect(buttons.filter(b => (b.text || b.href) && !b.disabled).length, `No actionable buttons/links on ${label}`).toBeGreaterThan(0);
}

async function expectFrameContains(page, selector, text, label, report){
  const frameElement = page.locator(selector).first();
  await expect(frameElement, `${label} iframe missing`).toBeVisible({ timeout: 15000 });
  const frame = await frameElement.contentFrame();
  expect(frame, `${label} iframe content frame missing`).toBeTruthy();
  await expect(frame.locator('body'), `${label} iframe text mismatch`).toContainText(text, { timeout: 15000 });
  report.checks.push({ check: `iframe-contains:${label}`, text });
}

async function waitForPublicPageReady(page, label, report){
  const hasPreloader = await page.locator('.preloader').count().catch(() => 0);
  if(hasPreloader){
    await page.waitForFunction(() => document.body.classList.contains('ready') || !document.querySelector('.preloader') || getComputedStyle(document.querySelector('.preloader')).visibility === 'hidden', null, { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(250);
    const stillVisible = await page.locator('.preloader').evaluate(el => {
      const cs = getComputedStyle(el);
      const opacity = Number.parseFloat(cs.opacity || '1');
      const coversPage = cs.display !== 'none'
        && cs.visibility !== 'hidden'
        && opacity > 0.05
        && cs.pointerEvents !== 'none';
      return coversPage;
    }).catch(() => false);
    report.checks.push({ check: `preloader-not-covering:${label}`, stillVisible });
    expect(stillVisible, `Preloader still covers ${label}`).toBe(false);
  }
}

async function expectVisibleText(page, text, label, options = {}){
  await expect(page.locator('body'), `${label} body should include ${text}`).toContainText(text, { timeout: 15000 });
  if(options.visible === false) return;
  const visibleCount = await page.locator(`text=${text}`).evaluateAll((nodes, wanted) => nodes.filter(el => {
    const cs = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && Number.parseFloat(cs.opacity || '1') > 0.05 && rect.width > 0 && rect.height > 0;
    return visible && (el.innerText || el.textContent || '').includes(wanted);
  }).length, text).catch(() => 0);
  expect(visibleCount, `${label} visible text missing: ${text}`).toBeGreaterThan(0);
}

test('global product QA: businesses, B2C editor, memorial editor, media, dates, public pages and QR', async ({ page, context }) => {
  test.setTimeout(120000);
  const problems = [];
  attachProblemCollectors(page, problems, 'main');
  const report = { createdAt: new Date().toISOString(), project: test.info().project.name, checks: [], created: {}, problems };
  const stamp = Date.now();
  const partnerName = `Global QA Partner ${stamp}`;
  const businessName = `global-qa-business-${stamp}`;
  const partnerLogin = `global_qa_partner_${stamp}`;
  const businessLogin = `global_qa_business_${stamp}`;
  const heroPath = path.join(process.cwd(), 'tests/fixtures/qa-hero.jpg');
  const albumPath = path.join(process.cwd(), 'tests/fixtures/qa-album.jpg');

  await login(page, 'admin');
  await screenshot(page, '01-super-admin-after-login');

  await page.goto('/admin/platform', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: /Платформа/i })).toBeVisible();
  await smokeVisibleButtons(page, 'platform-dashboard', report);
  await screenshot(page, '02-platform-dashboard');

  await page.locator('form[action="/admin/platform/partners/new"] input[name="name"]').fill(partnerName);
  await page.locator('form[action="/admin/platform/partners/new"] input[name="contact_name"]').fill('Global QA Partner Owner');
  await page.locator('form[action="/admin/platform/partners/new"] input[name="phone"]').fill('+7 999 310-31-31');
  await page.locator('form[action="/admin/platform/partners/new"] input[name="email"]').fill(`${partnerLogin}@example.test`);
  await page.locator('form[action="/admin/platform/partners/new"] input[name="login"]').fill(partnerLogin);
  await page.locator('form[action="/admin/platform/partners/new"] input[name="password"]').fill('change-me');
  await page.locator('form[action="/admin/platform/partners/new"] button').click();
  await page.waitForURL(/\/admin\/platform/);
  report.created.partnerLogin = partnerLogin;

  await page.goto('/admin/platform/partners', { waitUntil: 'networkidle' });
  await expect(page.getByText(partnerName)).toBeVisible();
  await screenshot(page, '03-platform-partners-list-after-create');

  await page.goto('/admin/platform', { waitUntil: 'networkidle' });
  const partnerOption = page.locator('select[name="partner_id"] option', { hasText: partnerName }).first();
  await expect(partnerOption).toHaveCount(1);
  const partnerId = await partnerOption.getAttribute('value');
  const csrf = await page.locator('meta[name="csrf-token"]').getAttribute('content');
  const createBusinessResponse = await page.request.post('/admin/platform/businesses/new', {
    form: {
      _csrf: csrf || '',
      partner_id: partnerId || '',
      name: businessName,
      city: 'Пермь',
      phone: '+7 999 320-32-32',
      email: `${businessLogin}@example.test`,
      login: businessLogin,
      password: 'change-me'
    },
    maxRedirects: 0
  });
  expect([302, 303]).toContain(createBusinessResponse.status());
  report.created.businessLogin = businessLogin;
  report.created.businessName = businessName;

  await page.goto('/admin/platform/businesses', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await expect(page.getByText(businessName)).toBeVisible();
  await expect(page.getByText(partnerName)).toBeVisible();
  await screenshot(page, '04-platform-businesses-list-after-create');
  const businessDetailLink = page.locator('tr', { hasText: businessName }).getByRole('link', { name: /Открыть/i }).first();
  await businessDetailLink.click();
  await page.waitForLoadState('networkidle').catch(() => {});
  await expect(page.getByRole('heading', { name: new RegExp(businessName) })).toBeVisible();
  await screenshot(page, '05-platform-business-detail');
  await page.locator('select[name="plan"]').selectOption('pro');
  await page.locator('select[name="account_status"]').selectOption('active');
  await saveFirst(page, /Сохранить/i);
  await expect(page.locator('select[name="plan"]')).toHaveValue('pro');

  await logout(page);
  await login(page, partnerLogin);
  await page.goto('/admin/partner/businesses', { waitUntil: 'networkidle' });
  await expect(page.getByText(businessName)).toBeVisible();
  await expect(page.getByText('Прямой клиент')).toHaveCount(0);
  await screenshot(page, '06-partner-businesses-scope');
  await logout(page);

  await login(page, businessLogin);
  await expect(page.locator('body')).toContainText(/Главная|Страницы/i);
  await screenshot(page, '07-business-dashboard-after-login');

  await page.goto('/admin/company', { waitUntil: 'networkidle' });
  await page.locator('input[name="name"]').fill('Память QR Global QA');
  const logoInput = page.locator('input[type="file"][name="logo"]');
  if(await logoInput.count()) await logoInput.setInputFiles(heroPath);
  await saveFirst(page, /сохранить компанию/i);
  await screenshot(page, '08-company-after-logo-save');

  const landingHero = `Global QA B2C ${stamp}`;
  await page.goto('/admin/landing', { waitUntil: 'networkidle' });
  await openTab(page, /Hero/i);
  await page.locator('input[name="preloader_title"]').fill('Память QR Global QA');
  await page.locator('input[name="hero_title"]').fill(landingHero);
  await page.locator('input[name="hero_subtitle"]').fill('Глобальная проверка редактируемости лендинга, кнопок, контактов, FAQ и изображений.');
  await page.locator('input[name="hero_primary_label"]').fill('Связаться QA');
  await page.locator('input[name="hero_secondary_label"]').fill('Открыть пример QA');
  await page.locator('input[type="file"][name="hero_image"]').setInputFiles(albumPath);
  await openTab(page, /Навигация/i);
  await setTextareaValue(page, 'nav_lines', 'Главная | #top\nКак работает | #how\nКонтакты | #contact\nFAQ | #faq');
  await openTab(page, /Контакты/i);
  await setTextareaValue(page, 'contact_lines', 'phone | +7 999 333-33-33 | tel:+79993333333\ntelegram | Telegram QA | https://t.me/pamyat_qr');
  await openTab(page, /FAQ/i);
  await setTextareaValue(page, 'faq_lines', 'Global QA вопрос? | Global QA ответ сохранён.');
  await screenshot(page, '09-landing-editor-before-save');
  await saveFirst(page, /сохранить лендинг/i);
  await screenshot(page, '10-landing-editor-after-save');
  await expectFrameContains(page, 'iframe.preview-frame, iframe[data-live-preview]', landingHero, 'landing-live-preview-after-save', report);

  const [landingPreview] = await Promise.all([
    context.waitForEvent('page'),
    page.getByRole('link', { name: /предпросмотр/i }).first().click()
  ]);
  attachProblemCollectors(landingPreview, problems, 'landing-admin-preview');
  await landingPreview.waitForLoadState('networkidle').catch(() => {});
  await waitForPublicPageReady(landingPreview, 'landing-admin-preview', report);
  await expectVisibleText(landingPreview, landingHero, 'Admin preview must show saved hero title');
  await expectVisibleText(landingPreview, 'Global QA вопрос?', 'Admin preview must show saved FAQ');
  await expectNoBrokenImages(landingPreview, 'landing-admin-preview', report);
  await screenshot(landingPreview, '11-landing-admin-preview-after-save');
  await landingPreview.close();

  const [landingPublic] = await Promise.all([
    context.waitForEvent('page'),
    page.getByRole('link', { name: /публичный/i }).first().click()
  ]);
  attachProblemCollectors(landingPublic, problems, 'landing-public');
  await landingPublic.waitForLoadState('networkidle').catch(() => {});
  await waitForPublicPageReady(landingPublic, 'landing-public', report);
  await expectVisibleText(landingPublic, landingHero, 'Public landing must show saved hero title, not stale defaults');
  await expectVisibleText(landingPublic, 'Global QA вопрос?', 'Public landing must show saved FAQ, not stale defaults');
  await expectVisibleText(landingPublic, '+7 999 333-33-33', 'Public landing must contain saved contact phone', { visible: false });
  await expectNoBrokenImages(landingPublic, 'landing-public', report);
  await screenshot(landingPublic, '12-landing-real-public-after-save');
  await landingPublic.close();

  await page.goto('/admin/memorials/new', { waitUntil: 'networkidle' });
  const memorialName = `Global QA Мемориал ${stamp}`;
  const memorialSlug = `global-qa-memorial-${stamp}`;
  await page.locator('input[name="full_name"]').fill(memorialName);
  await page.locator('input[name="slug"]').fill(memorialSlug);
  await page.locator('input[name="birth_date"]').fill('1951-03-14');
  await page.locator('input[name="death_date"]').fill('2023-08-22');
  await page.locator('select[name="status"]').selectOption('published');
  await page.locator('select[name="privacy_status"]').selectOption('unlisted');
  await page.locator('input[name="quote"]').fill('Global QA цитата сохранена.');
  await page.locator('textarea[name="epitaph"]').fill('Global QA эпитафия для проверки публикации.');
  await page.locator('textarea[name="biography"]').fill('Global QA история жизни. Проверяем длинный текст, сохранение после перезагрузки, предпросмотр и публичную страницу.\n\nВторой абзац нужен для визуальной проверки типографики.');
  await page.locator('input[name="consent_confirmed"]').check();
  await page.locator('input[type="file"][name="main_photo"]').setInputFiles(heroPath);
  await setTextareaValue(page, 'memories_lines', 'approved | 1 | Супруга | Global QA слова супруги сохранены и должны быть аккуратными.\napproved | 0 | Дочь | Global QA слова дочери сохранены.');
  await setTextareaValue(page, 'qualities_lines', 'Заботливый | Всегда был рядом.\nНадёжный | Держал слово.');
  await setTextareaValue(page, 'milestones_lines', '1951 | Родился.\n2023 | Светлая память.');
  await page.locator('input[type="file"][name="album_photos"]').setInputFiles([albumPath, heroPath]);
  await setTextareaValue(page, 'photos_meta', 'QA альбом 1 | 1988 | Семейный архив | Подпись к первому фото\nQA альбом 2 | 1995 | Семейный архив | Подпись ко второму фото');
  await setTextareaValue(page, 'footer_text', 'Global QA финальная фраза сохранена.');
  await screenshot(page, '13-memorial-new-before-save-with-dates-and-album');
  await saveFirst(page, /Сохранить страницу/i);
  await expect(page).toHaveURL(/\/admin\/memorials\/\d+/);
  const memorialUrl = page.url();
  const memorialId = memorialUrl.match(/\/admin\/memorials\/(\d+)/)?.[1];
  expect(memorialId, `Memorial ID not found in URL: ${memorialUrl}`).toBeTruthy();
  await expect(page.locator('input[name="birth_date"]')).toHaveValue('1951-03-14');
  await expect(page.locator('input[name="death_date"]')).toHaveValue('2023-08-22');
  await screenshot(page, '14-memorial-edit-after-save');

  await page.goto(`/admin/memorials/${memorialId}/preview`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1200);
  await waitForPublicPageReady(page, 'memorial-preview', report);
  await expect(page.locator('body')).toContainText(memorialName);
  await expect(page.locator('body')).toContainText('Global QA слова супруги');
  await expect(page.locator('body')).toContainText('Global QA история жизни');
  const uploadImages = await page.locator('img').evaluateAll(imgs => imgs.map(img => img.getAttribute('src') || '').filter(src => src.includes('/uploads/')));
  report.checks.push({ check: 'memorial-preview-upload-images', count: uploadImages.length, uploadImages });
  expect(uploadImages.length, `Expected uploaded main photo + album images. Actual: ${JSON.stringify(uploadImages, null, 2)}`).toBeGreaterThanOrEqual(3);
  await expectNoBrokenImages(page, 'memorial-preview', report);
  await screenshot(page, '15-memorial-preview-after-upload');

  await page.goto(`/admin/memorials/${memorialId}/publish`, { waitUntil: 'networkidle' });
  await expect(page.locator('body')).toContainText('Все обязательные поля заполнены');
  await smokeVisibleButtons(page, 'memorial-publish', report);
  const publicText = await page.locator('code').first().textContent();
  expect(publicText || '', 'Public link is missing on publish page').toContain('/m/');
  await screenshot(page, '16-memorial-publish-ready');

  await page.goto(`/admin/memorials/${memorialId}/qr`, { waitUntil: 'networkidle' });
  await expect(page.locator('body')).toContainText('QR и печать');
  await expect(page.locator('img')).toHaveCount(1);
  await expectNoBrokenImages(page, 'qr-center', report);
  await screenshot(page, '17-qr-center');

  const pdfResponse = await page.request.get(`/admin/memorials/${memorialId}/qr.pdf?type=a4`);
  const pdfContentType = pdfResponse.headers()['content-type'] || '';
  const pdfDisposition = pdfResponse.headers()['content-disposition'] || '';
  report.checks.push({
    check: 'qr-pdf-download-response',
    status: pdfResponse.status(),
    contentType: pdfContentType,
    disposition: pdfDisposition
  });
  expect(pdfResponse.status()).toBe(200);
  expect(pdfContentType).toMatch(/application\/pdf|application\/octet-stream/i);
  expect(pdfDisposition).toMatch(/filename|attachment|inline/i);
  await page.goto(`/admin/memorials/${memorialId}/preview`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1200);

  await page.goto(publicText, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1200);
  await waitForPublicPageReady(page, 'public-memorial', report);
  await expect(page.locator('body')).toContainText(memorialName);
  await expect(page.locator('body')).toContainText('Global QA слова супруги');
  await expectNoBrokenImages(page, 'public-memorial', report);
  await screenshot(page, '18-public-memorial');

  await page.goto(`/family/${businessName}/submit`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: /Передать материалы/i })).toBeVisible();
  await page.locator('input[name="full_name"]').fill(`Global QA Заявка ${stamp}`);
  await page.locator('input[name="birth_date"]').fill('1944-02-03');
  await page.locator('input[name="death_date"]').fill('2022-12-30');
  await page.locator('input[name="contact_name"]').fill('QA Родственник');
  await page.locator('input[name="contact_phone"]').fill('+7 999 444-44-44');
  await page.locator('textarea[name="epitaph"]').fill('QA заявка эпитафия');
  await page.locator('textarea[name="biography"]').fill('QA заявка история');
  await page.locator('textarea[name="memories_text"]').fill('QA заявка воспоминание 1\nQA заявка воспоминание 2');
  await page.locator('input[type="file"][name="main_photo"]').setInputFiles(heroPath);
  await page.locator('input[type="file"][name="album_photos"]').setInputFiles([albumPath, heroPath]);
  await page.locator('textarea[name="photos_meta"]').fill('Фото заявки 1 | 1980 | Дом | Подпись\nФото заявки 2 | 1990 | Архив | Подпись');
  await page.locator('input[name="consent_confirmed"]').check();
  await screenshot(page, '19-family-submission-before-send');
  await page.getByRole('button', { name: /Отправить материалы/i }).click();
  await page.waitForLoadState('networkidle').catch(() => {});
  await expect(page.locator('body')).toContainText(/спасибо|получ/i);
  await screenshot(page, '20-family-submission-after-send');

  await page.goto('/admin/submissions', { waitUntil: 'networkidle' });
  await expect(page.locator('body')).toContainText(`Global QA Заявка ${stamp}`);
  await screenshot(page, '21-admin-submissions-after-family-submit');

  await page.goto('/admin/landing', { waitUntil: 'networkidle' });
  await expect(page.locator('input[name="hero_title"]')).toHaveValue(landingHero);
  await page.goto(`/admin/memorials/${memorialId}`, { waitUntil: 'networkidle' });
  await expect(page.locator('input[name="full_name"]')).toHaveValue(memorialName);
  await expect(page.locator('input[name="birth_date"]')).toHaveValue('1951-03-14');
  await expect(page.locator('input[name="death_date"]')).toHaveValue('2023-08-22');
  await screenshot(page, '22-final-memorial-reload-persistence');

  writeReport('global-product-qa-report', report);
  const serious = problems.filter(p => !(p.type === 'requestfailed' && /svecha\.mp4|media|\/admin\/platform\/businesses\/new/i.test(p.url || '')));
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
});
