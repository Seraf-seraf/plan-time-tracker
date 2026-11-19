import {
  AppError,
  TRACKER_COMMANDS,
  TRACKER_READ_TOOLS,
  TRACKER_VERSION,
  TRACKER_VERSIONED_COMMANDS,
  WRITE_COMMANDS,
  appError,
  assertExactKeys,
  bodyJson,
  checkTimeZone,
  dbFirst,
  ensureOwner,
  isPlainRecord,
  isPlanDocumentCommand,
  json,
  mapDbError,
  messageFor,
  requireOwner,
  validateOrigin,
} from '../shared/index.js';
import { ATLM_TOOL_SCHEMAS } from '../atlm/sample.js';
import { executeAtlmTool, getEstimationTrainingHistory } from '../atlm/forecast.js';
import {
  MAX_PLAN_PAGE_SIZE,
  PLAN_STATUSES,
  assessmentPayloadSchema,
  buildAnalytics,
  buildStepAnalytics,
  estimationHistorySchema,
  executeCommand,
  getAssessmentSchema,
  listPlans,
  readAssessment,
  readCommandReceipt,
  readEstimationHistory,
  readPlan,
  readPlanExecutionSnapshot,
  readTrackerCapabilities,
} from '../tracker/index.js';
import { scheduleAtlmTraining } from '../atlm/training.js';

function validatePublicCommand(envelope) {
  if (!WRITE_COMMANDS.has(envelope?.commandType) && !TRACKER_COMMANDS.has(envelope?.commandType))
    throw appError('VALIDATION_ERROR', 'Неизвестная команда.');
  const payload = envelope?.payload;
  if (!isPlainRecord(payload)) return;
  const fields = {
    CreatePlan: [
      'planId',
      'title',
      'description',
      'acceptanceCriteria',
      'planCreatedAt',
      'planText',
      'sourceReference',
    ],
    UpdatePlanMetadata: [
      'planId',
      'title',
      'description',
      'acceptanceCriteria',
      'planCreatedAt',
      'reason',
      'confirmDateAnomaly',
      'planText',
      'stepEdits',
    ],
    StartPlan: ['planId'],
    PausePlan: ['planId', 'reason'],
    ResumePlan: ['planId'],
    FinishPlan: ['planId', 'completionNote', 'allowIncomplete', 'reason'],
    DeletePlan: ['planId', 'reason'],
    RestorePlan: ['planId', 'reason'],
  }[envelope.commandType];
  if (fields) assertExactKeys(payload, new Set(fields), 'payload');
}

function publicView(value) {
  if (Array.isArray(value)) return value.map(publicView);
  if (!value || typeof value !== 'object') return value;
  const hidden = new Set([
    'repositories',
    'commits',
    'commitConflicts',
    'repositoryId',
    'repositoryIds',
    'repositoryRefs',
    'repository_id',
    'revisionSha',
    'revision_sha',
    'testedSha',
    'tested_sha',
    'baseRevisionSha',
    'base_revision_sha',
    'commitPolicy',
    'pushPolicy',
    'commit_policy',
    'push_policy',
    'gitEvidence',
  ]);
  const result = {};
  for (const [key, item] of Object.entries(value))
    if (!hidden.has(key))
      result[key] = key === 'assessment' && item?.formatVersion === 1 ? item : publicView(item);
  return result;
}

async function apiRoute(request, env, url, channel, now, clock = () => now, ctx) {
  validateOrigin(request);
  const identity = requireOwner(request);
  if (!env.DB) throw appError('INTERNAL_ERROR', 'D1 binding DB не настроен.', 503);
  if (request.method === 'GET' && url.pathname === '/api/tracker/estimation-training-history') {
    const args = {};
    for (const key of url.searchParams.keys())
      if (!['limit', 'cursor'].includes(key))
        throw appError('VALIDATION_ERROR', 'Неизвестный параметр истории обучения.');
    if (url.searchParams.has('limit')) args.limit = Number(url.searchParams.get('limit'));
    if (url.searchParams.has('cursor')) args.cursor = url.searchParams.get('cursor');
    return json(await getEstimationTrainingHistory(env.DB, identity.ownerId, args, now));
  }
  const readOnlyPost = new Set([
    '/api/tracker/assessment',
    '/api/tracker/atlm-estimate',
    '/api/tracker/atlm-dataset',
    '/api/tracker/estimation-history',
  ]);
  if (request.method !== 'GET' && !readOnlyPost.has(url.pathname))
    await ensureOwner(env.DB, identity, now);
  if (request.method === 'GET' && url.pathname === '/api/whoami')
    return json({ userId: identity.ownerId, email: identity.email, serverNow: now });
  if (request.method === 'GET' && url.pathname === '/api/settings') {
    const settings = await dbFirst(
      env.DB,
      'SELECT timezone,locale FROM owners WHERE owner_id=?',
      identity.ownerId,
    );
    return json({ timezone: settings?.timezone ?? 'UTC', locale: settings?.locale ?? 'en' });
  }
  if (request.method === 'POST' && url.pathname === '/api/settings') {
    const body = await bodyJson(request);
    const zone = checkTimeZone(body.timezone);
    await env.DB.prepare('UPDATE owners SET timezone=? WHERE owner_id=?')
      .bind(zone, identity.ownerId)
      .run();
    return json({ timezone: zone });
  }
  if (request.method === 'GET' && url.pathname === '/api/plans') {
    const filter = {};
    const view = url.searchParams.get('view');
    if (view !== null && view !== 'cards')
      throw appError('VALIDATION_ERROR', 'Неизвестное представление списка планов.');
    for (const key of url.searchParams.keys())
      if (!['statuses', 'limit', 'cursor', 'deleted', 'view'].includes(key))
        throw appError('VALIDATION_ERROR', 'Неизвестный фильтр списка планов.');
    if (url.searchParams.has('statuses'))
      filter.statuses = url.searchParams.get('statuses').split(',');
    if (url.searchParams.has('limit')) filter.limit = Number(url.searchParams.get('limit'));
    if (url.searchParams.has('cursor')) filter.cursor = url.searchParams.get('cursor');
    if (url.searchParams.has('deleted')) {
      if (!['true', 'false'].includes(url.searchParams.get('deleted')))
        throw appError('VALIDATION_ERROR', 'deleted должен быть true или false.');
      filter.deleted = url.searchParams.get('deleted') === 'true';
    }
    return json(await listPlans(env.DB, identity.ownerId, now, filter, view === 'cards'));
  }

  if (request.method === 'GET' && url.pathname === '/api/tracker/capabilities')
    return json(publicToolReferences(await readTrackerCapabilities(env.DB, identity.ownerId)));
  if (request.method === 'POST' && url.pathname === '/api/tracker/assessment')
    return json(await readAssessment(env.DB, identity.ownerId, await bodyJson(request), now));
  const atlmPaths = {
    '/api/tracker/atlm-estimate': 'CalculateAtlmEstimate',
    '/api/tracker/atlm-dataset': 'GetAtlmDataset',
    '/api/tracker/estimation-model/process': 'ProcessEstimationTraining',
    '/api/tracker/estimation-model/start': 'StartEstimationTraining',
  };
  if (request.method === 'POST' && atlmPaths[url.pathname])
    return json(
      await executeAtlmTool(
        env.DB,
        identity.ownerId,
        atlmPaths[url.pathname],
        await bodyJson(request),
        now,
        clock,
      ),
    );
  if (request.method === 'GET' && url.pathname === '/api/tracker/estimation-model') {
    if (url.search) throw appError('VALIDATION_ERROR', 'Model status accepts no query parameters.');
    return json(
      await executeAtlmTool(env.DB, identity.ownerId, 'GetEstimationModelStatus', {}, now, clock),
    );
  }
  const atlmPlanMatch = url.pathname.match(/^\/api\/tracker\/plans\/([^/]+)\/estimate$/);
  if (request.method === 'GET' && atlmPlanMatch) {
    if (url.search) throw appError('VALIDATION_ERROR', 'Plan estimate accepts only planId.');
    return json(
      await executeAtlmTool(
        env.DB,
        identity.ownerId,
        'GetPlanEstimate',
        { planId: decodeURIComponent(atlmPlanMatch[1]) },
        now,
        clock,
      ),
    );
  }
  const stepAnalyticsMatch = url.pathname.match(/^\/api\/analytics\/plans\/([^/]+)\/steps$/);
  if (request.method === 'GET' && stepAnalyticsMatch)
    return json(
      await buildStepAnalytics(
        env.DB,
        identity.ownerId,
        decodeURIComponent(stepAnalyticsMatch[1]),
        {
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
          timeZone: url.searchParams.get('timeZone'),
          asOf: url.searchParams.get('asOf') ?? undefined,
        },
        now,
      ),
    );
  if (request.method === 'POST' && url.pathname === '/api/tracker/estimation-history')
    return json(
      await readEstimationHistory(env.DB, identity.ownerId, await bodyJson(request), now),
    );
  const trackerReceiptMatch = url.pathname.match(/^\/api\/tracker\/commands\/([^/]+)$/);
  if (request.method === 'GET' && trackerReceiptMatch)
    return json(
      await readCommandReceipt(
        env.DB,
        identity.ownerId,
        decodeURIComponent(trackerReceiptMatch[1]),
      ),
    );
  const executionMatch = url.pathname.match(/^\/api\/tracker\/plans\/([^/]+)\/execution$/);
  if (request.method === 'GET' && executionMatch)
    return json(
      await readPlanExecutionSnapshot(
        env.DB,
        identity.ownerId,
        decodeURIComponent(executionMatch[1]),
        now,
      ),
    );
  if (request.method === 'GET' && url.pathname.startsWith('/api/plans/')) {
    const planId = decodeURIComponent(url.pathname.slice('/api/plans/'.length));
    return json({
      plan: await readPlan(
        env.DB,
        identity.ownerId,
        planId,
        now,
        url.searchParams.get('includeEvents') !== 'false',
      ),
      serverNow: now,
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/commands') {
    const envelope = await bodyJson(request, isPlanDocumentCommand);
    validatePublicCommand(envelope);
    const result = await executeCommand(env.DB, identity, envelope, channel, now);
    scheduleAtlmTraining(env.DB, identity.ownerId, now, ctx, clock);
    return json(result);
  }
  if (request.method === 'GET' && url.pathname === '/api/analytics') {
    if (url.searchParams.has('repositoryId'))
      throw appError('VALIDATION_ERROR', 'Фильтр удален из текущего контракта.');
    return json(
      await buildAnalytics(
        env.DB,
        identity.ownerId,
        {
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
          timeZone:
            url.searchParams.get('timeZone') ||
            (
              await dbFirst(
                env.DB,
                'SELECT timezone FROM owners WHERE owner_id=?',
                identity.ownerId,
              )
            )?.timezone ||
            'UTC',
        },
        now,
      ),
    );
  }
  throw appError('NOT_FOUND', 'Маршрут не найден.', 404);
}

const TOOL_NAMES = [
  'CreatePlan',
  'GetPlan',
  'ListPlans',
  'StartPlan',
  'PausePlan',
  'ResumePlan',
  'FinishPlan',
  'DeletePlan',
  'RestorePlan',
  'UpdatePlanMetadata',
  'GetTimeReport',
  ...TRACKER_READ_TOOLS,
  ...TRACKER_COMMANDS,
  'ProcessEstimationTraining',
  'StartEstimationTraining',
];

const MCP_PUBLIC_NAMES = Object.freeze({
  UpdatePlanMetadata: 'UpdatePlan',
  GetTrackerCapabilities: 'GetTrackerInfo',
  GetPlanExecutionSnapshot: 'GetPlanProgress',
  GetCommandReceipt: 'GetCommandResult',
  CalculateAtlmEstimate: 'EstimatePlanTime',
  GetPlanEstimate: 'GetSavedEstimate',
  GetEstimationModelStatus: 'GetTrainingStatus',
  StartEstimationTraining: 'StartTraining',
  ProcessEstimationTraining: 'ContinueTraining',
  GetAtlmDataset: 'GetTrainingData',
  GetEstimationTrainingHistory: 'GetTrainingHistory',
  RecordAssessment: 'SaveTaskAssessment',
  GetAssessment: 'GetTaskAssessment',
  GetEstimationHistory: 'GetTimeHistory',
});

const MCP_INTERNAL_NAMES = Object.freeze(
  Object.fromEntries(
    Object.entries(MCP_PUBLIC_NAMES).map(([oldName, newName]) => [newName, oldName]),
  ),
);

function publicToolReferences(value) {
  if (typeof value === 'string') return MCP_PUBLIC_NAMES[value] || value;
  if (Array.isArray(value)) return value.map(publicToolReferences);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, publicToolReferences(item)]),
    );
  return value;
}

const MCP_DESCRIPTIONS = Object.freeze({
  GetPlan: 'Прочитать исходный текст, метаданные и текущее состояние плана по planId.',
  UpdatePlanMetadata: 'Изменить метаданные или документ плана по expectedVersion. До первого запуска можно передать полный planText либо stepEdits. Недоступные правки сразу отклоняются.',
  GetTrackerCapabilities: 'Показать доступные функции трекера и их ограничения.',
  GetPlanExecutionSnapshot: 'Показать текст и текущее состояние плана и этапов.',
  GetCommandReceipt: 'Проверить результат ранее отправленной команды по её идентификатору.',
  SetStepStatus:
    'Изменить статус этапа исходного плана. Нужна текущая версия этапа; текст плана и таймер не меняются.',
  CalculateAtlmEstimate:
    'Получить прогноз до первого запуска: ATLM либо явно обозначенный ранний ориентир historical-median по пригодной истории. Прогноз не сохраняется.',
  GetPlanEstimate:
    'Получить актуальный прогноз PLANNED по последним сохранённым признакам и текущим данным без записи и обучения; после первого запуска вернуть зафиксированную оценку.',
  GetEstimationModelStatus:
    'Посмотреть количество примеров, состояние обучения и причины исключения данных.',
  StartEstimationTraining:
    'По прямой просьбе пользователя запросить новую попытку обучения на доступных данных.',
  ProcessEstimationTraining:
    'Продолжить подготовку данных или уже запущенное обучение одним ограниченным проходом.',
  GetAtlmDataset: 'Посмотреть сохранённые примеры обучения и причины исключения, с пагинацией.',
  GetEstimationTrainingHistory: 'Прочитать историю попыток обучения с постраничным снимком.',
});

function mcpTools() {
  const writeNames = new Set([...WRITE_COMMANDS, ...TRACKER_COMMANDS]);
  const assessmentDescriptions = {
    RecordAssessment:
      'Записать оценку или неизменяемую ревизию. expectedVersion=0 создаёт серию; для новой ревизии передайте текущий номер ревизии в expectedVersion и причину в payload.reason. Метод и шкалу выбирает агент, прогноз отдельно в ms. Обязателен expectedRequirementsDigest из GetAssessment без assessmentId, прочитанный до анализа. Таймер не запускается.',
    GetAssessment:
      'Без assessmentId: прочитать текущие requirements/currentRequirementsDigest для анализа до первой оценки или пересмотра; stepId необязателен. С assessmentId: прочитать сохранённую ревизию (revision необязателен) и needsRevision; requirements в этом ответе относятся к сохранённому снимку.',
    GetEstimationHistory:
      'Факты и оценки по явным targets. Метрики ms раздельны, общий активный итог — объединение интервалов родителей. При пагинации сохраняйте asOf, throughSequence и nextAfterSequence как afterSequence. Окно дат относится к фактам времени, оценки читаются до asOf. Статистики относятся ко всей выборке фактов; readiness текущая. Время плана рассчитывается по рабочим интервалам.',
  };
  return TOOL_NAMES.map((name) => {
    let inputSchema = { type: 'object', additionalProperties: false };
    if (Object.hasOwn(ATLM_TOOL_SCHEMAS, name))
      return {
        name,
        description: {
          CalculateAtlmEstimate:
            'Предпросмотр полного PLAN_ACTIVE до первого StartPlan: приоритет активной ATLM, при расчётной недоступности — явный historical-median по реальной истории. Факты agent-task-v4; без обучения и записи.',
          GetPlanEstimate:
            'Текущий read-only расчёт PLANNED (source=CURRENT_INPUT); recordedEstimation сохраняет исходную оценку для аудита. После первого запуска — frozen-снимок; legacy без снимка читает исходную assessment. История не переписывается.',
          GetEstimationModelStatus:
            'Состояние модели, накопление пригодных планов и очередь обучения владельца. Только чтение.',
          ProcessEstimationTraining:
            'Один ограниченный проход долговечной очереди владельца. Идемпотентная мутация без planId, с lease и fence; может потребоваться повторный проход.',
          StartEstimationTraining:
            'По явной просьбе пользователя запросить обучение на доступных данных независимо от порога двух планов. Возвращает состояние очереди; качество и достаточность данных проверяются сервером.',
          GetEstimationTrainingHistory:
            'История попыток обучения владельца, включая ошибки и отказанные модели; nextCursor фиксирует границу среза.',
          GetAtlmDataset:
            'Приватная постраничная выгрузка неизменяемых sample-версий. Сохраняйте nextCursor; DATASET_CHANGED требует начать заново. Используется последняя версия каждого плана, только если она пригодна.',
        }[name],
        inputSchema: ATLM_TOOL_SCHEMAS[name],
        annotations: {
          readOnlyHint: !['ProcessEstimationTraining', 'StartEstimationTraining'].includes(name),
          destructiveHint: false,
          idempotentHint: name !== 'StartEstimationTraining',
          openWorldHint: false,
        },
      };
    if (name === 'GetPlan')
      inputSchema = {
        type: 'object',
        required: ['planId'],
        properties: { planId: { type: 'string', format: 'uuid' } },
        additionalProperties: false,
      };
    else if (name === 'ListPlans')
      inputSchema = {
        type: 'object',
        properties: {
          statuses: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            uniqueItems: true,
            items: { enum: PLAN_STATUSES },
          },
          limit: { type: 'integer', minimum: 1, maximum: MAX_PLAN_PAGE_SIZE, default: 50 },
          cursor: { type: 'string', maxLength: 200 },
          deleted: {
            type: 'boolean',
            default: false,
            description: 'true — только удалённые планы; false — только обычные',
          },
        },
        additionalProperties: false,
      };
    else if (name === 'GetTrackerCapabilities')
      inputSchema = { type: 'object', properties: {}, additionalProperties: false };
    else if (name === 'GetPlanExecutionSnapshot')
      inputSchema = {
        type: 'object',
        required: ['planId'],
        properties: { planId: { type: 'string', format: 'uuid' } },
        additionalProperties: false,
      };
    else if (name === 'GetCommandReceipt')
      inputSchema = {
        type: 'object',
        required: ['commandId'],
        properties: { commandId: { type: 'string', format: 'uuid' } },
        additionalProperties: false,
      };
    else if (name === 'GetTimeReport')
      inputSchema = {
        type: 'object',
        required: ['from', 'to', 'timeZone'],
        properties: {
          from: { type: 'string', format: 'date' },
          to: { type: 'string', format: 'date' },
          timeZone: { type: 'string' },
        },
        additionalProperties: false,
      };
    else if (name === 'GetAssessment') inputSchema = getAssessmentSchema;
    else if (name === 'GetEstimationHistory') inputSchema = estimationHistorySchema;
    else if (name === 'RecordAssessment')
      inputSchema = {
        type: 'object',
        additionalProperties: false,
        required: ['schemaVersion', 'commandId', 'expectedVersion', 'payload'],
        properties: {
          schemaVersion: { const: 1 },
          commandId: { type: 'string', format: 'uuid' },
          expectedVersion: { type: 'integer', minimum: 0 },
          payloadHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          payload: assessmentPayloadSchema,
        },
      };
    else if (writeNames.has(name)) {
      const required = ['schemaVersion', 'commandId', 'payload'];
      if (
        (WRITE_COMMANDS.has(name) && name !== 'CreatePlan') ||
        TRACKER_VERSIONED_COMMANDS.has(name)
      )
        required.push('expectedVersion');
      let payloadProperties = { planId: { type: 'string', format: 'uuid' } };
      let payloadRequired = ['planId'];
      let payloadAnyOf;
      if (name === 'SetStepStatus') {
        payloadProperties = {
          stepId: { type: 'string', format: 'uuid' },
          status: { enum: ['PENDING', 'RUNNING', 'BLOCKED', 'FAILED', 'DONE'] },
        };
        payloadRequired = ['stepId', 'status'];
      } else if (name === 'CreatePlan') {
        payloadProperties = {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          planText: {
            type: 'string',
            minLength: 1,
            description:
              'Полный исходный Markdown плана. Этапы из заголовков сохраняются автоматически; не пересказывайте их в отдельных полях.',
          },
          description: { type: 'string', maxLength: 20000 },
          acceptanceCriteria: { type: 'string', maxLength: 20000 },
          planCreatedAt: {
            oneOf: [
              {
                type: 'object',
                required: ['precision', 'value', 'timeZone'],
                properties: {
                  precision: { const: 'instant' },
                  value: { type: 'string', format: 'date-time' },
                  timeZone: { type: 'string' },
                },
                additionalProperties: false,
              },
              {
                type: 'object',
                required: ['precision', 'on', 'timeZone'],
                properties: {
                  precision: { const: 'dateOnly' },
                  on: { type: 'string', format: 'date' },
                  timeZone: { type: 'string' },
                },
                additionalProperties: false,
              },
            ],
          },
        };
        payloadRequired = ['title', 'planCreatedAt'];
      } else if (name === 'UpdatePlanMetadata') {
        payloadProperties = {
          planId: { type: 'string', format: 'uuid' },
          title: { type: 'string', minLength: 1, maxLength: 200 },
          planText: {
            type: 'string', minLength: 1,
            description: 'Полный Markdown в статусе PLANNED. Отдельно от метаданных и stepEdits.',
          },
          stepEdits: {
            type: 'array', minItems: 1,
            description: 'Правки существующих этапов в статусе PLANNED. Ответ обновляет и этапы, и общий Markdown.',
            items: {
              type: 'object', additionalProperties: false, required: ['stepId', 'markdown'],
              properties: {
                stepId: { type: 'string', format: 'uuid' },
                markdown: { type: 'string', minLength: 1, description: 'Весь этап с заголовком и прежним идентификатором.' },
              },
            },
          },
          description: { type: 'string', maxLength: 20000 },
          acceptanceCriteria: { type: 'string', maxLength: 20000 },
          planCreatedAt: {
            oneOf: [
              {
                type: 'object',
                required: ['precision', 'value', 'timeZone'],
                properties: {
                  precision: { const: 'instant' },
                  value: { type: 'string', format: 'date-time' },
                  timeZone: { type: 'string' },
                },
                additionalProperties: false,
              },
              {
                type: 'object',
                required: ['precision', 'on', 'timeZone'],
                properties: {
                  precision: { const: 'dateOnly' },
                  on: { type: 'string', format: 'date' },
                  timeZone: { type: 'string' },
                },
                additionalProperties: false,
              },
            ],
          },
          reason: { type: 'string', maxLength: 1000 },
          confirmDateAnomaly: { type: 'boolean' },
        };
        const metadata = ['title', 'description', 'acceptanceCriteria', 'planCreatedAt'];
        const documentFields = ['planText', 'stepEdits'];
        payloadAnyOf = [
          ...metadata.map(field => ({ required: [field], not: { anyOf: documentFields.map(key => ({ required: [key] })) } })),
          ...documentFields.map(field => ({
            required: [field],
            not: { anyOf: [...metadata, 'reason', 'confirmDateAnomaly', ...documentFields.filter(key => key !== field)]
              .map(key => ({ required: [key] })) },
          })),
        ];
      } else if (['DeletePlan', 'RestorePlan'].includes(name)) {
        payloadProperties.reason = { type: 'string', maxLength: 1000 };
      } else if (name === 'PausePlan') {
        payloadProperties.reason = { type: 'string', maxLength: 1000 };
      } else if (name === 'FinishPlan') {
        payloadProperties.completionNote = { type: 'string', maxLength: 2000 };
        payloadProperties.allowIncomplete = { type: 'boolean' };
        payloadProperties.reason = { type: 'string', minLength: 1, maxLength: 1000 };
      }
      inputSchema = {
        type: 'object',
        required: required,
        properties: {
          schemaVersion: { const: 1 },
          commandId: { type: 'string', format: 'uuid' },
          expectedVersion: {
            type: 'integer',
            minimum: TRACKER_VERSIONED_COMMANDS.has(name) ? 1 : 0,
          },
          payloadHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          sourceReference: { type: 'string', maxLength: 2048 },
          payload: {
            type: 'object',
            required: payloadRequired,
            properties: payloadProperties,
            ...(payloadAnyOf ? { anyOf: payloadAnyOf } : {}),
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      };
    }
    if (assessmentDescriptions[name])
      return { name, description: assessmentDescriptions[name], inputSchema };
    return {
      name: name,
      description:
        name === 'DeletePlan'
          ? 'Переместить план в удалённые: остановить его таймер, сохранить план. Требует явной просьбы пользователя и текущей версии.'
          : name === 'RestorePlan'
            ? 'Восстановить удалённый план без запуска таймера. Требует явной просьбы пользователя и текущей версии.'
            : name === 'ListPlans'
              ? 'Список планов владельца с фильтрами statuses, deleted (по умолчанию false) и стабильной пагинацией nextCursor; RUNNING возвращает все активные планы. Не выбирает план для исполнителя.'
              : name === 'GetTimeReport'
                ? 'Отчёт о фактически затраченном времени за период: totalActiveMs и activeByDay объединяют пересекающиеся интервалы, sumPlanActiveMs суммирует время планов. Это не прогноз. Значения в миллисекундах.'
                : ['StartPlan', 'ResumePlan', 'PausePlan', 'FinishPlan'].includes(name)
                  ? name + ': меняет только указанный planId; другие планы продолжаются независимо.'
                  : name === 'CreatePlan'
                    ? 'Сохранить готовый план целиком в planText и создать его этапы из заголовков. Таймер не запускается.'
                    : name + ' через общий командный/API слой Sites.',
      inputSchema: inputSchema,
    };
  }).map((tool) => ({
    ...tool,
    name: MCP_PUBLIC_NAMES[tool.name] || tool.name,
    description: Object.entries(MCP_PUBLIC_NAMES).reduce(
      (text, [oldName, newName]) => text.replaceAll(oldName, newName),
      MCP_DESCRIPTIONS[tool.name] || tool.description,
    ),
  }));
}

function unexpectedMcpErrorReason(error) {
  for (let current = error, depth = 0; current && depth < 3; current = current.cause, depth++) {
    const message = typeof current.message === 'string' ? current.message : '';
    if (current.name === 'TimeoutError') return 'DB_REQUEST_TIMEOUT';
    if (message.includes('too many terms in compound SELECT')) return 'D1_COMPOUND_SELECT_LIMIT';
    if (message.includes('D1 DB is overloaded.')) return 'D1_RESOURCE_LIMIT';
  }
  return 'UNEXPECTED_ERROR';
}

async function mcpRoute(request, env, now, ctx, clock = () => now) {
  if (request.method !== 'POST')
    return json(
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'POST required' } },
      405,
    );
  validateOrigin(request);
  const rpc = await bodyJson(
    request,
    (body) =>
      body?.method === 'tools/call' &&
      isPlanDocumentCommand({
        commandType: MCP_INTERNAL_NAMES[body.params?.name] || body.params?.name,
        payload: body.params?.arguments?.payload,
      }),
  );
  if (!rpc || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string')
    return json(
      {
        jsonrpc: '2.0',
        id: (rpc && rpc.id) || null,
        error: { code: -32600, message: 'Invalid JSON-RPC request' },
      },
      400,
    );
  const id = rpc.id == null ? null : rpc.id;
  if (rpc.method === 'initialize')
    return json({
      jsonrpc: '2.0',
      id: id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'plan-time-tracker', version: TRACKER_VERSION },
      },
    });
  if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
  if (rpc.method === 'ping') return json({ jsonrpc: '2.0', id: id, result: {} });
  if (rpc.method === 'tools/list')
    return json({ jsonrpc: '2.0', id: id, result: { tools: mcpTools() } });
  if (rpc.method !== 'tools/call')
    return json({ jsonrpc: '2.0', id: id, error: { code: -32601, message: 'Method not found' } });
  const identity = requireOwner(request);
  if (!env.DB)
    return json({
      jsonrpc: '2.0',
      id: id,
      result: { isError: true, content: [{ type: 'text', text: 'D1 binding DB не настроен.' }] },
    });
  const publicName = rpc.params && rpc.params.name;
  const name = MCP_INTERNAL_NAMES[publicName] || publicName;
  const args = (rpc.params && rpc.params.arguments) || {};
  try {
    if (!TOOL_NAMES.includes(name))
      throw appError('FEATURE_REMOVED', 'Инструмент недоступен в текущем контракте.', 410);
    if (name === 'GetTimeReport' && Object.hasOwn(args, 'repositoryIds'))
      throw appError('VALIDATION_ERROR', 'Фильтр удален из текущего контракта.');
    if (WRITE_COMMANDS.has(name) || TRACKER_COMMANDS.has(name))
      validatePublicCommand({ ...args, commandType: name });
    if (
      WRITE_COMMANDS.has(name) ||
      TRACKER_COMMANDS.has(name) ||
      ['ProcessEstimationTraining', 'StartEstimationTraining'].includes(name)
    )
      await ensureOwner(env.DB, identity, now);
    let result;
    if (Object.hasOwn(ATLM_TOOL_SCHEMAS, name))
      result = await executeAtlmTool(
        env.DB,
        identity.ownerId,
        name,
        rpc.params?.arguments === undefined ? {} : rpc.params.arguments,
        now,
        clock,
      );
    else if (name === 'GetPlan')
      result = await readPlan(env.DB, identity.ownerId, args.planId, now);
    else if (name === 'GetAssessment')
      result = await readAssessment(env.DB, identity.ownerId, args, now);
    else if (name === 'GetEstimationHistory')
      result = await readEstimationHistory(env.DB, identity.ownerId, args, now);
    else if (name === 'ListPlans') result = await listPlans(env.DB, identity.ownerId, now, args);
    else if (name === 'GetTimeReport')
      result = await buildAnalytics(env.DB, identity.ownerId, args, now);
    else if (name === 'GetTrackerCapabilities')
      result = publicToolReferences(await readTrackerCapabilities(env.DB, identity.ownerId));
    else if (name === 'GetPlanExecutionSnapshot')
      result = await readPlanExecutionSnapshot(env.DB, identity.ownerId, args.planId, now);
    else if (name === 'GetCommandReceipt')
      result = await readCommandReceipt(env.DB, identity.ownerId, args.commandId);
    else if (WRITE_COMMANDS.has(name) || TRACKER_COMMANDS.has(name)) {
      const envelope = { ...args, schemaVersion: args.schemaVersion || 1, commandType: name };
      result = await executeCommand(env.DB, identity, envelope, 'mcp', now);
      scheduleAtlmTraining(env.DB, identity.ownerId, now, ctx, clock);
    } else throw appError('VALIDATION_ERROR', 'Неизвестный MCP tool.');
    return json({
      jsonrpc: '2.0',
      id: id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(publicView(result)) }],
        structuredContent: publicView(result),
      },
    });
  } catch (error) {
    const e =
      error instanceof AppError ? error : appError('INTERNAL_ERROR', 'Внутренняя ошибка.', 500);
    const requestId = crypto.randomUUID();
    if (!(error instanceof AppError)) {
      console.error(
        JSON.stringify({
          event: 'mcp_unexpected_error',
          tool: TOOL_NAMES.includes(name) ? name : 'UNKNOWN',
          requestId,
          reason: unexpectedMcpErrorReason(error),
        }),
      );
    }
    const body = {
      code: e.code,
      message: e.message,
      details: e.details || null,
      requestId,
      retryable:
        e.details && typeof e.details.retryable === 'boolean'
          ? e.details.retryable
          : ['RATE_LIMITED', 'SOURCE_UNAVAILABLE', 'INTERNAL_ERROR'].includes(e.code),
      retryAfter: e.details && e.details.retryAfter != null ? e.details.retryAfter : null,
    };
    return json({
      jsonrpc: '2.0',
      id: id,
      result: {
        isError: true,
        structuredContent: body,
        content: [{ type: 'text', text: JSON.stringify(body) }],
      },
    });
  }
}

function workerError(error) {
  const mapped = error instanceof AppError ? error : mapDbError(error);
  const e =
    mapped instanceof AppError
      ? mapped
      : appError('INTERNAL_ERROR', messageFor('INTERNAL_ERROR'), 500);
  const code = e.code || 'INTERNAL_ERROR';
  const requestId = crypto.randomUUID();
  const retryable =
    e.details && typeof e.details.retryable === 'boolean'
      ? e.details.retryable
      : ['RATE_LIMITED', 'SOURCE_UNAVAILABLE', 'INTERNAL_ERROR'].includes(code);
  const retryAfter = e.details && e.details.retryAfter != null ? e.details.retryAfter : null;
  return json(
    {
      error: {
        code: code,
        message: e.message || messageFor('INTERNAL_ERROR'),
        details: e.details || null,
        requestId: requestId,
        retryable: retryable,
        retryAfter: retryAfter,
      },
    },
    e.status || 500,
  );
}

export { apiRoute, mcpRoute, publicView, workerError };
