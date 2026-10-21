import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleClassNotes } from '../src/notes.js';

const video = { url: 'https://www.bilibili.com/video/BV1f9ev6QEkT?p=1', language: 'ai-zh', summaryModel: 'fixture' };
const parts = [
  { start: 0, end: 1099, text: '### 什么是评测集\n\n评测集是治理工具。' },
  { start: 1099, end: 2200, text: '### 怎么建矩阵\n\n按失败成本分层。' },
];

test('class notes keep every detailed part, in transcript order, with ranges', () => {
  const md = assembleClassNotes(video, parts, {
    intro: '这份资料讲评测集怎么落地。',
    glossary: [{ term: '评测集', def: '可打分的题目与规则集合' }],
    checklist: ['先定红线指标'],
    questions: [{ q: '评测集与题库的区别？', a: '前者支撑决策' }],
  });
  assert.match(md, /^> 这份资料讲评测集怎么落地。/);
  assert.match(md, /## 术语表/);
  assert.match(md, /## 第 1 部分｜0:00 - 18:19/);
  assert.match(md, /评定集|评测集是治理工具/);
  assert.match(md, /## 第 2 部分｜18:19 - 36:40/);
  assert.ok(md.indexOf('第 1 部分') < md.indexOf('第 2 部分'));
  assert.match(md, /## 可落地清单/);
  assert.match(md, /## 复习题/);
  assert.match(md, /来源：https:\/\/www\.bilibili\.com\/video\/BV1f9ev6QEkT/);
});

test('missing scaffolding degrades to the notes themselves', () => {
  const md = assembleClassNotes(video, ['### 只有正文\n\n一句话。'], {});
  assert.match(md, /## 第 1 部分/);
  assert.ok(!md.includes('术语表'));
  assert.ok(!md.includes('undefined'));
});
