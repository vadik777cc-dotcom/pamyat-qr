# Локальный запуск — короткая инструкция

## 1. Распаковать архив

```bash
unzip pamyat_company_admin_release_candidate_v1.zip
cd pamyat_company_admin_release_candidate_v1
```

## 2. Установить зависимости

```bash
npm install
```

## 3. Создать `.env`

```bash
cp .env.example .env
```

По умолчанию будет:

```text
PORT=3001
ADMIN_LOGIN=manager
ADMIN_PASSWORD=change-me
```

## 4. Создать демо-данные

```bash
npm run seed
```

## 5. Запустить сервер

```bash
npm start
```

## 6. Открыть в браузере

Админка:

```text
http://localhost:3001/admin/login
```

Демо-доступ:

```text
manager / change-me
```

Публичный лендинг:

```text
http://localhost:3001/
```

## 7. Полная QA-проверка

```bash
npx playwright install
rm -rf playwright-report test-results
npm run test:e2e
```

Ожидаемый результат для release candidate:

```text
18 passed
```
