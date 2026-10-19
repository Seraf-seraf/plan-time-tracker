import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
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


test("metadata command retries replace an envelope only after proven validation rejection", async () => {
  const { scripts } = await clientScripts();
  const main = scripts[0];
  assert(main.includes("e.status=r.status"));
  assert(main.includes('e.code==="VALIDATION_ERROR"'));
  assert(!main.includes('e.status===422&&e.code==="VALIDATION_ERROR"'));
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


test("checkpoint disclosures and consecutive forms retain 10px gaps", async () => {
  const { html } = await clientScripts();
  assert(html.includes(".tracker-card-body>details[open]{display:grid;gap:10px}"));
  assert(html.includes(".tracker-card-body>.tracker-form+.tracker-form{margin-top:10px}"));
  assert(html.includes(".tracker-card-body>.tracker-actions{margin-top:10px}"));
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
  assert(scripts[0].includes('new CustomEvent("plan-time-tracker:plan-rendered",{detail:{planId,successMessage}})'));
  assert(scripts[1].includes("let detailEnhancementToken=0"));
  assert(scripts[1].includes('window.addEventListener("plan-time-tracker:plan-rendered"'));
  assert(scripts[1].includes("token!==detailEnhancementToken||detail.dataset.planId!==id"));
});

test("tracker releases only allowlisted matching final domain rejections after the next explicit submit", async () => {
  const { scripts } = await clientScripts();
  const tracker = scripts[2];
  assert(tracker.includes('new Set(["RESULT_REVISION_STALE","LEASE_EXPIRED","STEP_NOT_STARTED","STEP_ALREADY_EXISTS","REWORK_REQUIRED","ATTEMPT_CLOSED","LEASE_FENCED","ACTIVE_ATTEMPT_EXISTS"])'));
  assert(tracker.includes('if(error.status!==409||!terminalDomainRejections.has(error.code))return false'));
  assert(tracker.includes('receipt.status==="FINAL"&&receipt.commandId===envelope.commandId&&receipt.commandType===envelope.commandType&&receipt.error?.code===error.code&&!receipt.result'));
  assert(tracker.includes('else if(await hasMatchingFinalDomainRejection(envelope,error))terminalRejectedCommands.add(key)'));
  assert(tracker.includes('if(envelope&&terminalRejectedCommands.has(key)){envelope=null;pendingCommands.delete(key);terminalRejectedCommands.delete(key)}'));
  assert(tracker.includes('error.code="COMMAND_OUTCOME_UNKNOWN"'));
});

test("export link has the requested label and UTC storage copy remains unchanged", async () => {
  const { html } = await clientScripts();
  assert(html.includes('<a href="/api/export">Скачать JSON отчет</a>'));
  assert(html.includes("Все отметки времени хранятся в UTC."));
  assert(!html.includes("Скачать личный экспорт JSON"));
});


for (const client of ["main", "tracker"]) {
  test(`${client} command preserves exact replay after malformed or unconfirmed HTTP 200 responses`, async () => {
    const { scripts } = await clientScripts();
    const source = client === "main" ? scripts[0] : scripts[2];
    const start = source.indexOf(client === "main" ? "async function call(" : "async function api(");
    const end = source.indexOf(client === "main" ? "function btn(" : "function inputField(", start);
    assert(start >= 0 && end > start, "extract the actual delivered command client");
    const invalidResponses = [
      () => "{malformed",
      () => "null",
      () => "{}",
      (accepted) => JSON.stringify({ ...accepted, result: null }),
      (accepted) => JSON.stringify({ ...accepted, result: [] }),
      (accepted) => JSON.stringify({ ...accepted, commandId: "another-command" }),
      (accepted) => JSON.stringify({ ...accepted, outcome: "ERROR" }),
      (accepted) => JSON.stringify({ ...accepted, applied: undefined }),
      (accepted) => JSON.stringify({ ...accepted, replayed: true }),
      (accepted) => JSON.stringify({ ...accepted, error: { code: "INTERNAL_ERROR" } }),
    ];
    for (const invalidResponse of invalidResponses) {
      let nextId = 0;
      const posts = [];
      const sandbox = {
        pending: new Map(), rejectedValidation: new Set(), rejectedVersion: new Map(),
        uid: () => `main-${++nextId}`, uuid: () => `tracker-${++nextId}`,
        showToast() {}, refresh: async () => {}, root: { dataset: { planId: "fixture-plan" } },
        window: { addEventListener() {} },
        fetch: async (_path, options) => {
          const sent = JSON.parse(options.body);
          posts.push(sent);
          const accepted = { commandId: sent.commandId, outcome: "OK", applied: true, replayed: false, result: { applied: true } };
          return new Response(posts.length === 1 ? invalidResponse(accepted) : JSON.stringify(accepted), { status: 200 });
        },
      };
      runInNewContext(source.slice(start, end) + ";globalThis.invoke=command;", sandbox);
      const payload = client === "main" ? { title: "A single plan" } : { stepId: "fixture-step", summary: "A single result" };
      const invoke = (body) => client === "main" ? sandbox.invoke("CreatePlan", null, body) : sandbox.invoke("RecordStepResult", body, 1);
      await assert.rejects(() => invoke(payload), (error) => error.code === "COMMAND_OUTCOME_UNKNOWN");
      await assert.rejects(() => invoke({ ...payload, summary: "Edited while unknown" }), (error) => error.code === "COMMAND_OUTCOME_UNKNOWN");
      assert.equal(posts.length, 1, "edited payload must not produce a new POST");
      await invoke(payload);
      assert.equal(posts.length, 2);
      assert.deepEqual(posts[1], posts[0], "explicit retry must send the exact original ID, version, and payload");
      assert.equal(nextId, 1, "ambiguous acceptance must not allocate a second idempotency ID");
    }
  });
}

for (const [client, type, code] of [
  ["tracker", "CreateStep", "STEP_ALREADY_EXISTS"],
  ["tracker", "RecordStepResult", "LEASE_EXPIRED"],
  ["tracker", "RecordCheck", "RESULT_REVISION_STALE"],
  ["tracker", "ClaimStepAttempt", "REWORK_REQUIRED"],
  ["main", "FinishPlan", "CHECKPOINTS_INCOMPLETE"],
  ["main", "DeletePlan", "PLAN_DELETED"],
  ["main", "RestorePlan", "PLAN_NOT_DELETED"],
]) {
  test(`${client} ${type} unlocks only the matching FINAL refusal and preserves every ambiguous receipt`, async () => {
    const { scripts } = await clientScripts();
    const source = scripts[client === "main" ? 0 : 2];
    const start = source.indexOf(client === "main" ? "async function call(" : "async function api("), end = source.indexOf(client === "main" ? "function btn(" : "function inputField(", start);
    for (const mode of ["matching", "pending", "not-found", "wrong-id", "wrong-type", "wrong-code", "final-success", "infrastructure", "malformed", "read-network", "http-500", "network-post", "wrong-status-422"]) {
      let nextId = 0;
      const posts = [];
      const sandbox = {
        pending: new Map(), rejectedValidation: new Set(), rejectedVersion: new Map(),
        uid: () => `main-${++nextId}`, uuid: () => `tracker-${++nextId}`,
        showToast() {}, refresh: async () => {}, root: { dataset: { planId: "fixture-plan" } }, window: { addEventListener() {} },
        fetch: async (_path, options) => {
          if (options.method === "POST") {
            const sent = JSON.parse(options.body);
            posts.push(sent);
            if (posts.length === 1) {
              if (mode === "network-post") throw new TypeError("Synthetic lost response");
              return new Response(JSON.stringify({ error: { code, message: "Synthetic refusal" } }), { status: mode === "http-500" ? 500 : mode === "wrong-status-422" ? 422 : 409 });
            }
            return new Response(JSON.stringify({ commandId: sent.commandId, outcome: "OK", applied: false, replayed: true, result: { accepted: true } }));
          }
          if (mode === "read-network") throw new TypeError("Synthetic receipt read failure");
          if (mode === "malformed") return new Response("{malformed");
          const receipt = { status: "FINAL", commandId: posts[0].commandId, commandType: type, error: { code } };
          if (mode === "pending") receipt.status = "PENDING";
          if (mode === "not-found") receipt.status = "NOT_FOUND";
          if (mode === "wrong-id") receipt.commandId = "another-command";
          if (mode === "wrong-type") receipt.commandType = "AnotherCommand";
          if (mode === "wrong-code") receipt.error.code = "LEASE_CONFLICT";
          if (mode === "infrastructure") receipt.error.code = "INTERNAL_ERROR";
          if (mode === "final-success") { delete receipt.error; receipt.result = { accepted: true }; }
          return new Response(JSON.stringify(receipt));
        },
      };
      runInNewContext(source.slice(start, end) + ";globalThis.invoke=command;", sandbox);
      const payload = client === "main" ? { reason: "Original intent" } : { stepId: "fixture-step", planId: "fixture-plan", reason: "Original intent" };
      const invoke = (body) => client === "main" ? sandbox.invoke(type, { planId: "fixture-plan", version: 1 }, body) : sandbox.invoke(type, body, 1);
      await assert.rejects(() => invoke(payload));
      assert.equal(posts.length, 1, "receipt lookup cannot automatically resend a command");
      if (mode !== "matching") {
        await assert.rejects(() => invoke({ ...payload, reason: "Edited intent" }), (error) => error.code === "COMMAND_OUTCOME_UNKNOWN", mode);
        assert.equal(posts.length, 1, "ambiguous receipt must not permit an edited POST");
      }
      await invoke(payload);
      assert.equal(posts.length, 2);
      if (mode === "matching") assert.notEqual(posts[1].commandId, posts[0].commandId, "explicit new attempt follows a proven FINAL rejection");
      else assert.deepEqual(posts[1], posts[0], "unknown outcome requires exact ID/version/payload replay");
    }
  });
}

test("accepted tracker plan refresh keeps navigation identity and never sends another command", async () => {
  const { scripts } = await clientScripts();
  const source = scripts[0], start = source.indexOf('window.addEventListener("plan-time-tracker:refresh-plan"'), end = source.indexOf("function btn(", start);
  assert(start >= 0 && end > start);
  for (const mode of ["same-detail", "other-detail", "plans-list", "refresh-failure"]) {
    let listener, release, refreshCount = 0;
    const opened = [], root = { dataset: { planId: "A" } }, view = { classList: { contains: () => mode === "plans-list" } };
    const sandbox = {
      detailRequestId: 1,
      q: (selector) => selector === "#view-detail" ? view : root,
      window: { addEventListener(_name, callback) { listener = callback; } },
      refresh: async () => { refreshCount++; if (mode === "refresh-failure") throw new Error("Synthetic GET failure"); await new Promise((resolve) => { release = resolve; }); },
      openPlan: async (...args) => opened.push(args),
      fetch: () => assert.fail("accepted refresh must not POST another command"),
    };
    runInNewContext(source.slice(start, end), sandbox);
    const finished = new Promise((resolve, reject) => listener({ detail: { planId: "A", successMessage: "Accepted", resolve, reject } }));
    if (mode === "refresh-failure") await assert.rejects(finished, /Synthetic GET failure/);
    else {
      if (mode !== "same-detail") sandbox.detailRequestId++;
      if (mode === "other-detail") root.dataset.planId = "B";
      release(); await finished;
      assert.deepEqual(opened, mode === "same-detail" ? [["A", "Accepted"]] : []);
    }
    assert.equal(refreshCount, 1);
  }
});

test("checkpoint UI exposes only authoritative readiness, no owner-decision commands or forms", async () => {
  const { scripts } = await clientScripts();
  const tracker = scripts[2];
  for (const obsolete of ["AcceptStep", "RejectStep", "acceptanceCurrent", "currentAcceptance", "Waivers JSON", "waivers"])
    assert(!tracker.includes(obsolete), obsolete);
  assert(tracker.includes('steps.filter((step)=>!step.readyToFinish)'));
  assert(tracker.includes('check.status==="PASSED"&&check.matchesCurrentResult'));
  assert(tracker.includes('const currentChecks=step.currentChecks||[]'));
  assert(tracker.includes('toggle.type="button"'));
  assert(scripts[0].includes('new CustomEvent("plan-time-tracker:plan-will-render")'));
  assert(scripts[0].includes('edit.dataset.trackerForm="plan-metadata"'));
  assert(scripts[0].includes('confirm.dataset.draftField="confirmDateAnomaly"'));
  assert(scripts[0].includes('plan-time-tracker:draft-cleared'));
  assert(tracker.includes('toggle.setAttribute("aria-controls",body.id)'));
});

test("delivered draft-state helpers preserve plan/form identities and isolate result revisions", async () => {
  const { scripts } = await clientScripts(), source = scripts[2];
  const start = source.indexOf("  const viewState=new Map();"), end = source.indexOf("  function setMessage", start);
  assert(start >= 0 && end > start);
  const field = (key, value, checked = false, type = "text", dirty = true) => ({ dataset: { draftField: key, draftDirty: dirty ? 'true' : undefined }, value, checked, type, dispatchEvent() {}, getAttribute() { return null; } });
  const form = (key, controls) => ({ dataset: { trackerForm: key }, querySelectorAll() { return controls; } });
  let currentForms = [], listeners = new Map();
  const root = { dataset: { planId: "A" }, addEventListener(type, listener) { listeners.set(type, listener); }, querySelectorAll(selector) { return selector.startsWith("details") ? [] : currentForms; } };
  const sandbox = { root, Event: class Event {}, window: { addEventListener() {} } };
  runInNewContext(source.slice(start, end) + ";globalThis.capture=captureDrafts;globalThis.restore=restoreDrafts;", sandbox);
  currentForms = [form("result:step-A", [field("summary", "Unsubmitted A result")]), form("check:step-A:1:unit", [field("evidence", "Revision 1 evidence")]), form("plan-metadata", [field("title", "Draft A metadata"), field("confirm", "on", true, "checkbox")])];
  sandbox.capture(root);
  // Full tracker and outer-detail replacement use fresh controls; draft keys ignore random IDs.
  currentForms = [form("result:step-A", [field("summary", "")]), form("check:step-A:1:unit", [field("evidence", "")]), form("plan-metadata", [field("title", "Server title"), field("confirm", "on", false, "checkbox")])];
  sandbox.restore(root);
  assert.equal(currentForms[0].querySelectorAll()[0].value, "Unsubmitted A result");
  assert.equal(currentForms[1].querySelectorAll()[0].value, "Revision 1 evidence");
  assert.equal(currentForms[2].querySelectorAll()[0].value, "Draft A metadata");
  assert.equal(currentForms[2].querySelectorAll()[1].checked, true);
  currentForms = [form("edit:step-B", [field("title", "Old untouched title", false, "text", false), field("reason", "Owner-edited reason"), field("optional", "")])];
  sandbox.capture(root);
  currentForms = [form("edit:step-B", [field("title", "Concurrent new server title", false, "text", false), field("reason", "", false, "text", false), field("optional", "Server default", false, "text", false)])];
  sandbox.restore(root);
  assert.equal(currentForms[0].querySelectorAll()[0].value, "Concurrent new server title", "untouched fields adopt fresh server defaults");
  assert.equal(currentForms[0].querySelectorAll()[1].value, "Owner-edited reason", "only the dirty user field is restored");
  assert.equal(currentForms[0].querySelectorAll()[2].value, "", "intentional empty edits are real drafts");
  currentForms = [form("check:step-A:2:unit", [field("evidence", "New revision default")])];
  sandbox.restore(root);
  assert.equal(currentForms[0].querySelectorAll()[0].value, "New revision default", "stale check drafts never attach to a new result revision");
  root.dataset.planId = "B";
  currentForms = [form("result:step-A", [field("summary", "B server default")])];
  sandbox.restore(root);
  assert.equal(currentForms[0].querySelectorAll()[0].value, "B server default", "same step/form key on another plan cannot restore plan A draft");
});

test("unknown tracker outcome replays original version across newer or older rerendered forms", async () => {
  const { scripts } = await clientScripts(), source = scripts[2];
  const start = source.indexOf("async function api("), end = source.indexOf("function inputField(", start);
  for (const callerVersion of [0, 1, 2, 7]) {
    const posts = []; let nextId = 0;
    const sandbox = { root: { dataset: { planId: "fixture-plan" } }, uuid: () => `retry-${++nextId}`, window: { addEventListener() {} }, fetch: async (_path, options) => {
      const sent = JSON.parse(options.body); posts.push(sent);
      if (posts.length === 1) throw new TypeError("Synthetic response loss after POST");
      return new Response(JSON.stringify({ commandId: sent.commandId, outcome: "OK", applied: posts.length !== 2, replayed: posts.length === 2, result: { restored: true } }));
    } };
    runInNewContext(source.slice(start, end) + ";globalThis.invoke=command;", sandbox);
    const payload = { stepId: "step-A", attemptId: "attempt-A", fence: 1, outcome: "DONE", summary: "Preserved unknown result" };
    await assert.rejects(() => sandbox.invoke("RecordStepResult", payload, 1), /response loss/);
    await assert.rejects(() => sandbox.invoke("RecordStepResult", { ...payload, summary: "Changed while unknown" }, callerVersion), error => error.code === "COMMAND_OUTCOME_UNKNOWN");
    assert.equal(posts.length, 1, "changed draft cannot send a POST or replace pending state");
    await sandbox.invoke("RecordStepResult", payload, callerVersion);
    assert.deepEqual(posts[1], posts[0], "same payload uses the original immutable ID/version despite refreshed caller version");
    assert.equal(posts[1].expectedVersion, 1);
    assert.equal(nextId, 1);
    const freshVersion = Math.max(2, callerVersion);
    await sandbox.invoke("RecordStepResult", { ...payload, summary: "Fresh user intent after definitive success" }, freshVersion);
    assert.equal(posts[2].expectedVersion, freshVersion, "successful replay clears only that pending intent; next command uses fresh caller version");
    assert.notEqual(posts[2].commandId, posts[0].commandId);
    assert.equal(nextId, 2);
  }
});

test("accepted draft cleanup follows mounted identity and preserves newer field generations", async () => {
  const { scripts } = await clientScripts(), source = scripts[2];
  const start = source.indexOf("  const viewState=new Map();"), end = source.indexOf("  function setMessage", start);
  let forms = []; const listeners = new Map();
  const root = { dataset: { planId: "A" }, addEventListener(type, callback) { listeners.set(type, callback); }, querySelectorAll(selector) { return selector.startsWith("details") ? [] : forms; } };
  const sandbox = { root, Event: class Event {}, window: { addEventListener() {} } };
  runInNewContext(source.slice(start, end) + ";globalThis.snapshot=snapshotDraft;globalThis.clear=clearDraft;globalThis.restore=restoreDrafts;globalThis.capture=captureDrafts;", sandbox);
  const form = (title = "", reason = "") => {
    const node = { dataset: { trackerForm: "create-step" }, querySelectorAll() { return [node.title, node.reason]; } };
    for (const [key, value] of [["title", title], ["reason", reason]]) node[key] = { dataset: { draftField: key }, value, checked: false, type: "text", getAttribute() { return null; }, dispatchEvent() {}, matches() { return true; }, closest() { return node; } };
    return node;
  };
  const edit = (control, value) => { control.value = value; listeners.get("input")({ target: control }); };
  forms = [form()]; edit(forms[0].title, "Submitted A"); edit(forms[0].reason, "Submitted reason");
  const submitted = sandbox.snapshot(forms[0], "A");
  // A sibling command replaced the form while A's response was delayed.
  forms = [form()]; sandbox.restore(root); assert.equal(forms[0].title.value, "Submitted A");
  sandbox.clear(submitted); sandbox.capture(root);
  assert.equal(forms[0].dataset.trackerForm, "create-step", "accepted cleanup keeps future edits trackable");
  forms = [form()]; sandbox.restore(root); assert.equal(forms[0].title.value, "", "accepted A cannot resurrect from the replacement node");
  edit(forms[0].title, "New tracked B"); const beforeB = sandbox.snapshot(forms[0], "A");
  edit(forms[0].title, "Newer C while POST pending"); sandbox.clear(beforeB); sandbox.capture(root);
  forms = [form()]; sandbox.restore(root); assert.equal(forms[0].title.value, "Newer C while POST pending", "acknowledgement cannot erase an unsubmitted edit");
  edit(forms[0].reason, "Submitted reason again"); const mixed = sandbox.snapshot(forms[0], "A");
  edit(forms[0].reason, ""); sandbox.clear(mixed); sandbox.capture(root);
  forms = [form("Fresh server title", "Server reason")]; sandbox.restore(root);
  assert.equal(forms[0].title.value, "Fresh server title", "unchanged accepted fields stop being drafts");
  assert.equal(forms[0].reason.value, "", "newer intentional empty field remains a draft");
  edit(forms[0].reason, "A"); const sameValue = sandbox.snapshot(forms[0], "A");
  edit(forms[0].reason, "B"); edit(forms[0].reason, "A"); sandbox.clear(sameValue); sandbox.capture(root);
  forms = [form()]; sandbox.restore(root); assert.equal(forms[0].reason.value, "A");
  assert.equal(forms[0].reason.dataset.draftDirty, "true", "A→B→A is a newer generation even when values match");
  root.dataset.planId = "B"; forms = [form("Other plan draft")]; edit(forms[0].title, "Other plan draft");
  sandbox.clear(sameValue); assert.equal(forms[0].title.dataset.draftDirty, "true", "plan A acknowledgement cannot clear plan B's mounted form");
});
