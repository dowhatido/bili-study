import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  parseVideoUrl, videoKey, canonicalVideoUrl, createWbiSignature, createBilibiliClient,
} from '../src/bilibili.js';

const BV = 'BV17x411w7KC';
const OTHER_BV = 'BV1sK4y147ob';
const VIDEO = { bvid: BV, aid: 170001, cid: 12345, page: 1 };
const KEYS = { imgKey: '7cd084941338484aae1ad9425b84077c', subKey: '4932caff0ff746eab6f01bf08b70ac45' };
const ok = (data) => ({ code: 0, data });
const NAV = ok({ isLogin: true, mid: 42, uname: '学习者', wbi_img: {
  img_url: `https://i0.hdslb.com/bfs/wbi/${KEYS.imgKey}.png`,
  sub_url: `https://i0.hdslb.com/bfs/wbi/${KEYS.subKey}.png`,
} });
const VIEW = { bvid: BV, aid: VIDEO.aid, cid: VIDEO.cid, videos: 2, title: '课程', desc: '简介',
  owner: { name: '老师' }, pages: [
    { page: 1, cid: 12345, part: '第一课', duration: 100 },
    { page: 2, cid: 67890, part: '第二课', duration: 200 },
  ] };
const CDN = 'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/12345_zh.json?auth_key=temporary';
const BODY = { body: [{ from: 0, to: 2.5, content: '你好' }, { from: 3, to: 4, content: '世界' }] };
const track = (url = CDN, lan = 'ai-zh') => ({ subtitle_url: url, lan });
const metadata = (tracks = [track()], context = {}) => ok({ ...context, subtitle: { subtitles: tracks } });
const isCode = (code) => (error) => {
  assert.equal(error.code, code, error.message);
  assert.match(error.message, /[\u4e00-\u9fff]/);
  assert.doesNotMatch(error.message, /auth_key|temporary|SESSDATA|w_rid/);
  return true;
};

function fixture(overrides = {}, resourceCandidates = []) {
  const calls = [];
  const request = async (path, params = {}) => {
    calls.push({ path, params });
    if (Object.hasOwn(overrides, path)) {
      const value = overrides[path];
      return typeof value === 'function' ? value(params, calls) : structuredClone(value);
    }
    if (path === '/x/web-interface/nav') return structuredClone(NAV);
    if (path === '/x/web-interface/view') return ok(structuredClone(VIEW));
    if (path === '/x/player/wbi/v2') return metadata();
    if (path === CDN) return structuredClone(BODY);
    throw Object.assign(new Error('unexpected network URL auth_key=temporary'), { status: 500 });
  };
  return { client: createBilibiliClient({ request, resourceCandidates }), calls };
}

test('normal BVID, exact origin and query P parse correctly', () => {
  assert.deepEqual(parseVideoUrl(`https://www.bilibili.com/video/${BV}`), { bvid: BV, page: 1 });
  assert.deepEqual(parseVideoUrl(`https://www.bilibili.com/video/${BV}/?p=2&spm_id_from=1#x`), { bvid: BV, page: 2 });
  assert.deepEqual(parseVideoUrl(`http://www.bilibili.com/video/${BV}?p=1`), { bvid: BV, page: 1 });
});

for (const url of [
  `https://bilibili.com/video/${BV}`, `https://m.bilibili.com/video/${BV}`,
  `https://www.bilibili.com.evil.test/video/${BV}`, `https://evil.test/?url=https://www.bilibili.com/video/${BV}`,
  `https://www.bilibili.com:8443/video/${BV}`, `https://user@www.bilibili.com/video/${BV}`,
  `ftp://www.bilibili.com/video/${BV}`, `https://www.bilibili.com/video/${BV}/more`,
  `https://www.bilibili.com/video/bv17x411w7KC`, `https://www.bilibili.com/video/${BV}x`,
  `https://www.bilibili.com/video/BV0000000000`, `https://www.bilibili.com/video/av170001`,
  `https://www.bilibili.com/video/${BV}?p=0`, `https://www.bilibili.com/video/${BV}?p=-1`,
  `https://www.bilibili.com/video/${BV}?p=1.5`, `https://www.bilibili.com/video/${BV}?p=`,
  `https://www.bilibili.com/video/${BV}?p=2&p=1`, `https://www.bilibili.com/video/${BV}?p=9007199254740992`,
  'not a URL', null,
]) test(`URL rejected: ${url}`, () => assert.equal(parseVideoUrl(url), null));

test('keys are BVID + exact CID; canonical URL preserves P and seek seconds', () => {
  assert.equal(videoKey(VIDEO), `bilibili:${BV}:12345`);
  assert.equal(videoKey({ ...VIDEO, cid: '12345' }), videoKey(VIDEO));
  assert.notEqual(videoKey(VIDEO), videoKey({ ...VIDEO, cid: 67890 }));
  assert.equal(canonicalVideoUrl({ ...VIDEO, page: 2 }, 12.9), `https://www.bilibili.com/video/${BV}?p=2&t=12`);
  assert.equal(canonicalVideoUrl(VIDEO, 0), `https://www.bilibili.com/video/${BV}?p=1&t=0`);
  assert.throws(() => videoKey({ ...VIDEO, cid: 0 }), isCode('INVALID_VIDEO'));
  assert.throws(() => videoKey({ ...VIDEO, cid: Number.MAX_SAFE_INTEGER + 1 }), isCode('INVALID_VIDEO'));
  assert.throws(() => canonicalVideoUrl(VIDEO, -1), isCode('INVALID_ARGUMENT'));
});

test('WBI fixed public reference vector; pure, synchronous and non-mutating', () => {
  const params = Object.freeze({ foo: '114', bar: '514', zab: 1919810, wts: 1702204169 });
  const signed = createWbiSignature(params, Object.freeze(KEYS));
  assert.deepEqual(signed, { bar: '514', foo: '114', wts: '1702204169', zab: '1919810',
    w_rid: '8f6f2b5b3d485fe1886cec6a0be8c5d4' });
  assert.deepEqual(createWbiSignature(params, { img_key: KEYS.imgKey, sub_key: KEYS.subKey }), signed);
  assert.equal(params.w_rid, undefined);
});

test('browser MD5/WBI matches Node oracle across Unicode, padding and multiblock lengths', () => {
  const mixin = 'ea1db124af3c7062474693fa704f4ff8';
  for (const length of [0, 1, 15, 31, 32, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1000, 4096]) {
    const params = { text: `${'a'.repeat(length)}!'()*中文 🙂 空格`, wts: 1702204169, w_rid: 'old' };
    const signed = createWbiSignature(params, KEYS);
    const clean = params.text.replace(/[!'()*]/g, '');
    const query = `text=${encodeURIComponent(clean)}&wts=1702204169`;
    assert.equal(signed.w_rid, createHash('md5').update(query + mixin).digest('hex'), `length ${length}`);
    assert.equal(signed.text, clean);
  }
});

test('WBI rejects missing keys, missing time, objects and malformed Unicode', () => {
  assert.throws(() => createWbiSignature({ wts: 1 }, {}), isCode('INVALID_WBI_KEYS'));
  for (const params of [{}, { wts: -1 }, { wts: 1, foo: {} }, { wts: 1, foo: '\ud800' }, { wts: 1, foo: Infinity }]) {
    assert.throws(() => createWbiSignature(params, KEYS), isCode('INVALID_ARGUMENT'));
  }
});

test('video P2 resolves pages[].cid and part duration, not top-level P1', async () => {
  const { client, calls } = fixture();
  const video = await client.getVideo({ bvid: BV, page: 2 });
  assert.deepEqual(video, { key: `bilibili:${BV}:67890`, bvid: BV, aid: VIDEO.aid, cid: 67890, page: 2,
    title: '课程', partTitle: '第二课', author: '老师', description: '简介', duration: 200,
    url: `https://www.bilibili.com/video/${BV}?p=2` });
  assert.deepEqual(calls, [{ path: '/x/web-interface/view', params: { bvid: BV } }]);
  await assert.rejects(client.getVideo({ bvid: BV, page: 3 }), isCode('INVALID_VIDEO'));
});

test('wrong BVID, missing CID and unknown P fail closed', async () => {
  await assert.rejects(fixture({ '/x/web-interface/view': ok({ ...VIEW, bvid: OTHER_BV }) }).client.getVideo(VIDEO), isCode('CONTEXT_MISMATCH'));
  await assert.rejects(fixture({ '/x/web-interface/view': ok({ ...VIEW, pages: [{ page: 1 }] }) }).client.getVideo(VIDEO), isCode('INVALID_RESPONSE'));
  const { client, calls } = fixture();
  await assert.rejects(client.getVideo({ bvid: 'BVbad' }), isCode('INVALID_VIDEO'));
  assert.equal(calls.length, 0);
});

test('view rejects truncated, duplicate or noncontiguous pages instead of falling back to P1', async () => {
  for (const pages of [
    [], [VIEW.pages[0]], [VIEW.pages[0], VIEW.pages[0]],
    [VIEW.pages[0], { ...VIEW.pages[1], cid: VIEW.pages[0].cid }],
    [VIEW.pages[0], { ...VIEW.pages[1], page: 3 }],
  ]) {
    await assert.rejects(fixture({ '/x/web-interface/view': ok({ ...VIEW, pages }) }).client.getVideo({ bvid: BV, page: 2 }), isCode('INVALID_RESPONSE'));
  }
  const { client } = fixture({ '/x/web-interface/view': ok({ ...VIEW, pages: [...VIEW.pages].reverse() }) });
  assert.equal((await client.getVideo({ bvid: BV, page: 2 })).cid, 67890);
});

test('signed transcript uses current aid/BVID/CID; never calls legacy player/v2', async () => {
  const { client, calls } = fixture();
  const result = await client.getTranscript(VIDEO);
  assert.deepEqual(result, { language: 'ai-zh', source: 'signed-wbi', segments: [
    { id: `bilibili:${BV}:12345:0`, start: 0, end: 2.5, text: '你好' },
    { id: `bilibili:${BV}:12345:1`, start: 3, end: 4, text: '世界' },
  ] });
  const params = calls.find((call) => call.path === '/x/player/wbi/v2').params;
  assert.equal(params.cid, '12345');
  assert.equal(params.aid, String(VIDEO.aid));
  assert.equal(params.bvid, BV);
  assert.match(params.w_rid, /^[a-f0-9]{32}$/);
  assert.deepEqual(params, createWbiSignature(params, KEYS));
  assert.ok(!calls.some((call) => call.path === '/x/player/v2'));
  assert.deepEqual(calls.find((call) => call.path === CDN).params, {});
});

test('subtitle rows sort, deduplicate and retain overlaps and fractional times', async () => {
  const row = { from: 2.1, to: 5.2, content: '  同一句  ' };
  const { client } = fixture({ [CDN]: { body: [row, { from: 0.5, to: 3, content: '重叠' }, row] } });
  const result = await client.getTranscript(VIDEO);
  assert.deepEqual(result.segments.map(({ start, end, text }) => ({ start, end, text })), [
    { start: 0.5, end: 3, text: '重叠' }, { start: 2.1, end: 5.2, text: '同一句' },
  ]);
});

for (const body of [[], [{ from: 1, to: 0, content: '错误' }], [{ from: 1, to: 1, content: '错误' }],
  [{ from: -1, to: 1, content: '错误' }], [{ from: '0', to: 1, content: '错误' }],
  [{ from: 0, to: Infinity, content: '错误' }], [{ from: 0, to: 1, content: '  ' }], [null]]) {
  test(`invalid subtitles fail closed: ${JSON.stringify(body)}`, async () => {
    await assert.rejects(fixture({ [CDN]: { body } }).client.getTranscript(VIDEO), isCode('INVALID_CAPTIONS'));
  });
}

test('human Chinese is preferred to AI Chinese; protocol-relative trusted URL works', async () => {
  const url = '//i0.hdslb.com/bfs/subtitle/opaque.json';
  const { client } = fixture({ '/x/player/wbi/v2': metadata([track(CDN), track(url, 'zh-Hans')]),
    'https://i0.hdslb.com/bfs/subtitle/opaque.json': BODY });
  assert.equal((await client.getTranscript(VIDEO)).language, 'zh-Hans');
});

for (const context of [{ cid: 67890 }, { aid: 2 }, { bvid: OTHER_BV }]) {
  test(`signed metadata ownership rejected: ${JSON.stringify(context)}`, async () => {
    const { client, calls } = fixture({ '/x/player/wbi/v2': metadata([track()], context) });
    await assert.rejects(client.getTranscript(VIDEO), isCode('CONTEXT_MISMATCH'));
    assert.equal(calls.filter((call) => call.path.startsWith('https:')).length, 0);
  });
}

test('wrong input CID/aid/key cannot borrow metadata for a different part', async () => {
  for (const input of [{ ...VIDEO, cid: 67890 }, { ...VIDEO, aid: 9 }, { ...VIDEO, key: 'other' }]) {
    const { client, calls } = fixture();
    await assert.rejects(client.getTranscript(input), isCode('CONTEXT_MISMATCH'));
    assert.ok(!calls.some((call) => call.path === '/x/player/wbi/v2'));
  }
});

for (const url of [
  'https://evil.test/bfs/subtitle/12345.json', 'https://aisubtitle.hdslb.com.evil.test/bfs/subtitle/12345.json',
  'https://user:secret@aisubtitle.hdslb.com/bfs/subtitle/12345.json',
  'https://aisubtitle.hdslb.com:8443/bfs/subtitle/12345.json',
  'https://aisubtitle.hdslb.com/private/12345.json', 'http://127.0.0.1/bfs/subtitle/12345.json',
  'javascript:alert(1)', 'data:application/json,{}', '/bfs/subtitle/12345.json',
]) test(`unsafe signed subtitle URL is never requested: ${url}`, async () => {
  const { client, calls } = fixture({ '/x/player/wbi/v2': metadata([track(url)]) });
  await assert.rejects(client.getTranscript(VIDEO), isCode('UNSAFE_SUBTITLE_URL'));
  assert.ok(!calls.some((call) => call.path === url));
});

test('resource fallback accepts performance name with exact decimal CID token', async () => {
  const { client } = fixture({ '/x/player/wbi/v2': metadata([]) }, [{ name: CDN }]);
  assert.deepEqual(await client.getTranscript(VIDEO), { language: 'und', source: 'player-resource',
    segments: [
      { id: `bilibili:${BV}:12345:0`, start: 0, end: 2.5, text: '你好' },
      { id: `bilibili:${BV}:12345:1`, start: 3, end: 4, text: '世界' },
    ] });
});

test('explicit cid query accepted; arbitrary query values and substring CID are not proof', async () => {
  const valid = 'https://hds.hdslb.com/bfs/subtitle/opaque.json?cid=12345';
  const { client } = fixture({ '/x/player/wbi/v2': metadata([]), [valid]: BODY }, [{ url: valid, language: 'zh-Hans' }]);
  assert.equal((await client.getTranscript(VIDEO)).language, 'zh-Hans');
  const invalid = [
    CDN.replace('12345_', '912345_'), CDN.replace('12345_', '123456_'), CDN.replace('12345_', 'abc12345def_'),
    'https://hds.hdslb.com/bfs/subtitle/opaque.json?auth_key=12345',
    'https://hds.hdslb.com/bfs/subtitle/12345.json?cid=67890',
    'https://hds.hdslb.com/bfs/subtitle/opaque.json?cid=12345&cid=67890',
    `https://hds.hdslb.com/bfs/subtitle/12345.json?bvid=${OTHER_BV}`,
    'https://hds.hdslb.com/bfs/subtitle/170001.json',
    'https://evil.test/bfs/subtitle/12345.json',
    { url: CDN, bvid: OTHER_BV }, { url: CDN, cid: 67890 },
    { url: 'https://hds.hdslb.com/bfs/subtitle/opaque.json', cid: 12345 },
  ];
  const rejected = fixture({ '/x/player/wbi/v2': metadata([]) }, invalid);
  await assert.rejects(rejected.client.getTranscript(VIDEO), isCode('CAPTIONS_UNAVAILABLE'));
  assert.equal(rejected.calls.filter((call) => !call.path.startsWith('/x/')).length, 0);
});

test('expired subtitle HTTP 403 refreshes metadata once and succeeds on new URL', async () => {
  let discovery = 0;
  const fresh = CDN.replace('temporary', 'fresh');
  const { client, calls } = fixture({
    '/x/player/wbi/v2': () => metadata([track(++discovery === 1 ? CDN : fresh)]),
    [CDN]: () => { throw Object.assign(new Error('secret auth_key=temporary'), { status: 403 }); },
    [fresh]: BODY,
  });
  assert.equal((await client.getTranscript(VIDEO)).source, 'signed-wbi');
  assert.equal(discovery, 2);
  assert.equal(calls.filter((call) => call.path === CDN).length, 1);
  assert.equal(calls.filter((call) => call.path === fresh).length, 1);
});

test('expired subtitle HTTP 404 bounded to two discovery/body attempts', async () => {
  const { client, calls } = fixture({ [CDN]: () => { throw { status: 404, message: 'auth_key=temporary' }; } });
  await assert.rejects(client.getTranscript(VIDEO), isCode('SUBTITLE_EXPIRED'));
  assert.equal(calls.filter((call) => call.path === '/x/player/wbi/v2').length, 2);
  assert.equal(calls.filter((call) => call.path === CDN).length, 2);
});

test('expired resource already attempted via signed metadata is not fetched a third time', async () => {
  const { client, calls } = fixture({ [CDN]: () => { throw { status: 403 }; } }, [CDN, CDN]);
  await assert.rejects(client.getTranscript(VIDEO), isCode('SUBTITLE_EXPIRED'));
  assert.equal(calls.filter((call) => call.path === CDN).length, 2);
});

test('track-level and explicit URL identity conflicts are rejected before body fetch', async () => {
  for (const entry of [{ ...track(), cid: 67890 }, track(`${CDN}&cid=67890`), track(`${CDN}&bvid=${OTHER_BV}`)]) {
    const { client, calls } = fixture({ '/x/player/wbi/v2': metadata([entry]) });
    await assert.rejects(client.getTranscript(VIDEO), isCode('CONTEXT_MISMATCH'));
    assert.equal(calls.filter((call) => !call.path.startsWith('/x/')).length, 0);
  }
});

test('HTTP 412 refresh is bounded; invalid nav and malformed metadata do not mean no captions', async () => {
  const blocked = fixture({ '/x/player/wbi/v2': () => { throw { status: 412 }; } });
  await assert.rejects(blocked.client.getTranscript(VIDEO), isCode('RISK_CONTROL'));
  assert.equal(blocked.calls.filter((call) => call.path === '/x/player/wbi/v2').length, 2);
  await assert.rejects(fixture({ '/x/web-interface/nav': {} }).client.getTranscript(VIDEO), isCode('INVALID_RESPONSE'));
  await assert.rejects(fixture({ '/x/web-interface/nav': { code: -352 } }).client.getTranscript(VIDEO), isCode('RISK_CONTROL'));
  await assert.rejects(fixture({ '/x/web-interface/nav': ok({}) }).client.getTranscript(VIDEO), isCode('INVALID_WBI_KEYS'));
  await assert.rejects(fixture({ '/x/player/wbi/v2': ok({ subtitle: {} }) }).client.getTranscript(VIDEO), isCode('INVALID_RESPONSE'));
});

for (const denied of [{ code: -352 }, { code: -403 }, { code: 0, data: { v_voucher: 'blocked' } }]) {
  test(`signed metadata denial refreshes keys once: ${JSON.stringify(denied)}`, async () => {
    let attempt = 0;
    const { client, calls } = fixture({ '/x/player/wbi/v2': () => ++attempt === 1 ? denied : metadata() });
    await client.getTranscript(VIDEO);
    assert.equal(attempt, 2);
    assert.equal(calls.filter((call) => call.path === '/x/web-interface/nav').length, 2);
  });
}

test('risk denial is bounded and not mislabeled as missing captions', async () => {
  const { client, calls } = fixture({ '/x/player/wbi/v2': { code: -352, message: 'unsafe server message' } });
  await assert.rejects(client.getTranscript(VIDEO), isCode('RISK_CONTROL'));
  assert.equal(calls.filter((call) => call.path === '/x/player/wbi/v2').length, 2);
});

test('anonymous nav can supply keys; empty tracks distinguish login from missing captions', async () => {
  const anonymous = { ...NAV, code: -101, data: { ...NAV.data, isLogin: false } };
  const anon = fixture({ '/x/web-interface/nav': anonymous });
  assert.equal((await anon.client.getTranscript(VIDEO)).language, 'ai-zh');
  await assert.rejects(fixture({ '/x/web-interface/nav': anonymous, '/x/player/wbi/v2': metadata([]) }).client.getTranscript(VIDEO), isCode('LOGIN_REQUIRED'));
  await assert.rejects(fixture({ '/x/player/wbi/v2': metadata([]) }).client.getTranscript(VIDEO), isCode('CAPTIONS_UNAVAILABLE'));
  await assert.rejects(fixture({ '/x/player/wbi/v2': { code: -101 } }).client.getTranscript(VIDEO), isCode('LOGIN_REQUIRED'));
});

test('resource result can recover after metadata network failure without arbitrary page URLs', async () => {
  const { client } = fixture({ '/x/player/wbi/v2': () => { throw new Error('auth_key=temporary'); } }, [CDN]);
  assert.equal((await client.getTranscript(VIDEO)).source, 'player-resource');
});

test('late P1 result never changes P2 context; input and resource candidate snapshots are immutable', async () => {
  let release;
  let started;
  const wait = new Promise((resolve) => { release = resolve; });
  const arrived = new Promise((resolve) => { started = resolve; });
  const second = CDN.replace('12345', '67890');
  const firstVideo = { ...VIDEO };
  const resources = [{ name: CDN }];
  const { client, calls } = fixture({
    '/x/player/wbi/v2': async ({ cid }) => {
      if (cid === '12345') { started(); await wait; }
      return metadata([track(cid === '12345' ? CDN : second)], { cid: Number(cid) });
    }, [second]: { body: [{ from: 0, to: 1, content: '第二P' }] },
  }, resources);
  const late = client.getTranscript(firstVideo);
  await arrived;
  firstVideo.cid = 67890;
  firstVideo.page = 2;
  resources[0].name = second;
  const current = await client.getTranscript({ ...VIDEO, cid: 67890, page: 2 });
  release();
  const previous = await late;
  assert.match(current.segments[0].id, /:67890:/);
  assert.equal(current.segments[0].text, '第二P');
  assert.match(previous.segments[0].id, /:12345:/);
  assert.equal(previous.segments[0].text, '你好');
  assert.deepEqual(calls.filter((call) => call.path === '/x/player/wbi/v2').map((call) => call.params.cid), ['12345', '67890']);
});

test('resource candidates copied before await; later mutations cannot retarget a request', async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const resources = [{ name: CDN }];
  const { client } = fixture({ '/x/web-interface/view': async () => { await wait; return ok(VIEW); },
    '/x/player/wbi/v2': metadata([]) }, resources);
  const result = client.getTranscript(VIDEO);
  resources[0].name = 'https://evil.test/bfs/subtitle/12345.json';
  release();
  assert.equal((await result).source, 'player-resource');
});

test('account uses browser session nav; no credentials are requested or returned', async () => {
  const { client, calls } = fixture();
  assert.deepEqual(await client.getAccount(), { mid: 42, name: '学习者' });
  assert.deepEqual(calls, [{ path: '/x/web-interface/nav', params: {} }]);
  await assert.rejects(fixture({ '/x/web-interface/nav': { code: -101 } }).client.getAccount(), isCode('LOGIN_REQUIRED'));
  await assert.rejects(fixture({ '/x/web-interface/nav': ok({}) }).client.getAccount(), isCode('INVALID_RESPONSE'));
});

test('folders paginate by has_more, not short-page guesses', async () => {
  const { client, calls } = fixture({ '/x/v3/fav/folder/created/list': ({ up_mid, pn }) => {
    assert.equal(up_mid, 42);
    return ok({ list: [{ id: pn, title: `收藏${pn}`, media_count: pn * 2 }], has_more: pn < 3 });
  } });
  assert.deepEqual(await client.getFavoriteFolders(42), [
    { id: 1, title: '收藏1', count: 2 }, { id: 2, title: '收藏2', count: 4 }, { id: 3, title: '收藏3', count: 6 },
  ]);
  assert.deepEqual(calls.map((call) => call.params.pn), [1, 2, 3]);
});

test('folder count completion, empty folder list and repeated-page failure', async () => {
  const { client } = fixture({ '/x/v3/fav/folder/created/list': ({ pn }) => ok({
    list: [{ id: pn, title: '收藏', media_count: 0 }], count: 2,
  }) });
  assert.equal((await client.getFavoriteFolders(42)).length, 2);
  assert.deepEqual(await fixture({ '/x/v3/fav/folder/created/list': ok({ list: null, count: 0 }) }).client.getFavoriteFolders(42), []);
  await assert.rejects(fixture({ '/x/v3/fav/folder/created/list': ok({ list: [{ id: 1, title: 'x', media_count: 1 }], count: 2 }) }).client.getFavoriteFolders(42), isCode('INVALID_RESPONSE'));
  await assert.rejects(fixture({ '/x/v3/fav/folder/created/list': ok({ list: [], has_more: true }) }).client.getFavoriteFolders(42), isCode('INVALID_RESPONSE'));
});

test('folder cap throws instead of silently returning incomplete array', async () => {
  const { client, calls } = fixture({ '/x/v3/fav/folder/created/list': ({ pn }) => ok({
    list: [{ id: pn, title: '收藏', media_count: 0 }], has_more: true,
  }) });
  await assert.rejects(client.getFavoriteFolders(42), isCode('PAGINATION_LIMIT'));
  assert.equal(calls.length, 100);
});

const media = (bvid = BV, extra = {}) => ({ type: 2, id: 170001, bvid, title: '课程',
  upper: { name: '老师' }, duration: 300, page: 5, attr: 0, fav_time: 1700000100, ...extra });

test('favorites fully paginate, dedup BVID, keep true fav_time and always select P1', async () => {
  const { client, calls } = fixture({ '/x/v3/fav/resource/list': ({ pn }) => pn === 1
    ? ok({ medias: [media(), media(BV, { id: 6, type: 12 })], has_more: true })
    : ok({ medias: [media(), media(OTHER_BV, { id: 2, fav_time: undefined, ctime: 1, pubtime: 2 })], has_more: false }) });
  const result = await client.getFavoriteVideos(7);
  assert.equal(result.hasMore, false);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].favoritedAt, 1700000100);
  assert.equal(result.items[1].favoritedAt, null);
  assert.equal(result.items[0].partCount, 5);
  assert.equal(result.items[0].page, 1);
  assert.equal(result.items[0].url, `https://www.bilibili.com/video/${BV}?p=1`);
  assert.equal(result.items[0].cid, undefined);
  assert.equal(result.items[0].key, undefined);
  assert.equal(result.items[0].shares, undefined);
  assert.deepEqual(calls.map((call) => call.params.pn), [1, 2]);
});

test('favorite cap/unknown end/repeated pages never claim full completion', async () => {
  const repeating = { '/x/v3/fav/resource/list': ok({ medias: [media()], has_more: true }) };
  const capped = fixture(repeating);
  assert.equal((await capped.client.getFavoriteVideos(7, { maxPages: 1 })).hasMore, true);
  assert.equal(capped.calls.length, 1);
  const repeated = fixture(repeating);
  assert.equal((await repeated.client.getFavoriteVideos(7)).hasMore, true);
  assert.equal(repeated.calls.length, 2);
  assert.equal((await fixture({ '/x/v3/fav/resource/list': ok({ medias: null }) }).client.getFavoriteVideos(7)).hasMore, true);
});

test('favorite fallback count uses received rows, not page number times requested page size', async () => {
  const { client } = fixture({ '/x/v3/fav/resource/list': ok({ medias: [media()], info: { media_count: 5 } }) });
  assert.equal((await client.getFavoriteVideos(7, { maxPages: 1 })).hasMore, true);
  assert.deepEqual(await fixture({ '/x/v3/fav/resource/list': ok({ medias: null, has_more: false }) }).client.getFavoriteVideos(7), { items: [], hasMore: false });
});

const historyRow = (cid = 12345, page = 1, extra = {}) => ({
  title: '看过的课程', author_name: '老师', view_at: 1700000000, progress: -1, duration: 100,
  history: { bvid: BV, cid, page, business: 'archive' }, ...extra,
});

test('history follows opaque cursor tuple, preserves P and -1 completed marker', async () => {
  const { client, calls } = fixture({ '/x/web-interface/history/cursor': ({ max, view_at, business }) => {
    if (max === 0) return ok({ list: [historyRow(), { history: { business: 'live' } }],
      cursor: { max: 55, view_at: 1600, business: 'live' } });
    if (max === 55) {
      assert.equal(view_at, 1600);
      assert.equal(business, 'live');
      return ok({ list: [historyRow(), historyRow(67890, 2, { progress: 5.5 })],
        cursor: { max: 66, view_at: 1500, business: 'archive' } });
    }
    assert.equal(view_at, 1500);
    assert.equal(business, 'archive');
    return ok({ list: [], cursor: { max: 0, view_at: 0, business: '' } });
  } });
  const result = await client.getHistory({ maxPages: 5 });
  assert.equal(result.hasMore, false);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].progress, -1);
  assert.equal(result.items[0].viewedAt, 1700000000);
  assert.equal(result.items[1].page, 2);
  assert.equal(result.items[1].progress, 5.5);
  assert.equal(result.items[1].url, `https://www.bilibili.com/video/${BV}?p=2`);
  assert.deepEqual(calls.map((call) => call.params.max), [0, 55, 66]);
});

test('history only reads declared cap and does not mistake short/filtered page for end', async () => {
  const { client, calls } = fixture({ '/x/web-interface/history/cursor': ok({
    list: [{ history: { business: 'article' } }], cursor: { max: 1, view_at: 2, business: 'article' },
  }) });
  assert.deepEqual(await client.getHistory({ maxPages: 1 }), { items: [], hasMore: true });
  assert.equal(calls.length, 1);
});

test('history repeated/missing cursor and explicit-more empty page preserve incompleteness', async () => {
  for (const data of [
    { list: [historyRow()], cursor: { max: 0, view_at: 0, business: '' } },
    { list: [historyRow()] }, { list: [], has_more: true },
  ]) {
    const { client } = fixture({ '/x/web-interface/history/cursor': ok(data) });
    assert.equal((await client.getHistory()).hasMore, true);
  }
});

test('history cannot invent missing CID, part, timestamp, author or shares', async () => {
  const row = historyRow(67890, 2, { author_name: undefined, view_at: undefined });
  const { client } = fixture({ '/x/web-interface/history/cursor': ok({ list: [
    row, historyRow(0), historyRow(12345, 0), { history: { business: 'pgc', bvid: BV, cid: 2, page: 1 } },
  ], has_more: false }) });
  const result = await client.getHistory();
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].author, '');
  assert.equal(result.items[0].viewedAt, null);
  assert.equal(result.items[0].shares, undefined);
});

test('all paginated methods fail explicitly on API login/permission/network errors', async () => {
  for (const [path, method, args] of [
    ['/x/v3/fav/folder/created/list', 'getFavoriteFolders', [42]],
    ['/x/v3/fav/resource/list', 'getFavoriteVideos', [7]],
    ['/x/web-interface/history/cursor', 'getHistory', []],
  ]) {
    await assert.rejects(fixture({ [path]: { code: -101 } }).client[method](...args), isCode('LOGIN_REQUIRED'));
    await assert.rejects(fixture({ [path]: { code: -403 } }).client[method](...args), isCode('FORBIDDEN'));
    await assert.rejects(fixture({ [path]: () => { throw new Error('auth_key=temporary'); } }).client[method](...args), isCode('NETWORK_ERROR'));
  }
});

test('invalid pagination caps rejected before network; malformed envelopes not mistaken for empty results', async () => {
  const { client, calls } = fixture();
  for (const cap of [0, -1, 1.5, 101, Infinity, null]) {
    await assert.rejects(client.getHistory({ maxPages: cap }), isCode('INVALID_ARGUMENT'));
    await assert.rejects(client.getFavoriteVideos(7, { maxPages: cap }), isCode('INVALID_ARGUMENT'));
  }
  assert.equal(calls.length, 0);
  await assert.rejects(fixture({ '/x/web-interface/history/cursor': {} }).client.getHistory(), isCode('INVALID_RESPONSE'));
  await assert.rejects(fixture({ '/x/web-interface/history/cursor': ok({}) }).client.getHistory(), isCode('INVALID_RESPONSE'));
});
