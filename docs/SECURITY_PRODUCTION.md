# Security / production checklist

Сессия 10 добавляет базовую защиту для production-запуска админки менеджера.

## Обязательные переменные окружения

```env
NODE_ENV=production
APP_BASE_URL=https://your-domain.ru
SESSION_SECRET=<long-random-secret-64+chars>
ANALYTICS_SALT=<long-random-secret-64+chars>
MAX_UPLOAD_MB=30
```

`SESSION_SECRET` и `ANALYTICS_SALT` нельзя хранить в репозитории. На VPS они должны быть только в `.env`.

## Что включено

- Security headers: CSP, nosniff, same-origin frame protection, referrer policy, permissions policy.
- Secure session-cookie в production.
- CSRF-защита для обычных POST-форм: hidden token автоматически вставляется в HTML-формы.
- Origin-check для всех небезопасных методов.
- Rate limit для логина, публичной формы семьи и `/track`.
- Защита логина от перебора: временная блокировка после серии неверных попыток.
- Усиленная проверка загрузок: MIME, имя файла, сигнатура файла, лимит пикселей.
- Фото пересобираются в WebP без EXIF.
- `/uploads` отдаётся с `nosniff`, без dotfiles.
- Ошибки в production не показывают stack trace пользователю.
- Новый раздел `/admin/security`: security events + audit log.
- Скачивание backup логируется в audit log и отдаётся с `no-store`.

## Важное ограничение

Multipart-загрузки защищены Origin-check и SameSite-cookie. Для максимально строгого режима можно позже добавить отдельный CSRF-токен в multipart-поток после multer, но текущая сборка не ломает существующие загрузки фото.

## Проверка

```bash
npm run check
npm run doctor
npm start
```

Затем открыть:

- `/admin/login`
- `/admin/security`
- `/family/<company-slug>/submit`
- `/track` через публичный сайт
