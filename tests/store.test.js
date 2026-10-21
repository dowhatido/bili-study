import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA_VERSION, DEFAULT_SETTINGS, emptyState, readState, changeState, addAudit,
  publicState, normalizeSettings,
} from '../src/store.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// Async Chrome storage facsimile with clone-on-read/write, never real browser data.
function storageFixture(t, seed, { failGetAt = [], failSetAt = [] } = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  let stored = seed === undefined ? undefined : structuredClone(seed);
  let reads = 0;
  let writes = 0;
  const calls = [];
  Object.defineProperty(globalThis, 'chrome', { configurable: true, writable: true, value: { storage: { local: {
    async get(key) {
      reads++;
      calls.push(`get:${reads}`);
      assert.equal(key, 'biliStudy');
      if (failGetAt.includes(reads)) throw new Error('fixture read failure');
      await Promise.resolve();
      return stored === undefined ? {} : { biliStudy: structuredClone(stored) };
    },
    async set(value) {
      writes++;
      calls.push(`set:${writes}`);
      assert.deepEqual(Object.keys(value), ['biliStudy']);
      if (failSetAt.includes(writes)) throw new Error('fixture write failure');
      await Promise.resolve();
      stored = structuredClone(value.biliStudy);
    },
  } } } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'chrome', previous);
    else delete globalThis.chrome;
  });
  return { calls, snapshot: () => structuredClone(stored), counts: () => ({ reads, writes }) };
}

test('emptyState is schema-versioned, safe by default and deeply independent', () => {
  const first = emptyState();
  const second = emptyState();
  assert.equal(first.schemaVersion, SCHEMA_VERSION);
  assert.equal(first.epoch, 0);
  assert.equal(first.settings.gateway.apiKey, '');
  assert.equal(first.settings.autoCollect, false);
  assert.equal(first.settings.autoReports, false);
  assert.equal(first.settings.timezone, 'Asia/Shanghai');
  first.settings.gateway.apiKey = 'fixture-only-not-a-real-key';
  first.settings.folders.push('42');
  first.videos.A = { title: 'first only' };
  first.audit.push({ action: 'first only' });
  assert.deepEqual(second, emptyState());
  assert.equal(DEFAULT_SETTINGS.gateway.apiKey, '');
});

test('readState without Chrome storage returns fresh defaults, with no browser dependency', async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  Object.defineProperty(globalThis, 'chrome', { configurable: true, writable: true, value: undefined });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'chrome', previous);
    else delete globalThis.chrome;
  });
  assert.deepEqual(await readState(), emptyState());
});

test('readState loads only the project namespace, merges defaults and does not write during reads', async (t) => {
  const seed = { schemaVersion: SCHEMA_VERSION, epoch: 4, settings: { timezone: 'UTC' },
    videos: { A: { title: '已有资料' } }, conversations: { c: { messages: [] } } };
  const storage = storageFixture(t, seed);
  const state = await readState();
  assert.equal(state.epoch, 4);
  assert.equal(state.settings.timezone, 'UTC');
  assert.equal(state.settings.autoReports, false);
  assert.equal(state.settings.gateway.apiKey, '');
  assert.deepEqual(state.videos, seed.videos);
  assert.deepEqual(state.jobs, {});
  assert.deepEqual(state.coverage, {});
  state.videos.A.title = '只改副本';
  assert.equal(storage.snapshot().videos.A.title, '已有资料');
  assert.deepEqual(storage.counts(), { reads: 1, writes: 0 });
});

test('missing persisted state initializes defaults without a hidden write', async (t) => {
  const storage = storageFixture(t);
  assert.deepEqual(await readState(), emptyState());
  assert.deepEqual(storage.counts(), { reads: 1, writes: 0 });
});

test('changeState serializes async read-modify-write operations and preserves return values', async (t) => {
  const storage = storageFixture(t, emptyState());
  const entered = deferred();
  const release = deferred();
  const observed = [];
  const first = changeState(async (state) => {
    observed.push(`first:${state.epoch}`);
    entered.resolve();
    await release.promise;
    state.epoch++;
    return 'first-result';
  });
  const second = changeState((state) => { observed.push(`second:${state.epoch}`); state.epoch++; return 'second-result'; });
  const both = Promise.all([first, second]);
  let results;
  try {
    await entered.promise;
    assert.deepEqual(observed, ['first:0']);
    assert.deepEqual(storage.calls, ['get:1']);
  } finally {
    release.resolve();
    results = await both;
  }
  assert.deepEqual(results, ['first-result', 'second-result']);
  assert.deepEqual(observed, ['first:0', 'second:1']);
  assert.deepEqual(storage.calls, ['get:1', 'set:1', 'get:2', 'set:2']);
  assert.equal(storage.snapshot().epoch, 2);
});

test('many concurrent mutations retain all increments and do not overwrite prior updates', async (t) => {
  const storage = storageFixture(t, emptyState());
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => changeState(async (state) => {
    await Promise.resolve();
    state.epoch++;
    state.events[`fixture-${i}`] = { at: i, type: 'fixture' };
    return state.epoch;
  })));
  assert.deepEqual(results, Array.from({ length: 40 }, (_, i) => i + 1));
  assert.equal(storage.snapshot().epoch, 40);
  assert.equal(Object.keys(storage.snapshot().events).length, 40);
  assert.deepEqual(storage.counts(), { reads: 40, writes: 40 });
});

test('mutation callback failure rejects that caller, does not persist partial state and does not poison queue', async (t) => {
  const storage = storageFixture(t, emptyState());
  const results = await Promise.allSettled([
    changeState((state) => { state.epoch = 999; throw new Error('fixture callback failure'); }),
    changeState((state) => { assert.equal(state.epoch, 0); state.epoch = 1; return 'recovered'; }),
  ]);
  assert.equal(results[0].status, 'rejected');
  assert.match(results[0].reason.message, /fixture callback failure/);
  assert.deepEqual(results[1], { status: 'fulfilled', value: 'recovered' });
  assert.equal(storage.snapshot().epoch, 1);
  assert.deepEqual(storage.counts(), { reads: 2, writes: 1 });
});

test('async callback rejection is isolated, and a subsequently queued change still succeeds', async (t) => {
  const storage = storageFixture(t, emptyState());
  const results = await Promise.allSettled([
    changeState(async (state) => { state.epoch = 8; await Promise.resolve(); throw new Error('fixture async failure'); }),
    changeState((state) => { state.epoch += 2; return state.epoch; }),
  ]);
  assert.equal(results[0].status, 'rejected');
  assert.deepEqual(results[1], { status: 'fulfilled', value: 2 });
  assert.equal(storage.snapshot().epoch, 2);
});

test('storage write failure is visible and next change rereads the last durable state', async (t) => {
  const storage = storageFixture(t, emptyState(), { failSetAt: [1] });
  const results = await Promise.allSettled([
    changeState((state) => { state.epoch = 99; return 'must-not-succeed'; }),
    changeState((state) => { assert.equal(state.epoch, 0); state.epoch = 2; return 'durable'; }),
  ]);
  assert.equal(results[0].status, 'rejected');
  assert.match(results[0].reason.message, /保存|fixture write failure/);
  assert.deepEqual(results[1], { status: 'fulfilled', value: 'durable' });
  assert.equal(storage.snapshot().epoch, 2);
  assert.deepEqual(storage.calls, ['get:1', 'set:1', 'get:2', 'set:2']);
});

test('storage read failure prevents the callback/write and queue can recover on its next read', async (t) => {
  const storage = storageFixture(t, emptyState(), { failGetAt: [1] });
  let failedCallbackRan = false;
  const results = await Promise.allSettled([
    changeState(() => { failedCallbackRan = true; }),
    changeState((state) => { state.epoch++; return state.epoch; }),
  ]);
  assert.equal(failedCallbackRan, false);
  assert.equal(results[0].status, 'rejected');
  assert.match(results[0].reason.message, /fixture read failure/);
  assert.deepEqual(results[1], { status: 'fulfilled', value: 1 });
  assert.deepEqual(storage.calls, ['get:1', 'get:2', 'set:1']);
});

test('publicState clears active and all saved gateway keys without changing private state', () => {
  const state = emptyState();
  state.settings.gateway.apiKey = 'fixture-active-only';
  state.settings.gateways = {
    openai: { apiKey: 'fixture-openai-only', model: 'model-a', protocol: 'openai' },
    gemini: { apiKey: 'fixture-gemini-only', model: 'model-b', protocol: 'gemini' },
    empty: { apiKey: '', hasKey: true },
  };
  state.videos.A = { notes: [{ text: '保留资料' }] };
  const before = structuredClone(state);
  const result = publicState(state);
  assert.equal(result.settings.gateway.apiKey, '');
  assert.equal(result.settings.gateway.hasKey, true);
  for (const name of ['openai', 'gemini']) {
    assert.equal(result.settings.gateways[name].apiKey, '');
    assert.equal(result.settings.gateways[name].hasKey, true);
    assert.equal(result.settings.gateways[name].model, state.settings.gateways[name].model);
  }
  assert.equal(result.settings.gateways.empty.apiKey, '');
  assert.equal(result.settings.gateways.empty.hasKey, false);
  for (const secret of ['fixture-active-only', 'fixture-openai-only', 'fixture-gemini-only']) assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(state, before);
  result.videos.A.notes[0].text = '只改公开副本';
  assert.equal(state.videos.A.notes[0].text, '保留资料');
});

test('publicState marks missing/empty keys false and never depends on a previously stored hasKey flag', () => {
  const state = emptyState();
  state.settings.gateway.hasKey = true;
  state.settings.gateways = { absent: { hasKey: true }, empty: { apiKey: '', hasKey: true } };
  const result = publicState(state);
  assert.equal(result.settings.gateway.hasKey, false);
  for (const gateway of Object.values(result.settings.gateways)) assert.deepEqual(gateway, { apiKey: '', hasKey: false });
});

test('publicState redaction never persists blanks over private storage keys', async (t) => {
  const state = emptyState();
  state.settings.gateway.apiKey = 'fixture-private-persisted';
  const storage = storageFixture(t, state);
  const result = publicState(await readState());
  assert.equal(result.settings.gateway.apiKey, '');
  assert.equal(storage.snapshot().settings.gateway.apiKey, 'fixture-private-persisted');
  assert.deepEqual(storage.counts(), { reads: 1, writes: 0 });
});

test('audit timestamps are milliseconds, newest first, and bounded to 200 records', () => {
  const state = emptyState();
  state.audit = Array.from({ length: 200 }, (_, i) => ({ action: `old-${i}`, result: '完成', at: i }));
  const before = Date.now();
  addAudit(state, '新操作', '已停止');
  assert.equal(state.audit.length, 200);
  assert.equal(state.audit[0].action, '新操作');
  assert.equal(state.audit[0].result, '已停止');
  assert.ok(state.audit[0].at >= before && state.audit[0].at <= Date.now());
  assert.equal(state.audit[1].action, 'old-0');
  assert.equal(state.audit.at(-1).action, 'old-198');
});

test('settings normalize selected folder IDs, safety limits, allowed timezone and retain unspecified fields', () => {
  const previous = { ...structuredClone(DEFAULT_SETTINGS), timezone: 'UTC', autoReports: true,
    gateway: { ...DEFAULT_SETTINGS.gateway, model: 'existing-model' } };
  const before = structuredClone(previous);
  const result = normalizeSettings({ folders: [42, '42', 7], batchLimit: 500, dailyHour: 24.9, autoCollect: 1 }, previous);
  assert.deepEqual(result.folders, ['42', '7']);
  assert.equal(result.batchLimit, 50);
  assert.equal(result.dailyHour, 23);
  assert.equal(result.timezone, 'UTC');
  assert.equal(result.autoCollect, true);
  assert.equal(result.autoReports, true);
  assert.equal(result.gateway.model, 'existing-model');
  assert.deepEqual(previous, before);
  const lower = normalizeSettings({ batchLimit: -2, dailyHour: -1, timezone: 'invalid-zone' });
  assert.equal(lower.batchLimit, 1);
  assert.equal(lower.dailyHour, 0);
  assert.equal(lower.timezone, 'Asia/Shanghai');
});
