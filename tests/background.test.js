import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState } from '../src/store.js';

let data = emptyState(), fetchCalls = 0, responder;
const event = () => ({ addListener() {} });
globalThis.chrome = {
  runtime: { getURL: path => `chrome-extension://study/${path}`, onMessage: event(), onConnect: event(), onInstalled: event(), onStartup: event() },
  storage: { local: { async get() { return { biliStudy: structuredClone(data) }; }, async set(value) { data = structuredClone(value.biliStudy); }, async setAccessLevel() {} } },
  tabs: { onActivated: event(), onUpdated: event(), async query() { return []; }, async get() { return null; } },
  permissions: { async contains() { return true; } },
  action: { onClicked: event() }, sidePanel: {}, alarms: { onAlarm: event() },
};
globalThis.fetch = async (...args) => { fetchCalls++; return responder(...args); };
const { dispatch, drain } = await import('../src/background.js');
const sender = { url: 'chrome-extension://study/app.html', id: 'study' };
const key = 'bilibili:BV17x411w7KC:123';
function reset() {
  data = emptyState(); fetchCalls = 0;
  data.settings.gateway = { provider:'deepseek', protocol:'openai', baseUrl:'https://api.deepseek.com', apiKey:'synthetic-test-key', model:'text-test' };
  data.videos[key] = { key, bvid:'BV17x411w7KC', cid:123, page:1, title:'测试视频', language:'zh-CN', url:'https://www.bilibili.com/video/BV17x411w7KC/', segments:[{ id:'g0', start:0, end:10, text:'这是完整字幕' }], notes:[] };
  responder = async () => new Response(JSON.stringify({ choices:[{ message:{ content:'# 学习摘要\n证据 [g0]' }, finish_reason:'stop' }] }), { headers:{ 'content-type':'application/json' } });
}
async function until(check) {
  for (let i=0; i<200; i++) { if (check()) return; await new Promise(r=>setTimeout(r, 2)); }
  assert.fail('background condition timed out');
}
test('runtime integration: permissions, queue, interrupted requests, cancellation and reset', async t => {
  await t.test('untrusted pages cannot read storage or change settings', async () => {
    reset();
    for (const url of ['https://evil.test/', 'https://www.bilibili.com/video/BV17x411w7KC']) {
      await assert.rejects(dispatch({ type:'state' }, { url }), /权限/);
      await assert.rejects(dispatch({ type:'reset' }, { url }), /权限/);
    }
    const state = await dispatch({ type:'state' }, sender);
    assert.equal(state.settings.gateway.apiKey, ''); assert.equal(state.settings.gateway.hasKey, true);
  });
  await t.test('summary queue maps every part then reduces and preserves prior edits', async () => {
    reset(); data.videos[key].summary = '我自己的概览'; data.videos[key].summaryEdited = true;
    const result = await dispatch({ type:'enqueue', jobType:'summary', key }, sender);
    await until(()=>data.jobs[result.jobId]?.status === 'done');
    assert.equal(fetchCalls, 2); assert.match(data.videos[key].summary, /学习摘要/);
    assert.equal(data.videos[key].summaryHistory[0].text, '我自己的概览');
    assert.equal(data.videos[key].summaryHistory[0].edited, true);
  });
  await t.test('interrupted work is requeued only when no model request was dispatched', async () => {
    reset();
    data.jobs.safe = { id:'safe', type:'summary', key, data:{}, status:'running', createdAt:1, requestPending:false };
    await drain();
    assert.equal(data.jobs.safe.status, 'done');
    assert.ok(fetchCalls > 0);

    reset();
    data.jobs.paid = { id:'paid', type:'summary', key, data:{}, status:'running', createdAt:1, requestPending:true };
    await drain();
    assert.equal(data.jobs.paid.status, 'unknown');
    assert.equal(fetchCalls, 0);
    await assert.rejects(dispatch({ type:'retryJob', id:'paid' }, sender), /确认/);
  });
  await t.test('cancelled late response cannot overwrite a saved video', async () => {
    reset(); let release;
    responder = () => new Promise(r => { release = r; });
    const { jobId } = await dispatch({ type:'enqueue', jobType:'summary', key }, sender);
    await until(()=>Boolean(release));
    await dispatch({ type:'cancelJob', id:jobId }, sender);
    release(new Response(JSON.stringify({ choices:[{ message:{ content:'迟到的摘要' } }] }), { headers:{ 'content-type':'application/json' } }));
    await until(()=>data.jobs[jobId].status === 'cancelled');
    await drain(); assert.equal(data.videos[key].summary, undefined);
  });
  await t.test('clearing data during a question prevents late answers from resurrecting it', async () => {
    reset(); let release;
    responder = () => new Promise(r => { release = r; });
    const task = dispatch({ type:'ask', key, question:'解释内容' }, sender);
    await until(()=>Boolean(release));
    await dispatch({ type:'reset', confirm:'清除本插件资料' }, sender);
    release(new Response(JSON.stringify({ choices:[{ message:{ content:'回答 [g0]' } }] }), { headers:{ 'content-type':'application/json' } }));
    await assert.rejects(task, /清除/);
    assert.deepEqual(data.conversations, {}); assert.deepEqual(data.videos, {});
  });
  await t.test('long discussion refuses silently truncated summaries and preserves full export data', async () => {
    reset(); data.conversations[key] = { messages:[{ role:'user', content:'中'.repeat(71000) }] };
    await assert.rejects(dispatch({ type:'summarizeConversation', key }, sender), /未截断/);
    assert.equal(fetchCalls, 0); assert.equal(data.conversations[key].messages[0].content.length, 71000);
  });
  await t.test('manual summary edits are versioned once and never silently overwritten', async () => {
    reset();
    await dispatch({ type:'saveVideoSummary', key, text:'我的第一版判断' }, sender);
    await dispatch({ type:'saveVideoSummary', key, text:'我的第一版判断' }, sender);
    assert.equal(data.videos[key].summaryHistory, undefined);
    await dispatch({ type:'saveVideoSummary', key, text:'我的第二版判断' }, sender);
    assert.equal(data.videos[key].summaryHistory.length, 1);
    assert.equal(data.videos[key].summaryHistory[0].text, '我的第一版判断');
    assert.equal(data.videos[key].summaryHistory[0].edited, true);
    const { jobId } = await dispatch({ type:'enqueue', jobType:'summary', key }, sender);
    await until(()=>data.jobs[jobId]?.status === 'done');
    assert.equal(data.videos[key].summaryHistory.length, 2);
    assert.equal(data.videos[key].summaryHistory[1].text, '我的第二版判断');
    assert.equal(data.videos[key].summaryEdited, false);
  });
  await t.test('vault write results are recorded on the video', async () => {
    reset();
    data.videos[key].vaultPending = true;
    await dispatch({ type:'savedToVault', key, path:'Bili Study/视频资料/x.md' }, sender);
    assert.equal(data.videos[key].vaultPending, false);
    assert.equal(data.videos[key].vaultPath, 'Bili Study/视频资料/x.md');
    data.videos[key].vaultPending = true;
    await dispatch({ type:'savedToVault', key, error:'尚未获得写入权限' }, sender);
    assert.equal(data.videos[key].vaultPending, false);
    assert.equal(data.videos[key].vaultError, '尚未获得写入权限');
  });
  await t.test('summary batches use bounded parallel model calls', async () => {
    reset();
    data.videos[key].segments = Array.from({ length: 6 }, (_, index) => ({
      id: `g${index}`, start: index * 10, end: index * 10 + 9, text: '字'.repeat(2000),
    }));
    let active = 0, maxActive = 0;
    responder = async (_url, init) => {
      const prompt = JSON.parse(init.body).messages.at(-1).content;
      if (prompt.includes('这段字幕覆盖')) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 25));
        active -= 1;
        return new Response(JSON.stringify({
          choices: [{ message: { content: '### 分节笔记\n\n这段包含可验证内容 [g0]。' }, finish_reason: 'stop' }],
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: {
          content: '{"intro":"导读","glossary":[],"checklist":[],"questions":[]}',
        }, finish_reason: 'stop' }],
      }), { headers: { 'content-type': 'application/json' } });
    };
    const { jobId } = await dispatch({ type: 'enqueue', jobType: 'summary', key }, sender);
    await until(() => data.jobs[jobId]?.status === 'done');
    assert.equal(maxActive, 2);
    assert.equal(data.videos[key].summaryParts, 3);
  });
  await t.test('a failed parallel wave keeps completed batch checkpoints', async () => {
    reset();
    data.videos[key].segments = Array.from({ length: 6 }, (_, index) => ({
      id: `g${index}`, start: index * 10, end: index * 10 + 9, text: '字'.repeat(2000),
    }));
    let recovering = false;
    const recoveredRanges = [];
    responder = async (_url, init) => {
      const prompt = JSON.parse(init.body).messages.at(-1).content;
      if (prompt.includes('这段字幕覆盖')) {
        if (recovering) recoveredRanges.push(/覆盖 (\d+:\d+) 到 (\d+:\d+)/.exec(prompt)?.slice(1).join('-'));
        if (!recovering && prompt.includes('0:20 到 0:39')) {
          return new Response(JSON.stringify({ error: { message: 'synthetic failure' } }), {
            status: 500, headers: { 'content-type': 'application/json' },
          });
        }
        await new Promise(resolve => setTimeout(resolve, 10));
        return new Response(JSON.stringify({
          choices: [{ message: { content: '### 分节笔记\n\n可验证内容 [g0]。' }, finish_reason: 'stop' }],
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: {
          content: '{"intro":"导读","glossary":[],"checklist":[],"questions":[]}',
        }, finish_reason: 'stop' }],
      }), { headers: { 'content-type': 'application/json' } });
    };
    const { jobId } = await dispatch({ type: 'enqueue', jobType: 'summary', key }, sender);
    await until(() => data.jobs[jobId]?.status === 'failed');
    assert.equal(data.jobs[jobId].parts.length, 1);
    assert.equal(data.jobs[jobId].parts[0].batchIndex, 0);
    recovering = true;
    await dispatch({ type: 'retryJob', id: jobId, confirm: true }, sender);
    await until(() => data.jobs[jobId]?.status === 'done');
    assert.deepEqual(recoveredRanges.sort(), ['0:20-0:39', '0:40-0:59']);
    assert.equal(data.videos[key].summaryParts, 3);
  });
  await t.test('translation jobs are rejected and legacy queued jobs are cancelled', async () => {
    reset();
    await assert.rejects(dispatch({ type: 'enqueue', jobType: 'translate', key, data: { target: 'en' } }, sender), /翻译功能已移除/);
    data.jobs.legacy = { id: 'legacy', type: 'translate', key, data: {}, status: 'queued', createdAt: 1 };
    await drain();
    assert.equal(data.jobs.legacy.status, 'cancelled');
    assert.equal(data.jobs.legacy.progress, '翻译功能已移除');
    assert.equal(fetchCalls, 0);
  });
});
