import { UI_TIME_ZONES } from './time-zones.js';

export const UI_ENHANCEMENTS = String.raw`(()=> {
  const q = (s) => document.querySelector(s);
  const make = (tag, text, cls) => { const x=document.createElement(tag); if(text!=null)x.textContent=text; if(cls)x.className=cls; return x; };
  const supportedZones = ${JSON.stringify(UI_TIME_ZONES.map((option) => option.value))};
  const normalizeZone = (value) => supportedZones.includes(value) ? value : "Asia/Omsk";
  const state = { zone: "Asia/Omsk", analytics: null };
  const localDate = (d) => { const value=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:state.zone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(d)).map(part=>[part.type,part.value])); return value.year+"-"+value.month+"-"+value.day; };
  const duration = (n) => { if(n==null)return "—"; n=Math.max(0,Math.round(n/60000)); const d=Math.floor(n/1440),h=Math.floor(n%1440/60),m=n%60; return d?d+" д "+h+" ч "+m+" мин":h?h+" ч "+m+" мин":m+" мин"; };
  async function api(path, options) {
    const response=await fetch(path,{...options,headers:{"content-type":"application/json",...(options&&options.headers||{})},cache:"no-store"});
    const data=await response.json().catch(()=>({}));
    if(!response.ok){const err=new Error(data.error&&data.error.message||"HTTP "+response.status);err.code=data.error&&data.error.code;err.retryAfter=data.error&&data.error.retryAfter;throw err;}
    return data;
  }
  function addFilterPanel(target, id, title) {
    const panel=make("article",null,"panel period-filter"),heading=make("h2",title),toolbar=make("div",null,"toolbar");
    const fromWrap=make("div",null,"field"),fromLabel=make("label","С");fromLabel.htmlFor=id+"From";
    const from=make("input");from.type="date";from.id=id+"From";from.setAttribute("aria-label","Дата начала периода");fromWrap.append(fromLabel,from);
    const toWrap=make("div",null,"field"),toLabel=make("label","По");toLabel.htmlFor=id+"To";
    const to=make("input");to.type="date";to.id=id+"To";to.setAttribute("aria-label","Дата конца периода");toWrap.append(toLabel,to);
    const apply=make("button","Применить","primary");apply.type="button";
    const modeWrap=make("div",null,"field"),modeLabel=make("label","Показать");modeLabel.htmlFor=id+"Mode";
    const mode=make("select");mode.id=id+"Mode";mode.append(new Option("Активность за период","activity"),new Option("Завершённые за период","finished"));modeWrap.append(modeLabel,mode);
    toolbar.append(fromWrap,toWrap,modeWrap,apply);
    const stats=make("div",null,"metrics");
    panel.append(heading,toolbar,stats);
    target.prepend(panel);
    return {panel,from,to,mode,apply,stats};
  }
  const overview=q("#view-overview");
  const overviewFilter=addFilterPanel(overview,"overview","Фильтр периода");
  overviewFilter.mode.closest(".field").remove();
  const overviewHeading=overviewFilter.panel.querySelector("h2");
  overviewHeading.textContent="Показатели периода";
  const planFilter=addFilterPanel(q("#view-plans"),"plan","Планы за период");
  planFilter.panel.classList.add("plan-period-panel");
  const filterRequestIds=new WeakMap();
  function formatPlanSample(count) {
    const n=Number(count)||0,lastTwo=n%100;
    return "по "+n+" "+((lastTwo>=11&&lastTwo<=14)||n%10!==1?"планам":"плану");
  }
  function renderMetrics(target,data) {
    target.replaceChildren();
    const values=[
      ["Общее время",duration(data.totalActiveMs)],
      ["Завершено планов",String(data.completedPlans)],
      ["Медиана активного времени",duration(data.completedMedianActiveMs)+(data.completedMedianActiveMs==null?"":" · "+formatPlanSample(data.completedMeasuredN))],
      ["Сумма времени планов",duration(data.sumPlanActiveMs)]
    ];
    values.forEach(([label,value],index)=>{
      const box=make("div",null,"metric"),small=make("small",label),strong=make("strong",value);
      box.append(small,strong);
      if(index===2&&data.completedSmallSample){const note=make("small","Малая выборка","sample-note");note.title="Медиана рассчитана по менее чем пяти завершённым планам.";note.setAttribute("aria-label","Малая выборка: менее пяти завершённых планов.");box.append(note);}
      target.append(box);
    });
  }
  async function loadFilter(filter, overviewMode, preservePage=false) {
    const requestId=(filterRequestIds.get(filter)||0)+1;
    filterRequestIds.set(filter,requestId);
    const selection=preservePage&&filter.requested
      ? {...filter.requested,timeZone:state.zone}
      : {from:filter.from.value,to:filter.to.value,timeZone:state.zone,mode:filter.mode.value};
    if(!selection.from||!selection.to)return;
    filter.requested=selection;
    if(!preservePage)filter.resetPagePending=true;
    const query=new URLSearchParams({from:selection.from,to:selection.to,timeZone:selection.timeZone});
    let data;
    try{data=await api("/api/analytics?"+query);}
    catch(error){
      if(filterRequestIds.get(filter)!==requestId)return null;
      filter.requested=filter.applied;filter.resetPagePending=false;throw error;
    }
    if(filterRequestIds.get(filter)!==requestId)return null;
    filter.applied=selection;
    renderMetrics(filter.stats,data);
    if(overviewMode)return data;
    const rows=selection.mode==="finished"
      ? data.plans.filter(p=>p.status==="COMPLETED"&&p.finishedAt>=data.period.startMs&&p.finishedAt<data.period.endMs)
      : data.plans.filter(p=>p.activeInPeriodMs>0);
    const inactiveRows=selection.mode==="activity"?data.inactivePlans||[]:[];
    window.dispatchEvent(new CustomEvent("plan-time-tracker:period-plans",{
      detail:{rows:[...rows,...inactiveRows],resetPage:filter.resetPagePending,
        includeRunningNow:selection.mode==="activity"&&data.period.startMs<=data.asOf&&data.asOf<data.period.endMs}
    }));
    filter.resetPagePending=false;
    return data;
  }
  window.addEventListener("plan-time-zone-changed",event=>{
    state.zone=normalizeZone(event.detail);
    loadFilter(overviewFilter,true).catch(e=>window.alert(e.message));
    loadFilter(planFilter,false).catch(e=>window.alert(e.message));
    if(!q("#view-analytics").classList.contains("hidden"))q("#apply").click();
  });
  function defaults(filter) {
    const today=localDate(Date.now()),fromDate=new Date(today+"T12:00:00Z");fromDate.setUTCDate(fromDate.getUTCDate()-29);
    if(!filter.from.value)filter.from.value=localDate(fromDate);
    if(!filter.to.value)filter.to.value=today;
  }
  defaults(overviewFilter);defaults(planFilter);
  overviewFilter.apply.onclick=()=>loadFilter(overviewFilter,true).catch(e=>window.alert(e.message));
  planFilter.apply.onclick=()=>loadFilter(planFilter,false).catch(e=>window.alert(e.message));
  planFilter.mode.onchange=()=>loadFilter(planFilter,false).catch(e=>window.alert(e.message));
  let planFilterReady=false;
  window.addEventListener("plan-time-tracker:plans-rendered",()=>{
    if(!planFilterReady)return;
    loadFilter(overviewFilter,true,true).catch(e=>window.alert(e.message));
    loadFilter(planFilter,false,true).catch(e=>window.alert(e.message));
  });
  // Analytics uses the base loader so one accepted response updates metrics, chart and list together.
  async function init() {
    const settings=await api("/api/settings");state.zone=normalizeZone(settings.timezone);
    defaults(overviewFilter);defaults(planFilter);
    async function applyPlanFilter(){
      if(q("#plans").dataset.loaded!=="true"){
        await new Promise(resolve=>window.addEventListener("plan-time-tracker:plans-rendered",resolve,{once:true}));
      }
      planFilterReady=true;
      await loadFilter(planFilter,false);
    }
    await Promise.all([loadFilter(overviewFilter,true),applyPlanFilter()]);
  }
  const detail=q("#planDetail");
  let detailEnhancementToken=0;
  async function enhancePlanDetail(id){
    if(!detail||!id)return;
    const token=++detailEnhancementToken;
    detail.dataset.extraReady="true";detail.dataset.extraReadyPlanId=id;
    try{
      const {plan}=await api("/api/plans/"+encodeURIComponent(id)+"");
      if(token!==detailEnhancementToken||detail.dataset.planId!==id)return;
      const time=make("p",plan.finishedAt!=null?"От первого запуска до завершения: "+duration(plan.calendarMs):"");if(time.textContent)detail.append(time);
      if(plan.planCreatedAt.precision==="instant"&&plan.firstStartedAt!=null){
        const wait=plan.firstStartedAt-Date.parse(plan.planCreatedAt.value);
        detail.append(make("p","От указанной даты до первого запуска: "+duration(wait)));
      }
    }catch{}
  }
  window.addEventListener("plan-time-tracker:plan-rendered",event=>enhancePlanDetail(event.detail?.planId));
  init().catch(e=>{const notice=q("#notice");if(notice){notice.textContent=e.message;notice.classList.remove("hidden","error");}});
})();`;
