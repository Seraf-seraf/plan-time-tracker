export const UI_ATLM = String.raw`(()=>{
  const planRoot=document.querySelector("#planDetail"),settingsRoot=document.querySelector("#view-settings .settings-grid");
  if(!planRoot||!settingsRoot)return;
  const make=(tag,text,cls)=>{const el=document.createElement(tag);if(text!=null)el.textContent=text;if(cls)el.className=cls;return el;};
  const button=(text,action)=>{const el=make("button",text);el.type="button";el.addEventListener("click",action);return el;};
  const minutes=value=>new Intl.NumberFormat("ru-RU",{maximumFractionDigits:1}).format(value/60000)+" мин";
  const count=value=>Number.isSafeInteger(value)&&value>=0?value:0;
  const reasons={ASSESSMENT_REQUIRED:"До первого запуска не сохранены исходные признаки.",ASSESSMENT_INCOMPLETE:"Заполните обязательные поля оценки.",ASSESSMENT_INVALID:"Исправьте ошибки в оценке.",ASSESSMENT_SCHEMA_OUTDATED:"Требуется оценка по актуальной схеме.",ASSESSMENT_CONTEXT_CHANGED:"Требования или признаки изменились. Обновите оценку.",AVAILABLE:"Модель успешно обучена.",MISSING_REQUIRED_FEATURES:"Нужны признаки задачи.",HISTORY_RESET:"Нет нового прогноза для ранее начатого плана.",TRAINING_TIME_BUDGET:"Обучение не завершилось в отведённое время.",COLLECTING_DATA:"Пока недостаточно проверенных завершённых планов.",INCOMPLETE_FEATURES:"Для прогноза не хватает исходных сведений о задаче.",UNSUPPORTED_CATEGORY:"В накопленной истории ещё нет опыта для этого вида задачи.",MODEL_INVALIDATED:"Исходные данные модели изменились; требуется пересборка.",INVALID_PREDICTION:"Модель не смогла получить корректную оценку.",UNSUPPORTED_FORECAST_SCOPE:"Прогноз доступен для полного плана до первого запуска.",DATASET_LIMIT_REACHED:"Накопленные данные сохранены, но превышен текущий предел обучения.",RANK_DEFICIENT:"Данных пока недостаточно для независимой оценки влияния признаков.",MODEL_CAPACITY_LIMIT:"Превышен ресурсный предел числа коэффициентов модели. История сохранена.",INSUFFICIENT_DATA:"Пока недостаточно пригодных данных для обучения и проверки.",INSUFFICIENT_VALIDATION:"Пока недостаточно случаев для проверки новой модели.",INSUFFICIENT_EVALUATION_CASES:"В последней попытке не хватило проверочных сравнений. Новая версия допускает ранний прогноз с неподтверждённым качеством.",INSUFFICIENT_INCUMBENT_CASES:"Для замены действующей модели недостаточно независимых сравнений с ней.",MEDIAN_BASELINE_BETTER:"Новая модель ошибается сильнее обычной медианы прошлых длительностей.",MEDIAN_BASELINE_NOT_WORSE:"Медиана прошлых длительностей не хуже проверенных обучаемых способов. Новая обученная модель не активирована.",CANDIDATE_COVERAGE_WORSE:"Новая модель даёт прогноз для меньшей доли задач, чем действующая.",CANDIDATE_MAE_WORSE:"Средняя ошибка новой модели выше, чем у действующей.",SNAPSHOT_INVALIDATED:"Исходные данные изменились; подготовлена новая попытка обучения.",LEASE_EXPIRED:"Предыдущая обработка не завершилась вовремя; её состояние сохранено.",TRAINING_EXECUTION_FAILED:"Во время обучения произошёл технический сбой.",SOURCE_UNAVAILABLE:"Источник данных временно недоступен.",INVALID_ESTIMATION_SOURCE:"Сохранённый источник оценки не удалось проверить.",AVAILABLE:"Модель успешно обучена.",
    MISSING_FEATURES:"До первого запуска не сохранены исходные признаки.",INVALID_FEATURES:"Исходные признаки не соответствуют схеме.",PLAN_DELETED:"План удалён.",PLAN_NOT_COMPLETED:"План ещё не завершён.",RESULT_NOT_VERIFIED:"Результат и обязательные проверки не подтверждены.",SCOPE_CHANGED:"После начала изменился объём задачи.",INCOMPLETE_MEASUREMENT:"Нет полного подтверждённого измерения активного времени."};
  const statuses={IDLE:"Ожидание новых планов",QUEUED:"Обучение в очереди",RUNNING:"Модель обучается",RETRY_WAIT:"Ожидание повторной попытки",COLLECTING_DATA:"Накапливаем опыт",REJECTED:"Новая модель не прошла проверку",FAILED:"Не удалось завершить обучение"};
  const style=make("style");style.textContent=".atlm-panel{min-width:0;overflow-wrap:anywhere}.atlm-panel p{margin:9px 0}.atlm-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px}.atlm-heading h2,.atlm-heading h3{margin:0}.atlm-panel button{min-height:44px;white-space:normal}.atlm-controls{display:flex;gap:8px;flex-wrap:wrap}.atlm-point{font-size:1.35rem;font-weight:700;color:var(--ink)}.atlm-plan-estimate{margin:18px 0;padding:16px;border:1px solid var(--line-strong,var(--line));border-radius:var(--radius,10px);background:var(--paper-3,var(--panel))}.atlm-note{color:var(--ink-2,var(--muted));font-size:.9rem}.atlm-stale{border-left:3px solid var(--amber,var(--amber));padding-left:10px}.atlm-range-text,.atlm-fact{font-variant-numeric:tabular-nums}.atlm-scale{height:14px;position:relative;margin:18px 6px;background:var(--paper-2);border-radius:8px}.atlm-band{position:absolute;height:8px;top:3px;background:var(--amber);border-radius:8px}.atlm-marker,.atlm-fact-marker{position:absolute;top:0;height:14px;border-left:3px solid var(--ink)}.atlm-fact-marker{border-color:var(--blue)}.atlm-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr));gap:1px;background:var(--line);border:1px solid var(--line)}.atlm-metric{display:grid;gap:8px;padding:12px;background:var(--paper-2)}.atlm-metric strong{font-variant-numeric:tabular-nums}.atlm-metrics-help{margin:16px 0}.atlm-attempts{margin-top:24px}.atlm-table-wrap{max-width:100%;overflow-x:auto}.atlm-table-wrap table{width:100%;border-collapse:collapse;text-align:left;font-size:.9rem}.atlm-table-wrap th,.atlm-table-wrap td{padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}.atlm-panel summary{min-height:44px;display:flex;align-items:center;cursor:pointer}.atlm-panel summary::before{content:'▸';margin-right:6px}.atlm-panel details[open]>summary::before{content:'▾'}.atlm-table-wrap:focus-visible{outline:3px solid var(--amber-text);outline-offset:2px}.atlm-features{margin-top:16px}.atlm-features dl{display:grid;grid-template-columns:minmax(8rem,1fr) minmax(0,2fr);gap:6px 12px}.atlm-features dd{margin:0}.atlm-features h4{margin:14px 0 4px}@media(max-width:390px){.atlm-heading{align-items:flex-start}.atlm-controls{width:100%}.atlm-controls button{flex:1 1 100%}}";document.head.append(style);
  style.textContent += "#atlm-model-status{grid-column:1/-1}";
  style.textContent += ".atlm-feature-hint,.atlm-feature-reason{display:block;color:var(--ink-2,var(--muted));font-size:.85rem;line-height:1.4;margin-top:3px}.atlm-features dl{row-gap:14px}@media(max-width:600px){.atlm-features dl{grid-template-columns:1fr;gap:4px}.atlm-features dd{margin-bottom:12px}}";
  let supported=false,capabilityPending=false,planToken=0,planAbort=null,statusPending=null,pollTimer=null,pollsLeft=0,autoBudget=8,processPending=false,startPending=false,lastProcessFailure=null,latestStatus=null,recoveryAction=null;
  const processed=new Set();
  const statusPanel=make("article",null,"panel atlm-panel");statusPanel.id="atlm-model-status";statusPanel.setAttribute("aria-labelledby","atlm-model-heading");
  const statusHeading=make("h2","Накопление опыта");statusHeading.id="atlm-model-heading";
  const statusBody=make("div");statusBody.setAttribute("role","status");statusBody.setAttribute("aria-live","polite");
  const startTraining=button("Начать обучение",trainingAction);
  const controls=make("div",null,"atlm-controls");controls.append(startTraining);
  const attemptsRegion=make("section",null,"atlm-attempts");attemptsRegion.append(make("h3","Попытки обучения"));
  const attemptsBody=make("div","Загружаем историю…");attemptsBody.setAttribute("aria-live","polite");attemptsRegion.append(attemptsBody);
  statusPanel.append(statusHeading,statusBody,controls,attemptsRegion);
  let attemptsToken=0,attemptsCursor=null,attemptsRows=[];
  async function loadAttempts(more=false){
    const token=++attemptsToken;if(!more){attemptsRows=[];attemptsCursor=null;attemptsBody.replaceChildren(make("p","Загружаем историю…","atlm-note"));}
    try{
      const query=attemptsCursor?"?limit=50&cursor="+encodeURIComponent(attemptsCursor):"?limit=50";
      const page=await api("/api/tracker/estimation-training-history"+query);
      if(token!==attemptsToken)return;
      if(!Array.isArray(page.rows))throw new Error("Неполная история обучения.");
      attemptsRows.push(...page.rows);attemptsCursor=page.nextCursor;attemptsBody.replaceChildren();
      if(!attemptsRows.length){attemptsBody.append(make("p","Попыток обучения пока нет.","atlm-note"));return;}
      attemptsBody.append(renderAttempts(attemptsRows));
      if(attemptsCursor)attemptsBody.append(button("Показать ещё",()=>loadAttempts(true)));
    }catch(error){if(token!==attemptsToken)return;attemptsBody.replaceChildren(make("p","Не удалось загрузить историю. "+error.message,"error"),button("Повторить загрузку истории",()=>loadAttempts()));}
  }
  const trainingColumns = ["Дата", "Результат", "Примеры", "Точка", "Интервал", "Причина"];
  const trainingEngines = {
    OLS: "OLS", RIDGE: "Ridge", BAYESIAN: "Байесовская",
    BAYESIAN_PREDICTIVE: "Байесовский", BAYES_QUANTILE: "Квантильный"
  };
  const trainingPhases = {EVALUATE: "Проверка на истории", FIT: "Расчёт моделей", CALIBRATION: "Калибровка интервала"};
  const trainingFailures = new Set([
    "LEASE_EXPIRED", "TRAINING_EXECUTION_FAILED", "SOURCE_UNAVAILABLE",
    "INVALID_ESTIMATION_SOURCE", "TRAINING_TIME_BUDGET", "DATASET_LIMIT_REACHED"
  ]);
  function attemptOutcome(item) {
    if (item.completedAt === null) return {tone: "pending", label: "В работе"};
    if (!item.reason) return {tone: "success", label: "Модель обучена"};
    if (item.reason === "TRAINING_TIME_BUDGET") return {tone: "error", label: "Таймаут"};
    if (trainingFailures.has(item.reason)) return {tone: "error", label: "Прервано"};
    if (item.reason.startsWith("INSUFFICIENT_")) return {tone: "neutral", label: "Недостаточно данных"};
    return {tone: "neutral", label: "Кандидат отклонён"};
  }
  function candidateSummary(candidate) {
    if (candidate.status === "AVAILABLE") return "Доступен";
    if (candidate.reason === "INSUFFICIENT_DATA" && candidate.p > candidate.sampleCount) {
      return "Примеров: " + candidate.sampleCount + ", коэффициентов: " + candidate.p;
    }
    return candidate.reason ? reasonText(candidate.reason) : "Недоступен";
  }
  function renderAttempts(attempts) {
    const wrap = make("div", null, "atlm-table-wrap atlm-history-wrap");
    wrap.tabIndex = 0;
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", "Таблица попыток обучения");
    const table = make("table", null, "atlm-history");
    table.setAttribute("role", "table");
    const head = make("thead"), headRow = make("tr"), body = make("tbody");
    head.setAttribute("role", "rowgroup");
    headRow.setAttribute("role", "row");
    body.setAttribute("role", "rowgroup");
    for (const label of trainingColumns) {
      const th = make("th", label);
      th.scope = "col";
      th.setAttribute("role", "columnheader");
      headRow.append(th);
    }
    head.append(headRow);
    table.append(head, body);
    const timeZone = document.querySelector("#tz")?.value || "UTC";
    const timestamp = new Intl.DateTimeFormat("ru-RU", {dateStyle: "short", timeStyle: "short", timeZone});
    const seconds = new Intl.NumberFormat("ru-RU", {maximumFractionDigits: 1});
    for (const item of attempts.slice().reverse()) {
      const outcome = attemptOutcome(item);
      const row = make("tr");
      row.dataset.outcome = outcome.tone;
      row.setAttribute("role", "row");
      const appendCell = (index, content, className) => {
        const cell = make("td", null, className);
        const label = make("span", trainingColumns[index], "atlm-cell-label");
        label.setAttribute("aria-hidden", "true");
        cell.setAttribute("role", "cell");
        cell.append(label, content);
        row.append(cell);
      };
      const date = make("time", "Неизвестно");
      if (Number.isSafeInteger(item.startedAt)) {
        const start = new Date(item.startedAt);
        date.dateTime = start.toISOString();
        date.textContent = timestamp.format(start);
      }
      const time = make("div");
      time.append(date);
      if (Number.isSafeInteger(item.startedAt) && Number.isSafeInteger(item.completedAt) && item.completedAt >= item.startedAt) {
        time.append(make("span", seconds.format((item.completedAt - item.startedAt) / 1000) + " с", "atlm-attempt-duration"));
      }
      appendCell(0, time, "atlm-attempt-date");
      appendCell(1, make("strong", outcome.label, "atlm-attempt-outcome"), "atlm-attempt-status");
      appendCell(2, make("span", Array.isArray(item.manifest) ? String(item.manifest.length) : "Неизвестно"), "atlm-attempt-count");
      const point = item.selected?.point?.selectedEngine;
      const interval = item.selected?.interval?.selectedEngine;
      appendCell(3, make("span", trainingEngines[point] ?? point ?? "Нет"), "atlm-attempt-point");
      appendCell(4, make("span", trainingEngines[interval] ?? interval ?? "Нет"), "atlm-attempt-interval");

      const reason = make("div");
      if (item.reason) {
        const explanation = item.reason === "TRAINING_TIME_BUDGET"
          ? "Исчерпан бюджет времени прохода."
          : reasonText(item.reason);
        reason.append(make("span", explanation));
      }
      const candidates = Object.entries(item.diagnostics?.candidates || {});
      const diagnostic = item.diagnostics?.parameters;
      const phase = trainingPhases[diagnostic?.phase];
      if (phase || candidates.length) {
        const details = make("details", null, "atlm-attempt-details");
        details.append(make("summary", "Подробности"));
        const facts = make("dl");
        const addFact = (label, value) => facts.append(make("dt", label), make("dd", value));
        if (phase) {
          addFact("Этап", phase);
          if (Number.isSafeInteger(diagnostic.completedCases))
            addFact("Обработано примеров", String(diagnostic.completedCases));
          if (Number.isSafeInteger(diagnostic.stalledPasses))
            addFact("Проходов без прогресса", String(diagnostic.stalledPasses));
          if (Number.isFinite(diagnostic.passElapsedMs))
            addFact("Последний проход", seconds.format(diagnostic.passElapsedMs / 1000) + " с");
        }
        for (const [name, candidate] of candidates) {
          const engine = name.toUpperCase();
          addFact(trainingEngines[engine] ?? engine, candidateSummary(candidate));
        }
        details.append(facts);
        reason.append(details);
      } else if (!item.reason) {
        reason.append(make("span", "Нет", "atlm-note"));
      }
      appendCell(5, reason, "atlm-attempt-reason");
      body.append(row);
    }
    wrap.append(table);
    return wrap;
  }
  function updateControls(){
    startTraining.disabled=startPending||processPending||statusPending!==null;
    const stalled=latestStatus?.training.due&&(autoBudget<=0||processed.has(queueKey(latestStatus)));
    startTraining.textContent=startPending?"Запускаем обучение…":statusPending!==null?"Проверяем состояние…":recoveryAction==="status"?"Проверить состояние":recoveryAction==="process"||stalled||latestStatus?.training.due?"Продолжить обработку":["QUEUED","RUNNING","RETRY_WAIT"].includes(latestStatus?.training.status)?"Проверить состояние":"Начать обучение";
  }
  function trainingAction(){
    if(startPending||processPending||statusPending)return;
    if(recoveryAction==="status")return loadStatus(false);
    if(recoveryAction==="process"||latestStatus?.training.due||["QUEUED","RUNNING","RETRY_WAIT"].includes(latestStatus?.training.status)){
      autoBudget=8;processed.clear();lastProcessFailure=null;recoveryAction=null;pollsLeft=3;return loadStatus(true);
    }
    return requestTraining();
  }
  async function requestTraining(){
    if(startPending||processPending||statusPending)return;
    statusBody.querySelectorAll(".atlm-start-feedback,.atlm-process-feedback").forEach(message=>message.remove());lastProcessFailure=null;
    startPending=true;clearTimeout(pollTimer);statusPanel.setAttribute("aria-busy","true");updateControls();
    startTraining.textContent="Запускаем обучение…";
    try{
      const data=await api("/api/tracker/estimation-model/start",{method:"POST",body:"{}"});
      lastProcessFailure=null;recoveryAction=null;processed.clear();autoBudget=8;pollsLeft=3;showStatus(data);loadAttempts();
      const pending=data.training.due||["QUEUED","RUNNING","RETRY_WAIT"].includes(data.training.status);
      statusBody.append(make("p",pending?"Запрос принят. Обработка ещё не завершена.":"Попытка обучения завершена. Результат показан выше.","atlm-note atlm-start-feedback"));
      schedulePoll();
    }catch(error){
      recoveryAction="status";lastProcessFailure="Не удалось подтвердить запуск обучения. "+error.message+" Обновите состояние перед повторным запуском.";
      statusBody.append(make("p",lastProcessFailure,"error atlm-start-feedback"));
    }finally{startPending=false;startTraining.textContent="Начать обучение";statusPanel.removeAttribute("aria-busy");updateControls();}
  }
  async function api(path,options={}){
    const response=await fetch(path,{cache:"no-store",...options,headers:{"content-type":"application/json",...options.headers}});
    const data=await response.json().catch(()=>null);
    if(!response.ok){const error=new Error(data?.error?.message||"Не удалось получить ответ сервера.");error.code=data?.error?.code;throw error;}
    if(!data||typeof data!=="object")throw new Error("Сервер вернул неполный ответ. Повторите загрузку.");return data;
  }
  function reasonText(reason){return reasons[reason]||"Расчёт недоступен. Причина: "+String(reason)+".";}
  function diagnosticText(value){return typeof value?.message==="string"?value.message:null;}
  function forecastMethodLabel(model){
    if(model.method?.id==="historical-median")return "Ориентир — медиана прошлых задач";
    const engine=model.hybrid?.usedEngine||model.hybrid?.selectedEngine;
    if(engine==="BAYESIAN")return "ATLM: Bayesian";
    if(engine==="RIDGE")return "ATLM — ridge";
    if(engine==="OLS")return "ATLM — обычная регрессия";
    return "ATLM";
  }
  function intervalText(interval){return interval?.status==="AVAILABLE" ? minutes(interval.lowerMs)+" – "+minutes(interval.upperMs) : "Нет диапазона";}
  function addTimeline(target,estimate,actual){
    const interval=estimate.interval, point=estimate.pointMs;
    if(interval?.status!=="AVAILABLE") {target.append(make("p","Нет диапазона: "+reasonText(interval?.unavailableReason||"COLLECTING_DATA"),"atlm-note"));return;}
    target.append(make("p","Диапазон: "+intervalText(interval)+". Охват: цель 80%.","atlm-range-text"));
    target.append(make("p",interval.validationStatus==="HISTORICALLY_EVALUATED"?"Проверен на истории":"Экспериментальный","atlm-note"));
    const scale=make("div",null,"atlm-scale"),band=make("span",null,"atlm-band"),marker=make("span",null,"atlm-marker");
    const max=Math.max(1,point,interval.upperMs,Number.isSafeInteger(actual)?actual:0);
    band.style.left=(100*interval.lowerMs/max)+"%";band.style.width=(100*(interval.upperMs-interval.lowerMs)/max)+"%";
    marker.style.left=(100*point/max)+"%";scale.setAttribute("aria-hidden","true");scale.append(band,marker);
    if(Number.isSafeInteger(actual)){const fact=make("span",null,"atlm-fact-marker");fact.style.left=(100*actual/max)+"%";scale.append(fact);}
    target.append(scale);
  }
  function addTaskFeatures(target,task,failed,retry){
    const details=make("details",null,"atlm-features");details.append(make("summary","Признаки"));
    if(failed){details.append(make("p","Не удалось загрузить признаки.","error"),button("Повторить загрузку признаков",retry));target.append(details);return;}
    if(!task){details.append(make("p","Нужны признаки.","atlm-note"));target.append(details);return;}
    const groups=[
      ["Работа",["workUnits","doneBoundary","reuseLevel"]],
      ["Изменения",["components","contracts","systemBoundaries","migrationEntities","dataVolumeBand"]],
      ["Неопределённость",["requirementsUncertainty","solutionUncertainty","diagnosisState","learningTargets","scopeChangeRisk"]],
      ["Проверки",["verificationKinds","verificationScenarios","verificationReadiness","requiredReviewPasses"]],
      ["Условия работы",["environmentReadiness","accessReadiness","deploymentTargets"]],
      ["Исполнитель",["execution.mode","execution.modelId","execution.reasoningEffort","execution.environmentId","execution.plannedParallelAgents","execution.codebaseFamiliarity"]]
    ];
    const fields={
      workUnits:["Результаты","Что должно быть получено в результате задачи."],doneBoundary:["Граница готовности","До какого состояния нужно довести результат."],reuseLevel:["Готовая основа","Насколько существующее решение подходит для задачи."],
      components:["Компоненты","Какие модули, сервисы или приложения меняются."],contracts:["Контракты","Какие интерфейсы и форматы меняются."],systemBoundaries:["Системные границы","Операции с независимо управляемыми контрактами."],migrationEntities:["Миграция данных","Какие сохранённые сущности нужно преобразовать."],dataVolumeBand:["Объём данных","Сколько сохранённых записей затрагивает задача."],
      requirementsUncertainty:["Ясность требований","Насколько понятно, какой результат нужен."],solutionUncertainty:["Ясность решения","Насколько понятно, как получить результат."],diagnosisState:["Причина проблемы","Насколько установлена причина, если задача включает диагностику."],learningTargets:["Технологии для изучения","Технологии, чьи контракты нужно изучить для задачи."],scopeChangeRisk:["Риск расширения задачи","Насколько вероятно, что понадобится работа за текущими границами."],
      verificationKinds:["Виды проверок","Какие виды проверок нужны."],verificationScenarios:["Сценарии проверок","Что именно нужно проверить."],verificationReadiness:["Готовность проверок","Можно ли использовать существующие проверки."],requiredReviewPasses:["Независимые ревью","Сколько независимых ревью обязательно."],
      environmentReadiness:["Готовность рабочей среды","Можно ли начать работу или среду нужно подготовить."],accessReadiness:["Доступы","Есть ли необходимые доступы."],deploymentTargets:["Развёртывание","Куда нужно развернуть результат по условиям задачи."],
      "execution.mode":["Кто выполняет","Человек, ИИ-агент или они вместе."],"execution.modelId":["Модель","Модель ИИ-агента, если известна."],"execution.reasoningEffort":["Уровень рассуждения","Заданный уровень рассуждения модели, если известен."],"execution.environmentId":["Среда выполнения","Где работает исполнитель: локально или в облаке."],"execution.plannedParallelAgents":["Параллельные агенты","Сколько агентов планируется использовать одновременно."],"execution.codebaseFamiliarity":["Знакомство с кодом","Что исполнитель успел изучить до оценки."]
    };
    const values={
      doneBoundary:{ANALYSIS:"Анализ завершён",LOCAL_VERIFIED:"Проверено локально",LOCAL_STAGED:"Проверено локально и подготовлено в индексе Git",PUBLISHED:"Опубликовано",DEPLOYED_VERIFIED:"Развёрнуто и проверено"},
      reuseLevel:{0:"Основы нет",1:"Есть отдельные части",2:"Рабочее решение нужно изменить",3:"Достаточно выполнить готовое решение"},
      requirementsUncertainty:{0:"Требования определены",1:"Открыты отдельные детали",2:"Открыт существенный сценарий",3:"Результат требует согласования"},solutionUncertainty:{0:"Способ проверен",1:"Способ выбран, но не проверен",2:"Открыт ключевой технический вопрос",3:"Способ не определён"},
      diagnosisState:{NOT_APPLICABLE:"Диагностика не требуется",PROVEN:"Причина подтверждена",HYPOTHESIS:"Есть гипотеза"},scopeChangeRisk:{0:"Границы зафиксированы",1:"Возможны локальные уточнения",2:"Возможны дополнительные существенные работы",3:"Есть несколько открытых внешних зависимостей или требуется исследование"},
      dataVolumeBand:{NONE:"Сохранённые данные не затрагиваются",LE_1K:"До 1 000 записей включительно",LE_100K:"До 100 000 записей включительно",LE_10M:"До 10 млн записей включительно",GT_10M:"Более 10 млн записей"},
      verificationKinds:{BUILD_STATIC:"Сборка и статическая проверка",UNIT:"Модульные",INTEGRATION:"Интеграционные",UI_E2E:"Сквозные проверки интерфейса",DEPLOY_SMOKE:"Проверка после развёртывания"},
      verificationReadiness:{READY:"Готовы",ADAPT:"Нужно доработать",CREATE:"Нужно создать",NONE_REQUIRED:"Не требуются"},environmentReadiness:{READY:"Готова",SETUP_KNOWN:"Нужна известная настройка",BLOCKED:"Работа в среде заблокирована"},accessReadiness:{AVAILABLE:"Есть",MISSING:"Нет необходимых доступов"},
      "execution.mode":{AI_AGENT:"ИИ-агент",HUMAN:"Человек",HYBRID:"Человек и ИИ-агент"},"execution.environmentId":{local:"Локальная",cloud_workspace:"Облачная рабочая среда"},"execution.codebaseFamiliarity":{NOT_READ:"Код не изучен",MAPPED:"Структура кода изучена",PRIOR_VERIFIED_WORK:"Есть ранее проверенная работа с кодом"}
    };
    const empty={components:"Изменений компонентов нет",contracts:"Изменений контрактов нет",systemBoundaries:"Интеграции не требуются",migrationEntities:"Миграция не требуется",learningTargets:"Технологий для изучения нет",verificationKinds:"Проверки не требуются",verificationScenarios:"Сценариев нет",deploymentTargets:"Развёртывание не требуется"};
    const read=path=>path.split(".").reduce((value,key)=>value?.[key],task);
    const changes={CREATE:"создать",MODIFY:"изменить",REMOVE:"удалить",ADD:"добавить",COMPATIBLE:"совместимое изменение",BREAKING:"несовместимое изменение",USE:"использовать",CHANGE:"изменить"};
    function itemText(path,item){
      if(path==="systemBoundaries")return item.name+" ("+item.contractControl+", "+item.role+"): "+item.operations.map(op=>op.action+" "+op.description).join(", ");
      const label=item.description||item.key||item.id||item.kind;
      if(["components","contracts","systemBoundaries"].includes(path)&&item.change)return label+" — "+(changes[item.change]||item.change);
      return label;
    }
    function display(path,value){
      if(value===null||value===undefined||value==="UNKNOWN")return "Неизвестно";
      if(Array.isArray(value))return value.length?value.map(item=>typeof item==="object"?itemText(path,item):(values[path]?.[item]||item)).join(", "):(empty[path]||"Нет");
      return values[path]?.[value]||String(value);
    }
    for(const [title,keys] of groups){
      details.append(make("h4",title));const list=make("dl");
      for(const key of keys){
        const [name,hint]=fields[key],term=make("dt"),description=make("dd"),value=read(key);
        term.append(make("span",name),make("small",hint,"atlm-feature-hint"));description.append(make("span",display(key,value)));
        const reason=task.unknownReasons?.[key];
        if((value===null||value===undefined||value==="UNKNOWN")&&reason?.checkedSource)description.append(make("small",reason.reason+" ("+reason.checkedSource+")","atlm-feature-reason"));
        list.append(term,description);
      }
      details.append(list);
    }
    target.append(details);
  }
  function appendQuality(target,model){
    const evaluation=model.evaluation,n=model.sampleCount,k=evaluation?.pointCaseCount;
    target.append(make("p",Number.isSafeInteger(n)&&n>=1?"В обучении использовано планов: "+n+".":"Размер обучающей выборки не сохранён.","atlm-note"));
    target.append(make("p",Number.isSafeInteger(k)&&k>=0?"Проверено прогнозов: "+k+".":"Число проверенных прогнозов не сохранено.","atlm-note"));
    const fullPolicy=evaluation?.metricsScope==="FULL_POLICY";
    if(fullPolicy&&Number.isSafeInteger(evaluation.modelCaseCount)&&Number.isSafeInteger(k))target.append(make("p","В сравнениях обученная модель использована: "+evaluation.modelCaseCount+" из "+k+".","atlm-note"));
    const confirmed=model.accuracy==="HISTORICALLY_EVALUATED"&&Number.isSafeInteger(k)&&k>=5&&(!fullPolicy||evaluation.modelCaseCount>=5);
    const quality=make("p",null,"atlm-note atlm-quality");
    quality.append(make("strong",confirmed?"Проверен на истории":"Экспериментальный"));target.append(quality);
    if(Number.isSafeInteger(k)&&k>0&&Number.isFinite(evaluation?.maeMs)&&evaluation.maeMs>=0)target.append(make("p",(fullPolicy?"Средняя ошибка гибрида с запасным прогнозом: ":"Средняя ошибка прошлых проверок: ")+minutes(evaluation.maeMs)+". Это не гарантия длительности.","atlm-note"));
    else target.append(make("p","Ошибка пока не оценена.","atlm-note"));
    if(fullPolicy&&Number.isFinite(evaluation.medianBaselineMaeMs))target.append(make("p","Ошибка медианы на тех же задачах: "+minutes(evaluation.medianBaselineMaeMs)+".","atlm-note"));
    if(fullPolicy&&Number.isSafeInteger(evaluation.profileGroupCount))target.append(make("p","Разных профилей задач: "+evaluation.profileGroupCount+". Похожие задачи ограничивают выводы о качестве на другой работе.","atlm-note"));
  }
  function showStatus(data){
    if(!data.training||!statuses[data.training.status]||![data.newPlansSinceTraining,data.eligibleSampleCount,data.excludedSampleCount].every(value=>Number.isSafeInteger(value)&&value>=0)||!Number.isSafeInteger(data.retrainEveryNewPlans)||data.retrainEveryNewPlans<1||typeof data.training.due!=="boolean"||!Object.hasOwn(data,"activeModel")||(data.activeModel!==null&&(!Number.isSafeInteger(data.activeModel.sampleCount)||data.activeModel.sampleCount<1)))throw new Error("Не удалось прочитать состояние обучения.");
    const exclusionsOpen=statusBody.querySelector(".atlm-exclusions")?.open===true,methodOpen=statusBody.querySelector(".atlm-method")?.open===true;
    latestStatus=data;
    statusBody.replaceChildren();statusBody.append(make("p",statuses[data.training.status]));
    statusBody.append(make("p","Новых пригодных планов: "+count(data.newPlansSinceTraining)+". Начать обучение можно в любое время."));
    statusBody.append(make("p","Автоматическое обучение запускается после "+data.retrainEveryNewPlans+" новых пригодных планов. Для ручного запуска ждать не нужно.","atlm-note"));
    statusBody.append(make("p",data.training.due?"Новые планы ожидают обработки.":"До следующего автоматического обучения: "+Math.max(0,data.retrainEveryNewPlans-data.newPlansSinceTraining)+".","atlm-note"));
    statusBody.append(make("p","Всего пригодных планов: "+count(data.eligibleSampleCount)+". Исключено: "+count(data.excludedSampleCount)+".","atlm-note"));
    if(Array.isArray(data.exclusionReasons)&&data.exclusionReasons.length){
      const disclosure=make("details",null,"atlm-exclusions"),list=make("ul");disclosure.open=exclusionsOpen;disclosure.append(make("summary","Почему планы не учитываются"));
      for(const item of data.exclusionReasons)if(typeof item.reason==="string"&&Number.isSafeInteger(item.count)&&item.count>0)list.append(make("li",reasonText(item.reason)+" Планов: "+item.count+"."));
      disclosure.append(list,make("p","У одного плана может быть несколько причин.","atlm-note"));statusBody.append(disclosure);
    }
    if(data.activeModel){statusBody.append(make("p","Действующая модель: "+String(data.activeModel.modelVersion||data.activeModel.modelId)+".","atlm-note"),make("p","Точка: "+(data.activeModel.hybrid?.selectedEngine||"—")+". Интервал: "+(data.activeModel.hybrid?.intervalEngine||"—")+".","atlm-note"));appendQuality(statusBody,data.activeModel);}
    if(data.training.status==="REJECTED"&&data.activeModel)statusBody.append(make("p","Предыдущая пригодная модель продолжает давать прогнозы.","atlm-note"));
    if(data.training.progress&&Number.isSafeInteger(data.training.progress.totalCases)&&data.training.progress.totalCases>0)statusBody.append(make("p","Обработано примеров: "+count(data.training.progress.completedCases)+" из "+data.training.progress.totalCases+".","atlm-note"));
    if(data.training.status==="RETRY_WAIT"&&Number.isFinite(data.training.nextAttemptAt))statusBody.append(make("p","Повторная попытка не раньше "+new Intl.DateTimeFormat("ru-RU",{dateStyle:"short",timeStyle:"short",timeZone:document.querySelector("#tz")?.value||"UTC"}).format(new Date(data.training.nextAttemptAt))+".","atlm-note"));
    const reason=data.lastError||data.lastReason;
    if(data.lastAttempt){
      statusBody.append(make("p","Последняя завершённая попытка: "+reasonText(data.lastAttempt.code),"atlm-note"));
      const facts=data.lastAttempt;
      const technical=make("details",null,"atlm-candidates");technical.append(make("summary","Подробности последней попытки"));
      technical.append(make("p",reasonText(facts.code),"atlm-note"));
      for(const [name,label] of [["ols","Обычная регрессия"],["ridge","Ridge"],["bayesian","Bayesian"]]){
        const candidate=facts.candidates?.[name];if(!candidate)continue;
        technical.append(make("p",label+": "+(candidate.status==="AVAILABLE"?"рассчитана":reasonText(candidate.reason))+" Планов: "+candidate.sampleCount+".","atlm-note"));
      }
      statusBody.append(technical);
    }
    if(reason&&(!data.lastAttempt||data.lastAttempt.code!==reason))
      statusBody.append(make("p",reasonText(reason)+" Подробные параметры этой причины не сохранены.",data.lastError?"error":"atlm-note"));
    if(lastProcessFailure)statusBody.append(make("p",lastProcessFailure,"error atlm-process-feedback"));
    const method=make("details",null,"atlm-method");method.open=methodOpen;method.append(make("summary","Кто рассчитывает прогноз"),make("p","Сервер использует исходные признаки и активное время завершённых планов. При первом запуске прогноз фиксируется. Диапазон имеет целевой охват 80%, фактические попадания показаны в аналитике.","atlm-note"));statusBody.append(method);updateControls();
  }
  function queueKey(data){const t=data.training;return JSON.stringify([data.datasetRevision,t.generation,t.progressRevision,t.pendingRefreshCount,t.nextAttemptAt]);}
  function schedulePoll(){clearTimeout(pollTimer);if(pollsLeft>0){pollsLeft--;pollTimer=setTimeout(()=>loadStatus(true),750);}}
  function loadStatus(allowProcess=true){
    if(!supported||startPending)return Promise.resolve();if(statusPending)return statusPending;
    statusPanel.setAttribute("aria-busy","true");
    statusPending=(async()=>{
      try{
        const data=await api("/api/tracker/estimation-model");if(recoveryAction==="status"){recoveryAction=null;lastProcessFailure=null;}showStatus(data);
        const key=queueKey(data);
        if(allowProcess&&data.training.due&&!processPending&&autoBudget>0&&!processed.has(key)){
          processed.add(key);autoBudget--;processPending=true;updateControls();
          try{await api("/api/tracker/estimation-model/process",{method:"POST",body:"{}"});lastProcessFailure=null;pollsLeft=Math.max(pollsLeft,3);}
          catch(error){recoveryAction="process";lastProcessFailure="Не удалось продолжить обучение. "+error.message;statusBody.append(make("p",lastProcessFailure,"error atlm-process-feedback"));}
          finally{processPending=false;updateControls();}
          schedulePoll();
        }else if(allowProcess&&(data.training.status==="RUNNING"||data.training.due))schedulePoll();
      }catch(error){recoveryAction="status";statusBody.replaceChildren(make("p","Не удалось загрузить состояние обучения. "+error.message,"error"));}
      finally{statusPending=null;updateControls();statusPanel.removeAttribute("aria-busy");}
    })();updateControls();return statusPending;
  }
  async function loadPlan(planId,retry=0){
    if(!supported||!planId||planRoot.dataset.planId!==planId)return;
    const token=++planToken;planAbort?.abort();planAbort=new AbortController();
    planRoot.querySelector(".atlm-plan-estimate")?.remove();
    if(planRoot.dataset.deleted==="true")return;
    const panel=make("section",null,"atlm-panel atlm-plan-estimate");panel.dataset.planId=planId;panel.setAttribute("aria-labelledby","atlm-plan-heading");panel.setAttribute("aria-busy","true");
    const heading=make("h3","Прогноз активного времени");heading.id="atlm-plan-heading";
    const toolbar=make("div",null,"atlm-heading"),refresh=button("Обновить прогноз",()=>loadPlan(planId));toolbar.append(heading);
    if(planRoot.dataset.planStatus==="PLANNED")toolbar.append(refresh);
    const body=make("div","Рассчитываю прогноз…");body.setAttribute("role","status");body.setAttribute("aria-live","polite");panel.append(toolbar,body);planRoot.insertBefore(panel,planRoot.children[2]||null);
    refresh.disabled=true;
    try{
      const data=await api("/api/tracker/plans/"+encodeURIComponent(planId)+"/estimate",{signal:planAbort.signal});
      if(token!==planToken||planRoot.dataset.planId!==planId||!panel.isConnected)return;
      if(data.planId!==planId)throw new Error("Ответ относится к другому плану. Повторите загрузку.");
      if(!Object.hasOwn(data,"serverEstimation")||typeof data.isStale!=="boolean")throw new Error("Сервер вернул неполную оценку. Повторите загрузку.");
      body.replaceChildren();const estimate=data.serverEstimation;
      const forecastPlanStatus=data.forecastAvailability?.planStatus||planRoot.dataset.planStatus;
      if(data.forecastAvailability?.deleted===true){panel.remove();return;}
      if(data.forecastAvailability?.canRefreshSaved===false)refresh.remove();
      if(data.forecastAvailability?.canRefreshSaved===true&&planRoot.dataset.planStatus==="PLANNED"&&!refresh.isConnected)toolbar.append(refresh);
      let planData=null,task=null,planError=false,taskError=false;
      try {planData=(await api("/api/plans/"+encodeURIComponent(planId),{signal:planAbort.signal})).plan;}
      catch(error){if(error.name==="AbortError")throw error;planError=true;}
      if(data.assessmentId)try{const a=await api("/api/tracker/assessment",{method:"POST",signal:planAbort.signal,body:JSON.stringify({planId,assessmentId:data.assessmentId,...(data.assessmentRevision?{revision:data.assessmentRevision}:{})})});task=a.assessment?.context?.agentTask??null;}
      catch(error){if(error.name==="AbortError")throw error;taskError=true;}
      if(token!==planToken||planRoot.dataset.planId!==planId||!panel.isConnected)return;
      if(data.source==="CURRENT_INPUT" && planData?.firstStartedAt!=null){
        if(retry>=2)throw new Error("Статус плана изменился. Повторите загрузку прогноза.");
        return loadPlan(planId,retry+1);
      }
      const actual=planData?.status==="COMPLETED"&&Number.isSafeInteger(planData.activeMs)?planData.activeMs:null;
      if(data.source==="CURRENT_INPUT"&&Number.isSafeInteger(estimate?.calculatedAt))
        body.append(make("p","Рассчитано: "+new Intl.DateTimeFormat("ru-RU",{dateStyle:"short",timeStyle:"medium",timeZone:document.querySelector("#tz")?.value||"UTC"}).format(new Date(estimate.calculatedAt))+".","atlm-note"));
      if(estimate==null){body.append(make("p","Исходная оценка до запуска не сохранена.","atlm-note"));}
      else if(estimate.status==="AVAILABLE"&&Number.isFinite(estimate.pointMs)&&estimate.pointMs>=0){
        body.append(make("p","Около "+minutes(estimate.pointMs),"atlm-point"));
        addTimeline(body,estimate,actual);
        if(data.source==="FROZEN_INPUT")body.append(make("p","Зафиксировано при запуске","atlm-note"));

        body.append(make("p",forecastMethodLabel(estimate),"atlm-note atlm-method-label"));

        if(estimate.method?.id==="historical-median"){
          body.append(make("strong","Ранний ориентир по истории"));
          body.append(make("p","Учтено завершённых планов: "+count(estimate.sampleCount)+". Общая медиана активного времени; особенности новой задачи не учитываются. Качество не подтверждено.","atlm-note"));
          if(estimate.fallback?.atlmDiagnostics)body.append(make("p",(data.source==="CURRENT_INPUT"?"ATLM сейчас: ":"ATLM на момент оценки: ")+reasonText(estimate.fallback.atlmDiagnostics.code||estimate.fallback.atlmUnavailableReason),"atlm-note"));
        }
      }else if(estimate.status==="UNAVAILABLE"){
        body.append(make("p",reasonText(data.diagnostics?.code||estimate.diagnostics?.code||estimate.unavailableReason||"COLLECTING_DATA"),"atlm-note"));
        body.append(make("p",forecastPlanStatus==="PLANNED"?"Агент может дополнить исходные сведения до первого запуска плана.":"Исходная оценка зафиксирована при первом запуске плана. Отсутствие прогноза не блокирует работу.","atlm-note"));
      }else throw new Error("Сервер вернул некорректную оценку.");
      if(actual!==null)body.append(make("p","Факт: "+minutes(actual),"atlm-fact"));
      else if(planError)body.append(make("p","Не удалось загрузить факт.","error"),button("Повторить загрузку факта",()=>loadPlan(planId)));
      if(estimate==null&&data.diagnostics)body.append(make("p",diagnosticText(data.diagnostics)||reasonText(data.diagnostics.code),"atlm-note"));


      const readiness=data.assessmentReadiness;
      if(readiness){
        body.append(make("p",readiness.status==="READY"?"Оценка готова":reasonText(readiness.code),"atlm-readiness"));
        const paths=[...readiness.missingPaths,...readiness.invalidPaths];
        if(paths.length)body.append(make("p","Поля для проверки: "+paths.join(", "),"atlm-note"));
        if(readiness.operations){const ops=readiness.operations;body.append(make("p","READ: "+ops.readCount+", WRITE: "+ops.writeCount+", доля WRITE: "+new Intl.NumberFormat("ru-RU",{style:"percent",maximumFractionDigits:1}).format(ops.writeRatio),"atlm-operation-counts"));}
      }
      addTaskFeatures(body,task,taskError,()=>loadPlan(planId));
      if(data.isStale&&data.source!=="CURRENT_INPUT")body.append(make("p",data.staleReasons?.includes("BASELINE_SOURCE_CHANGED")?"История завершённых планов изменилась; сохранённая медиана показана как историческая оценка.":"Оценка устарела: изменился объём задачи или исходные данные модели. Сохранённое значение показано для истории.","atlm-stale"));
    }catch(error){if(token!==planToken||planRoot.dataset.planId!==planId||error.name==="AbortError")return;body.replaceChildren(make("p","Не удалось загрузить прогноз. "+error.message,"error"));}
    finally{if(token===planToken&&panel.isConnected){refresh.disabled=false;panel.removeAttribute("aria-busy");}}
  }
  const analyticsRoot=document.querySelector("#view-analytics"),qualityPanel=make("section",null,"panel atlm-panel atlm-analytics");
  const qualityHeading=make("h2","Качество прогнозов"),qualityBody=make("div","Загружаем…");qualityBody.setAttribute("aria-live","polite");qualityPanel.append(qualityHeading,qualityBody);analyticsRoot?.append(qualityPanel);
  let qualityToken=0,qualityRows=[],qualityPage=0;
  function renderQuality(){
    qualityBody.replaceChildren();const rows=qualityRows,points=rows.filter(row=>Number.isSafeInteger(row.issuedPrediction?.pointMs));
    const intervals=points.filter(row=>row.issuedPrediction.interval?.status==="AVAILABLE" && Number.isSafeInteger(row.issuedPrediction.interval.lowerMs) && Number.isSafeInteger(row.issuedPrediction.interval.upperMs));
    if(!rows.length){qualityBody.append(make("p","Нет наблюдений за выбранный период.","atlm-note"));return;}
    const errors=points.map(row=>row.issuedPrediction.pointMs-row.actualMs),absolute=errors.map(Math.abs).sort((a,b)=>a-b),sum=values=>values.reduce((a,b)=>a+b,0),actual=sum(points.map(row=>row.actualMs));
    const medianError=absolute.length?(absolute[Math.floor((absolute.length-1)/2)]+absolute[Math.floor(absolute.length/2)])/2:null;
    const rate=value=>Number.isFinite(value)?new Intl.NumberFormat("ru-RU",{maximumFractionDigits:1}).format(value)+"%":"—";
    const metric=(label,value)=>{const item=make("div",null,"atlm-metric");item.append(make("span",label),make("strong",value));return item;};
    const stats=make("div",null,"atlm-metrics");stats.append(metric("Средняя ошибка",points.length?minutes(sum(absolute)/points.length):"—"),metric("Медианная ошибка",medianError===null?"—":minutes(medianError)),
      metric("WAPE",actual?rate(100*sum(absolute)/actual):"—"),metric("Смещение",actual?rate(100*sum(errors)/actual):"—"),
      metric("Прогнозы",points.length+" / "+rows.length),metric("Попадания в диапазон",intervals.filter(row=>row.issuedPrediction.interval.lowerMs<=row.actualMs&&row.actualMs<=row.issuedPrediction.interval.upperMs).length+" / "+intervals.length),
      metric("Средняя ширина",intervals.length?minutes(sum(intervals.map(row=>row.issuedPrediction.interval.upperMs-row.issuedPrediction.interval.lowerMs))/intervals.length):"—"));qualityBody.append(stats);
    const help=make("details",null,"atlm-metrics-help");help.append(make("summary","Как читать показатели"),make("p","Ошибки сравнивают прогноз и фактическое активное время. WAPE и смещение не рассчитываются при нулевой сумме факта. Попадания считаются только для доступных диапазонов; цель 80% не является гарантией.","atlm-note"));qualityBody.append(help);
    const wrap=make("div",null,"atlm-table-wrap"),table=make("table"),head=make("thead"),hr=make("tr");wrap.setAttribute("tabindex","0");wrap.setAttribute("role","region");wrap.setAttribute("aria-label","Таблица прогнозов и фактического времени");
    for(const label of ["План","Прогноз","Диапазон","Факт","Ошибка"])hr.append(make("th",label));head.append(hr);table.append(head);const body=make("tbody");
    for(const row of rows.slice(qualityPage*10,qualityPage*10+10)){const tr=make("tr"),prediction=row.issuedPrediction;for(const value of [row.title||row.planId,prediction?.pointMs!=null?minutes(prediction.pointMs):"—",prediction?.interval?.status==="AVAILABLE"?intervalText(prediction.interval):"—",minutes(row.actualMs),prediction?.pointMs!=null?minutes(prediction.pointMs-row.actualMs):"—"])tr.append(make("td",value));body.append(tr);}table.append(body);wrap.append(table);qualityBody.append(wrap);
    const pages=Math.ceil(rows.length/10),nav=make("div",null,"atlm-controls");const previous=button("Назад",()=>{qualityPage--;renderQuality();}),next=button("Далее",()=>{qualityPage++;renderQuality();});previous.disabled=qualityPage===0;next.disabled=qualityPage+1>=pages;nav.append(previous,make("span","Страница "+(qualityPage+1)+" из "+pages),next);qualityBody.append(nav);
  }
  async function loadQuality(){
    const token=++qualityToken;qualityBody.replaceChildren(make("p","Загружаем данные…","atlm-note"));
    try{let cursor=null,all=[];do{const page=await api("/api/tracker/atlm-dataset",{method:"POST",body:JSON.stringify({limit:100,...(cursor?{cursor}:{})})});if(token!==qualityToken)return;all.push(...page.rows);cursor=page.nextCursor;}while(cursor);
      const latest=new Map();for(const row of all)latest.set(row.planId,row);
      const planFacts=new Map();let planCursor=null;do{const list=await api("/api/plans?limit=100"+(planCursor?"&cursor="+encodeURIComponent(planCursor):""));if(token!==qualityToken)return;
        for(const plan of list.plans)planFacts.set(plan.planId,{title:plan.title,finishedAt:plan.finishedAt});planCursor=list.nextCursor;}while(planCursor);
      const from=document.querySelector("#from")?.value,to=document.querySelector("#to")?.value,zone=document.querySelector("#tz")?.value||"UTC";
      const day=ms=>new Intl.DateTimeFormat("en-CA",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(ms));
      qualityRows=[...latest.values()].map(row=>({...row,...planFacts.get(row.planId)})).filter(row=>row.eligibility==="ELIGIBLE"&&Number.isSafeInteger(row.actualMs)&&Number.isSafeInteger(row.finishedAt)&&(!from||day(row.finishedAt)>=from)&&(!to||day(row.finishedAt)<=to)).sort((a,b)=>b.finishedAt-a.finishedAt||a.planId.localeCompare(b.planId));qualityPage=0;renderQuality();
    }catch(error){if(token!==qualityToken)return;qualityBody.replaceChildren(make("p","Не удалось загрузить качество прогнозов. "+error.message,"error"),button("Повторить загрузку качества",loadQuality));}
  }
  document.querySelector('[data-view="analytics"]')?.addEventListener("click",loadQuality);
  document.querySelector("#apply")?.addEventListener("click",loadQuality);
  window.addEventListener("plan-time-zone-changed",loadQuality);
  async function discover(){
    if(capabilityPending)return;capabilityPending=true;
    try{const capabilities=await api("/api/tracker/capabilities");supported=!!capabilities.assessments?.atlm;if(!supported){statusPanel.remove();return;}if(!statusPanel.isConnected)settingsRoot.append(statusPanel);pollsLeft=0;await Promise.all([loadStatus(false),loadAttempts()]);if(planRoot.dataset.planId)await loadPlan(planRoot.dataset.planId);}
    catch(error){if(!statusPanel.isConnected)settingsRoot.append(statusPanel);statusBody.replaceChildren(make("p","Не удалось проверить поддержку прогноза. "+error.message,"error"),button("Повторить проверку прогноза",discover));controls.hidden=true;}
    finally{capabilityPending=false;if(supported)controls.hidden=false;}
  }
  window.addEventListener("plan-time-tracker:plan-will-render",()=>{planToken++;planAbort?.abort();});
  window.addEventListener("plan-time-tracker:plan-rendered",event=>{loadPlan(event.detail?.planId);loadStatus(false);});
  document.querySelector('[data-view="settings"]')?.addEventListener("click",()=>{clearTimeout(pollTimer);pollsLeft=0;loadStatus(false);loadAttempts();});
  window.addEventListener("pagehide",()=>{clearTimeout(pollTimer);planAbort?.abort();});
  discover();
})();`;
