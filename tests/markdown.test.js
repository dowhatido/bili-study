import test from 'node:test';
import assert from 'node:assert/strict';
import { safeFilename, videoMarkdown, conversationMarkdown, reportMarkdown } from '../src/markdown.js';

const BV = 'BV17x411w7KC';
function video(extra = {}) {
  return { bvid: BV, cid: 67890, page: 2, title: '机器学习：入门', partTitle: '第二课', author: '中文老师',
    url: `https://www.bilibili.com/video/${BV}?p=2`, language: 'ai-zh',
    summary: '摘要保持否定：不能把观看等同掌握。', summaryModel: 'fixture-model', updatedAt: Date.parse('2026-10-15T01:02:03Z'),
    notes: [{ id: 'n1', start: 12.9, text: '个人笔记一' }, { id: 'n2', start: 61, text: '个人笔记二' }],
    segments: [{ id: 'g0', start: 0, end: 2, text: '第一句中文。' },
      { id: 'g1', start: 61.8, end: 63, text: '第二句中文。' }, { id: 'g2', start: 125, end: 130, text: '最后一句中文。' }],
    ...extra };
}

function metadata(markdown) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  assert.ok(match, 'must start with a single frontmatter block');
  return Object.fromEntries(match[1].split('\n').map((line) => {
    const [, key, value] = /^([^:]+): (.*)$/.exec(line);
    return [key, value.startsWith('"') ? JSON.parse(value) : value];
  }));
}

test('Chinese filenames survive normalization while path characters/control bytes are removed', () => {
  assert.equal(safeFilename('  学习：机器／智能？  第一课.  '), '学习机器智能 第一课');
  assert.equal(safeFilename('../课程\\章节:*?"<>|\u0000\n'), '..课程章节');
  assert.equal(safeFilename('...  '), '未命名');
  assert.equal(safeFilename(''), '未命名');
  assert.equal(safeFilename('中'.repeat(100)).length, 90);
});

test('video export has Chinese filename/category, part identity and complete metadata', () => {
  const source = video();
  const before = structuredClone(source);
  const result = videoMarkdown(source);
  assert.equal(result.filename, `机器学习入门 · 第二课-${BV}-67890.md`);
  assert.equal(result.category, '视频资料');
  assert.deepEqual(metadata(result.text), { type: 'bili-video', source: source.url, bvid: BV,
    cid: '67890', language: 'ai-zh', model: 'fixture-model', updated: '2026-10-15T01:02:03.000Z' });
  assert.match(result.text, /# 机器学习：入门 · 第二课\n/);
  assert.ok(result.text.includes(source.summary));
  assert.match(result.text, /UP 主：中文老师/);
  assert.match(result.text, /## 字幕/);
  for (const s of source.segments) assert.ok(result.text.includes(s.text));
  assert.deepEqual(source, before);
});

test('metadata quotes newlines/quotes safely and headings cannot inject another heading line', () => {
  const model = 'fixture:"quoted"\nnew_key: injected';
  const result = videoMarkdown(video({ summaryModel: model, title: '标题\n# 伪标题', partTitle: '' }));
  assert.equal(metadata(result.text).model, model);
  assert.equal(result.text.includes('\nnew_key: injected\n'), false);
  assert.equal(result.text.includes('\n# 伪标题\n'), false);
  assert.ok(result.text.includes('# 标题 # 伪标题'));
});

test('notes and caption links preserve P2 and seek seconds, never milliseconds', () => {
  const result = videoMarkdown(video());
  assert.ok(result.text.includes(`[0:12](https://www.bilibili.com/video/${BV}?p=2&t=12) 个人笔记一`));
  assert.ok(result.text.includes(`[1:01](https://www.bilibili.com/video/${BV}?p=2&t=61)`));
  assert.ok(result.text.includes(`[2:05](https://www.bilibili.com/video/${BV}?p=2&t=125)`));
  assert.equal(result.text.includes('t=61800'), false);
});

test('subtitle export remains available without translation state and avoids duplicate part titles', () => {
  const result = videoMarkdown(video({ partTitle: '机器学习：入门' }));
  assert.equal(result.filename, `机器学习入门-${BV}-67890.md`);
  assert.equal(result.text.includes('机器学习：入门 · 机器学习：入门'), false);
  assert.ok(result.text.includes('最后一句中文。'));
});

test('full conversation exports all messages, long content, summary and trusted citations without truncation', () => {
  const messages = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user',
    content: `消息-${i}-唯一标记${'长对话内容'.repeat(50)}`, ...(i === 39 ? {
      citations: [{ id: 'g1', start: 61.8, text: '用于核对的完整原文。' }],
    } : {}) }));
  const conversation = { id: 'conversation-42', summary: '讨论摘要不能替代完整消息。', messages };
  const before = structuredClone(conversation);
  const source = video();
  const result = conversationMarkdown(source, conversation);
  assert.equal(result.filename, `机器学习入门-${BV}-67890-完整对话.md`);
  assert.equal(result.category, '视频讨论');
  const frontmatter = metadata(result.text);
  assert.equal(frontmatter.type, 'bili-conversation');
  assert.equal(frontmatter.source, source.url);
  assert.equal(frontmatter.bvid, BV);
  assert.equal(frontmatter.cid, '67890');
  assert.equal(frontmatter.conversation, conversation.id);
  assert.ok(Number.isFinite(Date.parse(frontmatter.updated)));
  assert.equal((result.text.match(/^## 我的问题$/gm) || []).length, 20);
  assert.equal((result.text.match(/^## AI 回答$/gm) || []).length, 20);
  let previous = -1;
  for (const message of messages) {
    const index = result.text.indexOf(message.content);
    assert.ok(index > previous, 'every message must be exported whole and in order');
    previous = index;
  }
  assert.ok(result.text.includes(conversation.summary));
  assert.ok(result.text.includes(`[1:01](https://www.bilibili.com/video/${BV}?p=2&t=61) 用于核对的完整原文。`));
  assert.deepEqual(conversation, before);
});

test('summary-only conversation export is explicit and refuses an absent summary', () => {
  const conversation = { id: 'discussion', summary: '整理后的讨论。', messages: [{ role: 'user', content: '仅用于全量导出的问题' }] };
  const result = conversationMarkdown(video(), conversation, { summaryOnly: true });
  assert.ok(result.filename.endsWith('-讨论笔记.md'));
  assert.ok(result.text.includes(conversation.summary));
  assert.equal(result.text.includes(conversation.messages[0].content), false);
  assert.throws(() => conversationMarkdown(video(), { id: 'empty' }, { summaryOnly: true }), /请先整理本次讨论/);
});

test('complete conversation without a summary still exports the first and final exchange', () => {
  const result = conversationMarkdown(video(), { id: 'no-summary', messages: [
    { role: 'user', content: '第一条完整问题' }, { role: 'assistant', content: '最后一条完整回答' },
  ] });
  assert.ok(result.text.includes('第一条完整问题'));
  assert.ok(result.text.includes('最后一条完整回答'));
});

for (const kind of ['daily', 'weekly']) test(`report Markdown preserves ${kind} dates/timezone/model, sources and share caveat`, () => {
  const report = { kind, start: '2025-12-29', end: '2026-01-01', timeZone: 'Asia/Shanghai',
    model: 'fixture-report-model', text: '基于真实记录生成的回顾。', videos: [
      { title: '中文课程', url: `https://www.bilibili.com/video/${BV}?p=2` },
    ] };
  const before = structuredClone(report);
  const result = reportMarkdown(report);
  assert.equal(result.filename, `${kind === 'daily' ? '日报' : '周报'}-2025-12-29-2026-01-01.md`);
  assert.equal(result.category, '学习回顾');
  assert.deepEqual(metadata(result.text), { type: 'bili-report', start: report.start, end: report.end,
    timezone: report.timeZone, model: report.model });
  assert.ok(result.text.includes(report.text));
  assert.ok(result.text.includes(`[中文课程](${report.videos[0].url})`));
  assert.match(result.text, /不代表分享成功或完整转发历史/);
  assert.deepEqual(report, before);
});
