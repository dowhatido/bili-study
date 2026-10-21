import test from 'node:test';
import assert from 'node:assert/strict';
import { flushVaultQueue } from '../src/vault-queue.js';

const videos = {
  a: { key: 'a', summary: '甲', vaultPending: true },
  b: { key: 'b', summary: '乙', vaultPending: true },
  c: { key: 'c', summary: '', vaultPending: true },
  d: { key: 'd', summary: '丁' },
};

test('pending summaries are written and results recorded', async () => {
  const marks = [];
  const saved = [];
  const result = await flushVaultQueue(videos, {
    save: async (video) => { saved.push(video.key); return `Bili Study/${video.key}.md`; },
    mark: async (key, patch) => marks.push([key, patch]),
  });
  assert.deepEqual(saved, ['a', 'b']);
  assert.deepEqual(marks, [['a', { path: 'Bili Study/a.md' }], ['b', { path: 'Bili Study/b.md' }]]);
  assert.deepEqual(result, { total: 2, processed: 2 });
});

test('a failed write is recorded on the video instead of aborting the queue', async () => {
  const marks = [];
  await flushVaultQueue({ a: videos.a, b: videos.b }, {
    save: async (video) => { if (video.key === 'a') throw new Error('尚未获得写入权限'); return 'ok.md'; },
    mark: async (key, patch) => marks.push([key, patch]),
  });
  assert.deepEqual(marks[0], ['a', { error: '尚未获得写入权限' }]);
  assert.deepEqual(marks[1], ['b', { path: 'ok.md' }]);
});

test('the batch is bounded per poll', async () => {
  const many = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`v${i}`, { key: `v${i}`, summary: 'x', vaultPending: true }]));
  const saved = [];
  const result = await flushVaultQueue(many, { save: async (v) => { saved.push(v.key); return 'p.md'; }, mark: async () => {}, limit: 3 });
  assert.equal(saved.length, 3);
  assert.deepEqual(result, { total: 6, processed: 3 });
});
