import test from 'node:test';
import assert from 'node:assert/strict';
import { completeLong } from '../src/gateway.js';

const config = { provider: 'deepseek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'm' };
const reply = (text, finish) => new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: finish }] }),
  { headers: { 'content-type': 'application/json' } });

test('a truncated answer is continued instead of failing', async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return bodies.length === 1 ? reply('前半段。', 'length') : reply('后半段。', 'stop');
  };
  const result = await completeLong(config, [{ role: 'user', content: '写一篇长文' }], { fetchImpl, maxTokens: 1024 });
  assert.equal(result.text, '前半段。后半段。');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].messages.at(-1).role, 'user');
  assert.match(bodies[1].messages.at(-1).content, /继续写/);
  assert.equal(bodies[1].messages.at(-2).content, '前半段。');
});

test('continuation stops after maxContinuations and keeps what was produced', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return reply(`段${calls}`, 'length'); };
  const result = await completeLong(config, [{ role: 'user', content: 'x' }], { fetchImpl, maxContinuations: 2 });
  assert.equal(calls, 3);
  assert.equal(result.text, '段1段2段3');
});

test('an empty response is retried once with a plain instruction', async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return bodies.length === 1
      ? new Response(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } })
      : reply('正文。', 'stop');
  };
  const result = await completeLong(config, [{ role: 'user', content: '写' }], { fetchImpl });
  assert.equal(result.text, '正文。');
  assert.equal(bodies.length, 2);
  assert.match(bodies[1].messages.at(-1).content, /直接输出正文/);
});

test('an empty continuation keeps the already written text', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return reply('前半段。', 'length');
    return new Response(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
  };
  const result = await completeLong(config, [{ role: 'user', content: '写' }], { fetchImpl });
  assert.equal(result.text, '前半段。');
  assert.equal(calls, 2);
});

test('overlapping text at the seam is not duplicated', async () => {
  let calls = 0;
  const overlap = '这是一句会被重复的共同句子。';
  const fetchImpl = async () => (++calls === 1 ? reply(`第一段结束。${overlap}`, 'length') : reply(`${overlap}继续写。`, 'stop'));
  const result = await completeLong(config, [{ role: 'user', content: '写' }], { fetchImpl });
  assert.equal(result.text, `第一段结束。${overlap}继续写。`);
});
