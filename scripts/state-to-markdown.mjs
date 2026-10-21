// Convert an exported extension-state JSON dump into Markdown files for Feishu import.
// Usage: node scripts/state-to-markdown.mjs <state.json> <output-dir>
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { videoMarkdown, collectionMarkdown } from '../src/markdown.js';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('用法：node scripts/state-to-markdown.mjs <state.json> <output-dir>');
  process.exit(1);
}
const state = JSON.parse(await readFile(input, 'utf8'));
const videos = Object.values(state.videos || {}).filter(v => v?.summary && v?.segments?.length);
const creator = state.creator;
if (!videos.length) {
  console.error('导出文件里没有带摘要的视频。');
  process.exit(1);
}
const dir = path.resolve(output);
await mkdir(dir, { recursive: true });

let written = 0;
for (const video of videos) {
  const doc = videoMarkdown(video);
  await writeFile(path.join(dir, doc.filename), doc.text, { flag: 'wx' });
  written += 1;
}
console.log(`已写出 ${written} 篇视频资料 → ${dir}`);

if (creator?.summary) {
  const items = creator.items || [];
  const summarized = new Set(videos.map(v => v.bvid));
  const payload = {
    ...creator,
    items: items.map(item => ({ ...item, summarized: summarized.has(item.bvid) })),
    covered: videos.length,
  };
  const doc = collectionMarkdown(payload);
  await writeFile(path.join(dir, doc.filename), doc.text, { flag: 'wx' });
  console.log(`已写出汇总 → ${path.join(dir, doc.filename)}`);
} else {
  console.log('没有跨作品汇总（creator.summary 为空）。');
}
