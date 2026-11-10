import test from 'node:test';
import assert from 'node:assert/strict';
import { context, call, ok, running, PLAN, OWNER } from './fixtures/tracker-db.mjs';

test('status history pages both sources without preloading events or losing snapshot boundaries', async () => {
  const c = context();
  try {
    await running(c, []);
    for (let i = 0; i < 12; i++) {
      c.advance(1);
      await ok(c, 'UpdatePlanMetadata', {planId: PLAN, description: 'Revision '+i, reason: 'History fixture'}, i+1);
    }
    const queries = [], prepare = c.db.prepare.bind(c.db);
    c.db.prepare = sql => { queries.push(sql); return prepare(sql); };
    const detail = await call(c, '/api/plans/'+PLAN+'?includeEvents=false');
    assert.equal(detail.status, 200);
    assert.equal('events' in detail.value.plan, false);
    assert.equal(queries.some(sql => /FROM plan_events/i.test(sql)), false);
    assert((await call(c, '/api/plans/'+PLAN)).value.plan.events.length > 0, 'existing GetPlan contract stays available');
    const url = '/api/tracker/plans/'+PLAN+'/status-history';
    const first = (await call(c, url+'?limit=8')).value;
    assert.equal(first.events.length, 8);
    assert(first.events.some(e => e.legacy));
    assert(first.events.some(e => !e.legacy));
    assert(first.total > 8);
    c.advance(1);
    await ok(c, 'PausePlan', {planId: PLAN}, 13);
    const ids = first.events.map(e => e.eventId);
    for (let page = 1; page < first.pageCount; page++) {
      const result = await call(c, url+'?'+new URLSearchParams({page,limit:8,throughSequence:first.throughSequence,throughEventRowid:first.throughEventRowid}));
      assert.equal(result.status, 200);assert.equal(result.value.total, first.total);
      ids.push(...result.value.events.map(e => e.eventId));
    }
    assert.equal(ids.length, first.total);assert.equal(new Set(ids).size, ids.length);
    assert((await call(c,url)).value.total > first.total, 'explicit refresh sees newly added events');
    assert.equal((await call(c,url,undefined,'other-owner')).status,404);
    for(const query of ['page=-1','limit=101','throughSequence=0','page=1.5','throughSequence=0&throughEventRowid=-1']) {
      assert.equal((await call(c,url+'?'+query)).status,400,query);
    }
  } finally { c.close(); }
});
