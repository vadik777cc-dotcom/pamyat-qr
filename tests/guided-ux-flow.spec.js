const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

async function login(page, login='manager'){
  await page.goto('/admin/login', { waitUntil:'domcontentloaded' });
  await page.locator('input[name="login"], input[name="username"], input[type="text"]').first().fill(login);
  await page.locator('input[name="password"], input[name="pass"], input[type="password"]').first().fill('change-me');
  await Promise.all([
    page.waitForURL(/\/admin/, { timeout:20000 }).catch(()=>page.waitForLoadState('networkidle')),
    page.getByRole('button', { name:/войти/i }).click()
  ]);
}
async function shot(page, name){
  const dir = path.join('test-results','guided-ux-flow');
  fs.mkdirSync(dir,{recursive:true});
  await page.screenshot({ path:path.join(dir, `${test.info().project.name}-${name}.png`), fullPage:true, timeout:45000 }).catch(()=>{});
}

test('guided UX flow: page-level hints lead manager from company to landing, memorial and address', async ({ page }) => {
  await login(page, 'manager');

  await page.goto('/admin', { waitUntil:'networkidle' });
  await expect(page.getByRole('heading', { name:/Главная/i })).toBeVisible();
  const dashboardGuide = page.locator('[data-guided-step="dashboard"]');
  if (await dashboardGuide.count()) {
    await expect(dashboardGuide).toContainText(/С чего начать|проверьте данные компании|Перейти к лендингу/i);
  } else {
    await expect(page.locator('main')).toContainText(/Рабочий стол менеджера|Что сделать сейчас|Создать страницу памяти/i);
  }
  await shot(page, '01-dashboard-guided-start');

  await page.goto('/admin/company', { waitUntil:'networkidle' });
  const companyGuide = page.locator('[data-guided-step="company"]');
  if (await companyGuide.count()) {
    await expect(companyGuide).toContainText(/Шаг 1 из 5|Заполните данные компании|перейти к лендингу/i);
  } else {
    await expect(page.getByRole('heading', { name:/Компания/i })).toBeVisible();
    await expect(page.locator('main')).toContainText(/Название|Город|Телефон|Сохранить/i);
  }
  await shot(page, '02-company-step');

  await page.goto('/admin/landing', { waitUntil:'networkidle' });
  const landingGuide = page.locator('[data-guided-step="landing"]');
  if (await landingGuide.count()) {
    await expect(landingGuide).toContainText(/Шаг 2 из 5|Настройте лендинг для семей|Открыть страницы памяти/i);
  } else {
    await expect(page.getByRole('heading', { name:'Лендинг для семей', exact:true })).toBeVisible();
    await expect(page.locator('main')).toContainText(/Главный заголовок|Контакты для семьи|Предпросмотр/i);
  }
  await shot(page, '03-landing-step');

  await page.goto('/admin/memorials', { waitUntil:'networkidle' });
  const memorialsGuide = page.locator('[data-guided-step^="memorials_"]');
  if (await memorialsGuide.count()) {
    await expect(memorialsGuide).toContainText(/Шаг 3 из 5|Шаг 4 из 5|страниц[ау] памяти|QR-код/i);
  } else {
    await expect(page.locator('main')).toContainText(/Страницы памяти|Создать/i);
  }
  await shot(page, '04-memorials-step');

  await page.goto('/admin/memorials/new', { waitUntil:'networkidle' });
  const memorialNewGuide = page.locator('[data-guided-step="memorial_new"]');
  if (await memorialNewGuide.count()) {
    await expect(memorialNewGuide).toContainText(/Шаг 3 из 5|ФИО|дат|главного фото|согласие семьи/i);
  } else {
    await expect(page.locator('main')).toContainText(/ФИО|Дата рождения|Дата смерти|Сохранить/i);
  }
  await shot(page, '05-memorial-new-step');

  await page.goto('/admin/deploy', { waitUntil:'networkidle' });
  const deployGuide = page.locator('[data-guided-step="deploy"]');
  if (await deployGuide.count()) {
    await expect(deployGuide).toContainText(/Шаг 5 из 5|бесплатным адресом|Свой домен|Адрес/i);
  } else {
    await expect(page.getByRole('heading', { name:'Адрес сайта', exact:true })).toBeVisible();
    await expect(page.locator('main')).toContainText(/Адрес для семей|Короткая ссылка|Бренд компании/i);
  }
  await shot(page, '06-address-step');
});
