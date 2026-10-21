import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionMarkdown } from '../src/markdown.js';

const creator = {
  mid: 10001, name: '测试 UP 主', covered: 2, summaryModel: 'fixture-model', summaryAt: Date.parse('2026-10-19T10:00:00Z'),
  summary: '# 选题地图\n\n围绕面试拆解展开。',
  items: [
    { bvid: 'BV139pu6qEFJ', title: '第一期', duration: 772, url: 'https://www.bilibili.com/video/BV139pu6qEFJ?p=1', summarized: true },
    { bvid: 'BV1f9ev6QEkT', title: '长视频', duration: 3326, url: 'https://www.bilibili.com/video/BV1f9ev6QEkT?p=1', summarized: true },
    { bvid: 'BV1VHHR6AEp2', title: '未完成', duration: 632, url: 'https://www.bilibili.com/video/BV1VHHR6AEp2?p=1' },
  ],
};

test('collection Markdown keeps coverage, sources and the unfinished list', () => {
  const doc = collectionMarkdown(creator);
  assert.equal(doc.category, '学习回顾');
  assert.match(doc.filename, /^测试 UP 主作品汇总-10001\.md$/);
  assert.match(doc.text, /作品总数：3/);
  assert.match(doc.text, /已覆盖：2/);
  assert.match(doc.text, /\[第一期\]\(https:\/\/www\.bilibili\.com\/video\/BV139pu6qEFJ\?p=1\)/);
  assert.match(doc.text, /未完成.*未生成摘要/);
  assert.ok(!doc.text.includes('undefined'));
});

test('collection Markdown states the missing summary instead of inventing one', () => {
  const doc = collectionMarkdown({ ...creator, summary: '' });
  assert.match(doc.text, /尚未生成汇总/);
});
