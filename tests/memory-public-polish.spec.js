const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const outDir = path.join(process.cwd(), 'test-results', 'memory-public-polish');
function ensureDir(){ fs.mkdirSync(outDir, { recursive:true }); }
async function shot(page, name){ ensureDir(); await page.screenshot({ path:path.join(outDir, `${test.info().project.name}-${name}.png`), fullPage:true }); }
async function login(page){
  await page.goto('/admin/login', { waitUntil:'domcontentloaded' });
  await page.locator('input[name="login"]').fill(process.env.ADMIN_LOGIN || 'manager');
  await page.locator('input[name="password"]').fill(process.env.ADMIN_PASSWORD || 'change-me');
  await Promise.all([
    page.waitForURL(/\/admin/, { timeout:20000 }).catch(()=>page.waitForLoadState('domcontentloaded')),
    page.getByRole('button', { name:/Войти/i }).click()
  ]);
}

test('memory public polish: page is calm, family-focused and mobile-safe', async ({ page }) => {
  await login(page);
  await page.goto('/admin/memorials', { waitUntil:'networkidle' });
  await page.getByRole('link', { name:/редактировать/i }).first().click();
  await page.waitForLoadState('networkidle').catch(()=>{});
  const editorUrl = page.url();
  const memorialId = (editorUrl.match(/\/admin\/memorials\/(\d+)/) || [])[1];
  expect(memorialId, 'memorial id should be present in editor url').toBeTruthy();
  await page.goto(`/admin/memorials/${memorialId}/preview`, { waitUntil:'domcontentloaded' });

  await expect(page.locator('body')).toContainText(/Свеча памяти|Тёплые слова близких|История жизни|Семейный альбом/i);
  await expect(page.locator('body')).not.toContainText(/Slug|Desktop|Mobile|EXIF|SEO|DNS|CNAME|технические настройки/i);
  await expect(page.locator('#session51-memory-public-polish')).toHaveCount(1);
  await expect(page.locator('.candle-last')).toBeHidden();
  await expect(page.locator('.name-form')).toBeHidden();
  await expect(page.locator('.footer-privacy')).toBeHidden();
  await expect(page.locator('.hero')).toHaveCSS('overflow', /visible|hidden/);
  await shot(page, '01-public-memory-polished');

  await page.setViewportSize({ width:390, height:844 });
  await page.reload({ waitUntil:'domcontentloaded' });
  await expect(page.locator('.candle-card')).toBeVisible();
  await expect(page.locator('.album-viewer')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/Desktop|Mobile|EXIF|SEO|DNS|CNAME/i);
  await shot(page, '02-public-memory-mobile-polished');
});
