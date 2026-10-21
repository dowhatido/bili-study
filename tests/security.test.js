import test from 'node:test';
import assert from 'node:assert/strict';
import { videoMarkdown } from '../src/markdown.js';
test('export cannot turn untrusted subtitles or model output into active HTML/image embeds', () => {
  const input = '<script>alert(1)</script> ![track](https://evil.test/image) ![[secret]]';
  const video = { bvid:'BV17x411w7KC', cid:1, title:'安全导出', url:'https://www.bilibili.com/video/BV17x411w7KC/',
    language:'zh', summary:input, segments:[{id:'g0',start:0,end:1,text:input}], notes:[] };
  const doc = videoMarkdown(video);
  assert.ok(!doc.text.includes('<script>')); assert.ok(doc.text.includes('&lt;script&gt;'));
  assert.ok(doc.text.includes('\\![track]')); assert.ok(doc.text.includes('\\![[secret]]'));
});
test('export rejects unsafe source schemes and hosts', () => {
  for (const url of ['javascript:alert(1)', 'https://evil.test/video/BV17x411w7KC/']) {
    assert.throws(()=>videoMarkdown({bvid:'BV17x411w7KC',title:'视频',url,segments:[]}),/来源地址/);
  }
});
