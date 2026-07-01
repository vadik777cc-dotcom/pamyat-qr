const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const outDir = path.join(process.cwd(), 'test-results', 'publish-qr');
function ensureDir(){ fs.mkdirSync(outDir, { recursive:true }); }
async function shot(page, name){ ensureDir(); await page.screenshot({ path:path.join(outDir, `${test.info().project.name}-${name}.png`), fullPage:true, timeout:60000, animations:'disabled' }); }

async function login(page) {
  await page.goto('/admin/login', { waitUntil: 'domcontentloaded' });
  await page.locator('input[name="login"], input[name="username"], input[type="text"]').first().fill(process.env.ADMIN_LOGIN || 'manager');
  await page.locator('input[name="password"], input[name="pass"], input[type="password"]').first().fill(process.env.ADMIN_PASSWORD || 'change-me');
  await Promise.all([
    page.waitForURL(/\/admin/, { timeout: 20000 }).catch(() => page.waitForLoadState('networkidle')),
    page.getByRole('button', { name: /войти/i }).click()
  ]);
}

async function getFirstMemorialId(page) {
  await page.goto('/admin/memorials', { waitUntil: 'networkidle' });
  const publishLink = page.getByRole('link', { name: /публикация/i }).first();
  await expect(publishLink).toBeVisible();
  const href = await publishLink.getAttribute('href');
  const match = String(href || '').match(/\/admin\/memorials\/(\d+)\/publish/);
  expect(match, `Не удалось получить id страницы памяти из href=${href}`).toBeTruthy();
  return match[1];
}

function normalizePublicUrl(url) {
  const parsed = new URL(url, 'http://127.0.0.1:3001');
  return parsed.pathname + parsed.search + parsed.hash;
}

async function expectOk(context, url, label) {
  const response = await context.request.get(url, { maxRedirects: 2 });
  expect(response.status(), `${label}: ${url}`).toBeLessThan(400);
  return response;
}

test('publish / QR / public link: memorial is public and QR assets are generated', async ({ page }) => {
  const bad = [];
  page.on('response', res => {
    const status = res.status();
    const url = res.url();
    if (status >= 400 && !url.includes('/favicon.ico')) bad.push({ status, url });
  });

  await login(page);
  const memorialId = await getFirstMemorialId(page);

  await page.goto(`/admin/memorials/${memorialId}/publish`, { waitUntil:'networkidle' });
  await shot(page, 'publish-before');

  const publicUrlBefore = (await page.locator('.publish-checks code').first().textContent()).trim();
  expect(publicUrlBefore).toMatch(/\/m\//);

  const publishButton = page.getByRole('button', { name: /опубликовать/i }).first();
  await expect(publishButton).toBeVisible();
  await page.once('dialog', dialog => dialog.accept().catch(() => {}));
  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => {}),
    publishButton.click()
  ]);
  await page.waitForTimeout(700);
  await shot(page, 'publish-after');

  const publicUrl = (await page.locator('.publish-checks code').first().textContent()).trim();
  expect(publicUrl).toBeTruthy();
  expect(publicUrl).toMatch(/\/m\//);

  const publicPath = normalizePublicUrl(publicUrl);
  const publicResponse = await page.goto(publicPath, { waitUntil:'domcontentloaded', timeout:30000 });
  await page.waitForTimeout(1200);
  expect(publicResponse && publicResponse.status()).toBeLessThan(400);
  await expect(page.locator('body')).toContainText(/Алексей|Орлов|QA|Памяти/i);
  await shot(page, 'public-page');

  await page.goto(`/admin/memorials/${memorialId}/qr`, { waitUntil:'networkidle' });
  await shot(page, 'qr-center');
  await expect(page.locator('.qr-preview-card img, img[alt*="QR"], img[src*="/uploads/qr/"]').first()).toBeVisible();

  const qrText = (await page.locator('.qr-preview-card code, .qr-preview-card p').first().textContent()).trim();
  expect(normalizePublicUrl(qrText)).toBe(publicPath);

  const pngHref = await page.getByRole('link', { name: /PNG/i }).first().getAttribute('href');
  const svgHref = await page.getByRole('link', { name: /SVG/i }).first().getAttribute('href');
  const zipHref = await page.getByRole('link', { name: /ZIP|комплект/i }).first().getAttribute('href');
  const pdfLinks = await page.locator('a[href*="/qr.pdf"]').evaluateAll(links => links.map(a => a.getAttribute('href')).filter(Boolean));

  expect(pngHref).toMatch(/\.png/i);
  expect(svgHref).toMatch(/\.svg/i);
  expect(zipHref).toMatch(/qr-kit\.zip/i);
  expect(pdfLinks.length).toBeGreaterThanOrEqual(3);

  await expectOk(page.context(), pngHref, 'QR PNG');
  await expectOk(page.context(), svgHref, 'QR SVG');
  await expectOk(page.context(), zipHref, 'QR ZIP');
  for (const href of pdfLinks) await expectOk(page.context(), href, `QR PDF ${href}`);

  const linkJson = await expectOk(page.context(), zipHref, 'QR ZIP second check');
  expect((await linkJson.body()).length).toBeGreaterThan(500);

  ensureDir();
  fs.writeFileSync(path.join(outDir, `${test.info().project.name}-publish-qr.json`), JSON.stringify({ memorialId, publicUrl, publicPath, pngHref, svgHref, zipHref, pdfLinks, bad }, null, 2), 'utf8');

  const serious = bad.filter(item => !item.url.includes('/favicon.ico'));
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
});
