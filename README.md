# Память QR — Release Candidate v1

Админ-панель для ритуальной компании: управление B2C-лендингом, страницами памяти, фотоальбомами, публикацией, QR-материалами, заявками, CRM и базовой аналитикой.

## Production-домен

Основной домен релиза: `https://pamyat-qr.ru`.
Инструкция для Aeza и DNS: `docs/AEZA_DEPLOY_PAMYAT_QR.md`.
Демо-страницы после деплоя:

- `https://pamyat-qr.ru/demo/b2b`
- `https://pamyat-qr.ru/demo/families`
- `https://pamyat-qr.ru/demo/memory`


## Быстрый локальный запуск

Требования:

- Node.js 18 или выше
- npm
- macOS/Linux/Windows с поддержкой `sharp` и `better-sqlite3`

Команды:

```bash
npm install
cp .env.example .env
npm run seed
npm start
```

Открыть:

```text
http://localhost:3001/admin/login
```

Демо-доступ из `.env.example`:

```text
login: manager
password: change-me
```

Публичный лендинг:

```text
http://localhost:3001/
```

После `npm run seed` также создаётся пример страницы памяти.

## Проверка проекта локально

Базовая проверка синтаксиса:

```bash
npm run check
```

Полный Playwright QA-контур:

```bash
npx playwright install
rm -rf playwright-report test-results
npm run test:e2e
```

Собрать архив с результатами QA:

```bash
zip -r playwright-debug.zip test-results playwright-report
```

Открыть HTML-отчёт:

```bash
npx playwright show-report
```

## Что покрыто автотестами

Финальный QA-контур release candidate прошёл 18/18:

- открытие админки;
- B2C-редактор;
- редактор страницы памяти;
- вкладки редакторов;
- live-preview;
- сохранение данных после перезагрузки;
- загрузка hero-фото;
- загрузка фото альбома;
- подстановка реальных `/uploads/...` в preview;
- публичный лендинг;
- публикация страницы памяти;
- публичная ссылка `/m/...`;
- QR-центр;
- PNG/SVG/ZIP/PDF QR-материалы;
- отсутствие 404/500 на ключевых страницах;
- desktop и mobile.

## Важные папки

```text
server.js                  основной Express-сервер
db.js                      SQLite-слой
scripts/seed.js            демо-данные
scripts/doctor.js          диагностика окружения
templates/                 HTML-шаблоны публичных страниц
public/admin/              JS/CSS админки
public/assets/             статические ассеты
uploads/                   локальные загрузки медиа
docs/                      документация
tests/                     Playwright QA
```

## Переменные окружения

Скопируйте `.env.example` в `.env` и измените секреты перед реальным использованием:

```bash
cp .env.example .env
```

Минимально важные поля:

```text
NODE_ENV=development
PORT=3001
APP_BASE_URL=http://localhost:3001
SESSION_SECRET=change-me-long-random-secret
ADMIN_LOGIN=manager
ADMIN_PASSWORD=change-me
ANALYTICS_SALT=change-me-long-random-analytics-salt
MAX_UPLOAD_MB=30
```

Для production обязательно заменить:

- `SESSION_SECRET`
- `ADMIN_PASSWORD`
- `ANALYTICS_SALT`
- `APP_BASE_URL`

## Production-заметки

Перед публикацией на сервере:

1. выставить `NODE_ENV=production`;
2. заменить пароль менеджера;
3. заменить все секреты;
4. настроить HTTPS через nginx/reverse proxy;
5. проверить `APP_BASE_URL`;
6. настроить backup SQLite и папки `uploads/`;
7. проверить права записи для:
   - `uploads/`
   - `sessions/`
   - `logs/`

Дополнительные заметки лежат в:

```text
docs/SECURITY_PRODUCTION.md
docs/DEPLOY_DOMAINS_SEO.md
docs/QA_PLAYWRIGHT.md
docs/NOTIFICATIONS.md
```

## Статус

Release Candidate v1. Технический QA-контур закрыт. Следующий этап — ручная продуктовая приёмка дизайна, текстов и сценариев менеджера.
