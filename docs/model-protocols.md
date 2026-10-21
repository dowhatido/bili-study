# 模型网关协议与安全边界

核对日期：2026-10-15。此模块只提供纯文本模型调用，不读取环境变量、浏览器存储或本地文件，不包含界面、SDK、自动重试、工具调用或流式输出。

## 接入契约

```js
import { PROVIDERS, normalizeGateway, getPermissionOrigin, listModels, complete } from './gateway.js';

const gateway = normalizeGateway({
  provider: 'custom',
  protocol: 'openai',
  baseUrl: 'https://gateway.example/proxy/v1',
  apiKey: '', // 调用方从本机设置中取得；不要记录配置对象或密钥。
  model: '', // 使用用户从模型列表中选择的 ID。
});

const permission = getPermissionOrigin(gateway.baseUrl);
// 调用方在明确的用户操作中申请 permission 对应的可选站点权限。
// 获得权限并填入密钥后，才调用 listModels / complete。
```

导出函数：

- `PROVIDERS`：冻结的预设数组；项目均含 `id/name/protocol/baseUrl`，已核实的模型列表还带 `modelsUrl`。`modelsUrl` 是预设元数据；实际请求始终根据经过校验的 `baseUrl` 构造，不接受配置中的任意 `modelsUrl`。
- `normalizeGateway(input = {})`：返回且仅返回 `{ provider, protocol, baseUrl, apiKey, model }`。缺省服务是 DeepSeek，密钥和模型缺省为空，不虚构可用模型。预设服务的协议固定；其他协议组合使用 `custom`。标准化不要求密钥或模型，以便先编辑设置。
- `getPermissionOrigin(baseUrl)`：返回与配置同 scheme 的 `https://host/*` 或 `http://host/*`，不自行申请权限；显式非默认端口保留在 origin 中，符合 [Chrome match pattern 的端口规则](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns)。拒绝其他 scheme、内嵌凭据、查询参数和片段。
- `listModels(config, { fetchImpl = globalThis.fetch, signal } = {})`：需要密钥，返回 `Array<{ id, name, source: 'remote' | 'catalog' }>`，不需要预先指定模型。`source` 是列表数据来源，不是账号授权结论。
- `complete(config, messages, { fetchImpl = globalThis.fetch, signal, maxTokens = 4096 } = {})`：需要密钥、模型及至少一条非空 user 消息，返回 `{ text, usage? }`。消息为 `{ role: 'system' | 'user' | 'assistant', content: string }`。附加消息属性不透传，输入不被修改。

`fetchImpl` 应遵循标准 Fetch API 并返回标准 `Response`，生产环境使用浏览器原生 fetch。`usage` 仅保留各协议的已知数值计数字段，名称沿用服务端，不包含原始响应、思考内容或任意服务端字符串。

## 预设、端点与来源

| 服务 ID | 协议 | 默认 baseUrl | 文本生成端点 | 模型列表 |
| --- | --- | --- | --- | --- |
| `deepseek` | `openai` | `https://api.deepseek.com` | `/chat/completions` | `/models` |
| `openai` | `openai` | `https://api.openai.com/v1` | `/chat/completions` | `/models` |
| `xai` | `openai` | `https://api.x.ai/v1` | `/chat/completions` | `/models` |
| `minimax` | `openai` | `https://api.minimax.io/v1` | `/chat/completions` | `/models` |
| `zhipu` | `openai` | `https://open.bigmodel.cn/api/paas/v4` | `/chat/completions` | 官方文本模型目录，`source: catalog` |
| `anthropic` | `anthropic` | `https://api.anthropic.com/v1` | `/messages` | `/models` |
| `google` | `gemini` | `https://generativelanguage.googleapis.com/v1beta` | `/models/{model}:generateContent` | `/models` |
| `custom` | 默认 `openai`，可选另两种 | 必填 | 按协议构造 | 按协议构造，不保证服务实现 |

表中端点均相对于 baseUrl；不是把 `/v1` 再拼接一次。MiniMax 使用国际标准 API，不替换成国内域名、Coding Plan 或 Anthropic 兼容专用地址。智谱使用标准模型 API，不擅自切换 Coding Plan 专用地址。用户有其他服务区域或兼容网关时可显式配置其版本地址；优先 HTTPS，显式配置的 HTTP 也支持。

官方核对依据（先经 anysearch 检索与正文提取；Gemini/xAI 部分页面提取失败后只读访问官方网页）：

- DeepSeek：[首个调用](https://api-docs.deepseek.com/)、[模型列表](https://api-docs.deepseek.com/api/list-models)。当前官方示例使用无 `/v1` 的根地址，所以默认保留根地址；用户显式填写 `/v1` 时不重复追加。
- OpenAI：[模型列表](https://developers.openai.com/api/reference/resources/models/methods/list)、[Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。本模块按任务约定使用 Chat Completions，不把它伪装成 Responses API。
- xAI：[API 概览](https://docs.x.ai/developers/rest-api-reference/inference)、[Chat Completions](https://docs.x.ai/developers/rest-api-reference/inference/chat-completions)、[模型列表](https://docs.x.ai/developers/rest-api-reference/inference/models)。官方推荐新项目使用 Responses，但仍记录 Chat Completions；这里遵循限定协议范围。
- MiniMax：[OpenAI 兼容协议](https://platform.minimax.io/docs/api-reference/text-openai-api)、[模型列表](https://platform.minimax.io/docs/api-reference/models/openai/list-models)。当前官方模型列表明确使用 `GET https://api.minimax.io/v1/models`，不采用历史“不支持列表”的第三方结论。
- 智谱：[对话补全](https://docs.bigmodel.cn/api-reference/模型-api/对话补全)。该官方请求示例使用 `glm-5.3`；它是本轮目录 ID 的证据。本轮未找到可核实的原生模型列表文档，因此对标准智谱预设不带密钥探测猜测出来的路由，而返回显式标记的官方目录。目录不等于账号可用模型清单。
- Claude：[API 概览](https://platform.claude.com/docs/en/api/overview)、[模型列表](https://platform.claude.com/docs/en/api/models/list)、[官方 TypeScript SDK 头部实现](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts)。浏览器访问标识和固定版本头与官方实现对齐。
- Gemini：[模型列表与分页](https://ai.google.dev/api/models)、[generateContent](https://ai.google.dev/api/generate-content)、[API 认证](https://ai.google.dev/api)。认证密钥放入请求头，不写进 URL。

## 三种协议如何映射

### OpenAI Chat Completions

使用 `Authorization: Bearer ...`，POST JSON 包含 `model/messages/stream: false` 和输出长度上限。OpenAI、MiniMax 预设使用 `max_completion_tokens`，DeepSeek/xAI/GLM 和自定义 OpenAI 兼容服务使用 `max_tokens`。不发送 `thinking`、`reasoning_effort`、`enable_thinking`、温度、工具或其他厂商专有字段，也不根据用户配置任意扩展 payload。

取第一个 choice 的 `message.content`；支持字符串或其中的 text 内容块，忽略 `reasoning_content`、图片和工具块。不把推理内容当成最终答案。

### Claude Messages

使用 `x-api-key`、`anthropic-version: 2023-06-01`；仅当协议为 `anthropic` 且 origin 为 `https://api.anthropic.com` 时，添加 `anthropic-dangerous-direct-browser-access: true`。自定义 Anthropic 兼容网关仍使用 `x-api-key` 和版本头，但不自动携带官方浏览器专用头。

所有 system 消息按原顺序用两个换行合并至顶层 `system`；其余消息放入 `messages`，使用 `max_tokens` 和 `stream: false`。返回值仅拼接 `content` 中 `type: text` 的文本。将中途 system 消息提取为顶层指令是适配规则，不等于支持动态变更系统指令的所有语义。

模型列表用同样的认证和版本头；`limit=1000`，有 `has_more: true` 时用 `last_id` 设置下一页 `after_id`。游标缺失、重复或超限时失败，不静默交付半份列表。

### Gemini 原生

使用 `x-goog-api-key`，不发送 Bearer 或 Claude 头。system 消息合并为 `systemInstruction.parts[].text`；其余消息进入 `contents`，assistant 映射为 `model`，文本进入 `parts`。输出上限为 `generationConfig.maxOutputTokens`。

模型输入接受 `gemini-...` 或服务端返回的 `models/gemini-...`，只剥离一次 `models/` 后构建生成端点。拒绝模型名中的 URL、查询参数和多级路径，防止模型字符串改变密钥目的地。范围不含 Vertex AI、OAuth、tunedModels 或 Live API。

模型列表 `pageSize=1000`，将 `nextPageToken` 作为下一页的 `pageToken`；分页参数编码后仍只请求同一 models 端点，不把游标当作 URL。返回第一条 candidate 中非 `thought: true` 的文本，忽略多媒体内容和思考文本。

## 模型可见性不等于文本能力

远端列表条目均标记 `source: 'remote'`，保留真实远端 ID 和名称、按首次出现顺序去重，不改写 Gemini 的 `models/` 前缀，也不基于不可靠的名称前缀删除 embedding、图像或音频模型。统一返回类型不包含完整能力信息，所以这些项目不能被描述为“全部可用于总结”。界面仅使用下拉选择，不要求用户输入模型 ID。

官方目录回退是有限且明确的例外，不是远端发现成功：

| 触发条件 | 列表来源与模型 ID | 不代表什么 |
| --- | --- | --- |
| `provider: zhipu` 且标准 baseUrl 未改动；无已核实的账号发现路由 | 不发请求；`source: catalog`，`glm-5.3` | 不证明密钥有效、账号已授权、地区可用或余额足够 |
| `provider: minimax` 且标准 baseUrl 未改动；`GET /models` 明确返回 404 或 405，表明该部署未提供列表路由 | `source: catalog`，`MiniMax-M3`、`MiniMax-M2.7`、`MiniMax-M2.5` | 不把该目录描述成账号授权清单；也不隐瞒认证、限流或网络错误 |
| 其他服务、任何自定义网关、预设但 baseUrl 已覆盖 | 只接受真实远端列表，`source: remote`；失败就报错 | 不提供目录回退、不编造模型或账号可见性 |

MiniMax 当前官方文档已提供发现接口，因此始终先请求真实列表；成功返回空数组时保留空数组，不能回退目录。只有上述 404/405 才代表可用发现路由缺失；401/403/429/5xx、网络错误、超时、重定向和无效响应均直接失败。目录只使用上述官方文档核实的少量文本模型，不会扩展为厂商全量模型列表。目录对象每次新建，调用方修改不会污染后续结果。

界面需要说明 `catalog` 来自官方公共目录而非账号校验；选择后仍以实际生成调用的结果为准。即使自定义网关填写与官方相同的域名，也不会套用预设目录回退。密钥是否存在只在本地校验，不通过付费生成请求“试用”目录。

本模块只支持纯文本非流式生成。模型还可能因账号权限、地区、上下文上限、必需的推理配置或不支持当前端点而失败。`NO_TEXT` 提示选择文本模型；服务返回截断状态时抛 `OUTPUT_TRUNCATED`，过滤/拒绝时抛 `MODEL_REFUSAL`，不会把已知截断结果当作完整总结。模块不承诺所有可见模型、所有旧模型和厂商全部专有能力都兼容。

## 地址与凭据边界

- 必须是完整 HTTP 或 HTTPS 地址，无用户名、密码、查询参数或片段。禁止控制字符、路径转义、点段和重复斜线。默认预设均为 HTTPS，不自动降级；HTTP 只有显式配置才使用。
- 接受 API 根域名、版本地址和匹配协议的完整生成/模型列表端点，先剥离已知后缀再构造请求。例如 `/v1/chat/completions` 变成 `/v1`，不会出现 `/v1/v1`。Gemini 可粘贴完整 `:generateContent` 地址，但模型仍以配置中的 model 为准。
- 自定义 API 前缀可为 `/proxy/openai/v1`、`/anthropic/v1` 或 `/api/paas/v4` 等明确版本路径。其他无版本自定义子路径不猜测；需填写服务商提供的版本地址。拒绝已知网页路由（文档、登录、控制台、账单等）、HTML 文件、重复版本和不匹配端点。
- 路径校验不能证明一个陌生域名可信；用户选择自定义服务即意味着把密钥和输入交给该服务。调用方需展示/确认最终 origin（包含 scheme 和端口），申请最小站点权限，并只在扩展可信上下文读取密钥；不要把密钥交给 Bilibili 页面或 content script。
- HTTP 会明文传输密钥、消息及结果，中间网络可读取或篡改；仅在用户理解并明确配置的受信网络中使用，优先改用 HTTPS。本模块不自动升级 HTTP，不把 HTTP 的授权复用为 HTTPS，亦不跟随跨 scheme 跳转。调用方更改 scheme、主机或端口时必须清空密钥输入，不能向新 origin 预填旧密钥；新 origin 需显式申请权限。此模块无存储或密钥复用机制，主界面负责该流程。
- Fetch 固定 `redirect: 'error'`，同源跳转也拒绝，不跟随任何重定向。额外检测 `redirected`、30x、不匹配响应 URL 和 `opaqueredirect`。不向第二个 origin 重发凭据。
- 固定 `credentials: 'omit'`、`referrerPolicy: 'no-referrer'`、`cache: 'no-store'`；不携带站点 Cookie、不记录请求/响应或配置对象。

## 有界执行与错误

生成调用总时限 90 秒，模型列表全部分页共享 30 秒；包含响应体读取时间，不对每一页重新计时。外部 AbortSignal 可在发起前、等待响应时及读取正文时取消。忽略注入 fetch 的长等待也受本模块 Promise 竞速约束；生产环境原生 fetch 同时收到内部取消信号。

请求 JSON 和单次响应正文上限均为 2 MiB；读取响应采用字节计数，不能只相信 `Content-Length`。最多 1000 条输入消息、10000 个去重模型、10 页模型结果；输出长度接受 1–131072 的整数，具体模型可能有更低限制。超出分页上限时抛错，不返回未经标注的截断列表。

成功响应必须为 JSON（允许 `application/*+json`），不解析 HTML、不展示服务端错误正文。错误使用中文静态提示，仅暴露稳定 `code` 和适用时的 HTTP `status`；401、403、404、429、5xx 等保留状态并给出操作建议。网络异常、远端错误信息、URL、密钥、AbortSignal.reason、响应页面和嵌套 cause 均不进入对外错误。

不会自动重试生成、请求失败或未知结果，不自动切换服务或模型。取消/超时只代表本地停止等待，不保证服务端停止推理或停止计费；重试必须由调用方的明确用户操作触发。

## 验证方式与未覆盖项

在项目根运行：

```sh
node --test tests/gateway.test.js
```

全部测试使用 Node 内置 `node:test`、合成配置及注入 fetch，验证路径、协议头、消息映射、参数隔离、原始 ID、source 来源标记、目录回退触发与禁用条件、原生分页、分页边界、取消、超时、大小限制、HTTP/HTTPS 地址、错误脱敏、HTTP 状态及自定义网关。没有用户密钥读取，也没有联网模型推理或付费测试。

当前证据是官方协议核对与本地单元验证，不等于 Chrome/Edge 站点权限、CORS、MV3 服务生命周期或真实账户调用已验收。这些由主工程集成测试完成。本轮未改动任何界面，所以页面状态与可见文案审查不在本模块验收范围；项目 AGENTS.md/PRD 应由主工程同步记录上述协议和权限边界。
