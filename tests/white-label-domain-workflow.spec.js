const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

async function login(page){
  await page.goto('/admin/login', { waitUntil:'domcontentloaded' });
  await page.locator('input[name="login"], input[name="username"], input[type="text"]').first().fill('manager');
  await page.locator('input[name="password"], input[name="pass"], input[type="password"]').first().fill('change-me');
  await Promise.all([
    page.waitForURL(/\/admin/, { timeout:20000 }).catch(()=>page.waitForLoadState('networkidle')),
    page.getByRole('button', { name:/войти/i }).click()
  ]);
}
async function shot(page, name){
  const dir = path.join('test-results','white-label-domain-workflow');
  fs.mkdirSync(dir,{recursive:true});
  await page.screenshot({ path:path.join(dir, `${test.info().project.name}-${name}.png`), fullPage:true, timeout:45000 }).catch(()=>{});
}

test('white-label and domains: custom brand, domain host and public footer are scoped', async ({ page, context }) => {
  const stamp = Date.now();
  const slug = `qa-${stamp}`;
  const brand = `White Label Brand ${stamp}`;
  const footer = `© ${brand}`;

  await login(page);
  await page.goto('/admin/deploy', { waitUntil:'networkidle' });
  await expect(page.getByRole('heading', { name:/Адрес сайта/i })).toBeVisible();

  await page.locator('input[name="slug"]').fill(slug);
  await page.getByRole('button', { name:/Сохранить ссылку/i }).click();
  await page.waitForURL(/\/admin\/deploy/).catch(()=>page.waitForLoadState('networkidle'));

  await page.locator('input[name="white_label_enabled"]').check({ force:true });
  await page.locator('input[name="hide_platform_branding"]').check({ force:true });
  await page.locator('input[name="brand_display_name"]').fill(brand);
  await page.locator('input[name="public_footer_brand"]').fill(footer);
  await page.locator('input[name="accent_color"]').fill('#7a5533');
  await page.getByRole('button', { name:/Сохранить (white-label|бренд компании)/i }).click();
  await page.waitForURL(/\/admin\/deploy/).catch(()=>page.waitForLoadState('networkidle'));
  await shot(page, '01-deploy-white-label-saved');
  await expect(page.locator('input[name="brand_display_name"]')).toHaveValue(brand);
  await expect(page.locator('input[name="public_footer_brand"]')).toHaveValue(footer);
  await expect(page.locator('main')).toContainText(new RegExp(`/l/${slug}`));

  const bySlug = await page.goto(`/l/${slug}`, { waitUntil:'domcontentloaded' });
  expect(bySlug && bySlug.status()).toBeLessThan(400);
  await expect(page.locator('body')).toContainText(brand);
  await expect(page.locator('body')).toContainText(footer);
  await expect(page.locator('body')).not.toContainText('Работает на платформе Память QR');
  await shot(page, '02-public-by-slug-white-label');

  const robots = await context.request.get('/robots.txt');
  expect(robots.status()).toBeLessThan(400);

  await page.goto('/admin/deploy', { waitUntil:'networkidle' });
  const enabled = page.locator('input[name="white_label_enabled"]');
  if(await enabled.count() && await enabled.isChecked().catch(() => false)) await enabled.uncheck({ force:true });
  const hide = page.locator('input[name="hide_platform_branding"]');
  if(await hide.count() && await hide.isChecked().catch(() => false)) await hide.uncheck({ force:true });
  await page.getByRole('button', { name:/Сохранить (white-label|бренд компании)/i }).click();
  await page.waitForURL(/\/admin\/deploy/, { timeout:20000 }).catch(()=>page.waitForLoadState('networkidle'));
});
