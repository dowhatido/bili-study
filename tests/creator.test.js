import test from 'node:test';
import assert from 'node:assert/strict';
import { createBilibiliClient } from '../src/bilibili.js';

const IMG = 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png';
const SUB = 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png';

function response(item, total, page) {
  return { code: 0, data: { page: { count: total, pn: page }, list: { vlist: item } } };
}
function makeRequest({ pages, total = 31, navCode = 0 }) {
  const calls = [];
  const request = async (path, params) => {
    calls.push({ path, params: { ...params } });
    if (path === '/x/web-interface/nav') {
      return { code: navCode, data: navCode === 0 ? { isLogin: true, wbi_img: { img_url: IMG, sub_url: SUB } } : null };
    }
    if (path === '/x/space/wbi/acc/info') return { code: 0, data: { name: '测试 UP 主' } };
    if (path === '/x/space/wbi/arc/search') {
      const pn = params.pn;
      return response(pages[pn - 1] ?? [], total, pn);
    }
    throw new Error(`unexpected ${path}`);
  };
  return { request, calls };
}

test('creator videos parse durations, preserve both pages and de-duplicate', async () => {
  const { request, calls } = makeRequest({ pages: [
    [{ bvid: 'BV139pu6qEFJ', title: '第一期', length: '12:52', created: 1792000000 },
      { bvid: 'BV1f9ev6QEkT', title: '长视频', length: '55:26', created: 1791000000 }],
    [{ bvid: 'BV139pu6qEFJ', title: '重复项', length: '12:52', created: 1792000000 },
      { bvid: 'BV1VHHR6AEp2', title: '第二期', length: '1:02:03', created: 1790000000 }],
  ], total: 3 });
  const client = createBilibiliClient({ request });
  const result = await client.getCreatorVideos(10001, { maxPages: 10 });
  assert.equal(result.items.length, 3);
  assert.equal(result.total, 3);
  assert.equal(result.hasMore, false);
  assert.deepEqual(result.items.map((v) => v.duration), [772, 3326, 3723]);
  assert.equal(result.items[0].url, 'https://www.bilibili.com/video/BV139pu6qEFJ?p=1');
  assert.equal(calls.filter((c) => c.path === '/x/space/wbi/arc/search').length, 2);
  const signed = calls.find((c) => c.path === '/x/space/wbi/arc/search');
  assert.ok(signed.params.w_rid && signed.params.wts, 'space request must be WBI signed');
});

test('creator info returns the account name through the signed endpoint', async () => {
  const { request } = makeRequest({ pages: [[]] });
  const client = createBilibiliClient({ request });
  assert.deepEqual(await client.getCreatorInfo(10001), { mid: 10001, name: '测试 UP 主' });
});

test('risk control is surfaced instead of returning an empty creator list', async () => {
  const { request } = makeRequest({ pages: [[]], navCode: -352 });
  const client = createBilibiliClient({ request });
  await assert.rejects(client.getCreatorVideos(10001), (error) => error.code === 'RISK_CONTROL');
});

test('creator list stops at the page cap and reports truncation', async () => {
  const pages = Array.from({ length: 5 }, (_, i) => [
    { bvid: `BV1${String(i).padStart(9, '0')}`, title: `第${i}页`, length: '01:00', created: 1792000000 },
  ]);
  const { request, calls } = makeRequest({ pages, total: 500 });
  const result = await createBilibiliClient({ request }).getCreatorVideos(10001, { maxPages: 2 });
  assert.equal(calls.filter((c) => c.path === '/x/space/wbi/arc/search').length, 2);
  assert.equal(result.hasMore, true);
});
