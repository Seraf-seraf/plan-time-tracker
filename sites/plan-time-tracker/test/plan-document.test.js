import test from "node:test";
import assert from "node:assert/strict";
import {
  context,
  ok,
  call,
  command,
  mcp,
  PLAN,
  migrations,
  running,
  result,
  rows,
} from "./fixtures/tracker-db.mjs";
export const planText =
  "# Исправить чтение плана\r\n\r\n## Контекст\r\nПлан сохраняется **как есть**.\r\n\r\n## Карта этапов\r\n| Этап | Цель |\r\n| --- | --- |\r\n| 1 | Проверить |\r\n\r\n## Этап 1. Проверить текст\r\n\r\n### Начало\r\nЕсть исходный план.\r\n\r\n### Действия\r\n- Сохранить все разделы.\r\n- Проверить `npm test`.\r\n\r\n```md\r\n## Этап 99. Это пример кода\r\n```\r\n\r\n## Этап 2. Проверить статусы\r\n\r\n**Конец:** статусы видны после обновления.\r\n\r\n## Общая приёмка\r\nТекст совпадает с исходным.\r\n";
const create = (c) =>
  ok(c, "CreatePlan", {
    planId: PLAN,
    title: "Чтение плана",
    planText,
    planCreatedAt: {
      precision: "dateOnly",
      on: "2026-11-11",
      timeZone: "Asia/Omsk",
    },
  });
const progress = async (c) =>
  (await call(c, "/api/tracker/plans/" + PLAN + "/execution")).value;
test("full Markdown survives creation, reading and export; only executable headings become steps", async () => {
  const c = context();
  try {
    await create(c);
    const p = (await call(c, "/api/plans/" + PLAN)).value.plan;
    assert.equal(p.planText, planText);
    const s = await progress(c);
    assert.equal(s.steps.length, 2);
    assert.equal(
      s.steps[0].content,
      planText.slice(
        planText.indexOf("## Этап 1."),
        planText.indexOf("## Этап 2."),
      ),
    );
    assert.equal(
      s.steps[1].content,
      planText.slice(
        planText.indexOf("## Этап 2."),
        planText.indexOf("## Общая приёмка"),
      ),
    );
    assert.equal(s.steps[0].status, "PENDING");
    assert.equal(
      c.db.sqlite.prepare("SELECT COUNT(*) n FROM work_intervals").get().n,
      0,
    );
    const report = (await call(c, "/api/export")).value;
    assert.equal(report.plans[0].planText, planText);
    assert.equal(report.plans[0].steps[0].content, s.steps[0].content);
  } finally {
    c.close();
  }
});
test("agent sets statuses without technical evidence; completion and exact replay use the same contract", async () => {
  const c = context();
  try {
    await create(c);
    const steps = (await progress(c)).steps;
    await ok(c, "StartPlan", { planId: PLAN }, 0);
    const id = crypto.randomUUID();
    const first = await command(
      c,
      "SetStepStatus",
      { stepId: steps[0].step_id, status: "RUNNING" },
      1,
      id,
    );
    assert.equal(first.status, 200);
    const replay = await command(
      c,
      "SetStepStatus",
      { stepId: steps[0].step_id, status: "RUNNING" },
      1,
      id,
    );
    assert.equal(replay.value.replayed, true);
    assert.equal(
      (
        await command(
          c,
          "SetStepStatus",
          { stepId: steps[0].step_id, status: "DONE" },
          1,
        )
      ).value.error.code,
      "VERSION_CONFLICT",
    );
    await ok(
      c,
      "SetStepStatus",
      { stepId: steps[0].step_id, status: "DONE" },
      2,
    );
    assert.equal((await progress(c)).steps[0].readyToFinish, true);
    assert.equal(
      (await command(c, "FinishPlan", { planId: PLAN }, 1)).value.error.code,
      "CHECKPOINTS_INCOMPLETE",
    );
    const response = await mcp(c, "SetStepStatus", {
      schemaVersion: 1,
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      payload: { stepId: steps[1].step_id, status: "DONE" },
    });
    assert.equal(
      response.value.result.isError,
      undefined,
      JSON.stringify(response),
    );
    await ok(c, "FinishPlan", { planId: PLAN }, 1);
    assert.equal(
      c.db.sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='step_attempts'").get().n,
      0,
    );
    assert.equal(
      c.db.sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='step_results'").get().n,
      0,
    );
    assert.equal(
      c.db.sqlite
        .prepare(
          "SELECT COUNT(*) n FROM command_receipts WHERE command_type='SetStepStatus' AND outcome_code='OK'",
        )
        .get().n,
      3,
    );
  } finally {
    c.close();
  }
});
test("status writes enforce owner, current version, active plan and deletion for every stored step", async () => {
  const c = context();
  try {
    await create(c);
    const step = (await progress(c)).steps[0];
    assert.equal(
      (
        await command(
          c,
          "SetStepStatus",
          { stepId: step.step_id, status: "RUNNING" },
          1,
        )
      ).value.error.code,
      "INVALID_TRANSITION",
    );
    await ok(c, "StartPlan", { planId: PLAN }, 0);
    assert.equal(
      (
        await command(
          c,
          "SetStepStatus",
          { stepId: step.step_id, status: "DONE" },
          1,
          undefined,
          "another-owner",
        )
      ).value.error.code,
      "STEP_NOT_FOUND",
    );
    await ok(c, "PausePlan", { planId: PLAN }, 1);
    assert.equal(
      (
        await command(
          c,
          "SetStepStatus",
          { stepId: step.step_id, status: "DONE" },
          1,
        )
      ).value.error.code,
      "PLAN_PAUSED",
    );
    await ok(c, "DeletePlan", { planId: PLAN }, 2);
    assert.equal(
      (
        await command(
          c,
          "SetStepStatus",
          { stepId: step.step_id, status: "DONE" },
          1,
        )
      ).value.error.code,
      "PLAN_DELETED",
    );
    await ok(c, "RestorePlan", { planId: PLAN }, 3);
    assert.equal((await progress(c)).steps[0].status, "PENDING");
    const lease = await running(c, [], crypto.randomUUID());
    assert.equal(
      (
        await command(
          c,
          "SetStepStatus",
          { stepId: lease.stepId, status: "DONE" },
          2,
        )
      ).status,
      200,
    );
  } finally {
    c.close();
  }
});
test("document import is atomic and rejects missing, ambiguous or duplicate stages without rewriting prose", async () => {
  const c = context();
  try {
    for (const text of [
      "# Нет этапов",
      "## Этап 1. Один\nТекст\n## Этап 1. Повтор\nТекст",
      "## Этап 1. Один\n### Этап 2. Вложенный\nТекст",
    ]) {
      const response = await command(c, "CreatePlan", {
        title: "План",
        planText: text,
        planCreatedAt: {
          precision: "dateOnly",
          on: "2026-11-11",
          timeZone: "UTC",
        },
      });
      assert.equal(response.value.error.code, "VALIDATION_ERROR");
    }
    assert.equal(
      c.db.sqlite.prepare("SELECT COUNT(*) n FROM plans").get().n,
      0,
    );
    await create(c);
    assert.equal(
      (
        await command(c, "CreateStep", {
          planId: PLAN,
          ordinal: 9,
          title: "Лишний",
          expectedResult: "Лишний",
          requiredChecks: [],
        })
      ).value.error.code,
      "VALIDATION_ERROR",
    );
    const tools = (
      await call(c, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })
    ).value.result.tools;
    assert(
      tools.find((x) => x.name === "CreatePlan").inputSchema.properties.payload
        .properties.planText,
    );
    assert(tools.find((x) => x.name === "SetStepStatus"));
  } finally {
    c.close();
  }
});

test("failed document import rolls back the source, stages and receipt as one operation", async () => {
  const c = context();
  try {
    c.db.sqlite.exec(
      "CREATE TRIGGER fail_document_fixture BEFORE INSERT ON plan_steps BEGIN SELECT RAISE(ABORT,'fixture failure'); END;",
    );
    const response = await command(c, "CreatePlan", {
      title: "Atomic import",
      planText,
      planCreatedAt: {
        precision: "dateOnly",
        on: "2026-11-11",
        timeZone: "UTC",
      },
    });
    assert.equal(response.status, 500);
    for (const table of [
      "plans",
      "plan_steps",
      "plan_documents",
      "command_receipts",
      "assessment_targets",
    ])
      assert.equal(
        c.db.sqlite.prepare("SELECT COUNT(*) n FROM " + table).get().n,
        0,
        table,
      );
  } finally {
    c.close();
  }
});

test("stable stage IDs and fenced examples retain their source and assessment meaning", async () => {
  const c = context();
  try {
    const text =
      "## Контекст\nНе пересказывать.\n\n## Этап DATA-001. Данные\n\nОписание данных.\n\n## UI-002. Экран\n\nОписание экрана.\n";
    await ok(c, "CreatePlan", {
      planId: PLAN,
      title: "IDs",
      planText: text,
      planCreatedAt: {
        precision: "dateOnly",
        on: "2026-11-11",
        timeZone: "UTC",
      },
    });
    const snapshot = await progress(c);
    assert.deepEqual(
      snapshot.steps.map((s) => s.title),
      ["Этап DATA-001. Данные", "UI-002. Экран"],
    );
    const requirements = JSON.parse(
      c.db.sqlite
        .prepare(
          "SELECT requirements_json FROM assessment_targets WHERE step_id IS NULL",
        )
        .get().requirements_json,
    );
    assert.equal(requirements.plan.planText, text);
    assert.equal(requirements.steps[0].content, snapshot.steps[0].content);
  } finally {
    c.close();
  }
});
