export const UI_PLAN_LISTS = String.raw`
const PLAN_PAGE_SIZE=8, RECENT_PAGE_SIZE=4;
let planPage=0,recentPage=0,periodPlans=null,includeRunningNow=false;
function renderPagedList(list,items,pageSize,page,kind,emptyText) {
  const lastPage=Math.max(0,Math.ceil(items.length/pageSize)-1);
  page=Math.min(Math.max(0,page),lastPage);
  if(kind==="plans")planPage=page;else recentPage=page;
  list.replaceChildren();
  let pager=q("#"+kind+"Pager");
  if(!items.length){
    pager?.remove();
    if(emptyText){
      const empty=document.createElement("p");
      empty.className="muted";
      empty.textContent=emptyText;
      list.append(empty);
    }
    return;
  }
  items.slice(page*pageSize,(page+1)*pageSize).forEach(plan=>{
    const row=card(plan),period=kind==="plans"&&(periodPlans?.get(plan.planId)||(includeRunningNow&&plan.status==="RUNNING"?{activeInPeriodMs:0}:null));
    if(period){
      const meta=row.querySelector(".row-meta");
      meta.textContent+=" · за период: "+(period.activeInPeriodMs>0?duration(period.activeInPeriodMs):"без активности");
    }
    list.append(row);
  });
  if(!pager){
    pager=document.createElement("nav");pager.id=kind+"Pager";pager.className="pager";
    pager.setAttribute("aria-label",kind==="plans"?"Страницы списка планов":"Страницы остальных планов");
    const summary=document.createElement("span"),controls=document.createElement("div"),previous=document.createElement("button"),indicator=document.createElement("span"),next=document.createElement("button");
    summary.className="pager-summary";controls.className="pager-controls";indicator.className="pager-page";indicator.setAttribute("aria-live","polite");
    previous.type=next.type="button";previous.className=next.className="pager-arrow";
    const icon=pathData=>{const svg=document.createElementNS("http://www.w3.org/2000/svg","svg"),path=document.createElementNS("http://www.w3.org/2000/svg","path");svg.setAttribute("viewBox","0 0 24 24");svg.setAttribute("aria-hidden","true");svg.setAttribute("focusable","false");path.setAttribute("d",pathData);svg.append(path);return svg;};
    previous.append(icon("M15 18 9 12 15 6"));next.append(icon("M9 18 15 12 9 6"));previous.setAttribute("aria-label","Предыдущая страница");next.setAttribute("aria-label","Следующая страница");
    previous.onclick=()=>{if(kind==="plans"){planPage--;renderPlanList();}else{recentPage--;renderRecentList();}};
    next.onclick=()=>{if(kind==="plans"){planPage++;renderPlanList();}else{recentPage++;renderRecentList();}};
    controls.append(previous,indicator,next);pager.append(summary,controls);list.after(pager);
  }
  pager.querySelector(".pager-summary").textContent=(page*pageSize+1)+"–"+Math.min((page+1)*pageSize,items.length)+" из "+items.length;
  pager.querySelector(".pager-page").textContent=(page+1)+" / "+(lastPage+1);
  const arrows=pager.querySelectorAll("button");arrows[0].disabled=page===0;arrows[1].disabled=page===lastPage;
}
function renderPlanList(){
  const visible=periodPlans===null?plans:plans.filter(plan=>periodPlans.has(plan.planId)||(includeRunningNow&&plan.status==="RUNNING"));
  renderPagedList(q("#plans"),visible,PLAN_PAGE_SIZE,planPage,"plans",plans.length?"За выбранный период планов нет.":"Планов пока нет.");
}
function renderRecentList(){
  const otherPlans=plans.filter(plan=>plan.status!=="RUNNING");
  renderPagedList(q("#recent"),otherPlans,RECENT_PAGE_SIZE,recentPage,"recent",plans.length?"Остальные планы появятся здесь.":"Планов пока нет.");
}
window.addEventListener("plan-time-tracker:period-plans",event=>{
  periodPlans=new Map(event.detail.rows.map(plan=>[plan.planId,plan]));
  includeRunningNow=event.detail.includeRunningNow;
  if(event.detail.resetPage)planPage=0;
  q("#plans").dataset.filtered="true";
  renderPlanList();
});
function render(){
  renderPlanList();renderRecentList();renderActive();
  q("#plans").dataset.loaded="true";window.dispatchEvent(new Event("plan-time-tracker:plans-rendered"));
  if(q("#count"))q("#count").textContent=String(plans.filter(p=>p.status==="COMPLETED"&&p.finishedAt>Date.now()-30*86400000).length);
  if(q("#today"))q("#today").textContent=duration(todayActiveMs);
}
`;
