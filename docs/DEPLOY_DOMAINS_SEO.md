# Домены, SEO и публичный деплой

Сессия 9 добавляет рабочий центр подготовки компании к публичному запуску:

- экран `/admin/deploy`;
- настройку домена компании;
- статус подключения домена;
- robots-policy на уровне компании;
- SEO/OG-настройки лендинга;
- canonical URL;
- публичные ссылки;
- `robots.txt`;
- `sitemap.xml`;
- доменную проверку `/.well-known/pamyat-domain-check`.

## Логика домена

Если у компании задан `custom_domain`, публичная ссылка строится от него:

```text
https://company-domain.ru/
https://company-domain.ru/m/company-slug/name-token
```

Если домена нет, используется `APP_BASE_URL` и стандартный путь:

```text
/l/company-slug
/m/company-slug/name-token
```

## Robots

Политики:

- `default` — закрывает `/admin`, `/family`, временные uploads;
- `noindex_all` — закрывает весь сайт компании;
- `allow_public` — разрешает публичные страницы, но всё равно закрывает служебные разделы.

Страницы памяти попадают в sitemap только если:

- `status = published`;
- `privacy_status = public`;
- `noindex = 0`.

## DNS

В админке показывается техническая подсказка:

```text
CNAME domain.ru -> app.pamyat-qr.ru
A domain.ru -> IP сервера
```

Фактическая схема выбирается по инфраструктуре.

## Nginx

В `deploy/nginx.company-domain.sample.conf` лежит пример reverse-proxy.
