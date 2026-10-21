// Browser-safe ESM: transport, authentication and UI lifecycle belong to the caller.
const BVID = /^BV[1-9A-HJ-NP-Za-km-z]{10}$/;
const MAX_PAGES = 100;
const DEFAULT_PAGES = 10;
const SUBTITLE_HOSTS = new Set([
  'aisubtitle.hdslb.com', 'hds.hdslb.com', 'subtitle.bilibili.com',
  'i0.hdslb.com', 'i1.hdslb.com', 'i2.hdslb.com',
]);
const MESSAGES = {
  INVALID_VIDEO: '视频编号或分P信息无效。',
  INVALID_ARGUMENT: '请求参数无效。',
  INVALID_WBI_KEYS: '无法取得有效的字幕访问签名，请刷新视频页重试。',
  LOGIN_REQUIRED: '请先在哔哩哔哩登录，再重试。',
  FORBIDDEN: '当前账号无权访问此内容。',
  NOT_FOUND: '视频不存在或已失效。',
  RISK_CONTROL: '哔哩哔哩暂时限制了访问，请稍后重试。',
  NETWORK_ERROR: '无法连接哔哩哔哩，请检查网络后重试。',
  REQUEST_FAILED: '哔哩哔哩请求未成功，请稍后重试。',
  INVALID_RESPONSE: '哔哩哔哩返回的数据不完整，请刷新后重试。',
  CONTEXT_MISMATCH: '视频或分P已不匹配，请刷新当前视频后重试。',
  UNSAFE_SUBTITLE_URL: '无法安全确认字幕来源，已停止读取。',
  CAPTIONS_UNAVAILABLE: '当前分P没有可读取的字幕，请在播放器开启字幕后重试。',
  INVALID_CAPTIONS: '字幕内容为空或格式无效，请稍后重试。',
  SUBTITLE_EXPIRED: '字幕链接已失效，请刷新视频后重试。',
  PAGINATION_LIMIT: '收藏夹列表尚未读完，已停止读取，请缩小范围后重试。',
};

function failure(code, status) {
  const error = new Error(MESSAGES[code] ?? MESSAGES.REQUEST_FAILED);
  error.code = code;
  if (Number.isInteger(status)) error.status = status;
  return error;
}

function normalizedError(error) {
  if (Object.hasOwn(MESSAGES, error?.code)) return failure(error.code, error.status);
  const status = Number(error?.status ?? error?.statusCode);
  if (status === 401 || Number(error?.code) === -101) return failure('LOGIN_REQUIRED', status);
  if ([412, 429].includes(status)) return failure('RISK_CONTROL', status);
  if (status === 403) return failure('FORBIDDEN', status);
  if (status === 404) return failure('NOT_FOUND', status);
  return failure('NETWORK_ERROR', Number.isInteger(status) ? status : undefined);
}

function integer(value, minimum = 1) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= minimum ? n : null;
}

function requiredInteger(value, code = 'INVALID_ARGUMENT', minimum = 1) {
  const n = integer(value, minimum);
  if (n === null) throw failure(code);
  return n;
}

const text = (value) => typeof value === 'string' ? value : '';
const seconds = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const duration = (value) => {
  if (typeof value === 'number') return seconds(value);
  const match = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
};
// Source timestamps are Unix SECONDS. MAIN converts to milliseconds for events.
const timestamp = (value) => integer(value, 0);

export function parseVideoUrl(input) {
  try {
    if (typeof input !== 'string') return null;
    const url = new URL(input);
    if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== 'www.bilibili.com'
      || url.username || url.password || url.port) return null;
    const match = /^\/video\/([^/]+)\/?$/.exec(url.pathname);
    if (!match || !BVID.test(match[1])) return null;
    const pages = url.searchParams.getAll('p');
    if (pages.length > 1) return null;
    const page = pages.length ? integer(pages[0]) : 1;
    return page === null ? null : { bvid: match[1], page };
  } catch {
    return null;
  }
}

export function videoKey(video) {
  if (!BVID.test(video?.bvid ?? '')) throw failure('INVALID_VIDEO');
  return `bilibili:${video.bvid}:${requiredInteger(video.cid, 'INVALID_VIDEO')}`;
}

export function canonicalVideoUrl(video, atSeconds) {
  if (!BVID.test(video?.bvid ?? '')) throw failure('INVALID_VIDEO');
  const page = requiredInteger(video.page ?? 1, 'INVALID_VIDEO');
  const url = new URL(`https://www.bilibili.com/video/${video.bvid}`);
  url.searchParams.set('p', String(page));
  if (atSeconds !== undefined) {
    if (seconds(atSeconds) === null) throw failure('INVALID_ARGUMENT');
    url.searchParams.set('t', String(Math.floor(atSeconds)));
  }
  return url.href;
}

// RFC 1321 compression. MD5 is required by WBI, not used as a security primitive.
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
const MD5_SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
function md5(input) {
  const bytes = new TextEncoder().encode(input);
  const buffer = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  const words = new DataView(buffer.buffer);
  words.setUint32(buffer.length - 8, (bytes.length * 8) >>> 0, true);
  words.setUint32(buffer.length - 4, Math.floor(bytes.length / 2 ** 29), true);
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let offset = 0; offset < buffer.length; offset += 64) {
    let [a, b, c, d] = state;
    for (let i = 0; i < 64; i++) {
      const round = Math.floor(i / 16);
      const f = round === 0 ? (b & c) | (~b & d)
        : round === 1 ? (d & b) | (~d & c)
          : round === 2 ? b ^ c ^ d : c ^ (b | ~d);
      const g = round === 0 ? i : round === 1 ? (5 * i + 1) % 16
        : round === 2 ? (3 * i + 5) % 16 : (7 * i) % 16;
      const sum = (a + f + MD5_K[i] + words.getUint32(offset + g * 4, true)) | 0;
      const shift = MD5_SHIFTS[round * 4 + i % 4];
      const rotated = (sum << shift) | (sum >>> (32 - shift));
      [a, b, c, d] = [d, (b + rotated) | 0, b, c];
    }
    for (const [i, value] of [a, b, c, d].entries()) state[i] = (state[i] + value) | 0;
  }
  return state.map((word) => [0, 8, 16, 24]
    .map((shift) => ((word >>> shift) & 255).toString(16).padStart(2, '0')).join('')).join('');
}

const MIXIN_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

// Pure: caller supplies wts (Unix seconds); returns the exact values to send.
export function createWbiSignature(params, wbiKeys) {
  const img = wbiKeys?.imgKey ?? wbiKeys?.img_key;
  const sub = wbiKeys?.subKey ?? wbiKeys?.sub_key;
  if (!/^[a-fA-F0-9]{32}$/.test(img ?? '') || !/^[a-fA-F0-9]{32}$/.test(sub ?? '')) {
    throw failure('INVALID_WBI_KEYS');
  }
  requiredInteger(params?.wts, 'INVALID_ARGUMENT', 0);
  const raw = img + sub;
  const mixin = MIXIN_TABLE.slice(0, 32).map((i) => raw[i]).join('');
  const entries = Object.keys(params).filter((key) => key !== 'w_rid').sort().map((key) => {
    const value = params[key];
    if (!['string', 'number', 'boolean'].includes(typeof value)
      || (typeof value === 'number' && !Number.isFinite(value))) throw failure('INVALID_ARGUMENT');
    return [key, String(value).replace(/[!'()*]/g, '')];
  });
  let query;
  try {
    query = entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
  } catch {
    throw failure('INVALID_ARGUMENT');
  }
  return { ...Object.fromEntries(entries), w_rid: md5(query + mixin) };
}

function subtitleUrl(input) {
  try {
    if (typeof input !== 'string' || /[\s\\]/.test(input)) return null;
    const url = new URL(input.startsWith('//') ? `https:${input}` : input);
    if (!['http:', 'https:'].includes(url.protocol) || !SUBTITLE_HOSTS.has(url.hostname)
      || url.username || url.password || url.port || url.hash
      || !/^\/bfs\/(?:ai_subtitle|subtitle)\//.test(url.pathname)) return null;
    return url;
  } catch {
    return null;
  }
}

function resourceMatches(url, video) {
  // Only named CID query values or a complete decimal path token prove ownership.
  // Arbitrary query values, auth signatures, BVID, aid and substring matches do not.
  if (url.searchParams.getAll('bvid').some((bvid) => bvid !== video.bvid)) return false;
  const cidValues = url.searchParams.getAll('cid');
  if (cidValues.length) return cidValues.every((cid) => integer(cid) === video.cid);
  return url.pathname.split(/[\/_.-]/).includes(String(video.cid));
}

function checkContext(data, video) {
  if ((data?.bvid !== undefined && data.bvid !== video.bvid)
    || (data?.aid !== undefined && integer(data.aid) !== video.aid)
    || (data?.cid !== undefined && integer(data.cid) !== video.cid)) throw failure('CONTEXT_MISMATCH');
}

function normalizeSegments(json, video) {
  if (!Array.isArray(json?.body) || json.body.length === 0) throw failure('INVALID_CAPTIONS');
  const rows = json.body.map((row) => {
    const start = seconds(row?.from);
    const end = seconds(row?.to);
    const content = text(row?.content).trim();
    if (start === null || end === null || end <= start || !content) throw failure('INVALID_CAPTIONS');
    return { start, end, text: content };
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  const seen = new Set();
  return rows.filter((row) => {
    const key = JSON.stringify([row.start, row.end, row.text]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((row, i) => ({ id: `${videoKey(video)}:${i}`, ...row }));
}

function pageCap(value = DEFAULT_PAGES) {
  const cap = requiredInteger(value);
  if (cap > MAX_PAGES) throw failure('INVALID_ARGUMENT');
  return cap;
}

function list(value, nullable = false) {
  if (nullable && value === null) return [];
  if (!Array.isArray(value)) throw failure('INVALID_RESPONSE');
  return value;
}

function moreFlag(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return null;
}

export function createBilibiliClient({ request, resourceCandidates = [] } = {}) {
  if (typeof request !== 'function' || !Array.isArray(resourceCandidates)) throw failure('INVALID_ARGUMENT');

  async function rawRequest(path, params = {}) {
    try {
      return await request(path, params);
    } catch (error) {
      throw normalizedError(error);
    }
  }

  async function api(path, params = {}) {
    const json = await rawRequest(path, params);
    if (!json || typeof json.code !== 'number') throw failure('INVALID_RESPONSE');
    if (json.code !== 0) {
      const code = json.code === -101 ? 'LOGIN_REQUIRED'
        : json.code === -403 ? 'FORBIDDEN'
          : [-352, -412, -509].includes(json.code) ? 'RISK_CONTROL'
            : json.code === -404 ? 'NOT_FOUND' : 'REQUEST_FAILED';
      throw failure(code);
    }
    if (!json.data || typeof json.data !== 'object') throw failure('INVALID_RESPONSE');
    return json.data;
  }

  async function getVideo({ bvid, page = 1 } = {}) {
    if (!BVID.test(bvid ?? '')) throw failure('INVALID_VIDEO');
    page = requiredInteger(page, 'INVALID_VIDEO');
    const data = await api('/x/web-interface/view', { bvid });
    if (data.bvid !== bvid) throw failure('CONTEXT_MISMATCH');
    const parts = list(data.pages);
    const count = data.videos === undefined ? parts.length : requiredInteger(data.videos, 'INVALID_RESPONSE');
    if (parts.length === 0 || parts.length !== count) throw failure('INVALID_RESPONSE');
    const pageNumbers = new Set();
    const cids = new Set();
    for (const entry of parts) {
      const number = requiredInteger(entry?.page, 'INVALID_RESPONSE');
      const cid = requiredInteger(entry?.cid, 'INVALID_RESPONSE');
      if (number > count || pageNumbers.has(number) || cids.has(cid)) throw failure('INVALID_RESPONSE');
      pageNumbers.add(number);
      cids.add(cid);
    }
    const part = parts.find((item) => integer(item.page) === page);
    if (!part) throw failure('INVALID_VIDEO');
    const video = {
      bvid, aid: requiredInteger(data.aid, 'INVALID_RESPONSE'),
      cid: requiredInteger(part.cid, 'INVALID_RESPONSE'), page,
      title: text(data.title), partTitle: /^(?:lv_0_|Camera_xhs_)/.test(text(part.part)) ? '' : text(part.part), author: text(data.owner?.name),
      description: text(data.desc), duration: seconds(part.duration),
    };
    if (video.duration === null) throw failure('INVALID_RESPONSE');
    return { key: videoKey(video), ...video, url: canonicalVideoUrl(video) };
  }

  async function signedMetadata(video) {
    for (let attempt = 0; attempt < 2; attempt++) {
      // Do not cache account state, keys or short-lived subtitle URLs.
      const nav = await rawRequest('/x/web-interface/nav');
      if (!nav || ![0, -101].includes(nav.code)) {
        if (nav?.code === -352) throw failure('RISK_CONTROL');
        throw failure('INVALID_RESPONSE');
      }
      const image = nav.data?.wbi_img;
      const extract = (value) => {
        try { return /\/([a-fA-F0-9]{32})\.[a-zA-Z0-9]+$/.exec(new URL(value).pathname)?.[1]; }
        catch { return undefined; }
      };
      const params = createWbiSignature({
        aid: video.aid, bvid: video.bvid, cid: video.cid, wts: Math.floor(Date.now() / 1000),
      }, { imgKey: extract(image?.img_url), subKey: extract(image?.sub_url) });
      try {
        const data = await api('/x/player/wbi/v2', params);
        if (data.v_voucher) throw failure('RISK_CONTROL');
        checkContext(data, video);
        const tracks = list(data.subtitle?.subtitles);
        return { tracks, loggedOut: nav.code === -101 || nav.data?.isLogin === false };
      } catch (error) {
        if (attempt === 0 && ['RISK_CONTROL', 'FORBIDDEN'].includes(error.code)) continue;
        throw error;
      }
    }
  }

  // WBI keys are short-lived; never cache them across calls.
  async function wbiKeys() {
    const nav = await rawRequest('/x/web-interface/nav');
    if (!nav || ![0, -101].includes(nav.code)) {
      if (nav?.code === -352) throw failure('RISK_CONTROL');
      throw failure('INVALID_RESPONSE');
    }
    const extract = (value) => {
      try { return /\/([a-fA-F0-9]{32})\.[a-zA-Z0-9]+$/.exec(new URL(value).pathname)?.[1]; }
      catch { return undefined; }
    };
    const keys = { imgKey: extract(nav.data?.wbi_img?.img_url), subKey: extract(nav.data?.wbi_img?.sub_url) };
    if (!keys.imgKey || !keys.subKey) throw failure('INVALID_RESPONSE');
    return keys;
  }

  async function signedApi(path, params) {
    const keys = await wbiKeys();
    return api(path, createWbiSignature({ ...params, wts: Math.floor(Date.now() / 1000) }, keys));
  }

  // Space endpoints also expect browser fingerprint hints or they answer with risk control.
  const fingerprint = {
    dm_img_list: '[]',
    dm_img_str: 'V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ',
    dm_cover_img_str: 'QU5HTEUgKEludGVsLCBJbnRlbChSKSBVSEQgR3JhcGhpY3MgNjMwICgweDAwMDAzRTlCKSBEaXJlY3QzRDExIHZzXzVfMCBwc181XzApLCBvciBzaW1pbGFy',
    dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
  };

  async function getCreatorInfo(mid) {
    mid = requiredInteger(mid);
    const data = await signedApi('/x/space/wbi/acc/info', { mid, ...fingerprint });
    return { mid, name: text(data.name) };
  }

  async function getCreatorVideos(mid, { maxPages = DEFAULT_PAGES } = {}) {
    mid = requiredInteger(mid);
    const cap = pageCap(maxPages);
    const items = new Map();
    let total = null;
    let hasMore = false;
    for (let pn = 1; pn <= cap; pn++) {
      const data = await signedApi('/x/space/wbi/arc/search',
        { mid, ps: 30, pn, order: 'pubdate', platform: 'web', ...fingerprint });
      const rows = list(data.list?.vlist, true);
      const count = integer(data.page?.count);
      if (total === null && count !== null) total = count;
      for (const row of rows) {
        const bvid = row?.bvid;
        if (!BVID.test(bvid ?? '') || items.has(bvid)) continue;
        const video = { bvid, page: 1, title: text(row.title), duration: duration(row.length),
          publishedAt: timestamp(row.created) };
        items.set(bvid, { ...video, url: canonicalVideoUrl(video) });
      }
      const known = total === null ? rows.length >= 30 : items.size < total;
      hasMore = known;
      if (!known || rows.length === 0) break;
    }
    return { items: [...items.values()], total: total ?? items.size, hasMore };
  }

  async function fetchTrack(track, video, source) {
    if (!track || typeof track !== 'object') throw failure('INVALID_RESPONSE');
    checkContext(track, video);
    const url = subtitleUrl(track.subtitle_url);
    if (!url) throw failure('UNSAFE_SUBTITLE_URL');
    if (url.searchParams.getAll('bvid').some((bvid) => bvid !== video.bvid)
      || (url.searchParams.has('cid') && !resourceMatches(url, video))) throw failure('CONTEXT_MISMATCH');
    let json;
    try {
      json = await rawRequest(url.href);
    } catch (error) {
      if ([403, 404].includes(error.status)) throw failure('SUBTITLE_EXPIRED', error.status);
      throw error;
    }
    // Some transports expose a Bili error envelope instead of throwing HTTP status.
    if (json?.code !== undefined && json.code !== 0) {
      if (json.code === -101) throw failure('LOGIN_REQUIRED');
      throw failure('INVALID_CAPTIONS');
    }
    return { language: text(track.lan) || 'und', segments: normalizeSegments(json, video), source };
  }

  async function getTranscript(input) {
    // Capture before the first await: callers may change tabs/parts during requests.
    const video = {
      bvid: input?.bvid, cid: requiredInteger(input?.cid, 'INVALID_VIDEO'),
      aid: requiredInteger(input?.aid, 'INVALID_VIDEO'),
      page: requiredInteger(input?.page ?? 1, 'INVALID_VIDEO'),
    };
    const key = videoKey(video);
    if (input.key !== undefined && input.key !== key) throw failure('CONTEXT_MISMATCH');
    const candidates = resourceCandidates.map((entry) => typeof entry === 'string' ? { url: entry }
      : { url: entry?.url ?? entry?.name, bvid: entry?.bvid, cid: entry?.cid,
        lan: entry?.language ?? entry?.lan });
    const verified = await getVideo(video);
    if (verified.key !== key || verified.aid !== video.aid) throw failure('CONTEXT_MISMATCH');
    let lastError;
    let loggedOut = false;
    const attemptedUrls = new Set();
    for (let discovery = 0; discovery < 2; discovery++) {
      let metadata;
      try {
        metadata = await signedMetadata(video);
      } catch (error) {
        if (error.code === 'CONTEXT_MISMATCH') throw error;
        lastError = error;
        break;
      }
      loggedOut = metadata.loggedOut;
      let expired = false;
      // Prefer human Chinese, then AI Chinese, then other tracks; stable within a rank.
      const rank = (track) => /^zh(?:-|$)/i.test(track?.lan) ? 0 : track?.lan === 'ai-zh' ? 1 : 2;
      for (const track of [...metadata.tracks].sort((a, b) => rank(a) - rank(b))) {
        const url = subtitleUrl(track?.subtitle_url);
        if (url) attemptedUrls.add(url.href);
        try {
          return await fetchTrack(track, video, 'signed-wbi');
        } catch (error) {
          if (error.code === 'CONTEXT_MISMATCH') throw error;
          expired ||= error.code === 'SUBTITLE_EXPIRED';
          lastError = error;
        }
      }
      if (!expired || discovery === 1) break;
      // Expired URL: one fresh metadata discovery, never loop on the old URL.
    }
    const seen = new Set();
    for (const candidate of candidates) {
      const url = subtitleUrl(candidate.url);
      if (!url || !resourceMatches(url, video) || seen.has(url.href) || attemptedUrls.has(url.href)
        || (candidate.bvid !== undefined && candidate.bvid !== video.bvid)
        || (candidate.cid !== undefined && integer(candidate.cid) !== video.cid)) continue;
      seen.add(url.href);
      try {
        return await fetchTrack({ subtitle_url: url.href, lan: candidate.lan }, video, 'player-resource');
      } catch (error) {
        lastError = error;
      }
    }
    if (loggedOut || lastError?.code === 'LOGIN_REQUIRED') throw failure('LOGIN_REQUIRED');
    throw lastError ?? failure('CAPTIONS_UNAVAILABLE');
  }

  async function getAccount() {
    const data = await api('/x/web-interface/nav');
    if (data.isLogin === false) throw failure('LOGIN_REQUIRED');
    if (data.isLogin !== true) throw failure('INVALID_RESPONSE');
    return { mid: requiredInteger(data.mid, 'INVALID_RESPONSE'), name: text(data.uname) };
  }

  async function getFavoriteFolders(mid) {
    mid = requiredInteger(mid);
    const items = new Map();
    for (let pn = 1; pn <= MAX_PAGES; pn++) {
      const data = await api('/x/v3/fav/folder/created/list', { up_mid: mid, pn, ps: 20 });
      const rows = list(data.list, true);
      const previousSize = items.size;
      for (const row of rows) {
        const id = requiredInteger(row?.id, 'INVALID_RESPONSE');
        items.set(id, { id, title: text(row.title), count: requiredInteger(row.media_count, 'INVALID_RESPONSE', 0) });
      }
      const flag = moreFlag(data.has_more);
      const count = integer(data.count, 0);
      if (flag === false) {
        if (count !== null && items.size < count) throw failure('INVALID_RESPONSE');
        return [...items.values()];
      }
      if (flag === null && count !== null && items.size >= count) return [...items.values()];
      if (rows.length === 0 || previousSize === items.size) throw failure('INVALID_RESPONSE');
      // Unknown completeness must never become a silently complete array.
      if (flag === null && count === null) throw failure('INVALID_RESPONSE');
    }
    throw failure('PAGINATION_LIMIT');
  }

  async function getFavoriteVideos(folderId, { maxPages = DEFAULT_PAGES } = {}) {
    folderId = requiredInteger(folderId);
    const cap = pageCap(maxPages);
    const items = new Map();
    const pages = new Set();
    const received = new Set();
    let hasMore = true;
    for (let pn = 1; pn <= cap; pn++) {
      const data = await api('/x/v3/fav/resource/list', {
        media_id: folderId, pn, ps: 20, order: 'mtime', platform: 'web',
      });
      const rows = list(data.medias, true);
      const fingerprint = JSON.stringify(rows.map((row) => [row?.id, row?.bvid ?? row?.bv_id, row?.type, row?.fav_time]));
      if (pages.has(fingerprint)) return { items: [...items.values()], hasMore: true };
      pages.add(fingerprint);
      for (const row of rows) {
        received.add(JSON.stringify([row?.type, row?.id, row?.bvid ?? row?.bv_id]));
        const bvid = row?.bvid ?? row?.bv_id;
        if (row?.type !== 2 || !BVID.test(bvid ?? '')) continue;
        // row.page is the number of parts, NOT the selected part.
        const video = { bvid, page: 1, title: text(row.title), author: text(row.upper?.name),
          favoritedAt: timestamp(row.fav_time), duration: seconds(row.duration),
          description: text(row.intro), aid: integer(row.id),
          partCount: integer(row.page),
          unavailable: integer(row.attr, 0) === null ? null : integer(row.attr, 0) !== 0 };
        if (!items.has(bvid)) items.set(bvid, { ...video, url: canonicalVideoUrl(video) });
      }
      hasMore = moreFlag(data.has_more);
      if (hasMore === null) {
        const total = integer(data.info?.media_count, 0);
        hasMore = total === null || received.size < total;
      }
      if (!hasMore) break;
      if (rows.length === 0) return { items: [...items.values()], hasMore: true };
    }
    return { items: [...items.values()], hasMore };
  }

  async function getHistory({ maxPages = DEFAULT_PAGES } = {}) {
    const cap = pageCap(maxPages);
    const items = new Map();
    const visited = new Set();
    let cursor = { max: 0, view_at: 0, business: '' };
    for (let pn = 1; pn <= cap; pn++) {
      visited.add(JSON.stringify(cursor));
      const data = await api('/x/web-interface/history/cursor', { ...cursor, ps: 30 });
      const rows = list(data.list);
      for (const row of rows) {
        const history = row?.history;
        if (history?.business !== 'archive' || !BVID.test(history.bvid ?? '')) continue;
        const cid = integer(history.cid);
        const page = integer(history.page);
        if (cid === null || page === null) continue;
        const video = { bvid: history.bvid, cid, page, title: text(row.title), author: text(row.author_name),
          viewedAt: timestamp(row.view_at), progress: row.progress === -1 ? -1 : seconds(row.progress),
          duration: seconds(row.duration) };
        const key = videoKey(video);
        if (!items.has(key)) items.set(key, { ...video, url: canonicalVideoUrl(video) });
      }
      const flag = moreFlag(data.has_more);
      if (flag === false || (rows.length === 0 && flag !== true)) return { items: [...items.values()], hasMore: false };
      const next = data.cursor;
      const max = integer(next?.max, 0);
      const viewAt = integer(next?.view_at, 0);
      if (max === null || viewAt === null || typeof next?.business !== 'string') {
        return { items: [...items.values()], hasMore: true };
      }
      cursor = { max, view_at: viewAt, business: next.business };
      if (visited.has(JSON.stringify(cursor)) || rows.length === 0) return { items: [...items.values()], hasMore: true };
    }
    return { items: [...items.values()], hasMore: true };
  }

  return { getVideo, getTranscript, getAccount, getFavoriteFolders, getFavoriteVideos, getHistory,
    getCreatorInfo, getCreatorVideos };
}
