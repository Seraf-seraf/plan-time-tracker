export const UI_ANALYTICS = String.raw`
function stageDuration(ms){
 if(ms===null)return "Нет данных";
 const minutes=Math.floor(ms/60000),seconds=Math.floor(ms%60000/1000),millis=ms%1000;
 return minutes+" мин"+(seconds?" "+seconds+" с":"")+(millis?" "+millis+" мс":"");
}
function renderStageChart(body,data){
 const make=(tag,text,cls)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e;};
 if(!Array.isArray(data.steps)||!data.steps.every(s=>typeof s.title==="string"&&(s.activeMs===null||Number.isSafeInteger(s.activeMs)&&s.activeMs>=0)))throw new Error("Не удалось прочитать время этапов.");
 body.replaceChildren(make("h3","Записанное время этапов"));
 body.append(make("p","С "+data.period.from+" по "+data.period.to+" включительно, "+data.period.timeZone+".","stage-chart-note"));
 if(!data.steps.length){body.append(make("p","На момент отчёта в плане нет этапов.","stage-chart-note"));return;}
 const max=Math.max(60000,...data.steps.map(s=>s.activeMs||0)),axisRow=make("div",null,"stage-axis-row"),axis=make("div",null,"stage-axis");
 for(const value of [0,max/2,max])axis.append(make("span",new Intl.NumberFormat("ru-RU",{maximumFractionDigits:2}).format(value/60000)));
 const unit=make("span","Минуты","stage-axis-unit");axisRow.setAttribute("aria-hidden","true");axisRow.append(axis,unit);body.append(axisRow);
 const rows=make("ol",null,"stage-rows");rows.setAttribute("aria-label","Длительность выполнения этапов");
 for(const step of data.steps){
   const row=make("li",null,"stage-row"),title=make("span",step.title,"stage-title"),value=make("span",stageDuration(step.activeMs),"stage-value");
   const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");svg.setAttribute("viewBox","0 0 1000 24");svg.setAttribute("preserveAspectRatio","none");svg.setAttribute("aria-hidden","true");svg.classList.add("stage-bar");
   for(const x of [0,500,1000]){const line=document.createElementNS(svg.namespaceURI,"line");line.setAttribute("x1",x);line.setAttribute("x2",x);line.setAttribute("y1",0);line.setAttribute("y2",24);svg.append(line);}
   if(step.activeMs>0){const rect=document.createElementNS(svg.namespaceURI,"rect");rect.setAttribute("width",1000*step.activeMs/max);rect.setAttribute("height",14);rect.setAttribute("y",5);rect.setAttribute("rx",2);svg.append(rect);}
   row.append(title,svg,value);rows.append(row);
 }
 body.append(rows,make("p","Учитывается время со статусом «Выполняется», за вычетом пауз плана. Параллельные этапы измеряются независимо: их сумма может превышать время плана. Старое время без измерений не восстанавливается; «Нет данных» отличается от измеренных 0 минут.","stage-chart-note"));
}
function renderAnalyticsPlanCards(list,report){
 const make=(tag,text,cls)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e;};
 for(const plan of report.plans){
   const card=make("details",null,"analytics-plan"),summary=make("summary",null,"row"),title=make("span",plan.title,"row-title"),value=make("span",duration(plan.activeInPeriodMs),"analytics-plan-meta"),body=make("div",null,"stage-chart-body");
   card.dataset.planId=plan.planId;summary.append(title,value);card.append(summary,body);list.append(card);
   let pending=false,loaded=false;
   async function load(){
     if(pending||loaded||!card.isConnected)return;pending=true;body.setAttribute("aria-busy","true");body.replaceChildren(make("p","Загружаем время этапов…","stage-chart-note"));
     try{
       const query=new URLSearchParams({from:report.period.from,to:report.period.to,timeZone:report.period.timeZone,asOf:String(report.asOf)});
       const data=await call("/api/analytics/plans/"+encodeURIComponent(plan.planId)+"/steps?"+query);
       if(!card.isConnected)return;if(data.planId!==plan.planId)throw new Error("Ответ относится к другому плану.");renderStageChart(body,data);loaded=true;
     }catch(error){
       if(!card.isConnected)return;const message=make("p","Не удалось загрузить график. "+error.message,"error"),retry=make("button","Повторить загрузку");message.setAttribute("role","alert");retry.type="button";retry.addEventListener("click",load);body.replaceChildren(message,retry);
     }finally{pending=false;body.removeAttribute("aria-busy");}
   }
   card.addEventListener("toggle",()=>{if(card.open)load();});
 }
}
`;
