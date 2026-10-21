// Browser-safe ESM: no storage, SDK, environment variables, or implicit retries.
export const PROVIDERS = Object.freeze([
  { id: 'deepseek', name: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com' },
  { id: 'openai', name: 'GPT · OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1' },
  { id: 'xai', name: 'Grok · xAI', protocol: 'openai', baseUrl: 'https://api.x.ai/v1' },
  { id: 'minimax', name: 'MiniMax', protocol: 'openai', baseUrl: 'https://api.minimax.io/v1' },
  { id: 'zhipu', name: 'GLM · 智谱', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'anthropic', name: 'Claude · Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  { id: 'google', name: 'Gemini · Google', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  { id: 'custom', name: '自定义', protocol: 'openai', baseUrl: '' },
].map((preset) => Object.freeze(preset.id === 'custom' || preset.id === 'zhipu'
  ? preset : { ...preset, modelsUrl: `${preset.baseUrl}/models` })));

const PROTOCOLS = new Set(['openai', 'anthropic', 'gemini']);
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 10;
const MAX_MODELS = 10000;
// Official text-model IDs, not an account authorization claim. See model-protocols.md.
const OFFICIAL_CATALOGS = Object.freeze({
  zhipu: Object.freeze([{ id: 'glm-5.3', name: 'GLM-5.3' }].map(Object.freeze)),
  minimax: Object.freeze([
    { id: 'MiniMax-M3', name: 'MiniMax-M3' },
    { id: 'MiniMax-M2.7', name: 'MiniMax-M2.7' },
    { id: 'MiniMax-M2.5', name: 'MiniMax-M2.5' },
  ].map(Object.freeze)),
});
const catalogFor = (provider) => OFFICIAL_CATALOGS[provider].map((model) => ({ ...model, source: 'catalog' }));
const isOfficialPreset = (config, provider) => config.provider === provider
  && config.baseUrl === PROVIDERS.find((preset) => preset.id === provider).baseUrl;

class GatewayError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

const fail = (code, message, status) => new GatewayError(code, message, status);

function apiUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || !/^https?:\/\//i.test(value)
    || /[\s\\?#\u0000-\u001f\u007f]/u.test(value)) {
    throw fail('INVALID_URL', '请输入不含查询参数或片段的 HTTP 或 HTTPS API 地址。');
  }
  let url;
  try { url = new URL(value); } catch { throw fail('INVALID_URL', 'API 地址格式不正确。'); }
  const authorityAndPath = value.replace(/^https?:\/\//i, '');
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
    || authorityAndPath.split('/')[0].includes('@')) {
    throw fail('INVALID_URL', 'API 地址不能包含用户名或密码，且必须使用 HTTP 或 HTTPS。');
  }
  // Reject traversal before URL's dot-segment normalization, as well as encoded routing.
  const rawPath = authorityAndPath.replace(/^[^/]+/, '');
  if (/%|\/{2}|(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath)) {
    throw fail('INVALID_URL', 'API 地址不能包含转义路径、重复斜线或相对路径。');
  }
  return url;
}

function canonicalBase(value, protocol, provider) {
  const url = apiUrl(value);
  let path = url.pathname.replace(/\/+$/, '');
  const endings = {
    openai: /\/(?:chat\/completions|models)$/,
    anthropic: /\/(?:messages|models)$/,
    gemini: /\/models(?:\/[A-Za-z0-9._-]+:generateContent)?$/,
  };
  path = path.replace(endings[protocol], '');
  if (!path) {
    // DeepSeek documents its root as the API base; other root inputs get the protocol version.
    path = provider === 'deepseek' && url.origin === 'https://api.deepseek.com'
      ? '' : protocol === 'gemini' ? '/v1beta' : '/v1';
  }
  const segments = path.split('/').filter(Boolean);
  const validVersion = protocol === 'gemini' ? /^v1(?:beta)?$/
    : protocol === 'anthropic' ? /^v1$/ : /^v\d+(?:\.\d+)?$/;
  if (!validVersion.test(segments.at(-1) ?? '') && path !== '') {
    throw fail('INVALID_API_PATH', '请填写 API 根地址、版本地址或所选协议的完整端点，不要填写网页地址。');
  }
  if (segments.some((part, i) => !/^[A-Za-z0-9_-]+(?:\.[0-9]+)?$/.test(part)
    || (i < segments.length - 1 && /^v\d+(?:beta|\.\d+)?$/.test(part)))
    || segments.some((part) => /^(?:docs?|documentation|login|signin|dashboard|console|billing|chat|messages|models|responses)$/i.test(part))) {
    throw fail('INVALID_API_PATH', 'API 路径与所选协议不匹配，或包含网页路由、重复版本。');
  }
  return `${url.origin}${path}`;
}

function configString(value, label, maxLength) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw fail('INVALID_CONFIG', `${label}格式不正确。`);
  }
  return value.trim();
}

/** Validate without requiring a key/model, so settings can be edited and models listed separately. */
export function normalizeGateway(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw fail('INVALID_CONFIG', '模型配置格式不正确。');
  }
  const provider = input.provider ?? 'deepseek';
  const preset = PROVIDERS.find((item) => item.id === provider);
  if (!preset) throw fail('INVALID_PROVIDER', '请选择支持的模型服务或自定义服务。');
  const protocol = input.protocol ?? preset.protocol;
  if (!PROTOCOLS.has(protocol)) throw fail('INVALID_PROTOCOL', '请选择 OpenAI、Anthropic 或 Gemini 协议。');
  // Never silently reinterpret a native provider as an incompatible protocol.
  if (provider !== 'custom' && protocol !== preset.protocol) {
    throw fail('INVALID_PROTOCOL', '所选服务与协议不匹配；其他协议请使用自定义服务。');
  }
  const base = input.baseUrl === undefined || input.baseUrl === '' ? preset.baseUrl : input.baseUrl;
  return {
    provider,
    protocol,
    baseUrl: canonicalBase(base, protocol, provider),
    apiKey: configString(input.apiKey, '密钥', 8192),
    model: configString(input.model, '模型名称', 512),
  };
}

/** Chrome match pattern. Permission grants belong to the extension caller, not this module. */
export function getPermissionOrigin(baseUrl) {
  return `${apiUrl(baseUrl).origin}/*`;
}

function headersFor(config) {
  const headers = { Accept: 'application/json' };
  if (config.protocol === 'anthropic') {
    headers['x-api-key'] = config.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    if (new URL(config.baseUrl).origin === 'https://api.anthropic.com') {
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    }
  } else if (config.protocol === 'gemini') {
    headers['x-goog-api-key'] = config.apiKey;
  } else {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  return headers;
}

function httpError(status) {
  const hints = {
    400: '请求不被支持，请检查模型名称、协议和输入长度。',
    401: '密钥无效或已失效，请检查密钥。',
    402: '服务余额不足或需要开通付费权限。',
    403: '无访问权限，请检查模型授权、地区或服务配置。',
    404: '模型或端点不存在，请检查服务地址或重新选择可用模型。',
    408: '服务处理超时，请稍后手动重试。',
    413: '输入过长，请缩短内容后重试。',
    429: '请求频率或额度已达上限，请稍后重试或检查额度。',
  };
  return fail('HTTP_ERROR', `模型服务请求失败（HTTP ${status}）：${hints[status]
    ?? (status >= 500 ? '服务暂时不可用，请稍后重试。' : '请检查服务配置。')}`, status);
}

function cancelBody(response) {
  // Cancellation is best effort and must not delay error handling or leak a stream error.
  try { Promise.resolve(response.body?.cancel()).catch(() => {}); } catch { /* no-op */ }
}

async function boundedJson(response, signal) {
  const type = response.headers.get('content-type') ?? '';
  if (!/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)(?:\s*;|$)/i.test(type)) {
    cancelBody(response);
    throw fail('INVALID_RESPONSE', '服务未返回 JSON，请检查 API 地址，勿使用登录页或文档页。', response.status);
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_BYTES) {
    cancelBody(response);
    throw fail('RESPONSE_TOO_LARGE', '服务响应过大，已停止读取。', response.status);
  }
  if (!response.body?.getReader) throw fail('INVALID_RESPONSE', '服务返回了空响应。', response.status);
  const reader = response.body.getReader();
  const abort = () => { Promise.resolve(reader.cancel()).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  let total = 0;
  let text = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        abort();
        throw fail('RESPONSE_TOO_LARGE', '服务响应过大，已停止读取。', response.status);
      }
      text += decoder.decode(value, { stream: true });
    }
    signal.throwIfAborted();
    text += decoder.decode();
    let data;
    try { data = JSON.parse(text); } catch { throw fail('INVALID_RESPONSE', '服务返回的 JSON 无法解析。', response.status); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw fail('INVALID_RESPONSE', '服务返回的数据格式不正确。', response.status);
    }
    if (data.error || (data.base_resp?.status_code !== undefined && data.base_resp.status_code !== 0)) {
      throw fail('SERVICE_ERROR', '服务未完成请求，请检查模型权限、输入和余额。', response.status);
    }
    return data;
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

async function withSession(config, { fetchImpl, signal }, timeout, operation) {
  if (!config.apiKey) throw fail('MISSING_KEY', '请先填写模型服务密钥。');
  if (typeof fetchImpl !== 'function') throw fail('INVALID_FETCH', '当前环境无法发起网络请求。');
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  let removeAbort;
  const aborted = new Promise((_, reject) => {
    const stop = () => reject(fail(timedOut ? 'TIMEOUT' : 'CANCELLED', timedOut
      ? '模型服务请求超时，已停止等待；如需重试请手动操作。' : '请求已取消。'));
    removeAbort = () => controller.signal.removeEventListener('abort', stop);
    controller.signal.addEventListener('abort', stop, { once: true });
    if (controller.signal.aborted) stop();
  });
  const request = async (url, payload) => {
    controller.signal.throwIfAborted();
    const target = new URL(url);
    if (target.origin !== new URL(config.baseUrl).origin) {
      throw fail('UNSAFE_DESTINATION', '已阻止向其他站点发送密钥。');
    }
    const headers = headersFor(config);
    const init = {
      method: payload === undefined ? 'GET' : 'POST',
      headers,
      signal: controller.signal,
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    };
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(payload);
      if (new TextEncoder().encode(init.body).byteLength > MAX_BYTES) {
        throw fail('INPUT_TOO_LARGE', '输入内容过长，请分段处理。');
      }
    }
    const response = await fetchImpl(target.href, init);
    controller.signal.throwIfAborted();
    // Defense in depth for injected fetch implementations; real fetch rejects redirects above.
    if (response.redirected || response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)
      || (response.url && response.url !== target.href)) {
      cancelBody(response);
      throw fail('UNSAFE_REDIRECT', '服务尝试跳转，已阻止转发密钥；请填写最终 API 地址。', response.status || undefined);
    }
    if (!response.ok) {
      cancelBody(response);
      throw httpError(response.status);
    }
    return boundedJson(response, controller.signal);
  };
  try {
    return await Promise.race([aborted, Promise.resolve().then(() => operation(request))]);
  } catch (error) {
    // Never expose fetch exceptions, abort reasons, URLs, response bodies, or nested causes.
    if (controller.signal.aborted) throw fail(timedOut ? 'TIMEOUT' : 'CANCELLED', timedOut
      ? '模型服务请求超时，已停止等待；如需重试请手动操作。' : '请求已取消。');
    if (error instanceof GatewayError) throw error;
    throw fail('NETWORK_ERROR', '无法连接模型服务，请检查网络、站点授权及 API 地址。');
  } finally {
    clearTimeout(timer);
    removeAbort();
    signal?.removeEventListener('abort', onAbort);
    controller.abort();
  }
}

/** Source distinguishes account discovery from an official, non-authorizing catalog. */
export async function listModels(input, { fetchImpl = globalThis.fetch, signal } = {}) {
  const config = normalizeGateway(input);
  if (!config.apiKey) throw fail('MISSING_KEY', '请先填写模型服务密钥。');
  if (signal?.aborted) throw fail('CANCELLED', '请求已取消。');
  // GLM has no verified account-discovery route; do not send credentials to a guessed path.
  if (isOfficialPreset(config, 'zhipu')) return catalogFor('zhipu');
  return withSession(config, { fetchImpl, signal }, 30000, async (request) => {
    const models = new Map();
    const cursors = new Set();
    let cursor = '';
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL(`${config.baseUrl}/models`);
      if (config.protocol === 'gemini') url.searchParams.set('pageSize', '1000');
      if (config.protocol === 'anthropic') url.searchParams.set('limit', '1000');
      if (cursor) url.searchParams.set(config.protocol === 'gemini' ? 'pageToken' : 'after_id', cursor);
      const data = await request(url.href);
      // Gemini may omit an empty models array on the last/empty page.
      const items = config.protocol === 'gemini' ? (data.models ?? []) : data.data;
      if (!Array.isArray(items)) throw fail('INVALID_RESPONSE', '服务返回的模型列表格式不正确。');
      for (const item of items) {
        const id = config.protocol === 'gemini' ? item?.name : item?.id;
        if (typeof id !== 'string' || !id || id.length > 512 || /[\u0000-\u001f\u007f]/u.test(id)) {
          throw fail('INVALID_RESPONSE', '服务返回的模型名称格式不正确。');
        }
        const display = item.displayName ?? item.display_name ?? item.name;
        if (!models.has(id)) models.set(id, { id, name: typeof display === 'string' && display ? display : id, source: 'remote' });
        if (models.size > MAX_MODELS) throw fail('MODEL_LIST_LIMIT', '模型列表过大，请缩小服务端模型范围。');
      }
      const next = config.protocol === 'gemini' ? data.nextPageToken
        : config.protocol === 'anthropic' && data.has_more ? data.last_id : undefined;
      if (config.protocol === 'anthropic' && data.has_more && !next) {
        throw fail('INVALID_RESPONSE', '服务返回的模型分页游标缺失。');
      }
      if (next === undefined || next === null || next === '') return [...models.values()];
      if (typeof next !== 'string' || next.length > 2048 || cursors.has(next)) {
        throw fail('MODEL_LIST_LIMIT', '模型列表分页异常，已停止继续请求。');
      }
      cursors.add(next);
      cursor = next;
    }
    throw fail('MODEL_LIST_LIMIT', '模型列表超过 10 页，已停止请求；请缩小服务端模型范围。');
  }).catch((error) => {
    // MiniMax currently documents discovery, but some deployments lack that route.
    // Only an explicit unsupported-route response qualifies; never hide auth/quota/network errors.
    if (isOfficialPreset(config, 'minimax') && error.code === 'HTTP_ERROR' && [404, 405].includes(error.status)) {
      return catalogFor('minimax');
    }
    throw error;
  });
}

function validatedMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 1000) {
    throw fail('INVALID_MESSAGES', '请提供有效的对话内容。');
  }
  let characters = 0;
  const result = messages.map((message) => {
    if (!message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') {
      throw fail('INVALID_MESSAGES', '对话仅支持 system、user、assistant 角色及纯文本内容。');
    }
    characters += message.content.length;
    if (characters > MAX_BYTES) throw fail('INPUT_TOO_LARGE', '输入内容过长，请分段处理。');
    return { role: message.role, content: message.content };
  });
  if (!result.some((message) => message.role === 'user' && message.content.trim())) {
    throw fail('INVALID_MESSAGES', '请至少提供一条非空的用户消息。');
  }
  return result;
}

function numericUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const allowed = ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens',
    'cache_creation_input_tokens', 'cache_read_input_tokens', 'promptTokenCount', 'candidatesTokenCount',
    'totalTokenCount', 'cachedContentTokenCount', 'thoughtsTokenCount'];
  const usage = Object.fromEntries(allowed.filter((key) => Number.isFinite(value[key]) && value[key] >= 0)
    .map((key) => [key, value[key]]));
  return Object.keys(usage).length ? usage : undefined;
}

export async function complete(input, messages, { fetchImpl = globalThis.fetch, signal, maxTokens = 4096, allowTruncated = false } = {}) {
  const config = normalizeGateway(input);
  const conversation = validatedMessages(messages);
  if (!config.model) throw fail('MISSING_MODEL', '请先选择或填写模型名称。');
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 131072) {
    throw fail('INVALID_MAX_TOKENS', '输出长度应为 1 至 131072 之间的整数。');
  }
  const system = conversation.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
  const turns = conversation.filter((message) => message.role !== 'system');
  let endpoint;
  let payload;
  if (config.protocol === 'gemini') {
    const model = config.model.replace(/^models\//, '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model)) {
      throw fail('INVALID_MODEL', 'Gemini 模型名称应为模型 ID 或 models/模型ID，不能包含地址或其他路径。');
    }
    endpoint = `${config.baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
    payload = {
      contents: turns.map((message) => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] })),
      generationConfig: { maxOutputTokens: maxTokens },
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    };
  } else if (config.protocol === 'anthropic') {
    endpoint = `${config.baseUrl}/messages`;
    payload = { model: config.model, messages: turns, max_tokens: maxTokens, stream: false, ...(system ? { system } : {}) };
  } else {
    endpoint = `${config.baseUrl}/chat/completions`;
    const tokenField = config.provider === 'openai' || config.provider === 'minimax' ? 'max_completion_tokens' : 'max_tokens';
    payload = { model: config.model, messages: conversation, stream: false, [tokenField]: maxTokens };
  }
  return withSession(config, { fetchImpl, signal }, 90000, async (request) => {
    const data = await request(endpoint, payload);
    let text;
    let usage;
    let stopReason;
    if (config.protocol === 'gemini') {
      const candidate = data.candidates?.[0];
      text = candidate?.content?.parts?.filter((part) => typeof part.text === 'string' && part.thought !== true)
        .map((part) => part.text).join('');
      stopReason = candidate?.finishReason;
      usage = numericUsage(data.usageMetadata);
    } else if (config.protocol === 'anthropic') {
      text = data.content?.filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('');
      stopReason = data.stop_reason;
      usage = numericUsage(data.usage);
    } else {
      const choice = data.choices?.[0];
      const content = choice?.message?.content;
      text = typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('') : undefined;
      stopReason = choice?.finish_reason;
      usage = numericUsage(data.usage);
    }
    if (['length', 'max_tokens', 'MAX_TOKENS'].includes(stopReason) && !allowTruncated) {
      throw fail('OUTPUT_TRUNCATED', '模型输出达到长度上限，请缩短输入或提高输出长度后重试。');
    }
    if (['content_filter', 'refusal', 'SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(stopReason)) {
      throw fail('MODEL_REFUSAL', '模型未能返回此内容，请调整输入或选择其他模型。');
    }
    if (typeof text !== 'string' || !text.trim()) {
      throw fail('NO_TEXT', '模型没有返回可用文本；该模型可能不支持文本生成，请选择文本模型重试。');
    }
    return { text, ...(usage ? { usage } : {}), ...(stopReason ? { finishReason: String(stopReason) } : {}) };
  });
}

/**
 * Generate a long answer by continuing from where the model stopped.
 * Harnesses such as Codex/Claude Code do exactly this: the per-message cap is
 * real, but the caller stitches several messages into one artifact.
 */
export async function completeLong(input, messages, { fetchImpl = globalThis.fetch, signal, maxTokens = 8192, maxContinuations = 3 } = {}) {
  const mergeOverlap = (head, tail) => {
    for (let size = Math.min(80, head.length, tail.length); size >= 8; size -= 1) {
      if (head.slice(-size) === tail.slice(0, size)) return head + tail.slice(size);
    }
    return head + tail;
  };
  let text = '';
  let conversation = messages;
  let last = null;
  for (let attempt = 0; attempt <= maxContinuations; attempt++) {
    try {
      last = await complete(input, conversation, { fetchImpl, signal, maxTokens, allowTruncated: true });
    } catch (error) {
      // An empty continuation should not throw away the parts already produced.
      if (error?.code === 'NO_TEXT' && text) break;
      // Some gateways return an empty body on the first try; ask once more plainly.
      if (error?.code === 'NO_TEXT' && !text && attempt === 0) {
        conversation = [...messages, { role: 'user', content: '请直接输出正文内容，不要只给思考过程或留空。' }];
        last = await complete(input, conversation, { fetchImpl, signal, maxTokens, allowTruncated: true });
        text = text ? mergeOverlap(text, last.text) : last.text;
        if (!['length', 'max_tokens', 'MAX_TOKENS'].includes(last.finishReason)) break;
        continue;
      }
      throw error;
    }
    text = text ? mergeOverlap(text, last.text) : last.text;
    const truncated = ['length', 'max_tokens', 'MAX_TOKENS'].includes(last.finishReason);
    if (!truncated) break;
    conversation = [
      ...conversation,
      { role: 'assistant', content: last.text },
      { role: 'user', content: '上一次输出被长度限制截断。请从截断处继续写，不要重复已经写过的内容，也不要重新开头。' },
    ];
  }
  return { ...last, text, continued: text.length > (last?.text?.length || 0) };
}
