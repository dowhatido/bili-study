# Bilibili 只读适配器接入约定

版本：0.1.0。核查日期：2026-10-15。

本模块仅处理当前账号有权访问的普通 BV 视频、已有字幕、自己创建的收藏夹和观看历史。不读取、存储或返回 Cookie，不获取音视频，不做 ASR，不绕过登录/风控，不实现后台或界面。未修改 YouTube 项目。

## 导出与返回值

纯 ESM，无运行时依赖，无 Node 专用导入，浏览器可直接加载。恰好导出以下五个函数：

```js
parseVideoUrl(url)             // { bvid, page } | null
videoKey(video)                // `bilibili:${bvid}:${cid}`
canonicalVideoUrl(video, seconds?) // https://www.bilibili.com/video/BV...?p=N[&t=S]
createWbiSignature(params, wbiKeys) // 带 w_rid 的参数对象，同步纯函数
createBilibiliClient({ request, resourceCandidates = [] })
```

`parseVideoUrl` 只接受 http(s) 的精确主机 `www.bilibili.com`、`/video/<12位BV号>`（可带末尾斜杠）。支持普通 `BV17x411w7KC`。默认 P1；`p` 必须为正安全整数；重复、空、负数、小数 `p` 均拒绝。拒绝短链、av 号、移动站、番剧页、外站、userinfo 和非默认端口，不自动展开分享短链。

`canonicalVideoUrl` 始终显式保留 `p`，可选 `t` 为非负秒数向下取整，不保留追踪参数。`videoKey` 需要已解析的正整数 CID，收藏列表没有 CID 时不得伪造 key。

客户端返回六个异步方法：

```js
getVideo({ bvid, page = 1 })
// { key, bvid, aid, cid, page, title, partTitle, author, description, duration, url }

getTranscript(video)
// { language, segments: [{ id, start, end, text }], source }
// source: 'signed-wbi' | 'player-resource'

getAccount()
// { mid, name }

getFavoriteFolders(mid)
// [{ id, title, count }]

getFavoriteVideos(folderId, { maxPages = 10 } = {})
// { items: [{ bvid, page: 1, title, author, favoritedAt, duration,
//             description, aid, partCount, unavailable, url }], hasMore }

getHistory({ maxPages = 10 } = {})
// { items: [{ bvid, cid, page, title, author, viewedAt, progress, duration, url }], hasMore }
```

所有 `duration/start/end/progress` 均为秒，可有小数；历史 `progress === -1` 保留源接口的“已看完”标记。**`favoritedAt`、`viewedAt` 为源接口 Unix 秒，不是毫秒。由 MAIN 在写入事件之前转换为毫秒。** 缺失时间返回 `null`；收藏时间只取 `fav_time`，绝不使用投稿时间、发布时间或当前时间补造。没有可验证来源的分享数不返回。

`language` 原样保留轨道语言，例如 `zh-Hans`、`ai-zh`；播放器资源未提供语言时为 `und`。MAIN 的目标语言处理应识别 `ai-zh`，不能把它当成未知语言或英文。

收藏条目按整个 BVID 去重并默认选择 **P1**；源字段 `page` 是总分P数，只映射为 `partCount`，不能当作当前 P。收藏条目不是已解析视频：先 `getVideo({ bvid, page: 1 })` 再取字幕。收藏元数据时长不代表 P1 时长；摘要使用 `getVideo` 返回的当前分P时长。历史保留实际观看 P，以 BVID+CID 去重；缺失 CID/P、直播、专栏和番剧等条目不当作普通 BV 视频导入。

摘要范围仅为当前分P，或收藏视频的第一分P；没有承诺摘要覆盖整套多P课程。

## 请求桥接：MAIN 和后台的职责

注入函数约定为 `await request(path, params = {})`，返回已解析 JSON，不返回 `Response`：

| path | 执行位置 | 返回内容 |
| --- | --- | --- |
| `/x/...` | 登录的 Bili 页面 MAIN world，浏览器自然携带会话 | 原始 `{ code, data, ... }` JSON envelope |
| 经校验的完整字幕 http(s) URL | service worker，无凭据 | 原始字幕 JSON `{ body: [...] }` |

适配器只调用这些 API 路径，均为 GET：

```text
/x/web-interface/view
/x/web-interface/nav
/x/player/wbi/v2
/x/v3/fav/folder/created/list
/x/v3/fav/resource/list
/x/web-interface/history/cursor
```

MAIN 必须再执行同等白名单检查，不能把消息通道做成任意 URL 代理。后台取字幕时应使用 `credentials: 'omit'` 和 `redirect: 'error'`；manifest 只授权所需 CDN。不能默认跟随跳转到白名单外站点。适配器只看到 JSON，不能检查最终跳转地址或 HTTP 响应头，这一限制不能由适配器替后台“保证”。

HTTP 非成功时，桥接应抛出并跨消息边界保留数值 `error.status`（或 `statusCode`），例如 `{ status: 403 }`。只把“403”拼入错误文案，会失去过期链接自动恢复语义。设置超时、关闭失效 tab 的请求、限定请求响应大小均由 MAIN/后台完成。适配器不调用浏览器 API，不传任何 Cookie 参数，不采集真实凭据。

不要记录完整字幕 URL、短期签名或原始服务端错误；适配器错误只返回固定中文消息、机器可读 `code` 和可选 HTTP `status`。

## 字幕可信链与 URL 归属

1. `getVideo` 从 view 的 `pages[]` 中按显式 `page` 找 CID，不使用顶层 P1 CID 替代。检查 pages 非空、编号连续且唯一、CID 唯一；若 `videos` 声明总数，要求与 pages 长度一致。列表缺项/重复/截断为 `INVALID_RESPONSE`，真实完整列表之外的 P 为 `INVALID_VIDEO`。不从数组位置猜 P，也不默默退回 P1。
2. `getTranscript` 在任何 await 之前复制输入身份和资源候选，并再次读取 view 验证该 P 的 BVID/AID/CID。拒绝不匹配的输入 key 或 CID。
3. 从 nav 获取 `wbi_img` 文件名密钥，使用自实现 RFC 1321 MD5 计算 WBI 签名，向 `/x/player/wbi/v2` 显式绑定 `aid/bvid/cid`。nav 的匿名 `code=-101` 仍可能带密钥；密钥可用不等于已经登录。签名端点返回的身份字段只要存在，就必须匹配。
4. 仅下载签名 metadata 中的可信轨道。优先人工中文、再 AI 中文、再其他语言；返回所用轨道的真实语言。**不调用 `/x/player/v2`，不信任 view 中附带的未签名 subtitle 列表。**
5. 签名 URL 的 HTTP 403/404 最多触发一次新 metadata discovery（新 nav、新签名、新轨道）；不缓存短期 URL，不无限重试。同一已失败签名 URL 不再作为播放器资源重复请求。签名端点的风控/拒绝最多刷新密钥再试一次；`v_voucher` 不当作成功的空字幕。
6. 可信 metadata 不可用时，才尝试 `resourceCandidates` 中通过严格验证的播放器资源。不会扫描任意页面对象寻找 URL。

所有字幕 URL 都必须满足以下条件：

- 协议仅 http(s)，可将 `//host/path` 解析为 https；不更改既有签名查询。
- 精确主机白名单：`aisubtitle.hdslb.com`、`hds.hdslb.com`、`subtitle.bilibili.com`、`i0.hdslb.com`、`i1.hdslb.com`、`i2.hdslb.com`。没有 `*.hdslb.com`/`*.bilibili.com` 的泛信任。
- 路径仅 `/bfs/subtitle/` 或 `/bfs/ai_subtitle/`；拒绝账号密码、非默认端口、fragment、反斜线、空白和其他路径。未知 CDN/新路径需先取得证据再加入，不能自动放宽。
- URL 显式 `cid`/`bvid` 查询和轨道身份若存在，不得与当前视频冲突。签名 metadata 的不透明文件名可凭该次请求上下文授权，不能把这份信任转移给任意播放器资源。

资源候选支持字符串，或 `{ name }`（performance 条目），或 `{ url, language?, bvid?, cid? }`。候选额外身份声明若存在，必须一致，但声明本身不构成归属证明。**URL 自身仍须内嵌当前 CID**：完整命名 `cid` 查询值，或以 `/ _ . -` 分隔的完整十进制路径 token。

例如当前 CID 为 `12345`：`/bfs/ai_subtitle/prod/12345_zh.json`、`/bfs/subtitle/file.json?cid=12345` 可作为兜底；`912345`、`123456`、`abc12345def`、`auth_key=12345`、仅含 AID/BVID、仅候选对象声明 `cid:12345` 都不够。若 URL 同时声明其他 CID/BVID，也会拒绝。更严格的代价是无法证明归属的合法人工字幕资源可能不可用；不能据此向用户断言“视频没有字幕”。

正文只接受非空 `body`，每行包含非负有限 `from`、大于起点的 `to` 和非空字符串 `content`。全部校验后按时间排序、精确去重，保留正常重叠和小数时间；无效正文不伪造字幕。segment id 包含当前 `bilibili:BVID:CID`，不会跨P复用。

### 异步乱序边界

客户端没有全局“当前视频”状态；P1/P2 并行请求各自绑定独立快照，迟到结果不会被重标记成新 P。**它不知道界面是否已跳转，不能替 MAIN 丢弃旧结果。** MAIN 应按 tab+请求序号+`videoKey` 再校验一次，在展示/存储结果前拒绝旧 epoch。资源候选应由当前 tab 获取并在跳转时清空，不能把别的 tab 资源传来。测试覆盖 P1 晚于 P2 返回、输入对象中途改写、资源数组中途改写。

## WBI 纯函数

```js
const signedParams = createWbiSignature(
  { aid, bvid, cid, wts: Math.floor(Date.now() / 1000) },
  { imgKey, subKey }, // 也接受 img_key/sub_key
);
await request('/x/player/wbi/v2', signedParams);
```

调用者必须提供 Unix 秒 `wts`，函数自身不读时钟、不联网、不修改输入。返回值为可直接传给 request 的对象：值转换为字符串，去除 `!'()*`，按键排序编码，空间使用 `%20`，重新计算并覆盖旧 `w_rid`。请求桥应发送返回的值，而不是旧参数。MD5 仅用于平台规定的签名，不能用于密码/安全校验。

## 分页与错误

收藏夹每页 20 项，按 `has_more`，或缺少该字段时按 `count` 翻页；最多 100 页。因为返回契约是数组，没有 `hasMore` 可表达部分结果，所以达到安全上限、重复页、无进展或无法确认完整性时抛错，不返回静默截断数组。只包含该账号创建的文件夹，不声称包含它收藏的外部文件夹/合集。

收藏视频每页 20 项，`maxPages` 默认 10，上限 100；使用 `has_more`，缺失时以实际收到条目数与源总数保守判断，不能把请求的每页数量当成已收到数量。历史每页 30 项，默认 10 页、上限 100；原样接续 `cursor.max/view_at/business` 三元组，不用最后一个筛选后的视频推算游标。不会因为过滤掉直播/专栏或短页就停止。历史空列表或明确终点才算读完。遇到上限、循环游标、无进展或未知终点，返回 `hasMore: true`。该标记表示仍有未读或完整性未知，不是精确剩余数量。

错误 `code` 包括：`LOGIN_REQUIRED`、`FORBIDDEN`、`NOT_FOUND`、`RISK_CONTROL`、`NETWORK_ERROR`、`REQUEST_FAILED`、`INVALID_RESPONSE`、`CONTEXT_MISMATCH`、`UNSAFE_SUBTITLE_URL`、`CAPTIONS_UNAVAILABLE`、`INVALID_CAPTIONS`、`SUBTITLE_EXPIRED`、`PAGINATION_LIMIT` 和输入/密钥校验错误。空字幕轨道加明确未登录证据才返回登录提示；已登录的空轨道返回“当前分P没有可读取的字幕”，不是已证明字幕不存在。风控、权限、网络和解析失败不会被吞成空列表。

## 证据、供应链与验收

本次仅用 anysearch 阅读公开说明和协议资料，未安装、克隆执行或复制第三方项目代码；适配器独立实现，没有第三方包/构建脚本/遥测。参考项目声明 MIT，这里只吸收协议事实，不把其自述验证等同于本项目实测：

- [ymt200120/bili-subtitle](https://github.com/ymt200120/bili-subtitle) 及 [PROTOCOL.md](https://github.com/ymt200120/bili-subtitle/blob/main/docs/PROTOCOL.md)：旧接口串字幕风险、可信策略链、字幕过期恢复、严格归属。其登录态成功案例是第三方证据，不是本项目验收。
- [WBI 历史社区文档镜像](https://github.com/pskdje/bilibili-API-collect/blob/main/docs/misc/sign/wbi.md)：固定重排表和确定性签名向量。
- [收藏内容字段](https://github.com/pskdje/bilibili-API-collect/blob/main/docs/fav/list.md)、[收藏夹说明](https://github.com/pskdje/bilibili-API-collect/blob/main/docs/fav/info.md)、[历史游标字段](https://github.com/pskdje/bilibili-API-collect/blob/main/docs/historytoview/history.md)：字段语义及分页。此镜像已归档，只作历史协议依据。
- [已公开的 created/list 请求定义](https://github.com/wood3n/biu/blob/7d499206f6b19876c2f2fd2a84580b1cee683101/src/service/fav-folder-created-list.ts)：分页 `has_more` 的交叉核对。

本次匿名无凭据直连观测（2026-10-15；终端 Node fetch，不是扩展页面桥）：

| 检查 | 直接观测 |
| --- | --- |
| `view?bvid=BV17x411w7KC` | HTTP 200，code 0；P1 CID 279786，duration 199 秒；完整适配器 getVideo 成功 |
| nav | HTTP 200，code -101，isLogin false，包含 WBI 密钥字段；未输出密钥或签名值 |
| `/x/player/wbi/v2` | 使用本模块签名绑定上述视频，HTTP 200、code 0、轨道数 0；完整适配器返回 LOGIN_REQUIRED，没有误报“无字幕” |
| `created/list` | 使用公开文档示例账号，匿名返回 HTTP 200、code 0、`count/list/has_more` 字段；未保存其实际内容 |

这些匿名结果不代表登录态可用，也不证明空字幕接口在全部账号/风控状态下的行为。尚待 MAIN 在扩展环境验证：登录态字幕正文、多P真实视频、私有收藏夹、多页收藏/历史、CDN CORS/manifest、403/404 状态透传、后台重定向策略和 UI 旧结果丢弃。

`/x/v2/subtitle/web/view` 通常是二进制 Protobuf。第三方提供了有限字段说明，但当前 request 契约只有 JSON，且本次未验证真实登录态字段，因此**没有接入或猜测解码**。只有此接口可用、WBI/严格资源兜底均不可用时，字幕可能无法取得；不会伪装成全覆盖。

本地验证：

```sh
node --test tests/bilibili.test.js
node --test --experimental-test-coverage tests/bilibili.test.js
node --check src/bilibili.js
```

测试不联网，不依赖真实账号；覆盖签名公开向量和 Node crypto 对照、URL 拒绝、pages 完整性、身份归属、字幕规范化、登录/风控区分、精确 CID 资源筛选、一次过期恢复、乱序与对象变更，以及收藏/历史分页和时间戳真实性。未做界面文案/页面验收，因为背景和 UI 不在本次写入范围。由主任务同步本契约的项目进展到 AGENTS/agent.md 与 PRD；本次不越过指定三个文件修改它们。
