export const atlmModelOverviewHtml = '<article class="panel atlm-model-overview" id="atlm-model-overview" aria-labelledby="atlm-model-overview-heading">' +
  '<h2 id="atlm-model-overview-heading" tabindex="-1">Модель прогноза</h2>' +
  '<noscript>Для загрузки сведений о модели требуется JavaScript</noscript>' +
  '<div id="atlm-model-notice" class="model-notice" hidden></div>' +
  '<p id="atlm-model-live" role="status">Загружаем модель прогноза…</p>' +
  '<div id="atlm-model-content" aria-busy="true">' +
    '<div id="atlm-model-skeleton" class="model-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>' +
    '<div id="atlm-model-body" hidden>' +
      '<div id="atlm-model-current"></div>' +
      '<section class="model-section" aria-labelledby="atlm-model-data-heading">' +
        '<h3 id="atlm-model-data-heading">Данные</h3><div id="atlm-model-data"></div>' +
        '<details id="atlm-model-data-details" hidden><summary>Сведения о данных</summary><div id="atlm-model-dataset"></div></details>' +
      '</section>' +
      '<section class="model-section model-divider" aria-labelledby="atlm-model-quality-heading">' +
        '<h3 id="atlm-model-quality-heading" tabindex="-1">Качество</h3>' +
        '<div id="atlm-model-selection" class="model-selection"></div>' +
        '<fieldset id="atlm-model-sources" class="model-sources" hidden><legend>Источник качества</legend>' +
          '<label><input type="radio" name="model-quality-source" value="issued" checked>Выданные прогнозы</label>' +
          '<label><input type="radio" name="model-quality-source" value="evaluation">Контрольная проверка</label>' +
        '</fieldset>' +
        '<label id="atlm-model-report-field" class="model-report-field" hidden>Отчёт проверки<select id="atlm-model-report-picker"></select></label>' +
        '<div id="atlm-model-report"></div>' +
        '<details id="atlm-model-metrics" hidden><summary>Метрики и методика</summary><div id="atlm-model-methodology"></div></details>' +
        '<button type="button" id="atlm-model-show-cases" hidden>Показать планы</button>' +
        '<details id="atlm-model-training-evaluation" hidden><summary>Проверка при обучении</summary><div id="atlm-model-training-methodology"></div></details>' +
      '</section>' +
      '<details id="atlm-model-history" class="model-divider">' +
        '<summary>История ревизий</summary>' +
        '<div id="atlm-model-history-table"></div>' +
        '<div id="atlm-model-history-notice" class="model-notice" hidden></div>' +
        '<button type="button" id="atlm-model-more-revisions" hidden>Показать ещё ревизии</button>' +
      '</details>' +
      '<details id="atlm-model-cases" class="model-divider">' +
        '<summary>Разбор планов</summary>' +
        '<p id="atlm-model-cases-context" class="model-context"></p>' +
        '<div id="atlm-model-cases-table"></div>' +
        '<div id="atlm-model-cases-notice" class="model-notice" hidden></div>' +
        '<button type="button" id="atlm-model-more-cases" hidden>Показать ещё планы</button>' +
      '</details>' +
    '</div>' +
  '</div>' +
'</article>';

export const atlmModelOverviewScript = String.raw`
(() => {
  const panel = document.querySelector('#atlm-model-overview');
  if (!panel) return;
  const get = (suffix) => panel.querySelector('#atlm-model-' + suffix);
  const registryUrl = '/api/tracker/model-revisions';
  const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
  const signed = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1, signDisplay: 'exceptZero' });
  const millisecondsPerMinute = 60_000;
  const fullFitProtocols = [3, 4];
  const rollingPlanControls = ['ROLLING_PLAN_PLANNED', 'ROLLING_PLAN_ACTUAL'];
  const controls = [...rollingPlanControls, 'INTERNAL_HOLDOUT_PLANNED', 'INTERNAL_HOLDOUT_ACTUAL',
    'ROLLING_GROUPED_ACTUAL', 'ISSUED_FORECASTS'];
  const evidenceNames = {
    ROLLING_PLAN_PLANNED: 'Проверка на истории по исходным признакам',
    ROLLING_PLAN_ACTUAL: 'Проверка на истории по фактическим признакам',
    ROLLING_GROUPED_ACTUAL: 'Проверка на истории',
    INTERNAL_HOLDOUT_ACTUAL: 'Проверка на отложенной выборке',
    INTERNAL_HOLDOUT_PLANNED: 'Проверка на отложенных планах по исходным признакам',
    ISSUED_FORECASTS: 'Выданные прогнозы',
  };
  const methodologies = {
    ROLLING_PLAN_PLANNED: 'Для каждого плана взяты его исходные признаки и только те примеры, которые были доступны до его первого старта. Ошибка считается по планам с подтверждённым неизменным объёмом.',
    ROLLING_PLAN_ACTUAL: 'Для каждого плана взяты признаки выполненной работы. История для расчёта прогноза содержит только примеры, доступные до его первого старта. Эта проверка помогает выбрать метод для финального обучения.',
    ROLLING_GROUPED_ACTUAL: 'Модель переобучалась на каждом шаге. Ошибки измерены на следующих по времени задачах по восстановленным фактическим признакам.',
    INTERNAL_HOLDOUT_ACTUAL: 'Сохранённая модель проверена на отложенных группах по восстановленным фактическим признакам.',
    INTERNAL_HOLDOUT_PLANNED: 'Сохранённая модель проверена на отложенных планах с неизменившимся объёмом. Использованы исходные признаки до первого старта.',
    ISSUED_FORECASTS: 'Сводка сравнивает прогнозы выбранной ревизии, сохранённые при первом старте, с активным временем завершённых планов по учёту трекера.',
  };
  const reasonText = {
    SOURCE_CHANGED: 'Изменились исходные наблюдения.',
    HISTORY_RESET: 'История исходных наблюдений сброшена.',
    MODEL_SOURCE_MISSING: 'Часть исходных наблюдений недоступна.',
    ARTIFACT_UNSUPPORTED: 'Формат артефакта не поддерживается.',
    NO_ARTIFACT: 'Артефакт модели не сохранён.',
    HISTORICAL_PROVENANCE_INCOMPLETE: 'Состав обучающего набора подтверждён частично.',
    RETIRED_BY_AGENT_FLOW: 'Прежний процесс обучения закрыт.',
    TOO_FEW_HOLDOUT_GROUPS_OR_ROWS: 'В отложенной выборке недостаточно планов или групп.',
    TOO_FEW_DEVELOPMENT_GROUPS_OR_ROWS: 'До границы отложенной выборки недостаточно планов или групп.',
    NO_COMPARABLE_ROWS: 'Нет сопоставимых планов.',
    NO_AVAILABLE_FORECASTS: 'Нет доступных прогнозов.',
    SCOPE_CHANGED: 'Объём плана изменился.',
    SCOPE_CHANGE_UNKNOWN: 'Изменение объёма не установлено.',
    PLAN_DELETED: 'План удалён.',
    ACTUAL_MEASUREMENT_UNVERIFIED: 'Активное время не подтверждено.',
    ISSUED_TIME_UNVERIFIED: 'Время выдачи не подтверждено.',
    PLANNED_FEATURES_UNAVAILABLE: 'Исходные признаки недоступны.',
    ISSUED_FORECAST_NOT_RECORDED: 'Выданный прогноз не сохранён.',
    SOURCES_PENDING: 'Исходные наблюдения обновляются.',
    SOURCE_REFRESH_FAILED: 'Обновление источника завершилось ошибкой.',
    COLLECTING_DATA: 'Наблюдений пока недостаточно.',
    INSUFFICIENT_INCUMBENT_CASES: 'Недостаточно сопоставимых случаев действовавшей модели.',
  };
  const pointText = { OLS: 'OLS', RIDGE: 'Ridge', BAYESIAN: 'Байесовский', MEDIAN: 'Историческая медиана' };
  const intervalText = { BAYESIAN_PREDICTIVE: 'Байесовский прогнозный', BAYES_QUANTILE: 'Байесовский квантильный' };
  const requests = new Map();
  let viewing = false;
  let timeZone = document.querySelector('#tz')?.value || 'UTC';
  let overview = null;
  let loadedAt = null;
  let stale = false;
  let explicitId = null;
  let selectedId = null;
  let detail = null;
  let detailFailed = false;
  let selectionMessage = '';
  let choiceVersion = 0;
  let source = 'issued';
  let controlId = null;
  let history = { rows: [], cursor: null };
  let cases = { rows: [], cursor: null, ready: false };

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== null && text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function button(text, action) {
    const node = element('button', text);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  }

  function fact(label, value, className = 'model-number') {
    const row = element('div', null, 'model-fact');
    const content = element('dd', null, className);
    content.append(value);
    row.append(element('dt', label), content);
    return row;
  }

  function date(value) {
    if (!Number.isFinite(value)) return 'Нет данных';
    const valueDate = new Date(value);
    const output = element('time', new Intl.DateTimeFormat('ru-RU', {
      dateStyle: 'medium', timeStyle: 'short', timeZone,
    }).format(valueDate));
    output.dateTime = valueDate.toISOString();
    return output;
  }

  function count(value, empty = 'Нет данных') {
    return Number.isFinite(value) ? number.format(value) : empty;
  }

  function minutes(value, empty = 'Нет оценки', showSign = false) {
    return Number.isFinite(value) ? (showSign ? signed : number).format(value / millisecondsPerMinute) + ' мин' : empty;
  }

  function percent(value) {
    return Number.isFinite(value) ? number.format(value) + ' %' : 'Нет оценки';
  }

  function fraction(numerator, denominator) {
    return count(numerator) + ' из ' + count(denominator);
  }

  function reason(code) {
    if (!code) return '';
    return reasonText[code] ?? ('Причина: ' + code + '.');
  }

  function announce(text) {
    get('live').classList.add('model-visually-hidden');
    get('live').textContent = text;
  }

  function setBusy(node, busy) {
    if (busy) node.setAttribute('aria-busy', 'true');
    else node.removeAttribute('aria-busy');
  }

  function setButtonState(node, busy, disabled = busy) {
    setBusy(node, busy);
    if (disabled) node.setAttribute('aria-disabled', 'true');
    else node.removeAttribute('aria-disabled');
  }

  function clearNotice(node) {
    node.hidden = true;
    node.replaceChildren();
  }

  function notice(node, message, retry, previous = null) {
    const paragraph = element('p', message);
    node.replaceChildren();
    if (previous !== null) {
      const timestamp = element('p', 'Показаны данные от ');
      timestamp.append(date(previous));
      node.append(timestamp);
    }
    node.append(paragraph);
    if (retry) {
      const action = button(node === get('notice') ? 'Повторить загрузку' : 'Повторить', (event) => {
        if (event.currentTarget.getAttribute('aria-disabled') !== 'true') retry(event.currentTarget);
      });
      node.append(action);
    }
    node.dataset.stale = String(previous !== null);
    node.hidden = false;
    return node.querySelector('button');
  }

  function cancelRequest(name) {
    requests.get(name)?.abort();
    requests.delete(name);
  }

  function beginRequest(name) {
    cancelRequest(name);
    const controller = new AbortController();
    requests.set(name, controller);
    return controller;
  }

  function requestCurrent(name, controller) {
    return viewing && requests.get(name) === controller;
  }

  async function read(path, args, controller) {
    const response = await fetch(path + '?' + new URLSearchParams(args), { cache: 'no-store', signal: controller.signal });
    if (!response.ok) {
      const error = new Error('HTTP ' + response.status);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  function badge(serving, unavailable) {
    if (serving) {
      return stale
        ? element('span', 'Выдавала прогнозы', 'model-status model-status-stale')
        : element('span', 'Выдаёт прогнозы', 'model-status model-status-active');
    }
    return unavailable
      ? element('span', 'Недоступна', 'model-status model-status-invalid')
      : element('span', 'Не назначена', 'model-status');
  }

  function renderOverview() {
    const current = get('current');
    const selected = overview.activeRevision;
    const modelId = overview.activeModelRevisionId;
    current.replaceChildren();
    if (!modelId) {
      current.append(element('p', 'Модель для новых прогнозов пока не назначена'));
    } else {
      const model = element('div', null, 'model-current-grid');
      const identity = element('div', null, 'model-current-id');
      const serving = overview.servingModelRevisionId === modelId;
      identity.append(element('p', 'Назначенная ревизия', 'model-label'), element('p', modelId, 'model-id'),
        badge(serving, !serving));
      if (!serving) {
        identity.append(element('p', reason(overview.sourceProblem) || 'Причина недоступности не сохранена.', 'model-muted'));
      }
      if (selected?.historicalDecision?.status) {
        const decision = selected.historicalDecision;
        identity.append(element('p', 'Результат исторической проверки ' + decision.status + '. ' + reason(decision.reason), 'model-muted'));
      }
      const info = element('dl', null, 'model-parameters');
      info.append(fact('Точечный прогноз', pointText[selected?.pointEngine] ?? 'Нет данных'),
        fact('Интервал', intervalText[selected?.intervalEngine] ?? 'Нет данных'));
      if (selected?.activatedAt !== null && selected?.activatedAt !== undefined) {
        info.append(fact('Назначена', date(selected.activatedAt)));
      }
      model.append(identity, info);
      current.append(model);
    }

    const data = overview.dataSummary ?? {};
    const fields = element('dl', null, 'model-data-grid');
    fields.append(fact('В обучении', count(data.fitCount)), fact('Новые пригодные', count(data.newEligibleCount)),
      fact('Изменились после обучения', count(data.changedSourceCount)));
    get('data').replaceChildren(fields);
    const dataNotes = [];
    if (!data.manifestAvailable) dataNotes.push('Сравнение с обучающим набором недоступно.');
    if (!data.manifestAvailable && Number.isFinite(data.currentEligibleCount))
      dataNotes.push('Текущих пригодных планов ' + count(data.currentEligibleCount) + '.');
    if (data.pendingRefreshCount > 0)
      dataNotes.push('Идёт обновление источников (' + count(data.pendingRefreshCount) + ').');
    if (data.failedRefreshCount > 0)
      dataNotes.push('Ошибок обновления источников ' + count(data.failedRefreshCount) + '.');
    for (const text of dataNotes) get('data').append(element('p', text, 'model-muted'));

    get('data-details').hidden = !data.dataset;
    get('dataset').replaceChildren();
    if (data.dataset) {
      const dataset = data.dataset;
      const datasetFields = element('dl', null, 'model-parameters');
      datasetFields.append(fact('Обучающий набор', dataset.datasetRevisionId ?? 'Нет данных'),
        fact('Снимок', dataset.snapshotId ?? 'Нет данных'),
        fact('Зафиксирован', date(dataset.capturedAt ?? dataset.createdAt)),
        fact('Всего планов', count(dataset.rowCount)), fact('Исключено', count(dataset.excludedCount)));
      get('dataset').append(datasetFields);
    }
    renderHistory();
  }

  function controlEntries() {
    return (detail?.evidence ?? []).filter((item) => item.source === 'evaluation')
      .sort((a, b) => controls.indexOf(a.kind) - controls.indexOf(b.kind));
  }

  function qualitySource() {
    return fullFitProtocols.includes(detail?.revision?.protocolVersion) ? 'issued' : source;
  }

  function currentEvidence() {
    if (qualitySource() === 'issued') return detail?.evidence?.find((item) => item.source === 'issued');
    const entries = controlEntries();
    return entries.find((item) => item.evidenceId === controlId)
      ?? entries.find((item) => item.status === 'AVAILABLE') ?? entries[0];
  }

  function evidenceName(entry) {
    if (entry.kind === 'ISSUED_FORECASTS' && entry.source === 'evaluation') return 'Выданные прогнозы в сохранённом отчёте';
    return evidenceNames[entry.kind] ?? 'Проверка';
  }

  function evidenceMethodology(entry) {
    if (entry.kind === 'ISSUED_FORECASTS' && entry.source === 'evaluation') {
      return 'Отчёт сопоставляет прогнозы первого старта из снимка обучения с активным временем планов. В нём могут быть прогнозы прежних ревизий, историческая медиана и случаи без прогноза.';
    }
    return methodologies[entry.kind] ?? 'Сохранённая проверка.';
  }

  function emptyEvidence() {
    if (!selectedId) return 'Выберите ревизию в истории.';
    return qualitySource() === 'issued' ? 'По этой ревизии пока нет завершённых планов с выданным прогнозом.'
      : 'Проверка этой ревизии пока не сохранена.';
  }

  function summaryMetrics(summary, names) {
    const metrics = summary.metrics ?? {};
    const coverage = metrics.coverageDenominator > 0
      ? fraction(metrics.coverageNumerator, metrics.coverageDenominator) : 'Нет интервалов для проверки';
    const block = element('dl', null, 'model-quality-grid');
    const interval = fact('Попадания в интервал', coverage);
    if (Number.isFinite(metrics.meanIntervalWidthMs)) {
      interval.append(element('dd', 'Средняя ширина ' + minutes(metrics.meanIntervalWidthMs), 'model-muted'));
    }
    block.append(fact(names ?? 'Средняя абсолютная ошибка', minutes(metrics.maeMs)), interval);
    return block;
  }

  function renderQuality() {
    const selection = get('selection');
    selection.replaceChildren();
    if (selectedId) {
      const line = element('p', 'Ревизия для просмотра ');
      line.append(element('span', selectedId, 'model-number'));
      selection.append(line);
      if (overview?.activeModelRevisionId && selectedId !== overview.activeModelRevisionId) {
        selection.append(button('Вернуться к назначенной ревизии', () => chooseRevision(null)));
      }
    }
    if (selectionMessage) selection.append(element('p', selectionMessage, 'model-muted'));
    const fullFitOnly = fullFitProtocols.includes(detail?.revision?.protocolVersion);
    const displaySource = qualitySource();
    get('sources').hidden = !selectedId || fullFitOnly;
    get('sources').querySelectorAll('input').forEach((input) => { input.checked = input.value === displaySource; });
    const report = get('report');
    report.replaceChildren();
    setBusy(report, Boolean(requests.has('detail')));
    const evidence = currentEvidence();
    const options = controlEntries();
    const perPlanProtocol = fullFitOnly || options.some((item) => rollingPlanControls.includes(item.kind));
    if (perPlanProtocol && Number.isFinite(detail.revision?.fitCount)) {
      selection.append(element('p', 'Планов в финальном обучении ' + count(detail.revision.fitCount), 'model-muted'));
    }
    const picker = get('report-picker');
    const wasOnPicker = document.activeElement === picker;
    get('report-field').hidden = displaySource !== 'evaluation' || !options.length;
    picker.replaceChildren(...options.map((item) => {
      const option = element('option', evidenceName(item));
      option.value = item.evidenceId;
      return option;
    }));
    if (displaySource === 'evaluation' && evidence) picker.value = evidence.evidenceId;
    if (wasOnPicker && get('report-field').hidden) get('quality-heading').focus();
    get('metrics').hidden = true;
    get('show-cases').hidden = true;
    get('training-evaluation').hidden = !detail?.trainingEvaluation;

    if (detailFailed) {
      const box = element('div', null, 'model-notice');
      notice(box, 'Не удалось загрузить данные выбранной ревизии.', loadDetail);
      report.append(box);
    } else if (!evidence) {
      report.append(element('p', requests.has('detail') ? 'Загружаем данные ревизии…' : emptyEvidence(), 'model-muted'));
    } else {
      const { summary } = evidence;
      const metrics = summary.metrics ?? {};
      report.append(element('h4', evidenceName(evidence)));
      if (summary.rowCount === 0) report.append(element('p', displaySource === 'issued' ? emptyEvidence() : 'В этой проверке нет задач.', 'model-muted'));
      const groupPart = !perPlanProtocol && Number.isFinite(summary.groupCount) ? ', групп ' + count(summary.groupCount) : '';
      report.append(element('p', 'Планов ' + count(summary.rowCount) + groupPart, 'model-muted'));
      const { numerator, denominator } = summary.forecastAvailability ?? {};
      if (denominator > 0 && numerator < denominator) {
        report.append(element('p', 'Точечных прогнозов ' + fraction(numerator, denominator), 'model-muted'));
      }
      if (summary.excludedFromScoringCount > 0) {
        if (Number.isFinite(metrics.caseCount)) {
          report.append(element('p', 'В расчёте точности ' + fraction(metrics.caseCount, summary.rowCount), 'model-muted'));
        }
        report.append(element('p', 'Исключено из расчёта точности ' + count(summary.excludedFromScoringCount), 'model-muted'));
      }
      for (const limitation of evidence.limitations ?? []) {
        if (limitation !== 'CASES_NOT_RECORDED') report.append(element('p', reason(limitation), 'model-muted'));
      }
      if (evidence.limitations?.includes('CASES_NOT_RECORDED'))
        report.append(element('p', 'Список задач этой проверки не сохранён.', 'model-muted'));
      report.append(summaryMetrics(summary));
      if (evidence.paired?.rowCount > 0) {
        const paired = evidence.paired;
        const comparison = element('dl', null, 'model-parameters');
        comparison.append(fact('Сопоставимые планы', count(paired.rowCount)),
          fact('Средняя абсолютная ошибка модели', minutes(paired.candidate?.maeMs)),
          fact('Средняя абсолютная ошибка медианы', minutes(paired.median?.maeMs)));
        report.append(element('h5', 'Сравнение на одних и тех же планах'), comparison);
      }
      get('show-cases').hidden = !summary.rowCount || evidence.limitations?.includes('CASES_NOT_RECORDED');
      get('metrics').hidden = false;
      const method = element('dl', null, 'model-parameters');
      method.append(fact('Медиана абсолютной ошибки', minutes(metrics.medaeMs)), fact('WAPE', percent(metrics.wapePercent)),
        fact('Смещение', percent(metrics.signedBiasPercent)));
      if (Number.isFinite(metrics.nominalCoverage))
        method.append(fact('Целевая доля попаданий', percent(metrics.nominalCoverage * 100)));
      const intervalCounts = summary.intervalAvailability;
      if (intervalCounts?.denominator > 0)
        method.append(fact('Доступные интервалы', fraction(intervalCounts.numerator, intervalCounts.denominator)));
      get('methodology').replaceChildren(element('p', evidenceMethodology(evidence), 'model-muted'), method);
    }

    if (detail?.trainingEvaluation) {
      const validation = detail.trainingEvaluation;
      const description = element('p', 'Сохранённая оценка использует протокол обучения этой ревизии. Она имеет собственную выборку.', 'model-muted');
      const factList = element('dl', null, 'model-parameters');
      factList.append(fact('Планов', count(validation.caseCount)), fact('Групп', count(validation.groupCount)),
        fact('Точечные прогнозы', fraction(validation.pointCaseCount, validation.caseCount)));
      get('training-methodology').replaceChildren(description, factList, summaryMetrics({ metrics: validation }));
    }
  }

  function table(caption, labels, rows) {
    const grid = element('table', null, 'model-table');
    grid.setAttribute('role', 'table');
    grid.append(element('caption', caption, 'model-visually-hidden'));
    const head = element('thead');
    head.setAttribute('role', 'rowgroup');
    const headings = element('tr');
    headings.setAttribute('role', 'row');
    labels.forEach((label) => {
      const heading = element('th', label.text, label.numeric ? 'model-numeric-cell' : null);
      heading.scope = 'col';
      heading.setAttribute('role', 'columnheader');
      headings.append(heading);
    });
    head.append(headings);
    const body = element('tbody');
    body.setAttribute('role', 'rowgroup');
    for (const entries of rows) {
      const line = element('tr');
      line.setAttribute('role', 'row');
      entries.forEach((entry, index) => {
        const cell = element(index === 0 ? 'th' : 'td', null, labels[index].numeric ? 'model-numeric-cell' : null);
        if (index === 0) cell.scope = 'row';
        cell.setAttribute('role', index === 0 ? 'rowheader' : 'cell');
        if (index > 0) {
          const label = element('span', labels[index].text, 'model-mobile-label');
          label.setAttribute('aria-hidden', 'true');
          cell.append(label);
        }
        const value = element('span', null, 'model-cell-value');
        value.append(entry);
        cell.append(value);
        line.append(cell);
      });
      body.append(line);
    }
    grid.append(head, body);
    return grid;
  }

  function updatePageButton(node, cursor, pending) {
    const hasFocus = document.activeElement === node;
    setButtonState(node, pending, pending || !cursor);
    node.hidden = !cursor && !hasFocus;
  }

  function renderHistory() {
    const host = get('history-table');
    const focusedId = document.activeElement?.dataset.revisionId;
    const labels = [
      { text: 'Ревизия' }, { text: 'Статус' }, { text: 'Дата' },
      { text: 'В обучении', numeric: true }, { text: 'Просмотр' },
    ];
    const rows = history.rows.map((revision) => {
      const id = revision.modelRevisionId;
      const chosen = id === selectedId;
      const action = button(chosen ? 'Выбрана' : 'Показать', () => {
        if (!chosen) chooseRevision(id);
      });
      action.dataset.revisionId = id;
      action.setAttribute('aria-label', (chosen ? 'Выбрана ' : 'Показать ') + id);
      if (chosen) action.setAttribute('aria-disabled', 'true');
      const serving = revision.status === 'ACTIVE' && id === overview.servingModelRevisionId;
      const unavailable = revision.status === 'INVALIDATED' || revision.status === 'ARCHIVED';
      const status = element('div');
      status.append(badge(serving, unavailable));
      if (unavailable && !serving) {
        status.append(element('div', reason(revision.sourceProblem) || 'Причина недоступности не сохранена.', 'model-muted'));
      }
      return [element('span', id, 'model-number'), status, date(revision.registeredAt), count(revision.fitCount), action];
    });
    host.replaceChildren(rows.length ? table('История ревизий', labels, rows) : element('p', 'Ревизий пока нет', 'model-muted'));
    if (focusedId && document.activeElement === document.body) {
      const replacement = [...host.querySelectorAll('button')].find((node) => node.dataset.revisionId === focusedId);
      (replacement ?? get('history').querySelector('summary')).focus();
    }
    updatePageButton(get('more-revisions'), history.cursor, requests.has('history'));
  }

  function renderCases() {
    const entry = currentEvidence();
    get('cases-context').textContent = entry
      ? evidenceName(entry) + ' (' + selectedId + ')' : selectedId ?? '';
    const host = get('cases-table');
    setBusy(host, requests.has('cases'));
    if (!cases.ready) {
      const message = entry?.limitations?.includes('CASES_NOT_RECORDED') ? 'Список задач этой проверки не сохранён.'
        : requests.has('cases') ? 'Загружаем планы…'
          : entry && !entry.summary.rowCount ? (qualitySource() === 'issued' ? emptyEvidence() : 'В этой проверке нет задач.') : '';
      host.replaceChildren(element('p', message, 'model-muted'));
    } else if (!cases.rows.length) {
      host.replaceChildren(element('p', qualitySource() === 'issued' ? emptyEvidence() : 'В этой проверке нет задач.', 'model-muted'));
    } else {
      const labels = [{ text: 'План' }, { text: 'Факт', numeric: true }, { text: 'Прогноз', numeric: true },
        { text: 'Ошибка', numeric: true }, { text: 'Интервал', numeric: true }];
      const rows = cases.rows.map((row) => {
        const title = element('span', row.title ?? row.planId, 'model-case-title');
        if (Number.isFinite(row.finishedAt)) {
          const stamp = date(row.finishedAt);
          stamp.className = 'model-case-date';
          title.append(stamp);
        }
        const exclusion = row.scoringExclusionReason ?? row.pointUnavailableReason;
        if (exclusion) title.append(element('span', reason(exclusion), 'model-case-note'));
        const interval = row.interval?.status === 'AVAILABLE'
          ? 'От ' + minutes(row.interval.lowerMs, 'Нет данных') + ' до ' + minutes(row.interval.upperMs, 'Нет данных') : 'Нет данных';
        return [title, minutes(row.actualMs, 'Нет данных'), minutes(row.pointMs, 'Нет данных'),
          minutes(row.signedErrorMs, 'Нет данных', true), interval];
      });
      host.replaceChildren(table('Планы выбранной проверки', labels, rows));
    }
    updatePageButton(get('more-cases'), cases.cursor, requests.has('cases'));
  }

  function resetCases() {
    cancelRequest('cases');
    cases = { rows: [], cursor: null, ready: false };
    clearNotice(get('cases-notice'));
    renderCases();
  }

  async function loadCases(cursor = null, retryButton = null) {
    const entry = currentEvidence();
    if (!viewing || requests.has('cases') || !get('cases').open || !entry || !entry.summary.rowCount
      || entry.limitations?.includes('CASES_NOT_RECORDED')) return;
    const request = beginRequest('cases');
    if (retryButton) setButtonState(retryButton, true);
    renderCases();
    try {
      const path = registryUrl + '/' + encodeURIComponent(entry.modelRevisionId) + '/evidence/cases';
      const result = await read(path, {
        source: entry.source, evidenceId: entry.evidenceId, ...(cursor ? { cursor } : {}),
      }, request);
      if (!requestCurrent('cases', request)) return;
      requests.delete('cases');
      cases = { rows: [...(cursor ? cases.rows : []), ...result.cases], cursor: result.nextCursor, ready: true };
      const retryFocused = document.activeElement === retryButton;
      clearNotice(get('cases-notice'));
      renderCases();
      if (retryFocused) get('cases').querySelector('summary').focus();
      announce(cursor && !cases.cursor ? 'Все планы загружены' : 'Планы загружены.');
    } catch {
      if (!requestCurrent('cases', request)) return;
      requests.delete('cases');
      renderCases();
      const next = notice(get('cases-notice'), 'Не удалось загрузить планы.', (action) => loadCases(cursor, action));
      if (document.activeElement === retryButton) next.focus();
    }
  }

  function maybeLoadCases() {
    if (get('cases').open && !cases.ready) void loadCases();
  }

  async function loadHistory(cursor, retryButton = null) {
    if (!viewing || !cursor || requests.has('history')) return;
    const request = beginRequest('history');
    const action = get('more-revisions');
    setButtonState(action, true);
    if (retryButton) setButtonState(retryButton, true);
    try {
      const result = await read(registryUrl, { view: 'list', cursor }, request);
      if (!requestCurrent('history', request)) return;
      requests.delete('history');
      if (result.activationVersion !== overview.activationVersion
        || result.servingModelRevisionId !== overview.servingModelRevisionId
        || result.sourceProblem !== overview.sourceProblem) {
        await loadAtlmModelOverview();
        return;
      }
      history = { rows: [...history.rows, ...result.rows], cursor: result.nextCursor };
      const retryFocused = document.activeElement === retryButton;
      clearNotice(get('history-notice'));
      renderHistory();
      if (retryFocused) get('history').querySelector('summary').focus();
      announce(history.cursor ? 'Ревизии загружены.' : 'Все ревизии загружены');
    } catch {
      if (!requestCurrent('history', request)) return;
      requests.delete('history');
      setButtonState(action, false);
      const next = notice(get('history-notice'), 'Не удалось загрузить ревизии.', (node) => loadHistory(cursor, node));
      if (document.activeElement === retryButton) next.focus();
    }
  }

  async function loadDetail(retryButton = null) {
    const id = selectedId;
    if (!viewing || !id || requests.has('detail')) return;
    const request = beginRequest('detail');
    if (retryButton) {
      setButtonState(retryButton, true);
      setBusy(get('report'), true);
    } else renderQuality();
    try {
      const next = await read(registryUrl, { view: 'detail', modelRevisionId: id }, request);
      if (!requestCurrent('detail', request)) return;
      requests.delete('detail');
      detail = next;
      detailFailed = false;
      const retryFocused = document.activeElement === retryButton;
      renderQuality();
      resetCases();
      if (retryFocused) get('quality-heading').focus();
      maybeLoadCases();
    } catch (error) {
      if (!requestCurrent('detail', request)) return;
      requests.delete('detail');
      const retryFocused = document.activeElement === retryButton;
      if (error.status === 404 && explicitId === id) {
        explicitId = null;
        selectedId = overview?.activeModelRevisionId ?? null;
        if (selectedId === id) selectedId = null;
        detail = null;
        detailFailed = false;
        selectionMessage = 'Выбранная ревизия недоступна.';
        renderQuality();
        renderHistory();
        resetCases();
        announce(selectionMessage);
        if (selectedId) await loadDetail();
      } else {
        detailFailed = true;
        renderQuality();
      }
      if (retryFocused) (get('report').querySelector('button') ?? get('quality-heading')).focus();
    }
  }

  function chooseRevision(id) {
    explicitId = id;
    selectedId = id ?? overview?.activeModelRevisionId ?? null;
    choiceVersion++;
    cancelRequest('detail');
    detail = null;
    detailFailed = false;
    selectionMessage = '';
    controlId = null;
    get('quality-heading').focus();
    announce(selectedId ? 'Выбрана ревизия ' + selectedId : 'Модель для новых прогнозов пока не назначена.');
    renderQuality();
    renderHistory();
    resetCases();
    void loadDetail();
  }

  async function loadAtlmModelOverview(retryButton = null) {
    if (!viewing || requests.has('overview')) return;
    const request = beginRequest('overview');
    const originalChoice = choiceVersion;
    if (retryButton) setButtonState(retryButton, true);
    cancelRequest('history');
    if (overview) setButtonState(get('more-revisions'), true);
    setBusy(get('content'), true);
    try {
      const next = await read(registryUrl, { view: 'list' }, request);
      if (!requestCurrent('overview', request)) return;
      requests.delete('overview');
      overview = next;
      loadedAt = Date.now();
      stale = false;
      const retryFocused = document.activeElement === retryButton;
      clearNotice(get('notice'));
      clearNotice(get('history-notice'));
      get('skeleton').hidden = true;
      get('body').hidden = false;
      setBusy(get('content'), false);
      history = { rows: next.rows, cursor: next.nextCursor };
      if (originalChoice === choiceVersion) {
        cancelRequest('detail');
        selectedId = explicitId ?? next.activeModelRevisionId ?? null;
        detail = null;
        detailFailed = false;
      }
      renderOverview();
      renderQuality();
      if (originalChoice === choiceVersion) resetCases();
      if (retryFocused) get('overview-heading').focus();
      announce('Сведения о модели загружены.');
      if (!detail) void loadDetail();
    } catch {
      if (!requestCurrent('overview', request)) return;
      requests.delete('overview');
      stale = Boolean(overview);
      setBusy(get('content'), false);
      get('skeleton').hidden = true;
      if (overview) renderOverview();
      const next = notice(get('notice'), stale ? 'Обновить сведения не удалось' : 'Не удалось загрузить сведения о модели',
        loadAtlmModelOverview, loadedAt);
      if (document.activeElement === retryButton) next.focus();
      announce(stale ? 'Обновить сведения не удалось.' : 'Не удалось загрузить сведения о модели.');
    }
  }

  function leaveAtlmModelOverview() {
    viewing = false;
    for (const name of requests.keys()) cancelRequest(name);
    setBusy(get('content'), false);
    const retry = get('notice').querySelector('button');
    if (retry) setButtonState(retry, false);
    updatePageButton(get('more-revisions'), history.cursor, false);
    updatePageButton(get('more-cases'), cases.cursor, false);
  }

  get('sources').addEventListener('change', (event) => {
    if (!event.target.matches('input[name="model-quality-source"]')) return;
    source = event.target.value;
    renderQuality();
    resetCases();
    maybeLoadCases();
  });
  get('report-picker').addEventListener('change', (event) => {
    controlId = event.target.value;
    renderQuality();
    resetCases();
    maybeLoadCases();
  });
  get('show-cases').addEventListener('click', () => {
    const box = get('cases');
    box.open = true;
    box.querySelector('summary').focus();
    maybeLoadCases();
  });
  get('cases').addEventListener('toggle', () => {
    if (get('cases').open) maybeLoadCases();
    else {
      cancelRequest('cases');
      renderCases();
    }
  });
  const moreRevisions = get('more-revisions');
  const moreCases = get('more-cases');
  moreRevisions.addEventListener('click', () => {
    if (!requests.has('overview') && moreRevisions.getAttribute('aria-disabled') !== 'true') void loadHistory(history.cursor);
  });
  moreCases.addEventListener('click', () => {
    if (cases.cursor && moreCases.getAttribute('aria-disabled') !== 'true') void loadCases(cases.cursor);
  });
  moreRevisions.addEventListener('blur', () => { if (!history.cursor) moreRevisions.hidden = true; });
  moreCases.addEventListener('blur', () => { if (!cases.cursor) moreCases.hidden = true; });

  function refreshOnReturn() {
    if (viewing && !document.hidden) void loadAtlmModelOverview();
  }

  window.addEventListener('plan-time-tracker:view-changed', ({ detail: view }) => {
    if (view.view !== 'settings') {
      leaveAtlmModelOverview();
      return;
    }
    viewing = true;
    timeZone = view.timeZone ?? document.querySelector('#tz')?.value ?? timeZone;
    void loadAtlmModelOverview();
  });
  window.addEventListener('plan-time-zone-changed', () => {
    timeZone = document.querySelector('#tz')?.value ?? timeZone;
    if (overview) {
      renderOverview();
      renderCases();
    }
    refreshOnReturn();
  });
  document.addEventListener('visibilitychange', refreshOnReturn);
  window.addEventListener('pageshow', refreshOnReturn);
})();
`;
