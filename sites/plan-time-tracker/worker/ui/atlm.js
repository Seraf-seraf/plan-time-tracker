export const UI_ATLM = String.raw`(()=>{
  const planRoot=document.querySelector("#planDetail");
  if(!planRoot)return;
  const make=(tag,text,cls)=>{const el=document.createElement(tag);if(text!=null)el.textContent=text;if(cls)el.className=cls;return el;};
  const button=(text,action)=>{const el=make("button",text);el.type="button";el.addEventListener("click",action);return el;};
  const minutes=value=>new Intl.NumberFormat("ru-RU",{maximumFractionDigits:1}).format(value/60000)+" мин";
  const count=value=>Number.isSafeInteger(value)&&value>=0?value:0;
  const reasons={ASSESSMENT_REQUIRED:"До первого запуска не сохранены исходные признаки.",ASSESSMENT_INCOMPLETE:"Заполните обязательные поля оценки.",ASSESSMENT_INVALID:"Исправьте ошибки в оценке.",ASSESSMENT_SCHEMA_OUTDATED:"Требуется оценка по актуальной схеме.",ASSESSMENT_CONTEXT_CHANGED:"Требования или признаки изменились. Обновите оценку.",AVAILABLE:"Модель успешно обучена.",MISSING_REQUIRED_FEATURES:"Нужны признаки задачи.",HISTORY_RESET:"Нет нового прогноза для ранее начатого плана.",TRAINING_TIME_BUDGET:"Обучение не завершилось в отведённое время.",COLLECTING_DATA:"Пока недостаточно проверенных завершённых планов.",INCOMPLETE_FEATURES:"Для прогноза не хватает исходных сведений о задаче.",UNSUPPORTED_CATEGORY:"В накопленной истории ещё нет опыта для этого вида задачи.",MODEL_INVALIDATED:"Исходные данные модели изменились; требуется пересборка.",INVALID_PREDICTION:"Модель не смогла получить корректную оценку.",UNSUPPORTED_FORECAST_SCOPE:"Прогноз доступен для полного плана до первого запуска.",DATASET_LIMIT_REACHED:"Накопленные данные сохранены, но превышен текущий предел обучения.",RANK_DEFICIENT:"Данных пока недостаточно для независимой оценки влияния признаков.",MODEL_CAPACITY_LIMIT:"Превышен ресурсный предел числа коэффициентов модели. История сохранена.",INSUFFICIENT_DATA:"Пока недостаточно пригодных данных для обучения и проверки.",INSUFFICIENT_VALIDATION:"Пока недостаточно случаев для проверки новой модели.",INSUFFICIENT_EVALUATION_CASES:"В последней попытке не хватило проверочных сравнений. Новая версия допускает ранний прогноз с неподтверждённым качеством.",INSUFFICIENT_INCUMBENT_CASES:"Для замены действующей модели недостаточно независимых сравнений с ней.",MEDIAN_BASELINE_BETTER:"Новая модель ошибается сильнее обычной медианы прошлых длительностей.",MEDIAN_BASELINE_NOT_WORSE:"Медиана прошлых длительностей не хуже проверенных обучаемых способов. Новая обученная модель не активирована.",CANDIDATE_COVERAGE_WORSE:"Новая модель даёт прогноз для меньшей доли задач, чем действующая.",CANDIDATE_MAE_WORSE:"Средняя ошибка новой модели выше, чем у действующей.",SNAPSHOT_INVALIDATED:"Исходные данные изменились; подготовлена новая попытка обучения.",LEASE_EXPIRED:"Предыдущая обработка не завершилась вовремя; её состояние сохранено.",TRAINING_EXECUTION_FAILED:"Во время обучения произошёл технический сбой.",SOURCE_UNAVAILABLE:"Источник данных временно недоступен.",INVALID_ESTIMATION_SOURCE:"Сохранённый источник оценки не удалось проверить.",AVAILABLE:"Модель успешно обучена.",
    MISSING_FEATURES:"До первого запуска не сохранены исходные признаки.",INVALID_FEATURES:"Исходные признаки не соответствуют схеме.",PLAN_DELETED:"План удалён.",PLAN_NOT_COMPLETED:"План ещё не завершён.",RESULT_NOT_VERIFIED:"Результат и обязательные проверки не подтверждены.",SCOPE_CHANGED:"После начала изменился объём задачи.",INCOMPLETE_MEASUREMENT:"Нет полного подтверждённого измерения активного времени."};
  const style=make("style");style.textContent=".atlm-panel{min-width:0;overflow-wrap:anywhere}.atlm-panel p{margin:9px 0}.atlm-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px}.atlm-heading h2,.atlm-heading h3{margin:0}.atlm-panel button{min-height:44px;white-space:normal}.atlm-controls{display:flex;gap:8px;flex-wrap:wrap}.atlm-point{font-size:1.35rem;font-weight:700;color:var(--ink)}.atlm-plan-estimate{margin:18px 0;padding:16px;border:1px solid var(--line-strong,var(--line));border-radius:var(--radius,10px);background:var(--paper-3,var(--panel))}.atlm-note{color:var(--ink-2,var(--muted));font-size:.9rem}.atlm-stale{border-left:3px solid var(--amber,var(--amber));padding-left:10px}.atlm-range-text,.atlm-fact{font-variant-numeric:tabular-nums}.atlm-scale{height:14px;position:relative;margin:18px 6px;background:var(--paper-2);border-radius:8px}.atlm-band{position:absolute;height:8px;top:3px;background:var(--amber);border-radius:8px}.atlm-marker,.atlm-fact-marker{position:absolute;top:0;height:14px;border-left:3px solid var(--ink)}.atlm-fact-marker{border-color:var(--blue)}.atlm-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr));gap:1px;background:var(--line);border:1px solid var(--line)}.atlm-metric{display:grid;gap:8px;padding:12px;background:var(--paper-2)}.atlm-metric strong{font-variant-numeric:tabular-nums}.atlm-metrics-help{margin:16px 0}.atlm-table-wrap{max-width:100%;overflow-x:auto}.atlm-table-wrap table{width:100%;border-collapse:collapse;text-align:left;font-size:.9rem}.atlm-table-wrap th,.atlm-table-wrap td{padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}.atlm-panel summary{min-height:44px;display:flex;align-items:center;cursor:pointer}.atlm-panel summary::before{content:'▸';margin-right:6px}.atlm-panel details[open]>summary::before{content:'▾'}.atlm-table-wrap:focus-visible{outline:3px solid var(--amber-text);outline-offset:2px}.atlm-features{margin-top:16px}.atlm-features dl{display:grid;grid-template-columns:minmax(8rem,1fr) minmax(0,2fr);gap:6px 12px}.atlm-features dd{margin:0}.atlm-features h4{margin:14px 0 4px}@media(max-width:390px){.atlm-heading{align-items:flex-start}.atlm-controls{width:100%}.atlm-controls button{flex:1 1 100%}}";document.head.append(style);
  style.textContent += ".atlm-feature-hint,.atlm-feature-reason{display:block;color:var(--ink-2,var(--muted));font-size:.85rem;line-height:1.4;margin-top:3px}.atlm-features dl{row-gap:14px}@media(max-width:600px){.atlm-features dl{grid-template-columns:1fr;gap:4px}.atlm-features dd{margin-bottom:12px}}";
  let planToken=0,planAbort=null;
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
  async function loadPlan(planId,retry=0){
    if(!planId||planRoot.dataset.planId!==planId)return;
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
  const ISSUED_PAGE_SIZE = 10;
  const analyticsRoot = document.querySelector("#view-analytics");
  const qualityPanel = make("section", null, "panel atlm-panel atlm-analytics");
  const qualityHeading = make("h2", "Выданные прогнозы всех версий за выбранный период");
  qualityHeading.id = "atlm-issued-history-heading";
  qualityHeading.tabIndex = -1;
  qualityPanel.setAttribute("aria-labelledby", qualityHeading.id);
  const qualityBody = make("div");
  const qualityStatus = make("p", null, "atlm-note");
  qualityStatus.setAttribute("role", "status");
  const qualityActions = make("div", null, "atlm-controls");
  qualityPanel.append(qualityHeading, qualityBody, qualityStatus, qualityActions);
  analyticsRoot.append(qualityPanel);

  let qualityAbort = null;
  let qualityRows = null;
  let qualityParams = null;
  const numberFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
  const qualityValue = (value, format) => Number.isFinite(value) ? format(value) : "Нет оценки";
  const ratioText = value => Number.isFinite(value?.numerator) && Number.isFinite(value?.denominator)
    ? value.numerator + " / " + value.denominator : "Нет оценки";
  function metric(label, value) {
    const item = make("div", null, "atlm-metric");
    item.append(make("span", label), make("strong", value));
    return item;
  }

  function renderQuality(summary) {
    qualityBody.replaceChildren();
    if (!summary.rowCount) {
      qualityBody.append(make("p", "Нет наблюдений за выбранный период.", "atlm-note"));
      return;
    }
    const metrics = summary.metrics;
    const percent = value => qualityValue(value, number => numberFormat.format(number) + "%");
    const coverage = metrics?.coverageDenominator > 0
      ? ratioText({ numerator: metrics.coverageNumerator, denominator: metrics.coverageDenominator })
      : "Нет оценки";
    const stats = make("div", null, "atlm-metrics");
    const coverageMetric = metric("Попадания в интервал", coverage);
    coverageMetric.append(make("span", "Средняя ширина " + qualityValue(metrics?.meanIntervalWidthMs, minutes)));
    if (Number.isFinite(metrics?.nominalCoverage)) coverageMetric.append(make("span", "Целевой охват " + percent(100 * metrics.nominalCoverage)));
    stats.append(
      metric("Средняя абсолютная ошибка", qualityValue(metrics?.maeMs, minutes)),
      metric("Медиана абсолютной ошибки", qualityValue(metrics?.medaeMs, minutes)),
      metric("WAPE", percent(metrics?.wapePercent)),
      metric("Смещение", percent(metrics?.signedBiasPercent)),
      metric("Прогнозы", ratioText(summary.forecastAvailability)),
      metric("Интервалы", ratioText(summary.intervalAvailability)),
      coverageMetric,
    );
    const help = make("details", null, "atlm-metrics-help");
    help.append(make("summary", "Как читать показатели"), make("p",
      "Ошибки сравнивают прогноз и фактическое активное время. WAPE и смещение доступны при ненулевой сумме факта. Попадания считаются для сопоставимых планов с диапазоном. Целевой охват не является гарантией.", "atlm-note"));
    if (summary.excludedFromScoringCount) help.append(make("p", "Исключено из расчёта ошибок: " + summary.excludedFromScoringCount + ".", "atlm-note"));
    const wrap = make("div", null, "atlm-table-wrap"), table = make("table");
    wrap.tabIndex = 0;
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", "Таблица прогнозов и фактического времени");
    table.append(make("caption", "Прогнозы и фактическое время планов"));
    const head = table.createTHead().insertRow();
    for (const label of ["План", "Прогноз", "Интервал", "Факт", "Ошибка"]) {
      const cell = make("th", label);
      cell.scope = "col";
      head.append(cell);
    }
    qualityRows = table.createTBody();
    wrap.append(table);
    qualityBody.append(stats, help, wrap);
  }

  function appendQualityCases(cases) {
    if (!qualityRows) return;
    const date = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeZone: qualityParams.timeZone });
    for (const row of cases) {
      const tr = qualityRows.insertRow();
      const plan = make("th", row.title || row.planId);
      plan.scope = "row";
      if (Number.isFinite(row.finishedAt)) {
        const time = make("time", date.format(row.finishedAt), "atlm-note");
        time.dateTime = new Date(row.finishedAt).toISOString();
        plan.append(make("br"), time);
      }
      const model = row.method === "historical-median" ? "Медиана прошлых задач"
        : row.modelRevisionId || (row.pointMs != null && row.method === "atlm" ? "Ревизия не установлена" : null);
      if (model) plan.append(make("br"), make("span", model, "atlm-note"));
      tr.append(plan);
      for (const value of [
        qualityValue(row.pointMs, minutes),
        intervalText(row.interval),
        qualityValue(row.actualMs, minutes),
        qualityValue(row.signedErrorMs, ms => (ms > 0 ? "+" : "") + minutes(ms)),
      ]) tr.append(make("td", value));
    }
  }

  async function requestQuality(cursor = null, trigger = null) {
    if (qualityAbort || !qualityParams) return;
    const request = new AbortController();
    qualityAbort = request;
    const params = new URLSearchParams({ view: "issued-history", limit: ISSUED_PAGE_SIZE, ...qualityParams });
    if (cursor) params.set("cursor", cursor);
    if (trigger) trigger.disabled = true;
    qualityPanel.setAttribute("aria-busy", "true");
    qualityStatus.textContent = "Загружаем выданные прогнозы…";
    try {
      const data = await api("/api/tracker/model-revisions?" + params, { signal: request.signal });
      if (qualityAbort !== request) return;
      if (!cursor) renderQuality(data.summary);
      appendQualityCases(data.cases);
      qualityStatus.textContent = cursor ? "Добавлено планов: " + data.cases.length + "." : "";
      const focused = trigger === document.activeElement;
      qualityActions.replaceChildren();
      if (data.nextCursor) {
        const next = button("Показать ещё планы", () => requestQuality(data.nextCursor, next));
        qualityActions.append(next);
        if (focused) next.focus();
      } else if (focused) {
        qualityHeading.focus();
      }
    } catch (error) {
      if (qualityAbort !== request) return;
      qualityStatus.textContent = "Не удалось загрузить выданные прогнозы. " + error.message;
      if (!trigger || trigger.textContent !== "Повторить загрузку качества") {
        const focused = trigger === document.activeElement;
        const retry = button("Повторить загрузку качества", () => requestQuality(cursor, retry));
        qualityActions.replaceChildren(retry);
        if (focused) retry.focus();
      }
    } finally {
      if (qualityAbort === request) {
        qualityAbort = null;
        if (trigger) trigger.disabled = false;
        qualityPanel.removeAttribute("aria-busy");
      }
    }
  }

  function cancelQuality() {
    qualityAbort?.abort();
    qualityAbort = null;
    qualityPanel.removeAttribute("aria-busy");
  }

  function loadQuality(timeZone = document.querySelector("#tz").value || "UTC") {
    cancelQuality();
    qualityParams = { from: document.querySelector("#from").value, to: document.querySelector("#to").value, timeZone };
    qualityRows = null;
    qualityBody.replaceChildren();
    qualityActions.replaceChildren();
    requestQuality();
  }

  document.querySelector("#apply").addEventListener("click", () => loadQuality());
  window.addEventListener("plan-time-zone-changed", event => {
    if (!analyticsRoot.classList.contains("hidden")) loadQuality(event.detail);
  });
  window.addEventListener("plan-time-tracker:view-changed", event => {
    if (event.detail.view === "analytics") loadQuality(event.detail.timeZone);
    else cancelQuality();
  });
  window.addEventListener("plan-time-tracker:plan-will-render", () => { planToken++; planAbort?.abort(); });
  window.addEventListener("plan-time-tracker:plan-rendered", event => loadPlan(event.detail?.planId));
  window.addEventListener("pagehide", () => { cancelQuality(); planAbort?.abort(); });
})();`;
