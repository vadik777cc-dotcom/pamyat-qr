const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const outDir = path.join('test-results', 'visual-assets-polish');
function ensure(){ fs.mkdirSync(outDir, { recursive:true }); }
function labelFromUrl(url){ return String(url).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'root'; }

async function scrollFullPage(page){
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let y = 0;
      const step = Math.max(360, Math.floor(window.innerHeight * 0.8));
      const timer = setInterval(() => {
        y += step;
        window.scrollTo(0, y);
        if (y >= document.documentElement.scrollHeight - window.innerHeight - 20) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 80);
    });
  });
  await page.waitForTimeout(500);
}

async function collectAssetProblems(page){
  return await page.evaluate(() => {
    const imgs = Array.from(document.images).map(img => ({
      src: img.currentSrc || img.src || img.getAttribute('src') || '',
      alt: img.getAttribute('alt') || '',
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      visible: !!(img.offsetWidth || img.offsetHeight || img.getClientRects().length)
    })).filter(img => img.visible && (!img.complete || img.naturalWidth < 8 || img.naturalHeight < 8));
    const backgrounds = [];
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const bg = getComputedStyle(el).backgroundImage;
      if (!bg || bg === 'none') continue;
      const matches = [...bg.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map(m => m[1]);
      for (const src of matches) backgrounds.push({ src, text: (el.textContent || '').trim().slice(0,80) });
    }
    const overflow = Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth);
    return { imgs, backgrounds, overflow };
  });
}

async function checkBackgroundUrls(page, backgrounds){
  const broken = [];
  for (const item of backgrounds) {
    if (!item.src || item.src.startsWith('data:') || item.src.startsWith('blob:')) continue;
    const absolute = await page.evaluate(src => new URL(src, location.href).href, item.src);
    const response = await page.request.get(absolute).catch(e => ({ status: () => 0, error: String(e) }));
    const status = response.status ? response.status() : 0;
    if (status >= 400 || status === 0) broken.push({ status, url:absolute, text:item.text });
  }
  return broken;
}

async function collectTypographyWarnings(page){
  return await page.evaluate(() => {
    const warnings = [];
    const allowed = /^(H1|H2|H3|BUTTON|B|STRONG)$/;
    for (const el of Array.from(document.querySelectorAll('p, li, a, span, small, div'))) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 18 || text.length > 220) continue;
      const style = getComputedStyle(el);
      const weight = parseInt(style.fontWeight, 10) || 400;
      const size = parseFloat(style.fontSize) || 16;
      const visible = style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length;
      if (visible && !allowed.test(el.tagName) && weight >= 750 && size <= 24) warnings.push({ tag:el.tagName, weight, size, text:text.slice(0,120) });
    }
    return warnings.slice(0, 80);
  });
}

async function auditPublicPage(page, url){
  ensure();
  const response = await page.goto(url, { waitUntil:'domcontentloaded', timeout:45000 });
  await page.waitForLoadState('load', { timeout:15000 }).catch(() => {});
  await page.waitForTimeout(800);
  await scrollFullPage(page);
  const label = labelFromUrl(url);
  const shotPath = path.join(outDir, `${test.info().project.name}-${label}.png`);
  await page.screenshot({ path:shotPath, fullPage:true });
  const assetProblems = await collectAssetProblems(page);
  const brokenBackgrounds = await checkBackgroundUrls(page, assetProblems.backgrounds);
  const typographyWarnings = await collectTypographyWarnings(page);
  const report = { url, status: response ? response.status() : null, brokenImages: assetProblems.imgs, brokenBackgrounds, overflow: assetProblems.overflow, typographyWarnings };
  fs.writeFileSync(path.join(outDir, `${test.info().project.name}-${label}.json`), JSON.stringify(report, null, 2), 'utf8');
  return report;
}

test('public examples have no missing images or mobile overflow', async ({ page }) => {
  const pages = [
    '/',
    '/demo/b2b',
    '/demo/families',
    '/demo/memory',
    '/primer-b2b',
    '/primer-dlya-semei',
    '/primer-stranicy-pamyati',
    '/static/examples/b2b/index.html',
    '/static/examples/b2c/index.html',
    '/static/examples/memory/index.html'
  ];
  const reports = [];
  for (const url of pages) reports.push(await auditPublicPage(page, url));
  const failures = [];
  for (const r of reports) {
    for (const x of r.brokenImages) failures.push({ type:'image', page:r.url, item:x });
    for (const x of r.brokenBackgrounds) failures.push({ type:'background', page:r.url, item:x });
    if (r.overflow > 6) failures.push({ type:'overflow', page:r.url, item:{ px:r.overflow } });
  }
  fs.writeFileSync(path.join(outDir, `${test.info().project.name}-summary.json`), JSON.stringify({ reports, failures }, null, 2), 'utf8');
  expect(failures).toEqual([]);
});

test('public examples do not use heavy font weight for body copy', async ({ page }) => {
  const pages = ['/', '/demo/b2b', '/demo/families', '/demo/memory', '/static/examples/b2b/index.html', '/static/examples/b2c/index.html', '/static/examples/memory/index.html'];
  const all = [];
  for (const url of pages) {
    await page.goto(url, { waitUntil:'domcontentloaded', timeout:45000 });
    await page.waitForLoadState('load', { timeout:15000 }).catch(() => {});
    await page.waitForTimeout(800);
    await scrollFullPage(page);
    const warnings = await collectTypographyWarnings(page);
    all.push({ url, warnings });
  }
  ensure();
  fs.writeFileSync(path.join(outDir, `${test.info().project.name}-typography.json`), JSON.stringify(all, null, 2), 'utf8');
  const tooHeavy = all.flatMap(r => r.warnings.map(w => ({ page:r.url, item:w })));
  expect(tooHeavy).toEqual([]);
});
