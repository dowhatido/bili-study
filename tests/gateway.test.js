import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, normalizeGateway, getPermissionOrigin, listModels, complete } from '../src/gateway.js';

// Deliberately synthetic: this suite never reads credentials or uses a live network.
const KEY = 'fixture-key-DO-NOT-SEND';
const messages = [
  { role: 'system', content: '你是学习助手。' },
  { role: 'user', content: '解释梯度下降。' },
  { role: 'assistant', content: '沿梯度的反方向更新。' },
  { role: 'system', content: '保持简洁。' },
  { role: 'user', content: '给一个例子。' },
];
const config = (provider = 'deepseek', extra = {}) => ({ provider, apiKey: KEY, model: 'fixture-text-model', ...extra });
const json = (body, init = {}) => Response.json(body, init);
const openaiReply = (text = '学习总结') => ({ choices: [{ message: { content: text }, finish_reason: 'stop' }] });

function recordingFetch(responses) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: options.body ? JSON.parse(options.body) : undefined });
      assert.ok(responses.length, 'Unexpected extra request (possibly a retry)');
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(url, options) : next;
    },
  };
}

function errorCode(code, status) {
  return (error) => {
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    const serialized = `${error.stack}\n${JSON.stringify(error)}`;
    assert.ok(!serialized.includes(KEY), 'An error leaked the API key');
    assert.ok(!serialized.includes('secret-page'), 'An error leaked a response page');
    assert.equal(error.cause, undefined);
    return true;
  };
}

test('presets cover all required services and cannot be mutated', () => {
  assert.deepEqual(PROVIDERS.map((p) => p.id), ['deepseek', 'openai', 'xai', 'minimax', 'zhipu', 'anthropic', 'google', 'custom']);
  for (const preset of PROVIDERS) {
    assert.ok(preset.name);
    assert.ok(['openai', 'anthropic', 'gemini'].includes(preset.protocol));
    assert.ok(Object.isFrozen(preset));
  }
  assert.ok(Object.isFrozen(PROVIDERS));
  assert.equal(PROVIDERS.find((p) => p.id === 'zhipu').modelsUrl, undefined);
});

test('normalize defaults without inventing an available model or requiring credentials', () => {
  assert.deepEqual(normalizeGateway(), {
    provider: 'deepseek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: '', model: '',
  });
  assert.equal(normalizeGateway({ provider: 'google' }).protocol, 'gemini');
  assert.equal(normalizeGateway(config('openai', { apiKey: ` ${KEY} `, model: ' gpt-text ' })).apiKey, KEY);
  assert.equal(normalizeGateway(config('openai', { model: ' gpt-text ' })).model, 'gpt-text');
  assert.throws(() => normalizeGateway({ provider: 'unknown' }), errorCode('INVALID_PROVIDER'));
  assert.throws(() => normalizeGateway({ provider: 'openai', protocol: 'gemini' }), errorCode('INVALID_PROTOCOL'));
  assert.throws(() => normalizeGateway({ provider: 'custom', protocol: 'responses', baseUrl: 'https://test.example/v1' }), errorCode('INVALID_PROTOCOL'));
  for (const value of [null, [], 'config']) assert.throws(() => normalizeGateway(value), errorCode('INVALID_CONFIG'));
});

test('normalize protocol roots and complete endpoints without a duplicate version', () => {
  const cases = [
    ['openai', 'https://api.openai.com', 'https://api.openai.com/v1'],
    ['openai', 'https://api.openai.com/v1/', 'https://api.openai.com/v1'],
    ['openai', 'https://api.openai.com/v1/chat/completions', 'https://api.openai.com/v1'],
    ['openai', 'https://api.openai.com/v1/models', 'https://api.openai.com/v1'],
    ['deepseek', 'https://api.deepseek.com/chat/completions', 'https://api.deepseek.com'],
    ['deepseek', 'https://api.deepseek.com/v1/chat/completions', 'https://api.deepseek.com/v1'],
    ['anthropic', 'https://api.anthropic.com/v1/messages/', 'https://api.anthropic.com/v1'],
    ['google', 'https://generativelanguage.googleapis.com', 'https://generativelanguage.googleapis.com/v1beta'],
    ['google', 'https://generativelanguage.googleapis.com/v1beta/models', 'https://generativelanguage.googleapis.com/v1beta'],
    ['google', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-text:generateContent', 'https://generativelanguage.googleapis.com/v1beta'],
    ['zhipu', 'https://open.bigmodel.cn/api/paas/v4/chat/completions', 'https://open.bigmodel.cn/api/paas/v4'],
  ];
  for (const [provider, baseUrl, expected] of cases) {
    assert.equal(normalizeGateway({ provider, baseUrl }).baseUrl, expected);
  }
});

test('reject dangerous, ambiguous, HTML, and protocol-mismatched destinations without echoing input', () => {
  const invalid = [
    '', 'not a URL', 'ftp://example.com/v1', '//example.com/v1', 'file:///etc/passwd',
    'https://user:password@example.com/v1', 'https://user@example.com/v1', 'https://@example.com/v1',
    `https://example.com/v1?key=${KEY}`, `https://example.com/v1#${KEY}`, 'https://example.com/v1?',
    'https://example.com/v1#', 'https://example.com/console', 'https://example.com/login',
    'https://example.com/docs/v1', 'https://example.com/dashboard/v1', 'https://example.com/index.html',
    'https://example.com/v1/v1', 'https://example.com/v1/messages', 'https://example.com/v1/responses',
    'https://example.com/../v1', 'https://example.com/x/./v1', 'https://example.com/%2e%2e/v1',
    'https://example.com/x%2fv1', 'https://example.com/x//v1', 'https://example.com\\@evil.example/v1',
    'https://example.com/v1\n', 'https://example.com/v1/chat/completions/extra',
  ];
  for (const baseUrl of invalid) {
    assert.throws(() => normalizeGateway(config('custom', { baseUrl })), (error) => {
      assert.ok(['INVALID_URL', 'INVALID_API_PATH'].includes(error.code), baseUrl);
      assert.ok(!`${error.stack}`.includes(KEY));
      return true;
    }, `Must reject ${baseUrl}`);
  }
  assert.throws(() => normalizeGateway(config('google', { baseUrl: 'https://example.com/v1/chat/completions' })), errorCode('INVALID_API_PATH'));
});

test('custom API prefixes and host permission origin are retained', () => {
  const input = config('custom', { baseUrl: 'https://Gateway.Example/proxy/openai/v1/chat/completions' });
  const normalized = normalizeGateway(input);
  assert.equal(normalized.baseUrl, 'https://gateway.example/proxy/openai/v1');
  assert.equal(getPermissionOrigin(normalized.baseUrl), 'https://gateway.example/*');
  assert.equal(getPermissionOrigin('https://api.anthropic.com/v1'), 'https://api.anthropic.com/*');
  assert.throws(() => getPermissionOrigin(`https://${KEY}@test.example/v1`), errorCode('INVALID_URL'));
  assert.equal(getPermissionOrigin('http://localhost:3000/v1'), 'http://localhost:3000/*');
});

test('OpenAI-compatible providers use isolated headers/payloads and documented paths', async () => {
  const bases = {
    deepseek: 'https://api.deepseek.com', openai: 'https://api.openai.com/v1',
    xai: 'https://api.x.ai/v1', minimax: 'https://api.minimax.io/v1',
    zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  };
  for (const [provider, base] of Object.entries(bases)) {
    const fixture = recordingFetch([json({ ...openaiReply(), usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, ignored: KEY } })]);
    const input = config(provider, { thinking: { type: 'enabled' }, reasoning_effort: 'high' });
    const result = await complete(input, messages, { fetchImpl: fixture.fetchImpl, maxTokens: 99 });
    assert.deepEqual(result, { text: '学习总结', usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }, finishReason: 'stop' });
    const call = fixture.calls[0];
    assert.equal(call.url, `${base}/chat/completions`);
    assert.deepEqual(call.options.headers, { Accept: 'application/json', Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
    const tokenField = ['openai', 'minimax'].includes(provider) ? 'max_completion_tokens' : 'max_tokens';
    assert.deepEqual(call.body, { model: input.model, messages, stream: false, [tokenField]: 99 });
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.referrerPolicy, 'no-referrer');
    assert.equal(call.options.cache, 'no-store');
    assert.ok(call.options.signal instanceof AbortSignal);
  }
});

test('native Claude extracts system messages and ignores thinking/tool content', async () => {
  const fixture = recordingFetch([json({
    content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }],
    stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 8 },
  })]);
  const snapshot = structuredClone(messages);
  assert.deepEqual(await complete(config('anthropic'), messages, { fetchImpl: fixture.fetchImpl }), {
    text: '第一段第二段', usage: { input_tokens: 20, output_tokens: 8 }, finishReason: 'end_turn',
  });
  const { url, options, body } = fixture.calls[0];
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.deepEqual(options.headers, {
    Accept: 'application/json', 'Content-Type': 'application/json', 'x-api-key': KEY,
    'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true',
  });
  assert.deepEqual(body, {
    model: 'fixture-text-model', system: '你是学习助手。\n\n保持简洁。',
    messages: messages.filter((m) => m.role !== 'system'), max_tokens: 4096, stream: false,
  });
  assert.deepEqual(messages, snapshot);
});

test('native Gemini uses contents/model role/systemInstruction and header-only auth', async () => {
  for (const model of ['gemini-fixture', 'models/gemini-fixture']) {
    const fixture = recordingFetch([json({ candidates: [{ content: { parts: [
      { text: 'private reasoning', thought: true }, { text: '原理' }, { inlineData: { data: 'ignored' } }, { text: '示例' },
    ] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 8, totalTokenCount: 13 } })]);
    const output = await complete(config('google', { model }), messages, { fetchImpl: fixture.fetchImpl });
    assert.equal(output.text, '原理示例');
    assert.equal(output.usage.totalTokenCount, 13);
    const { url, options, body } = fixture.calls[0];
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-fixture:generateContent');
    assert.deepEqual(options.headers, { Accept: 'application/json', 'Content-Type': 'application/json', 'x-goog-api-key': KEY });
    assert.deepEqual(body, {
      contents: [
        { role: 'user', parts: [{ text: '解释梯度下降。' }] },
        { role: 'model', parts: [{ text: '沿梯度的反方向更新。' }] },
        { role: 'user', parts: [{ text: '给一个例子。' }] },
      ], generationConfig: { maxOutputTokens: 4096 },
      systemInstruction: { parts: [{ text: '你是学习助手。\n\n保持简洁。' }] },
    });
    assert.ok(!url.includes(KEY));
  }
});

test('custom gateways work for each protocol, never inherit another provider credentials', async () => {
  const cases = [
    ['openai', '/proxy/v1/chat/completions', openaiReply(), 'Authorization'],
    ['anthropic', '/proxy/v1/messages', { content: [{ type: 'text', text: 'ok' }] }, 'x-api-key'],
    ['gemini', '/proxy/v1beta/models/fixture-text-model:generateContent', { candidates: [{ content: { parts: [{ text: 'ok' }] } }] }, 'x-goog-api-key'],
  ];
  for (const [protocol, path, reply, authHeader] of cases) {
    const baseUrl = `https://custom.example/proxy/${protocol === 'gemini' ? 'v1beta' : 'v1'}`;
    const fixture = recordingFetch([json(reply)]);
    await complete(config('custom', { protocol, baseUrl }), [{ role: 'user', content: 'hi' }], { fetchImpl: fixture.fetchImpl });
    const call = fixture.calls[0];
    assert.equal(call.url, `https://custom.example${path}`);
    assert.ok(call.options.headers[authHeader]);
    assert.equal(call.options.headers['anthropic-dangerous-direct-browser-access'], undefined);
    assert.equal(call.body.system, undefined);
    assert.equal(call.body.systemInstruction, undefined);
  }
});

test('OpenAI models preserve IDs, display names, non-text entries, and deduplicate', async () => {
  for (const provider of ['deepseek', 'openai', 'xai', 'minimax']) {
    const fixture = recordingFetch([json({ data: [
      { id: 'text-model', name: 'Text Model' }, { id: 'org/embedding-model', name: 'Embeddings' }, { id: 'text-model' },
    ] })]);
    assert.deepEqual(await listModels(config(provider), { fetchImpl: fixture.fetchImpl }), [
      { id: 'text-model', name: 'Text Model', source: 'remote' }, { id: 'org/embedding-model', name: 'Embeddings', source: 'remote' },
    ]);
    assert.equal(fixture.calls[0].url, `${normalizeGateway(config(provider)).baseUrl}/models`);
    assert.equal(fixture.calls[0].options.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(fixture.calls[0].options.method, 'GET');
    assert.equal(fixture.calls[0].options.body, undefined);
  }
});

test('Gemini models use bounded native paging and preserve models/ resource names', async () => {
  const fixture = recordingFetch([
    json({ models: [{ name: 'models/gemini-fixture', displayName: 'Gemini fixture', supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'a+/&?=b' }),
    json({ models: [{ name: 'models/embedding-fixture', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] }] }),
  ]);
  assert.deepEqual(await listModels(config('google'), { fetchImpl: fixture.fetchImpl }), [
    { id: 'models/gemini-fixture', name: 'Gemini fixture', source: 'remote' }, { id: 'models/embedding-fixture', name: 'Embedding', source: 'remote' },
  ]);
  assert.equal(fixture.calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000');
  const second = new URL(fixture.calls[1].url);
  assert.equal(second.searchParams.get('pageToken'), 'a+/&?=b');
  assert.equal(second.searchParams.get('pageSize'), '1000');
  for (const call of fixture.calls) {
    assert.deepEqual(call.options.headers, { Accept: 'application/json', 'x-goog-api-key': KEY });
    assert.ok(!call.url.includes(KEY));
  }
});

test('Claude models send native headers and paginate using after_id', async () => {
  const fixture = recordingFetch([
    json({ data: [{ id: 'claude-one', display_name: 'Claude One' }], has_more: true, last_id: 'claude-one' }),
    json({ data: [{ id: 'claude-two', display_name: 'Claude Two' }], has_more: false, last_id: 'claude-two' }),
  ]);
  assert.deepEqual(await listModels(config('anthropic'), { fetchImpl: fixture.fetchImpl }), [
    { id: 'claude-one', name: 'Claude One', source: 'remote' }, { id: 'claude-two', name: 'Claude Two', source: 'remote' },
  ]);
  assert.equal(fixture.calls[0].url, 'https://api.anthropic.com/v1/models?limit=1000');
  assert.equal(new URL(fixture.calls[1].url).searchParams.get('after_id'), 'claude-one');
  for (const { options } of fixture.calls) {
    assert.equal(options.headers['x-api-key'], KEY);
    assert.equal(options.headers['anthropic-version'], '2023-06-01');
    assert.equal(options.headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.equal(options.headers.Authorization, undefined);
  }
});

test('GLM catalog is explicitly labeled and unverified model-list route is not probed with a key', async () => {
  const models = await listModels(config('zhipu'), { fetchImpl: () => assert.fail('must not contact unverified route') });
  assert.deepEqual(models, [{ id: 'glm-5.3', name: 'GLM-5.3', source: 'catalog' }]);
  models[0].name = 'mutated';
  assert.equal((await listModels(config('zhipu')))[0].name, 'GLM-5.3');
  const fixture = recordingFetch([json({ data: [{ id: 'custom-glm' }] })]);
  assert.deepEqual(await listModels(config('custom', { baseUrl: 'https://gateway.example/v1' }), { fetchImpl: fixture.fetchImpl }), [
    { id: 'custom-glm', name: 'custom-glm', source: 'remote' },
  ]);
});

test('pagination never follows supplied URLs and bounds loops and page counts', async () => {
  const fixture = recordingFetch([
    json({ models: [{ name: 'models/one' }], nextPageToken: 'https://evil.example/secret-page' }),
    json({ models: [], nextPageToken: 'https://evil.example/secret-page' }),
  ]);
  await assert.rejects(listModels(config('google'), { fetchImpl: fixture.fetchImpl }), errorCode('MODEL_LIST_LIMIT'));
  assert.equal(fixture.calls.length, 2);
  for (const call of fixture.calls) assert.equal(new URL(call.url).origin, 'https://generativelanguage.googleapis.com');
  const endless = recordingFetch(Array.from({ length: 10 }, (_, i) => json({ models: [], nextPageToken: `page-${i}` })));
  await assert.rejects(listModels(config('google'), { fetchImpl: endless.fetchImpl }), errorCode('MODEL_LIST_LIMIT'));
  assert.equal(endless.calls.length, 10);
  const missingCursor = recordingFetch([json({ data: [], has_more: true })]);
  await assert.rejects(listModels(config('anthropic'), { fetchImpl: missingCursor.fetchImpl }), errorCode('INVALID_RESPONSE'));
});

test('remote errors keep HTTP status, use Chinese guidance and never read or echo error pages', async () => {
  for (const status of [400, 401, 402, 403, 404, 408, 413, 429, 500, 503]) {
    const fixture = recordingFetch([new Response(`<html>secret-page ${KEY}</html>`, { status, headers: { 'Content-Type': 'text/html' } })]);
    await assert.rejects(complete(config(), messages, { fetchImpl: fixture.fetchImpl }), (error) => {
      errorCode('HTTP_ERROR', status)(error);
      assert.match(error.message, /模型服务请求失败/);
      assert.ok(error.message.includes(String(status)));
      assert.ok(!error.message.includes('手动填写'));
      return true;
    });
    assert.equal(fixture.calls.length, 1);
  }
});

test('network exceptions and remote JSON errors never leak API key or nested causes', async () => {
  const fixture = recordingFetch([new Error(`https://secret-page.test/?key=${KEY}`, { cause: new Error(KEY) })]);
  await assert.rejects(complete(config(), messages, { fetchImpl: fixture.fetchImpl }), errorCode('NETWORK_ERROR'));
  for (const reply of [{ error: { message: KEY } }, { base_resp: { status_code: 1004, status_msg: KEY } }]) {
    await assert.rejects(complete(config(), messages, { fetchImpl: async () => json(reply) }), errorCode('SERVICE_ERROR', 200));
  }
});

test('redirects, including same-origin redirects, never trigger another request', async () => {
  for (const response of [
    new Response(null, { status: 302, headers: { Location: `https://evil.example/secret-page?key=${KEY}` } }),
    { status: 200, ok: true, redirected: true, url: 'https://evil.example/', body: null },
    { status: 0, ok: false, type: 'opaqueredirect', body: null },
    { status: 200, ok: true, redirected: false, url: 'https://api.deepseek.com/login', body: null },
  ]) {
    const fixture = recordingFetch([response]);
    await assert.rejects(complete(config(), messages, { fetchImpl: fixture.fetchImpl }), errorCode('UNSAFE_REDIRECT'));
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].options.redirect, 'error');
  }
});

test('JSON-only responses, malformed data and invalid list entries fail safely', async () => {
  const replies = [
    new Response(`<html>secret-page ${KEY}</html>`, { headers: { 'Content-Type': 'text/html' } }),
    new Response(`invalid ${KEY}`, { headers: { 'Content-Type': 'application/json' } }),
    json(null), json([]), new Response(null, { status: 204 }),
  ];
  for (const response of replies) {
    await assert.rejects(complete(config(), messages, { fetchImpl: async () => response }), errorCode('INVALID_RESPONSE'));
  }
  for (const body of [{ data: 'wrong' }, { data: [{}] }, { data: [{ id: 42 }] }, { data: [{ id: '' }] }]) {
    await assert.rejects(listModels(config(), { fetchImpl: async () => json(body) }), errorCode('INVALID_RESPONSE'));
  }
});

test('response size is bounded for both declared lengths and streamed bytes', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } });
  await assert.rejects(complete(config(), messages, { fetchImpl: async () => new Response(stream, { headers: { 'Content-Type': 'application/json' } }) }), errorCode('RESPONSE_TOO_LARGE'));
  assert.equal(cancelled, true);
  const response = new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '99999999' } });
  await assert.rejects(complete(config(), messages, { fetchImpl: async () => response }), errorCode('RESPONSE_TOO_LARGE', 200));
});

test('cancellation before dispatch sends nothing and discards private abort reasons', async () => {
  const controller = new AbortController();
  controller.abort(new Error(KEY));
  await assert.rejects(complete(config(), messages, { signal: controller.signal, fetchImpl: () => assert.fail('aborted request was sent') }), errorCode('CANCELLED'));
});

test('cancellation interrupts a pending fetch even if an injected fetch ignores signal', async () => {
  const controller = new AbortController();
  let sentSignal;
  const pending = complete(config(), messages, { signal: controller.signal, fetchImpl: async (_url, options) => {
    sentSignal = options.signal;
    queueMicrotask(() => controller.abort(KEY));
    return new Promise(() => {});
  } });
  await assert.rejects(pending, errorCode('CANCELLED'));
  assert.equal(sentSignal.aborted, true);
});

test('cancellation during response streaming stops body reads', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const pending = complete(config(), messages, { signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({
    pull() { queueMicrotask(() => controller.abort(new Error(KEY))); },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(pending, errorCode('CANCELLED'));
  assert.equal(cancelled, true);
});

test('deadlines cover completion and entire model-list pagination without paid retries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [action, deadline] of [[complete, 90000], [listModels, 30000]]) {
    let signal;
    let ready;
    const started = new Promise((resolve) => { ready = resolve; });
    const options = { fetchImpl: async (_url, init) => { signal = init.signal; ready(); return new Promise(() => {}); } };
    const pending = action === complete ? action(config(), messages, options) : action(config(), options);
    const rejection = assert.rejects(pending, errorCode('TIMEOUT'));
    await started;
    t.mock.timers.tick(deadline);
    await rejection;
    assert.equal(signal.aborted, true);
  }
});

test('invalid messages/config/model/token options do not dispatch a request', async () => {
  const options = { fetchImpl: () => assert.fail('invalid input must not be sent') };
  for (const input of [[], [{ role: 'tool', content: 'x' }], [{ role: 'user', content: ['x'] }], [{ role: 'system', content: 'only' }], [{ role: 'user', content: ' ' }]]) {
    await assert.rejects(complete(config(), input, options), errorCode('INVALID_MESSAGES'));
  }
  await assert.rejects(complete(config('openai', { model: '' }), messages, options), errorCode('MISSING_MODEL'));
  await assert.rejects(complete(config('openai', { apiKey: '' }), messages, options), errorCode('MISSING_KEY'));
  for (const maxTokens of [0, -1, 1.5, Infinity, 131073, '100']) {
    await assert.rejects(complete(config(), messages, { ...options, maxTokens }), errorCode('INVALID_MAX_TOKENS'));
  }
  for (const model of ['../other', 'models/../../login', 'https://evil.example/model', 'model?key=x', 'models/models/model']) {
    await assert.rejects(complete(config('google', { model }), messages, options), errorCode('INVALID_MODEL'));
  }
  assert.throws(() => normalizeGateway(config('openai', { apiKey: `x\r\n${KEY}` })), errorCode('INVALID_CONFIG'));
  await assert.rejects(complete(config(), [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }], options), errorCode('INPUT_TOO_LARGE'));
});

test('non-text, refusals and truncated outputs are not returned as successful summaries', async () => {
  const cases = [
    ['openai', { choices: [{ message: { content: null, reasoning_content: 'not an answer' } }] }, 'NO_TEXT'],
    ['anthropic', { content: [{ type: 'tool_use', name: 'tool' }] }, 'NO_TEXT'],
    ['google', { candidates: [{ content: { parts: [{ inlineData: {} }] } }] }, 'NO_TEXT'],
    ['google', { promptFeedback: { blockReason: 'SAFETY' } }, 'NO_TEXT'],
    ['openai', { choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }, 'OUTPUT_TRUNCATED'],
    ['anthropic', { content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens' }, 'OUTPUT_TRUNCATED'],
    ['google', { candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }] }, 'OUTPUT_TRUNCATED'],
    ['google', { candidates: [{ finishReason: 'SAFETY' }] }, 'MODEL_REFUSAL'],
    ['openai', { choices: [{ message: { content: 'filtered' }, finish_reason: 'content_filter' }] }, 'MODEL_REFUSAL'],
  ];
  for (const [provider, reply, code] of cases) {
    await assert.rejects(complete(config(provider), messages, { fetchImpl: async () => json(reply) }), errorCode(code));
  }
  assert.deepEqual(await complete(config(), messages, { fetchImpl: async () => json({ choices: [{ message: { content: [
    { type: 'text', text: 'one' }, { type: 'image', text: 'ignored' }, { type: 'text', text: 'two' },
  ] } }] }) }), { text: 'onetwo' });
});

test('a later model page failure preserves its status instead of returning partial results', async () => {
  const fixture = recordingFetch([
    json({ models: [{ name: 'models/page-one' }], nextPageToken: 'next' }),
    json({ error: { message: KEY } }, { status: 429 }),
  ]);
  await assert.rejects(listModels(config('google'), { fetchImpl: fixture.fetchImpl }), errorCode('HTTP_ERROR', 429));
  assert.equal(fixture.calls.length, 2);
});

test('all model pages share one deadline rather than restarting the timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let ready;
  const onSecond = new Promise((resolve) => { ready = resolve; });
  let calls = 0;
  const pending = listModels(config('google'), { fetchImpl: async () => {
    calls += 1;
    if (calls === 1) {
      t.mock.timers.tick(25000);
      return json({ models: [], nextPageToken: 'second' });
    }
    ready();
    return new Promise(() => {});
  } });
  const rejection = assert.rejects(pending, errorCode('TIMEOUT'));
  await onSecond;
  t.mock.timers.tick(5000);
  await rejection;
  assert.equal(calls, 2);
});

test('deadline includes a stalled response body, not just response headers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let ready;
  let cancelled = false;
  const reading = new Promise((resolve) => { ready = resolve; });
  const pending = complete(config(), messages, { fetchImpl: async () => new Response(new ReadableStream({
    pull() { ready(); }, cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'application/json' } }) });
  const rejection = assert.rejects(pending, errorCode('TIMEOUT'));
  await reading;
  t.mock.timers.tick(90000);
  await rejection;
  assert.equal(cancelled, true);
});

test('streamed UTF-8 text and application/*+json media types are handled without corruption', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(openaiReply('中文总结')));
  let offset = 0;
  const response = new Response(new ReadableStream({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.slice(offset, offset + 1));
    offset += 1;
  } }), { headers: { 'Content-Type': 'application/vnd.gateway+json; charset=utf-8' } });
  assert.deepEqual(await complete(config(), messages, { fetchImpl: async () => response }), { text: '中文总结', finishReason: 'stop' });
});

test('large or malformed pagination cannot cause infinite requests or a fabricated list', async () => {
  const many = Array.from({ length: 10001 }, (_, i) => ({ id: `model-${i}` }));
  await assert.rejects(listModels(config(), { fetchImpl: async () => json({ data: many }) }), errorCode('MODEL_LIST_LIMIT'));
  for (const nextPageToken of [42, 'x'.repeat(2049)]) {
    await assert.rejects(listModels(config('google'), { fetchImpl: async () => json({ models: [], nextPageToken }) }), errorCode('MODEL_LIST_LIMIT'));
  }
  assert.deepEqual(await listModels(config('google'), { fetchImpl: async () => json({}) }), []);
  assert.deepEqual(await listModels(config(), { fetchImpl: async () => json({ data: [] }) }), []);
});

test('MiniMax unsupported discovery routes return only verified catalog entries with explicit source', async () => {
  for (const status of [404, 405]) {
    const fixture = recordingFetch([json({ error: { message: KEY } }, { status })]);
    assert.deepEqual(await listModels(config('minimax'), { fetchImpl: fixture.fetchImpl }), [
      { id: 'MiniMax-M3', name: 'MiniMax-M3', source: 'catalog' },
      { id: 'MiniMax-M2.7', name: 'MiniMax-M2.7', source: 'catalog' },
      { id: 'MiniMax-M2.5', name: 'MiniMax-M2.5', source: 'catalog' },
    ]);
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].url, 'https://api.minimax.io/v1/models');
    assert.equal(fixture.calls[0].options.method, 'GET');
  }
});

test('MiniMax never substitutes catalog for auth, quota, network, malformed, or empty remote results', async () => {
  for (const status of [400, 401, 402, 403, 429, 500, 503]) {
    await assert.rejects(listModels(config('minimax'), { fetchImpl: async () => json({ error: { message: KEY } }, { status }) }), errorCode('HTTP_ERROR', status));
  }
  await assert.rejects(listModels(config('minimax'), { fetchImpl: async () => { throw new Error(KEY); } }), errorCode('NETWORK_ERROR'));
  await assert.rejects(listModels(config('minimax'), { fetchImpl: async () => json({ invalid: true }) }), errorCode('INVALID_RESPONSE'));
  assert.deepEqual(await listModels(config('minimax'), { fetchImpl: async () => json({ data: [] }) }), []);
});

test('custom gateways and overridden preset destinations can never use an official catalog', async () => {
  const inputs = [
    config('custom', { baseUrl: 'https://api.minimax.io/v1' }),
    config('custom', { baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }),
    config('minimax', { baseUrl: 'https://proxy.example/v1' }),
    config('zhipu', { baseUrl: 'https://proxy.example/v1' }),
    config('minimax', { baseUrl: 'http://api.minimax.io/v1' }),
  ];
  for (const input of inputs) {
    const fixture = recordingFetch([json({ error: { message: KEY } }, { status: 404 })]);
    await assert.rejects(listModels(input, { fetchImpl: fixture.fetchImpl }), errorCode('HTTP_ERROR', 404));
    assert.equal(fixture.calls.length, 1);
    const remote = recordingFetch([json({ data: [{ id: 'account-model' }] })]);
    assert.deepEqual(await listModels(input, { fetchImpl: remote.fetchImpl }), [
      { id: 'account-model', name: 'account-model', source: 'remote' },
    ]);
  }
});

test('catalog retrieval honors cancellation and local missing-key checks without account authorization claims', async () => {
  const controller = new AbortController();
  controller.abort(KEY);
  await assert.rejects(listModels(config('zhipu'), { signal: controller.signal }), errorCode('CANCELLED'));
  await assert.rejects(listModels(config('zhipu', { apiKey: '' })), errorCode('MISSING_KEY'));
  const models = await listModels(config('zhipu'), { fetchImpl: () => assert.fail('no account discovery or paid generation') });
  assert.ok(models.every((model) => model.source === 'catalog' && Object.keys(model).sort().join(',') === 'id,name,source'));
});

test('explicit HTTP custom gateways preserve scheme, port, exact permission origin, and native protocol mapping', async () => {
  for (const protocol of ['openai', 'anthropic', 'gemini']) {
    const baseUrl = `http://127.0.0.1:8042/proxy/${protocol === 'gemini' ? 'v1beta' : 'v1'}`;
    const input = config('custom', { protocol, baseUrl });
    assert.equal(normalizeGateway(input).baseUrl, baseUrl);
    assert.equal(getPermissionOrigin(baseUrl), 'http://127.0.0.1:8042/*');
    const listReply = protocol === 'gemini' ? { models: [{ name: 'models/text-fixture' }] } : { data: [{ id: 'text-fixture' }] };
    const completionReply = protocol === 'gemini' ? { candidates: [{ content: { parts: [{ text: 'ok' }] } }] }
      : protocol === 'anthropic' ? { content: [{ type: 'text', text: 'ok' }] } : openaiReply('ok');
    const fixture = recordingFetch([json(listReply), json(completionReply)]);
    const discovered = await listModels(input, { fetchImpl: fixture.fetchImpl });
    assert.equal(discovered[0].source, 'remote');
    const output = await complete(input, [{ role: 'user', content: 'hi' }], { fetchImpl: fixture.fetchImpl });
    assert.equal(output.text, 'ok');
    for (const { url, options } of fixture.calls) {
      assert.equal(new URL(url).origin, 'http://127.0.0.1:8042');
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.headers['anthropic-dangerous-direct-browser-access'], undefined);
      assert.ok(!url.includes(KEY));
    }
  }
  assert.equal(normalizeGateway(config('custom', { baseUrl: 'http://gateway.example' })).baseUrl, 'http://gateway.example/v1');
});

test('HTTP custom gateways reject credential injection, queries, web routes, and cross-scheme redirects', async () => {
  for (const baseUrl of [
    `http://user:${KEY}@gateway.example/v1`, `http://gateway.example/v1?key=${KEY}`,
    'http://gateway.example/login', 'http://gateway.example/x//v1', 'http://gateway.example/../v1',
  ]) assert.throws(() => normalizeGateway(config('custom', { baseUrl })));
  const input = config('custom', { baseUrl: 'http://gateway.example/v1' });
  for (const location of ['https://gateway.example/v1/models', 'http://evil.example/v1/models']) {
    const fixture = recordingFetch([new Response(null, { status: 307, headers: { Location: location } })]);
    await assert.rejects(listModels(input, { fetchImpl: fixture.fetchImpl }), errorCode('UNSAFE_REDIRECT', 307));
    assert.equal(fixture.calls.length, 1);
  }
});
