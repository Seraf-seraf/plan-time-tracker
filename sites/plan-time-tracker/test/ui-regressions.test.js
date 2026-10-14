import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/index.js";

async function clientScripts() {
  const response = await worker.fetch(new Request("https://tracker.test/", {
    headers: { "oai-authenticated-user-id": "ui-regression-owner" },
  }), {});
  const html = await response.text();
  return {
    html,
    scripts: [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, script]) => script),
  };
}

test("plan and commit filters use the important hidden class on flex rows", async () => {
  const { html, scripts } = await clientScripts();
  assert(scripts[1].includes('row.classList.toggle("hidden",!visibleIds.has(row.dataset.planId))'));
  assert(scripts[1].includes('row.classList.add("hidden")'));
  assert(scripts[1].includes('row.classList.toggle("hidden",status!=="all"&&parts[1]!==status)'));
  assert(!scripts[1].includes("row.hidden="));
  assert(html.includes(".hidden{display:none!important}"));
});

test("metadata command retries replace an envelope only after proven validation rejection", async () => {
  const { scripts } = await clientScripts();
  const main = scripts[0];
  assert(main.includes("e.status=r.status"));
  assert(main.includes('e.status===422&&e.code==="VALIDATION_ERROR"'));
  assert(main.includes("rejectedValidation.has(key)&&JSON.stringify(c.payload)!==JSON.stringify(nextPayload)"));
  assert(main.includes('e.code="COMMAND_OUTCOME_UNKNOWN"'));
  assert(main.includes("pending.delete(key);rejectedValidation.delete(key)"));
  assert(main.includes('await command("CreatePlan",null,payload)'));
  assert(scripts[2].includes("const pendingCommands=new Map(),rejectedCommands=new Set()"));
  assert(scripts[2].includes('error.status=response.status'));
});

test("analytics applies one guarded loader for metrics, chart, and list", async () => {
  const { scripts } = await clientScripts();
  const main = scripts[0], enhancements = scripts[1];
  assert(main.includes("const requestId=++analyticsRequestId"));
  assert(main.includes("if(requestId!==analyticsRequestId)return"));
  assert(main.includes('q("#apply").onclick=()=>loadAnalytics()'));
  assert(!enhancements.includes('q("#apply").onclick=async'));
  assert(!enhancements.includes('setTimeout(()=>q("#apply").click(),0)'));
  assert(main.includes('const chart=q("#chart");chart.replaceChildren()'));
});

test("repository conflict controls wrap inside their own settings card", async () => {
  const { html, scripts } = await clientScripts();
  assert(scripts[1].includes('make("div",null,"row commit-conflict-row")'));
  assert(html.includes(".commit-conflict-row{min-width:0;flex-wrap:wrap}"));
  assert(html.includes(".commit-conflict-row>select{flex:1 1 100%;min-width:0;max-width:100%}"));
  assert(scripts[0].includes('commits.className="plan-commit-list"'));
  assert(html.includes("#planDetail .plan-commit-list>.row{min-width:0;flex-wrap:wrap}"));
});

test("checkpoint disclosures and consecutive forms retain 10px gaps", async () => {
  const { html } = await clientScripts();
  assert(html.includes(".tracker-card>details{display:grid;gap:10px}"));
  assert(html.includes(".tracker-card>.tracker-form+.tracker-form{margin-top:10px}"));
  assert(html.includes(".tracker-card>.tracker-actions{margin-top:10px}"));
});

test("long unbroken checkpoint titles wrap without widening the document", async () => {
  const { html } = await clientScripts();
  assert(html.includes(".tracker-card h4{min-width:0;overflow-wrap:anywhere}"));
});

test("NOT_RUN disables the exit code immediately and after status changes", async () => {
  const { scripts } = await clientScripts();
  const tracker = scripts[2];
  assert(tracker.includes('exit.control.disabled=statusSelect.control.value==="NOT_RUN";form.addEventListener'));
  assert(tracker.includes('statusSelect.control.addEventListener("change",()=>{exit.control.disabled=statusSelect.control.value==="NOT_RUN"'));
});

test("new checkpoint ordinal is one greater than the largest occupied ordinal", async () => {
  const { scripts } = await clientScripts();
  assert(scripts[2].includes('value:String(Math.max(0,...steps.map(step=>Number(step.ordinal)||0))+1)'));
  assert(!scripts[2].includes("value:String(steps.length)"));
});

test("Plans period panel has 16px gaps and loads once the primary list is ready", async () => {
  const { html, scripts } = await clientScripts();
  assert(scripts[1].includes('planFilter.panel.classList.add("plan-period-panel")'));
  assert(scripts[1].includes('await loadFilter(planFilter,false)'));
  assert(scripts[1].includes('window.addEventListener("plan-time-tracker:plans-rendered"'));
  assert(html.includes(".plan-period-panel>.metrics{margin-top:16px}"));
  assert(html.includes(".plan-period-panel>#planPeriodPlans{margin-top:16px}"));
});

test("inactive Start and Resume are single-flight and use shared idempotent command state", async () => {
  const { scripts } = await clientScripts();
  const main = scripts[0], enhancements = scripts[1];
  assert(enhancements.includes("if(action.disabled)return;\n          action.disabled=true"));
  assert(enhancements.includes("await executePlanCommand(commandType,p)"));
  assert(main.includes('window.addEventListener("plan-time-tracker:command"'));
  assert(main.includes('e.code="COMMAND_OUTCOME_UNKNOWN"'));
  assert(main.includes('pending.delete(key);rejectedValidation.delete(key)'));
});

test("checkpoint success feedback survives a tracker rerender", async () => {
  const { scripts } = await clientScripts();
  const tracker = scripts[2];
  assert(tracker.includes('pendingSuccessFeedback=prior.textContent'));
  assert(tracker.includes('if(pendingSuccessFeedback){setMessage(message,pendingSuccessFeedback);pendingSuccessFeedback="";}'));
});

test("detail enhancements are reapplied for each plan render and stale responses are ignored", async () => {
  const { scripts } = await clientScripts();
  assert(scripts[0].includes('new CustomEvent("plan-time-tracker:plan-rendered",{detail:{planId}})'));
  assert(scripts[1].includes("let detailEnhancementToken=0"));
  assert(scripts[1].includes('window.addEventListener("plan-time-tracker:plan-rendered"'));
  assert(scripts[1].includes("token!==detailEnhancementToken||detail.dataset.planId!==id"));
});
