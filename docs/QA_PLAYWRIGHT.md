# Playwright QA

Команды:

```bash
npm run seed
rm -rf playwright-report test-results
npm run test:e2e
zip -r playwright-debug.zip test-results playwright-report
```

## Что проверяется

- открытие админки и публичных страниц;
- отсутствие 404/500 на ключевых маршрутах;
- вкладки редакторов B2C и страницы памяти;
- desktop/mobile скриншоты;
- реальная загрузка `main_photo` и `album_photos` в странице памяти;
- попадание загруженных изображений в preview через `/uploads/`.

Новый важный тест: `tests/media-persistence.spec.js`.


## Session 26: publish / QR / public link

Добавлен тест `tests/publish-qr-public-link.spec.js`. Он проверяет публикацию страницы памяти, открытие публичной ссылки и генерацию QR-комплекта: PNG, SVG, ZIP и PDF-макеты.

После прогона скриншоты и JSON-результат сохраняются в `test-results/publish-qr/`.

## Session 27 deep functional edit QA

`tests/editor-functional-deep.spec.js` adds a deeper functional test for the editor layer:

- edits company name and logo;
- edits B2C landing brand, hero, button, nav, contacts and FAQ;
- uploads a new hero image;
- opens the real preview button popup;
- checks that public landing and preview contain the same saved data;
- checks that uploaded media is used via `/uploads/...`;
- checks super admin and partner admin entry points.

Expected command:

```bash
npm run seed
rm -rf playwright-report test-results
npm run test:e2e
```
