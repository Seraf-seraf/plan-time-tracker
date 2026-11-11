import test from 'node:test';
import assert from 'node:assert/strict';
import {Script} from 'node:vm';
import worker from '../worker/index.js';
async function html(){return (await worker.fetch(new Request('https://tracker.test/',{headers:{'oai-authenticated-user-id':'ui-test-owner'}}),{})).text();}
test('all four client scripts compile and period filters remain present',async()=>{const source=await html();const scripts=[...source.matchAll(/<script>([\s\S]*?)<\/script>/g)];assert.equal(scripts.length,4);scripts.forEach(([,js])=>new Script(js));assert(source.includes('overviewFilter'));assert(source.includes('plan-time-tracker:period-plans'));assert(!source.includes('repoRefs'));});
test('responsive forms and keyboard dialog safeguards are delivered',async()=>{const source=await html();for(const marker of ['minmax(min(100%,180px),1fr)','aria-labelledby="modalTitle"',"event.key==='Escape'","event.key!=='Tab'",'modalReturnFocus.focus()','overflow-wrap:anywhere'])assert(source.includes(marker),marker);});
test('forms prevent duplicate submission and no integration controls are delivered',async()=>{const source=await html();for(const marker of ["form.getAttribute('aria-busy')==='true'","form.removeAttribute('aria-busy')"])assert(source.includes(marker),marker);for(const removed of ['githubStatus','repositoryId','commitPolicy','pushPolicy','SyncRepository'])assert(!source.includes(removed),removed);});
test('mobile plan cards give titles and actions separate full-width rows',async()=>{const source=await html();assert(source.includes('.row>.plan-open{flex:1 1 100%}'));assert(source.includes('.row>.row-right{width:100%;justify-content:flex-start'));});
test('Plans header keeps a scoped 16px separation before its list',async()=>{const source=await html();assert(source.includes('#view-plans>.toolbar{margin-bottom:16px}'));});
test('Plan detail keeps its 16px gap and intrinsic back-button width',async()=>{const source=await html();assert(source.includes('#view-detail{display:grid;gap:16px}'));assert(source.includes('#view-detail>#backPlans{justify-self:start}'));});

test('period metrics keep scoped gaps and concise accessible copy for date filters and median sample',async()=>{
  const source=await html();
  for(const marker of ['#view-overview>.panel:has(#overviewFrom)>.metrics{margin-top:16px}','#view-overview>.panel:has(#overviewFrom)>.list{margin-top:16px}','make("label","С")','make("label","По")','from.setAttribute("aria-label","Дата начала периода")','to.setAttribute("aria-label","Дата конца периода")','Завершено планов','Медиана активного времени','formatPlanSample(data.completedMeasuredN)','Малая выборка','Медиана рассчитана по менее чем пяти завершённым планам.','lastTwo>=11&&lastTwo<=14'])assert(source.includes(marker),marker);
  for(const old of ['С даты','По дату','Завершено за период','Медиана полной активности · малая выборка','1 планов'])assert(!source.includes(old),old);
  const scripts=[...source.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([,script])=>script);
  const helper=scripts[1].match(/function formatPlanSample\(count\) \{[\s\S]*?\n  \}/)?.[0];
  assert(helper,'formatPlanSample function exists');
  const formatPlanSample=new Function(`${helper}; return formatPlanSample;`)();
  assert.deepEqual([1,2,4,5,11,21].map(formatPlanSample),['по 1 плану','по 2 планам','по 4 планам','по 5 планам','по 11 планам','по 21 плану']);
});

test('document stages use a status form and contain no technical evidence editors',async()=>{
  const source=await html();
  for(const marker of ['SetStepStatus','planText','Текст плана','Статус этапа','Сохранить статус','Исходный текст','aria-controls','aria-expanded'])assert(source.includes(marker),marker);
  for(const removed of ['Digest проверенного снимка','Код завершения','evidence summary','Подробности проверок','ClaimStepAttempt','RecordCheck','RenewStepLease','create-step'])assert(!source.includes(removed),removed);
  assert.equal((source.match(/setInterval\(/g)||[]).length,1);
});

test('legacy stage reading keeps prose and actual results without a diagnostic summary',async()=>{
  const source=await html();
  for(const marker of ['Что нужно сделать','Результат','step.expected_result','step.currentResult.summary','step.readyToFinish'])assert(source.includes(marker),marker);
  for(const removed of ['Сводка: блокировок','задержка до первой проверки','Серверная последовательность:','Время клиента:'])assert(!source.includes(removed),removed);
});

test('status history keeps server paging and describes stage status changes',async()=>{
  const source=await html();for(const marker of ['/status-history?','История статусов','STEP_STATUS_CHANGED','event.stepTitle'])assert(source.includes(marker),marker);
});

test('timezone selector keeps supported choices, falls back to Omsk, and drives persistence and display',async()=>{const source=await html();const select=source.match(/<select id="tz" required>([\s\S]*?)<\/select>/);assert(select);assert.deepEqual([...select[1].matchAll(/<option value="([^"]+)"([^>]*)>([^<]+)<\/option>/g)].map(([,value,attrs,label])=>({value,selected:attrs.includes('selected'),label})),[{value:'Europe/Moscow',selected:false,label:'Москва (UTC+3)'},{value:'Asia/Omsk',selected:true,label:'Омск (UTC+6)'}]);const scripts=[...source.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([,script])=>script);assert(scripts[0].includes('normalizeZone(settings.timezone)'));assert(scripts[0].includes('timezone:q("#tz").value'));assert(scripts[0].includes('timeZone:zone'));assert(scripts[0].includes('plan-time-zone-changed'));assert(scripts[1].includes('normalizeZone(settings.timezone)'));assert(scripts[1].includes('timeZone:state.zone'));assert(source.includes('<label for="tz">Часовой пояс</label>'));for(const old of ['IANA timezone','Явный учёт интервалов','Медиана сопровождается размером выборки N'])assert(!source.includes(old),old);});
