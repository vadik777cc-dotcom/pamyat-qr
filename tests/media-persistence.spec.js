const { test, expect } = require('@playwright/test');
const path = require('path');

async function login(page) {
  await page.goto('/admin/login', { waitUntil: 'domcontentloaded' });
  await page.locator('input[name="login"], input[name="username"], input[type="text"]').first().fill(process.env.ADMIN_LOGIN || 'manager');
  await page.locator('input[name="password"], input[name="pass"], input[type="password"]').first().fill(process.env.ADMIN_PASSWORD || 'change-me');
  await Promise.all([
    page.waitForURL(/\/admin/, { timeout: 20000 }).catch(() => page.waitForLoadState('networkidle')),
    page.getByRole('button', { name: /войти/i }).click()
  ]);
}

async function save(page) {
  await page.getByRole('button', { name: /сохранить/i }).first().click();
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1200);
}

async function getPreviewFrame(page) {
  const frameLocator = page.frameLocator('iframe.preview-frame, iframe[data-live-preview]').first();
  await expect(page.locator('iframe.preview-frame, iframe[data-live-preview]').first()).toBeVisible({ timeout: 15000 });
  return frameLocator;
}

test('media persistence: hero and album uploads appear in preview', async ({ page }) => {
  const bad = [];
  page.on('response', res => {
    if (res.status() >= 400 && !res.url().includes('/favicon.ico')) bad.push({ status: res.status(), url: res.url() });
  });

  await login(page);
  await page.goto('/admin/memorials', { waitUntil: 'networkidle' });
  await page.getByRole('link', { name: /редактировать/i }).first().click();
  await page.waitForLoadState('networkidle').catch(() => {});

  await page.locator('input[name="full_name"]').fill('QA Медиа Проверка Орлов');
  const birth = page.locator('input[name="birth_date"]');
  const death = page.locator('input[name="death_date"]');
  if (await birth.count()) await birth.fill('1951-03-14');
  if (await death.count()) await death.fill('2023-08-22');

  const heroPath = path.join(process.cwd(), 'tests/fixtures/qa-hero.jpg');
  const albumPath = path.join(process.cwd(), 'tests/fixtures/qa-album.jpg');

  await page.locator('input[type="file"][name="main_photo"]').setInputFiles(heroPath);
  await page.locator('input[type="file"][name="album_photos"]').setInputFiles(albumPath);

  await save(page);

  const frame = await getPreviewFrame(page);
  await expect(frame.locator('body')).toContainText('QA Медиа Проверка Орлов');

  const imageSrcs = await frame.locator('img').evaluateAll(imgs => imgs.map(img => img.getAttribute('src') || '').filter(Boolean));
  const uploadImages = imageSrcs.filter(src => src.includes('/uploads/'));

  await page.screenshot({ path: `test-results/media-persistence/${test.info().project.name}-editor-after-upload.png`, fullPage: true, timeout: 60000, animations: 'disabled' });
  await frame.locator('body').screenshot({ path: `test-results/media-persistence/${test.info().project.name}-preview-after-upload.png`, timeout: 60000, animations: 'disabled' });

  expect(uploadImages.length, `Preview should contain uploaded images. Actual images: ${JSON.stringify(imageSrcs, null, 2)}`).toBeGreaterThanOrEqual(2);
  expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
});
