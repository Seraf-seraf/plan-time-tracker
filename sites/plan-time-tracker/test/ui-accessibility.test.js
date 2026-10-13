import test from 'node:test';
import assert from 'node:assert/strict';
import {Script} from 'node:vm';
import worker from '../worker/index.js';
async function html(){return (await worker.fetch(new Request('https://tracker.test/',{headers:{'oai-authenticated-user-id':'ui-test-owner'}}),{})).text();}
test('all three client scripts compile and existing UI enhancements remain present',async()=>{const source=await html();const scripts=[...source.matchAll(/<script>([\s\S]*?)<\/script>/g)];assert.equal(scripts.length,3);scripts.forEach(([,js])=>new Script(js));assert(source.includes('overviewPeriodPlans'));assert(source.includes('repoRefs'));});
test('responsive forms and keyboard dialog safeguards are delivered',async()=>{const source=await html();for(const marker of ['minmax(min(100%,180px),1fr)','aria-labelledby="modalTitle"',"event.key==='Escape'","event.key!=='Tab'",'modalReturnFocus.focus()','overflow-wrap:anywhere'])assert(source.includes(marker),marker);});
test('forms prevent duplicate submission and public sync stays enabled without a runtime token',async()=>{const source=await html();for(const marker of ["form.getAttribute('aria-busy')==='true'",'sync.dataset.githubAvailable=String(data.githubAvailable===true)','sync.querySelector("button").disabled=data.githubAvailable!==true',"form.removeAttribute('aria-busy')",'status.textContent=data.message','r.result.errorMessage||r.result.message'])assert(source.includes(marker),marker);assert.equal((source.match(/id=\"githubStatus\"/g)||[]).length,1);assert(source.includes('role=\"status\"'));assert(!source.includes('G3 не настроен:'));assert(!source.includes('list.prepend(n)'));});
test('mobile plan cards give titles and actions separate full-width rows',async()=>{const source=await html();assert(source.includes('.row>.plan-open{flex:1 1 100%}'));assert(source.includes('.row>.row-right{width:100%;justify-content:flex-start'));});

test('GitHub author ID placeholder stays concise on mobile',async()=>{const source=await html();assert(source.includes('ID авторов GitHub'));assert(source.includes('authors.placeholder=\"через запятую\"'));});

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

test('timezone selector keeps supported choices, falls back to Omsk, and drives persistence and display',async()=>{const source=await html();const select=source.match(/<select id="tz" required>([\s\S]*?)<\/select>/);assert(select);assert.deepEqual([...select[1].matchAll(/<option value="([^"]+)"([^>]*)>([^<]+)<\/option>/g)].map(([,value,attrs,label])=>({value,selected:attrs.includes('selected'),label})),[{value:'Europe/Moscow',selected:false,label:'Москва (UTC+3)'},{value:'Asia/Omsk',selected:true,label:'Омск (UTC+6)'}]);const scripts=[...source.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([,script])=>script);assert(scripts[0].includes('normalizeZone(s.timezone)'));assert(scripts[0].includes('timezone:q("#tz").value'));assert(scripts[0].includes('timeZone:zone'));assert(scripts[0].includes('plan-time-zone-changed'));assert(scripts[1].includes('normalizeZone(settings.timezone)'));assert(scripts[1].includes('timeZone:state.zone'));assert(source.includes('<label for="tz">Часовой пояс</label>'));for(const old of ['IANA timezone','Явный учёт интервалов','Медиана сопровождается размером выборки N'])assert(!source.includes(old),old);});
