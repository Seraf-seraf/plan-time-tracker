export const UI_REFRESH = String.raw`
async function refresh(){
  const requestId=++refreshRequestId;
  const [first,who,settings]=await Promise.all([
    call("/api/plans?limit=100&view=cards"),call("/api/whoami"),call("/api/settings")
  ]);
  const collected=[...first.plans];
  let cursor=first.nextCursor, asOf=first.serverNow;
  while(cursor && requestId===refreshRequestId){
    const query=new URLSearchParams({limit:"100",view:"cards",cursor});
    const page=await call("/api/plans?"+query);
    collected.push(...page.plans);
    cursor=page.nextCursor;
    asOf=Math.max(asOf,page.serverNow);
  }
  if(requestId!==refreshRequestId)return;
  zone=normalizeZone(settings.timezone);
  const today=dateLocal(asOf);
  plans=collected;
  activePlans=plans.filter(plan=>plan.status==="RUNNING");
  function syncClocks(now){
    for(const plan of activePlans){
      plan.activeMs+=Math.max(0,now-plan.serverNow);
      plan.serverNow=Math.max(plan.serverNow,now);
    }
    serverNow=now;
    receivedAt=Date.now();
  }
  syncClocks(asOf);
  todayDate=today;
  todayActiveMs=null;
  q("#who").textContent=who.email||"Личный аккаунт";
  q("#tz").value=zone;
  render();
  try{
    const daily=await call("/api/analytics?"+new URLSearchParams({from:today,to:today,timeZone:zone}));
    if(requestId!==refreshRequestId)return;
    syncClocks(daily.serverNow);
    todayActiveMs=daily.totalActiveMs;
    if(q("#today"))q("#today").textContent=duration(todayActiveMs);
    for(const plan of activePlans){
      const clock=q('[data-clock-plan="'+plan.planId+'"]');
      if(clock)clock.textContent=duration(plan.activeMs);
    }
  }catch(error){
    if(requestId!==refreshRequestId)return;
    showToast("Не удалось загрузить время за сегодня. "+error.message,true);
  }
  if(!q("#view-deleted").classList.contains("hidden"))await loadDeleted();
}
`;
