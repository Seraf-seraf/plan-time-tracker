# Worker трекера планов

Приложение использует Cloudflare Worker ESM и аутентификацию владельца в Sites. Версия исходников указана в `package.json`, версию запущенного сервиса возвращает `GetTrackerInfo.version`.

## Подключение к базе

`DB_DRIVER=d1` использует привязку `DB` по умолчанию. Для SQLite на отдельном сервере задайте в окружении Worker `DB_DRIVER=remote-sqlite`, HTTPS-адрес `DB_URL` и секрет `DB_TOKEN`. Тайм-аут одного запроса задаёт `DB_TIMEOUT_MS` (по умолчанию 30000). Сервис принимает тот же секрет и путь к файлу в `DB_FILE`. Пример переменных, конфигурация nginx и unit systemd находятся в [tracker-db](tracker-db/).

Файл рабочей базы на `pay` — `/var/lib/plan-time-tracker/tracker.sqlite3`. Перед обновлением Worker применяйте совместимые SQL-миграции к выбранной базе. Для резервной копии работающей SQLite используйте SQLite Backup API, который учитывает WAL.

## Контракт

Сервер публикует актуальные схемы MCP через `tools/list` и описание возможностей через `GetTrackerInfo` и `GET /api/tracker/capabilities`. [Инструменты MCP](../../docs/mcp-naming-review.md), [контракт планов, этапов и времени](../../docs/plan-documents.md).

## ATLM и требования

ATLM использует признаки `agent-task-v4`, точечные методы OLS, Ridge и Bayesian и отдельный прогнозный интервал. При отсутствии модели возможен ранний ориентир historical-median. Для первого запуска сохраните плановую оценку ATLM и проверьте READY через GetSavedEstimate. StartPlan фиксирует результат даже при отсутствии обученной модели. [Контракт ATLM](../../docs/atlm.md).

Ручной запуск доступен кнопкой «Начать обучение» и через `StartTraining`, независимо от двух новых планов. HTTP `POST /api/tracker/estimation-model/start` принимает `{}` и использует тот же процесс. Проверки данных и активации модели сохраняются.

## Схема и проверки

Для установки применяйте все SQL-файлы из `drizzle/` в порядке номеров. Тесты проверяют чистую базу и применение миграций к заполненной базе.

```sh
npm ci
npm run build
npm run validate
npm test
npm run test:ui
node --test ../../plugin/plan-time-tracker/test/*.test.mjs
```

Тесты запускаются в Node.js с `node:sqlite`. Браузерным сценариям нужны Playwright и Chromium. [Подготовка среды](test/README.md).

`test/simple-model.test.js` проверяет атомарность, контроль версий, повторы команд, изоляцию владельцев и обновление заполненной базы. Переменная `SITES_SOURCE_ROOT=/absolute/sites/checkout` дополнительно включает проверку SQL из этого репозитория Sites. Тесты используют синтетические данные.

## Упаковка

`npm run build` создаёт Worker `dist/server/index.js` и копирует каталог миграций в `dist/.openai/drizzle/`. Конфигурация проекта `.openai/hosting.json` хранится в отдельном репозитории Sites и нужна при упаковке для публикации. `npm run validate` проверяет, что собранный Worker импортируется и экспортирует `default.fetch`.
