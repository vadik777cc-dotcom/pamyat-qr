# Деплой Память QR на Aeza: pamyat-qr.ru

Домен: `pamyat-qr.ru`  
Сервер Aeza: `194.113.106.161`  
Приложение внутри сервера: `127.0.0.1:3001`

## 1. DNS у регистратора / в панели домена

Создайте записи:

| Имя | Тип | Значение | TTL |
|---|---|---|---|
| `@` | `A` | `194.113.106.161` | `300` |
| `www` | `A` | `194.113.106.161` | `300` |

После этого проверьте:

```bash
dig +short pamyat-qr.ru
dig +short www.pamyat-qr.ru
```

Оба должны вернуть `194.113.106.161`.

## 2. Подготовка сервера

```bash
ssh root@194.113.106.161
apt update && apt upgrade -y
apt install -y curl git unzip nginx certbot python3-certbot-nginx build-essential
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node -v
npm -v
```

## 3. Загрузка проекта

```bash
mkdir -p /var/www/pamyat-qr
cd /var/www/pamyat-qr
cd work_s56_domain_deploy
npm install --omit=dev
```

Для первичной проверки на сервере можно поставить dev-зависимости и прогнать тесты отдельно, но в production достаточно runtime-зависимостей.

## 4. Production `.env`

Создайте файл:

```bash
nano .env
```

Минимум:

```env
NODE_ENV=production
PORT=3001
APP_BASE_URL=https://pamyat-qr.ru
SESSION_SECRET=СЛУЧАЙНАЯ_СТРОКА_64_СИМВОЛА
ADMIN_LOGIN=admin
ADMIN_PASSWORD=СИЛЬНЫЙ_ПАРОЛЬ_ДЛЯ_ПЛАТФОРМЫ
ANALYTICS_SALT=СЛУЧАЙНАЯ_СТРОКА_ДЛЯ_АНАЛИТИКИ
MAX_UPLOAD_MB=30
```

Сгенерировать секреты:

```bash
openssl rand -hex 32
openssl rand -hex 32
```

## 5. Проверка приложения без Nginx

```bash
npm run check
node server.js
```

В другом окне:

```bash
curl -I http://127.0.0.1:3001
curl -I http://127.0.0.1:3001/demo/b2b
curl -I http://127.0.0.1:3001/demo/families
curl -I http://127.0.0.1:3001/demo/memory
```

## 6. systemd-сервис

```bash
nano /etc/systemd/system/pamyat-qr.service
```

```ini
[Unit]
Description=Pamyat QR Node App
After=network.target

[Service]
Type=simple
WorkingDirectory=/var/www/pamyat-qr/work_s56_domain_deploy
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
```

Запуск:

```bash
systemctl daemon-reload
systemctl enable pamyat-qr
systemctl start pamyat-qr
systemctl status pamyat-qr --no-pager
journalctl -u pamyat-qr -f
```

## 7. Nginx

```bash
nano /etc/nginx/sites-available/pamyat-qr.ru
```

```nginx
server {
    listen 80;
    server_name pamyat-qr.ru www.pamyat-qr.ru;

    client_max_body_size 40M;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
ln -sf /etc/nginx/sites-available/pamyat-qr.ru /etc/nginx/sites-enabled/pamyat-qr.ru
nginx -t
systemctl reload nginx
```

## 8. HTTPS

```bash
certbot --nginx -d pamyat-qr.ru -d www.pamyat-qr.ru
certbot renew --dry-run
```

После HTTPS проверьте:

```bash
curl -I https://pamyat-qr.ru
curl -I https://pamyat-qr.ru/admin/login
curl -I https://pamyat-qr.ru/demo/b2b
curl -I https://pamyat-qr.ru/demo/families
curl -I https://pamyat-qr.ru/demo/memory
```

## 9. Входы после деплоя

Платформенная админка:

```text
https://pamyat-qr.ru/admin/login
логин: значение ADMIN_LOGIN из .env
пароль: значение ADMIN_PASSWORD из .env
```

Партнёр не должен получать общий пароль. Платформа создаёт партнёра и выдаёт одноразовую ссылку подключения. Партнёр открывает ссылку, задаёт свой пароль и входит в свою админку.

## 10. Создание бизнеса

Платформа:

1. Войти в `https://pamyat-qr.ru/admin/login`.
2. Открыть платформенную админку.
3. Создать партнёра, если бизнес должен быть закреплён за партнёром.
4. Создать бизнес: название, город, телефон, email, логин.
5. Открыть карточку бизнеса.
6. Нажать «Создать ссылку входа».
7. Отправить клиенту одноразовую ссылку. Клиент сам задаёт пароль.

Партнёр:

1. Войти через свою админку.
2. Открыть «Мои бизнесы».
3. Создать бизнес в рамках своих прав.
4. Создать ссылку подключения для клиента.

Партнёр не удаляет бизнесы и не имеет доступа к глобальным функциям платформы.

## 11. Публичные демо-страницы

После деплоя доступны:

```text
https://pamyat-qr.ru/demo/b2b
https://pamyat-qr.ru/demo/families
https://pamyat-qr.ru/demo/memory
```

Их можно отправлять клиентам как отдельные примеры.
