import test from 'node:test';
import assert from 'node:assert/strict';
import {Script} from 'node:vm';
import worker from '../worker/index.js';
async function html(){return (await worker.fetch(new Request('https://tracker.test/',{headers:{'oai-authenticated-user-id':'ui-test-owner'}}),{})).text();}
test('all three client scripts compile and existing UI enhancements remain present',async()=>{const source=await html();const scripts=[...source.matchAll(/<script>([\s\S]*?)<\/script>/g)];assert.equal(scripts.length,3);scripts.forEach(([,js])=>new Script(js));assert(source.includes('overviewPeriodPlans'));assert(source.includes('repoRefs'));});
test('responsive forms and keyboard dialog safeguards are delivered',async()=>{const source=await html();for(const marker of ['minmax(min(100%,180px),1fr)','aria-labelledby="modalTitle"',"event.key==='Escape'","event.key!=='Tab'",'modalReturnFocus.focus()','overflow-wrap:anywhere'])assert(source.includes(marker),marker);});
test('forms prevent duplicate submission and sync follows runtime availability',async()=>{const source=await html();for(const marker of ["form.getAttribute('aria-busy')==='true'",'sync.dataset.githubAvailable=String(data.githubAvailable===true)','sync.querySelector("button").disabled=data.githubAvailable!==true',"form.removeAttribute('aria-busy')",'GitHub runtime-доступ настроен.'])assert(source.includes(marker),marker);});
