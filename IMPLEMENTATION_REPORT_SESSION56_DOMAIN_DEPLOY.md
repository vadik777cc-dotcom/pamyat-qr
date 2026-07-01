# Session56 — Domain deployment package

## Сделано

- Адаптирован production-домен `https://pamyat-qr.ru`.
- Добавлены публичные демо-страницы:
  - `/demo/b2b`
  - `/demo/families`
  - `/demo/memory`
- Добавлены короткие редиректы:
  - `/primer-b2b`
  - `/primer-dlya-semei`
  - `/primer-stranicy-pamyati`
- В B2B-примере кнопки «Посмотреть пример» ведут на демо страницы памяти.
- В справке и материалах менеджера добавлены ссылки на демо-страницы.
- Исправлена навигация-«островок» на публичном лендинге: активная кнопка теперь обновляется после прокрутки и после клика по секциям даже после динамической подстановки nav.
- Подготовлена инструкция деплоя на Aeza: `docs/AEZA_DEPLOY_PAMYAT_QR.md`.
- Добавлены production-примеры:
  - `.env.example`
  - `deploy/nginx.pamyat-qr.ru.conf`
  - `deploy/pamyat-qr.service`
- Удалён мусор из релизного архива: старые implementation reports, `.DS_Store`, `__MACOSX`.

## Проверка

```bash
npm run check
npm run seed
npm run test:e2e:full
```

Для быстрой проверки после деплоя:

```bash
curl -I https://pamyat-qr.ru
curl -I https://pamyat-qr.ru/demo/b2b
curl -I https://pamyat-qr.ru/demo/families
curl -I https://pamyat-qr.ru/demo/memory
```
