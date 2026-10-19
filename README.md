# plan-time-tracker

Версия 3.0.0 учитывает выполнение каждого разрешённого пользователем плана через аутентифицированный MCP и серверные интервалы работы. Несколько планов могут выполняться независимо. Общее время владельца — объединение интервалов; время каждого плана и сумма также доступны. Проверки привязаны к снимкам исходников без требования Git-репозитория. Этот выпуск рассчитан на новую базу данных; обновление исходников на GitHub не развёртывает Worker и не обновляет установленное App.

Приватный Site: [Трекер планов](https://plan-time-tracker-v3.seraf-k.chatgpt.site). Новый Site v3 использует новое подключение App. GitHub-пакет 3.0.1 ссылается на него, сохраняя имя в marketplace. Отдельный плагин, созданный Site, имеет версию 3.0.0: его нужно установить и подключить отдельно от старого Site.

Исходники приложения, контракт API и подробные инструкции по проверкам: [sites/plan-time-tracker](sites/plan-time-tracker/README.md). Контракт доказательств: [docs/worktree-evidence.md](docs/worktree-evidence.md). Инструкции агента: [track-plan](plugin/plan-time-tracker/skills/track-plan/SKILL.md).

## Что потребуется

- Для установки плагина: актуальный Codex CLI с командами `plugin marketplace` и `plugin add`, Git, доступ к GitHub и учётная запись ChatGPT с доступом к приватному Site/App. Политика workspace должна разрешать плагин и его подключение.
- Для сборки и локальных проверок: Node.js 24, npm и Bash; для архива — `tar`. Проверки используют встроенный `node:sqlite`. В `package.json` нет зависимостей и поля `engines`; Node.js 24 — проверенное окружение, а не объявленная минимальная версия.
- Для публикации: доступ владельца/редактора к нужному проекту ChatGPT Sites и подключённые инструменты Sites. Одного доступа к этому GitHub-репозиторию недостаточно.

## Установка плагина в Codex CLI

Если Codex ещё не установлен, [официальная инструкция CLI](https://developers.openai.com/codex/cli) предлагает установку через npm:

```sh
npm install -g @openai/codex
```

Проверьте доступность команд и войдите через ChatGPT:

```sh
codex --version
codex plugin marketplace add --help
codex plugin add --help
codex login
codex login status
```

Добавьте marketplace репозитория и установите пакет:

```sh
codex plugin marketplace add Seraf-seraf/plan-time-tracker
codex plugin add dev-9529b49da3708191b8f13f1e1e4b1e01@plan-time-tracker
```

Имена взяты из [.agents/plugins/marketplace.json](.agents/plugins/marketplace.json) и [manifest](plugin/plan-time-tracker/plugin.json): marketplace — `plan-time-tracker`, пакет — `dev-9529b49da3708191b8f13f1e1e4b1e01`, версия — `3.0.1`. Синтаксис `PLUGIN@MARKETPLACE` и источник `owner/repo` подтверждены локальным `--help` Codex CLI 0.159.2. Установка и аутентификация приватного App при подготовке README не выполнялись.

Видимое имя плагина — «Трекер планов». Техническое поле `name` в командах не переводится. Единственный manifest пакета — корневой [`plugin.json`](plugin/plan-time-tracker/plugin.json) по схеме Agent Plugins; настройки OpenAI и ссылка на `.app.json` находятся в `extensions.com.openai`. Такой формат предусмотрен [правилами упаковки OpenAI](https://developers.openai.com/plugins/build/plugins). Codex CLI 0.159.2 обнаруживает пакет и версию через `plugin list --available --json` в изолированном профиле без установки. Отдельной команды `codex plugin validate` в этой версии нет. Старые клиенты, требующие вложенный manifest, не проверены; используйте актуальный клиент с поддержкой корневого формата.

Завершите предложенный клиентом процесс подключения App, затем начните новую сессию Codex. Списки для проверки:

```sh
codex plugin marketplace list
codex plugin list --marketplace plan-time-tracker
```

В новой сессии проверьте доступность MCP-инструментов: вызовите `GetTrackerCapabilities` и убедитесь, что `parallelPlans: true`; вызовите `ListPlans` с `statuses: ["RUNNING"]`, проходя все страницы по `nextCursor`. Это чтение, оно не запускает таймер. После выпуска совместимого Worker обновите discovery инструментов. Если инструментов нет или вход не работает, остановитесь и сообщите проблему; не подставляйте `ownerId` и не обходите вход другим endpoint.

### Установка собственного плагина и распространение

Для проверки локальной копии собственного marketplace вместо GitHub-источника выполните из корня клона `codex plugin marketplace add .`, затем `codex plugin add dev-9529b49da3708191b8f13f1e1e4b1e01@plan-time-tracker`. Выберите один источник marketplace с этим именем. Локальная установка всё равно использует App из [.app.json](plugin/plan-time-tracker/.app.json): `asdk_app_sites_ae77444ef43481919c2588ef24f70c84`. Она не поднимает локальный сервер и не выдаёт доступ к чужому приватному Site.

В ChatGPT откройте каталог Plugins, найдите доступный вам собственный плагин, установите его, завершите подключение и начните новый чат. Общая процедура описана в [документации Plugins](https://learn.chatgpt.com/docs/plugins). Для этого Site отдельный плагин имеет ID `plugin_asdk_app_sites_ae77444ef43481919c2588ef24f70c84` и версию 3.0.0; это не имя GitHub-пакета для `codex plugin add`.

Добавление GitHub marketplace распространяет исходный пакет среди тех, кто может его получить. Оно не публикует плагин в общем каталоге и не делает Site общедоступным. Для публичного каталога предусмотрена отдельная [подача плагина на проверку](https://developers.openai.com/plugins/deploy/submission). Ни публичная подача, ни установка пакета не заменяют настройку доступа и аутентификацию приватного App. Подключения к предыдущему Site автоматически не переключаются.

## Подготовка site локально

Для нового клона:

```sh
git clone https://github.com/Seraf-seraf/plan-time-tracker.git
cd plan-time-tracker
```

Если репозиторий уже клонирован, используйте его текущий checkout. Из корня проверьте выбранную версию и перейдите к приложению:

```sh
git remote -v
git status --short --branch
git rev-parse HEAD
cd sites/plan-time-tracker
node --version
npm --version
npm run build
npm run validate
```

`npm install` / `npm ci` для этого приложения не нужны: зависимостей и lockfile нет. Скрипт [build.sh](sites/plan-time-tracker/scripts/build.sh) пересоздаёт только локальный `dist/`, копирует `worker/index.js` в `dist/server/index.js` и hosting manifest в `dist/.openai/hosting.json`. Worker содержит UI и MCP endpoint `/mcp`. `validate` проверяет ESM-артефакт и экспорт `default.fetch`; сборка ничего не публикует.

Локальные проверки из того же каталога:

```sh
npm test
node --test ../../plugin/plan-time-tracker/test/*.test.mjs
```

`npm test` сначала выполняет build и использует SQLite в памяти. Тесты плагина включают проверку единственного manifest, App-привязки и упаковки/распаковки через `tar`. Дополнительные браузерные проверки требуют отдельно установленного Playwright и Chromium; точные переменные и команда есть в [README приложения](sites/plan-time-tracker/README.md#local-verification). Локальные проверки не подтверждают hosted D1, вход или доступ к приватному App.

### Конфигурация и переменные среды

Провайдер, предусмотренный репозиторием, — ChatGPT Sites с Cloudflare Worker и D1. Его конфигурация: [`.openai/hosting.json`](sites/plan-time-tracker/.openai/hosting.json).

| Параметр | Назначение |
| --- | --- |
| `project_id` | `appgprj_6ad342fe722481919f98177e1c447931` — существующий приватный проект v3; это идентификатор проекта, не секрет. |
| `d1: "DB"` | Требуемый D1 binding `env.DB`; его предоставляет хостинг. Это объект базы, а не строковая переменная с URL. |
| `capabilities: ["mcp"]` | Включает MCP для соответствующего Site. |
| `r2: null` | R2 этому приложению не нужен. |

Обязательных строковых переменных окружения и `.env.example` нет. Текущий Worker читает только `env.DB`; GitHub PAT, OpenAI API key, `DATABASE_URL` и Cloudflare API token приложению не требуются. Для UI-тестов предусмотрены `PLAYWRIGHT_MODULE`, `CHROMIUM_EXECUTABLE`, `UI_ACCEPTANCE_ARTIFACT_DIR`; это локальные параметры тестов.

Вход обеспечивает ChatGPT Sites: Worker ожидает доверенные `oai-authenticated-user-id` и необязательный `oai-authenticated-user-email`. Не задавайте их как секреты или пользовательские заголовки для обхода входа. Размещение Worker напрямую на другом хостинге требует отдельного доверенного слоя аутентификации; конфигурации такого развёртывания здесь нет.

### База данных и миграции v3

Для новой установки нужна **новая пустая D1** с binding `DB`. Примените все 15 SQL-файлов из [drizzle](sites/plan-time-tracker/drizzle) в порядке имён: от `0001_initial.sql` до `0015_source_snapshots.sql`. Проверки используют именно эту цепочку. Старые таблицы сохраняются для истории, хотя текущий контракт не требует интеграции с GitHub.

Старая база с ограничением на один RUNNING-план не поддерживается этим выпуском: исправленная `0001_initial.sql` рассчитана на создание новой схемы. Не применяйте начальную цепочку повторно к рабочей базе и не обновляйте только Worker старой установки. Уже подготовленную v3-базу при обычной публикации не обнуляют.

**Ограничение автоматизации:** в репозитории нет migration script, Wrangler-конфигурации или подтверждённой CLI-команды применения SQL к Sites D1. Build не включает `drizzle/` в артефакт и не выполняет SQL. Доступный инструмент Sites `read_database_overview` только читает схему. Для первоначального развёртывания владелец должен обеспечить применение цепочки через доступный ему поддерживаемый механизм Sites/D1 и подтвердить полученную схему. Если такого доступа нет, первоначальное развёртывание заблокировано на этом шаге; не считайте `npm run build` или загрузку архива миграцией базы.

## Развёртывание через ChatGPT Sites

Публикация — отдельная операция владельца. Ниже порядок работы с подключёнными инструментами Sites; это **не shell-команды**. В репозитории нет `npm run deploy`, настроек Vercel/Netlify или готового standalone-развёртывания через Wrangler. Общие правила публикации и доступа: [Sites — Publish and share](https://learn.chatgpt.com/docs/sites/publishing-and-sharing).

1. Прочитайте hosting manifest. Для обновления используйте его точный `project_id`, проверьте проект через `get_site` и сохраните приватную аудиторию. Для независимой установки сначала подготовьте отдельную копию приложения без привязки к чужому проекту, создайте свой проект через `create_site` и сохраните возвращённый ID в её manifest. Не придумывайте ID проекта, App или плагина; новая установка также требует собственного App-подключения и обновления metadata пакета.
2. Убедитесь, что целевая D1 подготовлена по разделу о миграциях. Для существующего v3-проекта проверьте binding `DB` и схему через `read_database_overview`; этот вызов не применяет миграции.
3. Подготовьте точное состояние исходников в **source repository, настроенном у Site**. Это не обязательно GitHub `origin` данного репозитория. При необходимости инструмент `create_source_repository_write_credential` возвращает точные `remote_url`, `branch` и краткоживущие credentials. Не включайте token в README, remote URL, журналы или архив. Для обычного явного save/deploy не запрашивайте `publish_on_push`.
4. Зафиксируйте и отправьте это состояние в source branch Site в рамках отдельного разрешённого выпуска. Сборка должна соответствовать отправленному commit; `commit_sha` при сохранении версии — полный SHA текущей HEAD этой удалённой ветки. Обновление GitHub само по себе не выполняет этот шаг.
5. Из соответствующего checkout выполните build, validate и локальные проверки выше. Упакуйте **содержимое `dist/`**, включая скрытый `.openai`, в tar-архив. Пример из каталога `sites/plan-time-tracker` для Bash; локальный архив создаётся во временном каталоге:

   ```sh
   tracker_archive_dir=$(mktemp -d)
   tar -czf "$tracker_archive_dir/plan-time-tracker.tar.gz" -C dist .
   tar -tzf "$tracker_archive_dir/plan-time-tracker.tar.gz"
   ```

   В архиве должны быть `./server/index.js` и `./.openai/hosting.json`. Исходники, `.git`, credentials и SQL-миграции в этот build-артефакт не входят. Сохраните абсолютный путь к архиву до завершения загрузки.
6. Вызовите `save_site_version` с точным `project_id`, полным `commit_sha` из шага 4 и абсолютным путём `archive` из шага 5. Операция сохраняет версию без публикации; возьмите `id` из её ответа как `version_id`.
7. Для подтверждённого приватного проекта вызовите `deploy_private_site_version` с теми же `project_id` и полученным `version_id`. При несовпадении аудитории остановитесь и выясните причину. Проверяйте `get_deployment_status` по возвращённому deployment ID до `succeeded` или `failed`; опубликованный URL является production URL.
8. После успеха проверьте вход в UI под владельцем и MCP-проверки чтения `GetTrackerCapabilities` / `ListPlans`. Проверьте `parallelPlans: true` и полноту пагинации. Отдельно обновите/подключите соответствующий плагин и discovery в клиентах: публикация Worker не обновляет установленный пакет.

Названия и параметры операций сверены с доступными официальными схемами инструментов Sites (`save_site_version`, `deploy_private_site_version`, `create_source_repository_write_credential`, `read_database_overview`). Сквозное развёртывание, миграции hosted D1 и подключение приватного App при подготовке этой инструкции не выполнялись.
