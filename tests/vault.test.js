import test from 'node:test';
import assert from 'node:assert/strict';
import { writeSnapshot } from '../src/vault.js';

const doc = { category: '视频资料', filename: '我的笔记.md', text: '# 学习\n\n中文与 English' };
function fixture({ permission = 'granted', exists = false, writeError = false, corrupt = false } = {}) {
  const calls = []; let text = '';
  const file = { async createWritable() { calls.push('create'); return {
    async write(value) { calls.push('write'); if (writeError) throw new Error('disk'); text = value; },
    async close() { calls.push('close'); }, async abort() { calls.push('abort'); },
  }; }, async getFile() { calls.push('readback'); return { async text() { return corrupt ? '损坏' : text; } }; } };
  const folder = { async getFileHandle(name, options) {
    calls.push(options?.create ? 'open-new' : 'exists-check');
    if (!options?.create && !exists) throw Object.assign(new Error(), { name: 'NotFoundError' });
    return file;
  } };
  const root = { async getDirectoryHandle() { return folder; } };
  const handle = { async queryPermission() { return permission; }, async requestPermission() { return permission; }, async getDirectoryHandle() { return root; } };
  return { handle, calls };
}
test('snapshot writes complete Markdown and reads it back before reporting success', async () => {
  const f = fixture();
  const path = await writeSnapshot(f.handle, doc, 0, '12345678-abc');
  assert.match(path, /^Bili Study\/视频资料\/我的笔记-1970.*12345678\.md$/);
  assert.deepEqual(f.calls, ['exists-check','open-new','create','write','close','readback']);
});
test('existing filename is never opened for writing', async () => {
  const f = fixture({ exists: true });
  await assert.rejects(writeSnapshot(f.handle, doc), /同名快照/);
  assert.deepEqual(f.calls, ['exists-check']);
});
test('permission denial and invalid document never create files', async () => {
  const f = fixture({ permission: 'denied' });
  await assert.rejects(writeSnapshot(f.handle, doc), /权限/);
  await assert.rejects(writeSnapshot(f.handle, { ...doc, category: '../' }), /不正确/);
  await assert.rejects(writeSnapshot(f.handle, { ...doc, filename: '../a.md' }), /不正确/);
  await assert.rejects(writeSnapshot(null, doc), /文件夹/);
  assert.deepEqual(f.calls, []);
});
test('write failure aborts without claiming success', async () => {
  const f = fixture({ writeError: true });
  await assert.rejects(writeSnapshot(f.handle, doc), /保存未完成/);
  assert.ok(f.calls.includes('abort')); assert.ok(!f.calls.includes('readback'));
});
test('readback mismatch fails instead of claiming a verified save', async () => {
  const f = fixture({ corrupt: true });
  await assert.rejects(writeSnapshot(f.handle, doc), /核对未通过/);
});
