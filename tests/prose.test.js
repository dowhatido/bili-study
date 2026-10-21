import test from 'node:test';
import assert from 'node:assert/strict';

function node(tag) {
  return {
    tag, className: '', dataset: {}, children: [],
    append(...items) { this.children.push(...items); },
    replaceChildren() { this.children = []; },
    get textContent() { return this.children.map((c) => (c.textNode ? c.text : c.textContent || '')).join(''); },
    set textContent(value) { this.children = value === '' ? [] : [{ textNode: true, text: String(value) }]; },
  };
}
globalThis.document = {
  createElement: (tag) => node(tag),
  createTextNode: (text) => ({ textNode: true, text }),
};

const { renderProse } = await import('../src/prose.js');
const render = (text) => { const host = node('article'); renderProse(host, text); return host.children; };

test('blank input renders one honest placeholder paragraph', () => {
  const [only] = render('');
  assert.equal(only.tag, 'p');
  assert.equal(only.textContent, '暂无内容。');
});

test('headings, paragraphs and lists become separate structural blocks', () => {
  const blocks = render('# 标题\n\n第一段\n\n- 甲\n- 乙\n\n1. 丙');
  assert.deepEqual(blocks.map((b) => b.tag), ['h3', 'p', 'ul', 'ul']);
  assert.equal(blocks[0].textContent, '标题');
  assert.equal(blocks[1].textContent, '第一段');
  assert.equal(blocks[2].children.length, 2);
  assert.equal(blocks[2].children[0].textContent, '甲');
  assert.equal(blocks[3].children[0].dataset.marker, '1.');
  assert.equal(blocks[3].children[0].textContent, '丙');
});

test('inline bold and code stay structured, never literal asterisks or backticks', () => {
  const [paragraph] = render('要点是 **证据先固定**，再看 `prompt` 版本。');
  const kinds = paragraph.children.map((c) => c.tag || 'text');
  assert.deepEqual(kinds, ['text', 'strong', 'text', 'code', 'text']);
  assert.equal(paragraph.children[1].textContent, '证据先固定');
  assert.equal(paragraph.children[3].textContent, 'prompt');
  assert.ok(!JSON.stringify(paragraph).includes('**'));
});

test('list groups close when a paragraph interrupts them', () => {
  const blocks = render('- 甲\n\n中间段落\n\n- 乙');
  assert.deepEqual(blocks.map((b) => b.tag), ['ul', 'p', 'ul']);
});

test('untrusted angle brackets stay as text and never become markup', () => {
  const [paragraph] = render('<img src=x onerror=alert(1)>');
  assert.equal(paragraph.children[0].text, '<img src=x onerror=alert(1)>');
  assert.equal(paragraph.children[0].textNode, true);
});
