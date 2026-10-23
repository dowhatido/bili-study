import { PROVIDERS, normalizeGateway, listModels, complete, completeLong, getPermissionOrigin } from "./gateway.js";
import { createBilibiliClient, parseVideoUrl, videoKey } from "./bilibili.js";
import { readState, changeState, publicState, normalizeSettings, addAudit } from "./store.js";
import { groupSegments, splitBatches, parseJson, GROUNDED_SYSTEM, sourceText, rankSegments, validateCitations, reportEvidence, dateKey, eventTime, timeLabel } from "./learning.js";
import { videoMarkdown, collectionMarkdown } from "./markdown.js";
import { vaultHandle, writeSnapshot } from "./vault.js";
import { assembleClassNotes } from "./notes.js";

let draining = false;
const controllers = new Map();
const inFlight = new Map();
const modelLists = new Map();
const SUMMARY_BATCH_CONCURRENCY = 2;
const discoveryKey = config => JSON.stringify([config.provider, config.protocol, config.baseUrl, config.apiKey]);
function parseSpaceMid(value) {
  const raw = String(value || "").trim();
  if (/^\d{1,20}$/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "space.bilibili.com") return null;
    return /^\/(\d{1,20})\/?$/.exec(url.pathname)?.[1] || null;
  } catch { return null; }
}
const TRUSTED_PAGE = /^https:\/\/www\.bilibili\.com\//;
const API_PATHS = /^\/x\/(web-interface|player|v2\/subtitle|v3\/fav|space|polymer)\//;

function preserveSummary(video) {
  if (video.summary) (video.summaryHistory ||= []).push({ text: video.summary, model: video.summaryModel, edited: Boolean(video.summaryEdited), at: video.updatedAt || Date.now() });
}


async function saveDoc(doc) {
  const handle = await vaultHandle().catch(() => null);
  if (!handle) return { saved: false, reason: "未连接知识库文件夹" };
  try { return { saved: true, path: await writeSnapshot(handle, doc) }; }
  catch (error) { return { saved: false, reason: error.message || "保存失败" }; }
}

async function findTab(tabId) {
  if (tabId) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && TRUSTED_PAGE.test(tab.url || "")) return tab;
  }
  const tabs = await chrome.tabs.query({ url: "https://www.bilibili.com/*" });
  // A discarded or still-loading tab cannot serve a MAIN-world fetch reliably.
  const usable = tabs.filter(t => !t.discarded && t.status !== "unloaded");
  return usable.find(t => t.active)
    || usable.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0]
    || tabs[0]
    || null;
}

async function biliClient(tabId) {
  const tab = await findTab(tabId);
  // A frozen tab can make executeScript hang forever; the probe is optional evidence only.
  const resources = tab ? await Promise.race([
    chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN",
      func: () => performance.getEntriesByType("resource").map(x => x.name).filter(x => /subtitle/i.test(x)).slice(-80),
    }).catch(() => []),
    new Promise(resolve => setTimeout(() => resolve([]), 1500)),
  ]) : [];
  const request = async (path, params = {}) => {
    if (/^https:\/\//.test(path)) {
      const url = new URL(path);
      if (!/(^|\.)hdslb\.com$/.test(url.hostname) && !/(^|\.)bilibili\.com$/.test(url.hostname)) throw new Error("字幕来源无法确认。");
      const response = await fetch(url, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(30000) });
      if (!response.ok) { const error = new Error(`字幕暂时无法读取（${response.status}）。`); error.status = response.status; throw error; }
      return response.json();
    }
    if (!API_PATHS.test(path)) throw new Error("请求路径不受支持。");
    const url = new URL(path, "https://api.bilibili.com");
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
    // B 站部分接口会校验请求上下文；后台直连失败时回退到页面内请求。
    try {
      const response = await fetch(url, { credentials: "include", redirect: "error", signal: AbortSignal.timeout(20000) });
      if (!response.ok) { const error = new Error(`B 站暂时无法访问（${response.status}），请稍后重试。`); error.status = response.status; throw error; }
      const data = await response.json();
      if (data && typeof data.code === "number") return data;
      throw new Error("RESPONSE_SHAPE");
    } catch (directError) {
      if (!tab) throw directError;
      const bridged = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: "MAIN", args: [url.toString()],
        func: async (target) => {
          try {
            const response = await fetch(target, { credentials: "include", redirect: "error", signal: AbortSignal.timeout(20000) });
            if (!response.ok) return { bridgeError: `B 站暂时无法访问（${response.status}），请稍后重试。`, status: response.status };
            return await response.json();
          } catch { return { bridgeError: "读取 B 站资料失败，请确认已登录并刷新页面后重试。" }; }
        },
      });
      const data = bridged[0]?.result;
      if (!data || data.bridgeError) {
        const error = new Error(data?.bridgeError || directError.message);
        if (data?.status) error.status = data.status;
        throw error;
      }
      return data;
    }
  };
  return createBilibiliClient({ request, resourceCandidates: resources[0]?.result || [] });
}

async function gateway() {
  const state = await readState();
  const config = normalizeGateway(state.settings.gateway);
  if (!config.apiKey || !config.model) throw new Error("请先在设置中连接模型并选择可用模型。");
  if (!await chrome.permissions.contains({ origins: [getPermissionOrigin(config.baseUrl)] })) throw new Error("请在设置中重新连接模型，允许访问该服务。");
  return config;
}

async function ai(messages, signal, { long = false, maxTokens = long ? 8192 : 4096 } = {}) {
  const config = await gateway();
  const result = long
    ? await completeLong(config, messages, { signal, maxContinuations: 2, maxTokens })
    : await complete(config, messages, { signal, maxTokens });
  if (!result.text?.trim()) throw new Error("模型未返回内容，请重试或更换模型。");
  return { text: result.text, model: config.model, provider: config.provider };
}

async function loadVideo(info, tabId) {
  const epoch = (await readState()).epoch;
  const client = await biliClient(tabId);
  const video = await client.getVideo(info);
  video.key = video.key || videoKey(video);
  const existing = (await readState()).videos[video.key];
  if (existing?.segments?.length) return existing;
  const transcript = await client.getTranscript(video);
  const segments = groupSegments(transcript.segments);
  if (!segments.length) throw new Error("该视频暂无可获取字幕；如有 CC 字幕，请开启后重新读取。");
  const row = { ...existing, ...video, language: transcript.language || "", subtitleSource: transcript.source,
    segments, notes: existing?.notes || [], updatedAt: Date.now() };
  await changeState(s => { if (s.epoch !== epoch) throw new Error("资料已清除，请重新读取。"); s.videos[row.key] = row; addAudit(s, "读取视频字幕"); });
  return row;
}

async function enqueue(type, key, data = {}) {
  const id = await changeState(s => {
    if (type === "translate") throw new Error("翻译功能已移除。");
    if (data.automatic && !(type === "report" ? s.settings.autoReports : s.settings.autoCollect)) return null;
    const existing = Object.values(s.jobs).find(j => j.type === type && j.key === key && ["queued", "running"].includes(j.status));
    if (existing) return existing.id;
    const id = crypto.randomUUID(); s.jobs[id] = { id, type, key, data, status: "queued", createdAt: Date.now(), updatedAt: Date.now(), progress: "等待处理" };
    return id;
  });
  void drain(); return { jobId: id };
}

async function updateJob(id, patch, runId) {
  return changeState(s => {
    const job = s.jobs[id]; if (!job || job.status === "cancelled" || (runId && job.runId !== runId)) return false;
    Object.assign(job, patch, { updatedAt: Date.now() }); return true;
  });
}

async function boundedParallel(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  let firstError = null;
  async function run() {
    for (;;) {
      if (firstError) return;
      const index = cursor++;
      if (index >= items.length) return;
      try { results[index] = await worker(items[index], index); }
      catch (error) { firstError ||= error; return; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, limit)) }, run));
  if (firstError) throw firstError;
  return results;
}

async function doJob(job, signal) {
  let pendingRequests = 0;
  let pendingGate = null;
  const jobAi = async (messages, options) => {
    if (signal.aborted) throw new Error("任务已停止。");
    pendingRequests += 1;
    if (pendingRequests === 1) {
      pendingGate = updateJob(job.id, { requestPending: true }, job.runId).then(saved => {
        if (!saved) throw new Error("任务已停止。");
      });
    }
    try {
      await pendingGate;
      return await ai(messages, signal, options);
    } finally {
      pendingRequests -= 1;
      // Keep the job marked pending until the last concurrent response settles.
      if (pendingRequests === 0) {
        pendingGate = null;
        await updateJob(job.id, { requestPending: false }, job.runId).catch(() => {});
      }
    }
  };
  const canCommit = s => s.jobs[job.id]?.runId === job.runId && s.jobs[job.id]?.status === "running" && !signal.aborted;
  if (job.type === "report") {
    const s = await readState();
    const evidence = reportEvidence(s.events, job.data.kind, Date.now(), s.settings.timezone);
    if (!evidence.videos.length) throw new Error("这段时间还没有可用记录。请先同步收藏与观看记录。");
    await updateJob(job.id, { progress: "正在整理学习回顾" }, job.runId);
    const notes = evidence.videos.map(v => ({ ...v, summary: Object.values(s.videos).find(x => x.bvid === v.bvid)?.summary || "未生成内容摘要" }));
    if (JSON.stringify(notes).length + JSON.stringify(evidence).length > 80000) throw new Error("本期记录过多，无法完整生成回顾；未发送或截断本期资料。请先使用日报整理。");
    const result = await jobAi([{ role: "system", content: GROUNDED_SYSTEM }, { role: "user", content:
      `根据以下可验证记录生成${job.data.kind === "daily" ? "日报" : "周报"}，只用中文 Markdown。给一个轻松但有事实依据的标题；包含内容回顾、值得留下的观点（只有已提供摘要才能引用）、待消化收藏、最多3条下一步建议。观看不等于掌握。分享入口点击不等于成功转发。不编造观看时长、全站转发或心理画像。注明覆盖范围和数据缺失。统计口径：${JSON.stringify(evidence)}\n内容资料：${JSON.stringify(notes)}\n覆盖范围：${JSON.stringify(s.coverage)}。` }]);
    const report = { ...evidence, id: job.key, kind: job.data.kind, text: result.text, model: result.model, createdAt: Date.now() };
    await changeState(s => { if (canCommit(s)) { const previous = s.reports[job.key]; report.history = previous ? [...(previous.history || []), { ...previous, history: undefined }] : []; s.reports[job.key] = report; addAudit(s, "生成学习回顾"); } });
    return { status: "done", progress: "学习回顾已生成" };
  }
  if (job.type === "collection") {
    const state = await readState();
    const creator = state.creator;
    if (!creator?.items?.length) throw new Error("请先同步 UP 主作品。");
    const rows = creator.items.map(item => {
      const video = Object.values(state.videos).find(v => v.bvid === item.bvid && v.summary);
      return { title: item.title, duration: item.duration, bvid: item.bvid, summary: video?.summary || "" };
    });
    const ready = rows.filter(row => row.summary);
    if (!ready.length) throw new Error("还没有可汇总的作品摘要。");
    const digest = ready.map(row => ({ title: row.title, duration: row.duration,
      summary: row.summary.slice(0, 1400) }));
    const missing = rows.filter(row => !row.summary).map(row => row.title);
    await updateJob(job.id, { progress: "正在汇总全部作品" }, job.runId);
    const result = await jobAi([{ role: "system", content: GROUNDED_SYSTEM }, { role: "user", content:
      `以下是同一位 UP 主的 ${ready.length} 个视频的摘要。请写一篇跨视频的中文 Markdown 汇总：选题地图、反复出现的方法、观点演进、可直接复用的清单、仍然缺失的部分。总长度控制在 700 字以内，只依据摘要，不编造视频中未出现的内容；引用视频时使用标题。\n${JSON.stringify(digest)}` }]);
    await changeState(s => {
      if (!canCommit(s) || !s.creator) return;
      Object.assign(s.creator, { summary: result.text, summaryModel: result.model, summaryAt: Date.now(),
        covered: ready.length, missing });
      addAudit(s, "生成作品汇总");
    });
    if (job.data.save) {
      const current = (await readState()).creator;
      if (current) {
        const saved = await saveDoc(collectionMarkdown(current));
        await changeState(s => { if (s.creator) Object.assign(s.creator, saved.saved ? { vaultPath: saved.path } : { vaultError: saved.reason }); });
      }
    }
    return { status: "done", progress: `汇总完成，覆盖 ${ready.length}/${rows.length}` };
  }
  let video = (await readState()).videos[job.key];
  if (!video?.segments?.length) {
    await updateJob(job.id, { progress: "正在读取字幕" }, job.runId);
    video = await loadVideo(job.data.video || video, job.data.tabId);
    await updateJob(job.id, { key: video.key }, job.runId);
  }
  if (signal.aborted) throw new Error("已取消处理。");
  const config = await gateway();
  const signature = JSON.stringify([config.provider, config.protocol, config.baseUrl, config.model]);
  if (job.configSignature && job.configSignature !== signature) {
    throw new Error("处理期间模型已切换，请重新发起任务。");
  }
  await updateJob(job.id, { configSignature: signature }, job.runId);
  if (job.type === "summary") {
    // Small models have limited output per response. Keep the detailed batches,
    // but process a bounded wave in parallel so latency is no longer the sum of
    // every batch. Completed batches remain checkpointed independently.
    const batches = splitBatches(video.segments, 4000);
    let parts = Array.isArray(job.parts)
      ? job.parts.filter(part => part && typeof part !== "string").map((part, index) => ({
        ...part, batchIndex: Number.isInteger(part.batchIndex) ? part.batchIndex : index,
      })).filter(part => part.batchIndex >= 0 && part.batchIndex < batches.length)
      : [];
    parts.sort((a, b) => a.batchIndex - b.batchIndex);
    const completed = new Set(parts.map(part => part.batchIndex));
    const pending = batches.map((batch, batchIndex) => ({ batch, batchIndex }))
      .filter(({ batchIndex }) => !completed.has(batchIndex));
    if (pending.length) {
      await updateJob(job.id, {
        progress: `正在精读 ${Math.min(batches.length, completed.size + SUMMARY_BATCH_CONCURRENCY)}/${batches.length} 段`,
        step: completed.size,
        stepTotal: batches.length,
      }, job.runId);
      await boundedParallel(
        pending.slice(0, SUMMARY_BATCH_CONCURRENCY),
        SUMMARY_BATCH_CONCURRENCY,
        async ({ batch, batchIndex }) => {
          const result = await jobAi([{ role: "system", content: GROUNDED_SYSTEM }, { role: "user", content:
            `你在整理一份可以直接阅读复习的课堂笔记。视频《${video.title}》的这段字幕覆盖 ${timeLabel(batch[0].start)} 到 ${timeLabel(batch[batch.length - 1].end)}。\n` +
            `基于字幕写出这一段详细笔记，要求：\n` +
            `1. 用 2 到 4 个小标题（###）组织，每个小标题下写完整段落，不要只列关键词；\n` +
            `2. 保留讲者给出的定义、判断标准、数字、例子、步骤、踩坑和适用边界；\n` +
            `3. 关键结论后标注引用，格式 [段落ID]；\n` +
            `4. 去掉口头语和重复，但不要压缩掉信息；不编造字幕里没有的内容；\n` +
            `5. 长度 550 到 700 字。\n\n字幕：\n${sourceText({ segments: batch })}` }], { long: true });
          await changeState(s => {
            const current = s.jobs[job.id];
            if (!canCommit(s) || !current) return;
            const saved = (current.parts || []).filter(part => part && typeof part !== "string")
              .map((part, index) => ({ ...part, batchIndex: Number.isInteger(part.batchIndex) ? part.batchIndex : index }));
            const next = [
              ...saved.filter(part => part.batchIndex !== batchIndex),
              { batchIndex, start: batch[0].start, end: batch[batch.length - 1].end, text: result.text, model: result.model },
            ].sort((a, b) => a.batchIndex - b.batchIndex);
            current.parts = next;
            current.step = next.length;
            current.stepTotal = batches.length;
            current.progress = `已精读 ${next.length}/${batches.length} 段`;
          });
        },
      );
      const saved = (await readState()).jobs[job.id]?.parts || [];
      parts = saved.filter(part => part && typeof part !== "string").sort((a, b) => a.batchIndex - b.batchIndex);
      if (parts.length < batches.length) {
        return { status: "queued", parts, step: parts.length, stepTotal: batches.length, progress: `已精读 ${parts.length}/${batches.length} 段` };
      }
    }
    // The article is assembled in code from the detailed parts; the model only adds
    // the study scaffolding (intro, glossary, checklist, review questions).
    await updateJob(job.id, { progress: "正在整理导读与复习材料" }, job.runId);
    const overview = await jobAi([{ role: "system", content: GROUNDED_SYSTEM }, { role: "user", content:
      `以下是视频《${video.title}》的完整课堂笔记。请只输出一个 JSON 对象，不要 Markdown 代码围栏：\n` +
      `{"intro":"3 到 4 句导读，说清这份资料解决什么问题、适合谁",` +
      `"glossary":[{"term":"术语","def":"一句定义"}],` +
      `"checklist":["可以直接照着做的动作，含判断标准"],` +
      `"questions":[{"q":"复习题","a":"答案要点"}]}\n` +
      `要求：术语 5 到 8 个，清单 6 到 10 条，复习题 5 道；只依据笔记，不编造；总计不超过 900 字。\n\n${parts.map(p => p.text || p).join("\n\n")}` }], { long: true });
    let meta = {};
    try { meta = parseJson(overview.text); } catch { meta = {}; }
    const summary = assembleClassNotes({ ...video, summaryModel: overview.model }, parts, meta);
    await changeState(s => { if (canCommit(s) && s.videos[video.key]) {
      const current = s.videos[video.key]; preserveSummary(current);
      Object.assign(current, { summary, summaryModel: overview.model, summaryParts: parts.length, summaryEdited: false, updatedAt: Date.now() });
    } });
    if (job.data.save) {
      // Service workers cannot request directory permission; the page performs the write.
      await changeState(s => { const target = s.videos[video.key]; if (target) target.vaultPending = true; });
    }
    return { status: "done", progress: "视频资料已整理" };
  }
  throw new Error("任务类型不受支持。");
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    // A job that never dispatched a model request is safe to requeue; one with a
    // request in flight may have been billed, so it waits for an explicit retry.
    await changeState(s => {
      for (const j of Object.values(s.jobs)) {
        if (j.status !== "running") continue;
        if (j.requestPending) {
          j.status = "unknown";
          j.error = "上次处理已中断，服务可能已经计费。请确认后再重试。";
        } else {
          j.status = "queued";
        }
        j.runId = null;
      }
    });
    for (;;) {
      const state = await readState();
      const job = Object.values(state.jobs).filter(j => j.status === "queued").sort((a,b) => a.createdAt - b.createdAt)[0];
      if (!job) break;
      if (job.type === "translate") {
        await updateJob(job.id, { status: "cancelled", progress: "翻译功能已移除" });
        continue;
      }
      if (job.data?.automatic && !(job.type === "report" ? state.settings.autoReports : state.settings.autoCollect)) { await updateJob(job.id, { status: "cancelled", progress: "自动整理已关闭" }); continue; }
      const controller = new AbortController(); controllers.set(job.id, controller);
      job.runId = crypto.randomUUID();
      await updateJob(job.id, { status: "running", runId: job.runId, requestPending: false });
      try { await updateJob(job.id, { ...await doJob(job, controller.signal), requestPending: false }, job.runId); }
      catch (error) {
        const current = (await readState()).jobs[job.id];
        const unknown = Boolean(current?.requestPending);
        await updateJob(job.id, { status: unknown ? "unknown" : "failed", error: error.message || "处理失败，请重试。", progress: unknown ? "请确认后重试，可能再次计费" : "需要重试" }, job.runId);
        if ([401,403,429].includes(error.status)) await changeState(s => {
          for (const queued of Object.values(s.jobs)) if (queued.status === "queued") Object.assign(queued, { status: "failed", error: "模型连接或额度需要处理，已暂停后续任务。请检查设置后逐项重试。" });
        });
      }
      finally { controllers.delete(job.id); }
    }
  } finally { draining = false; }
}

async function syncCollection() {
  if (inFlight.has("sync")) return inFlight.get("sync");
  const task = performSyncCollection(); inFlight.set("sync", task);
  try { return await task; } finally { inFlight.delete("sync"); }
}
async function performSyncCollection() {
  const epoch = (await readState()).epoch;
  const client = await biliClient(); const account = await client.getAccount();
  const initial = await readState();
  if (initial.account && String(initial.account.mid) !== String(account.mid)) throw new Error("B 站账号已切换。请在设置中清除旧账号资料后重新连接。");
  const folders = await client.getFavoriteFolders(account.mid);
  const checkEpoch = s => { if (s.epoch !== epoch) throw new Error("资料已清除，同步已停止。"); };
  await changeState(s => { checkEpoch(s); s.account = account; s.folders = folders; });
  let queued = 0;
  for (const folderId of initial.settings.folders) {
    const result = await client.getFavoriteVideos(folderId, { maxPages: 10 });
    const items = Array.isArray(result) ? result : result.items;
    for (const item of items) {
      if (!item.bvid) continue;
      const eventAt = eventTime(item.favoritedAt);
      await changeState(s => {
        checkEpoch(s);
        const eventId = `favorite:${account.mid}:${folderId}:${item.bvid}:${eventAt || "observed"}`;
        if (eventAt) s.events[eventId] = { type: "favorite", bvid: item.bvid, title: item.title, url: item.url || `https://www.bilibili.com/video/${item.bvid}/`, at: eventAt, source: "收藏记录" };
      });
      const existing = Object.values((await readState()).videos).find(x => x.bvid === item.bvid && x.page === 1 && x.summary);
      const attempted = Object.values((await readState()).jobs).some(j => j.type === "summary" && j.data?.video?.bvid === item.bvid);
      if (initial.settings.autoCollect && !existing && !attempted && queued < initial.settings.batchLimit) {
        const result = await enqueue("summary", `bilibili:${item.bvid}:p1`, { automatic: true, video: { bvid: item.bvid, page: 1 } }); if (result.jobId) queued++;
      }
    }
    await changeState(s => { checkEpoch(s); s.favorites[String(folderId)] = { items, fetchedAt: Date.now(), truncated: Boolean(result.hasMore) }; s.coverage[`folder:${folderId}`] = { at: Date.now(), truncated: Boolean(result.hasMore), count: items.length }; });
  }
  const history = await client.getHistory({ maxPages: 10 });
  await changeState(s => {
    checkEpoch(s);
    for (const item of history.items || history) {
      if (!item.bvid || !item.viewedAt) continue;
      const id = `view:${account.mid}:${item.bvid}:${item.cid || ""}:${item.viewedAt}`;
      s.events[id] = { ...item, type: "view", at: eventTime(item.viewedAt), source: "观看历史" };
    }
    s.coverage.history = { at: Date.now(), truncated: Boolean(history.hasMore), count: (history.items || history).length };
    s.coverage.shares = "仅本插件观察到的分享入口点击";
    addAudit(s, "同步收藏与观看记录");
  });
  return { folders, queued };
}

async function askVideo(key, question) {
  if (!String(question).trim() || question.length > 6000) throw new Error("请输入不超过6000字的问题。");
  const state = await readState(); const video = state.videos[key];
  if (!video?.segments?.length) throw new Error("请先读取当前视频字幕。");
  const selected = rankSegments(video.segments, question);
  const conversation = state.conversations[key] || { id: crypto.randomUUID(), messages: [] };
  const history = conversation.messages.slice(-12).map(({ role, content }) => ({ role, content: content.slice(0, 7000) }));
  const result = await ai([{ role: "system", content: `${GROUNDED_SYSTEM}\n围绕所给视频字幕回答。每个关于视频的关键结论引用 [段落ID]。没有依据时明确说视频资料未提及。${selected.partial ? "当前是检索到的部分片段，不得声称覆盖全片。" : "已提供完整字幕。"}\n视频：${video.title}\n${sourceText(selected)}` }, ...history, { role: "user", content: question }]);
  const citations = validateCitations(result.text, selected.segments);
  const answer = { role: "assistant", content: result.text, citations, partial: selected.partial, model: result.model, at: Date.now() };
  await changeState(s => {
    if (s.epoch !== state.epoch) throw new Error("资料已清除，本次回答不再保存。");
    const current = s.conversations[key] || { ...conversation, messages: [] };
    current.messages.push({ role: "user", content: question, at: Date.now() }, answer);
    current.updatedAt = Date.now(); current.summaryStale = Boolean(current.summary); s.conversations[key] = current;
  });
  return answer;
}

async function dispatch(message, sender) {
  const type = message?.type;
  const fromExtension = sender.url?.startsWith(chrome.runtime.getURL(""));
  if (!fromExtension) {
    if (!TRUSTED_PAGE.test(sender.url || "") || !["openPanel", "shareIntent"].includes(type)) throw new Error("该页面没有访问权限。");
    if (type === "openPanel") { await chrome.sidePanel.open({ tabId: sender.tab.id }); return {}; }
    const parsed = parseVideoUrl(sender.url);
    if (parsed) await changeState(s => { const now = Date.now(), bvid = parsed.bvid;
      const known = Object.values(s.videos).find(v => v.bvid === bvid);
      const id = `share-intent:${bvid}:${Math.floor(now / 10000)}`;
      s.events[id] = { type: "share-intent", bvid, title: known?.title || bvid, url: sender.url, at: now, source: "分享入口点击" };
    });
    return {};
  }
  switch (type) {
    case "state": return publicState(await readState());
    case "savedToVault": await changeState(s => {
      const video = s.videos[message.key]; if (!video) return;
      video.vaultPending = false;
      if (message.path) { video.vaultPath = message.path; video.vaultError = ""; }
      else video.vaultError = message.error || "保存失败";
    }); return {};
    case "activeVideo": {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return parseVideoUrl(tabs[0]?.url || "");
    }
    case "providers": return PROVIDERS;
    case "loadModels": {
      const config = normalizeGateway(message.gateway);
      if (!config.apiKey) {
        const saved = (await readState()).settings;
        const previous = saved.gateways?.[config.provider] || saved.gateway;
        if (previous?.baseUrl === config.baseUrl && previous?.protocol === config.protocol) config.apiKey = previous.apiKey;
      }
      if (!await chrome.permissions.contains({ origins: [getPermissionOrigin(config.baseUrl)] })) throw new Error("请允许访问所选模型服务。");
      const models = await listModels(config);
      if (modelLists.size >= 8) modelLists.clear();
      modelLists.set(discoveryKey(config), { models, at: Date.now() });
      return { models };
    }
    case "saveSettings": {
      const input = message.settings;
      return changeState(s => {
        const config = normalizeGateway(input.gateway);
        const previous = s.settings.gateways?.[config.provider] || s.settings.gateway;
        if (!config.apiKey && previous?.baseUrl === config.baseUrl && previous?.protocol === config.protocol) config.apiKey = previous.apiKey;
        if (!config.apiKey || !config.model) throw new Error("请先连接模型并选择可用模型。");
        const discovered = modelLists.get(discoveryKey(config));
        const selected = discovered?.models.find(m => m.id === config.model);
        const unchanged = previous?.apiKey === config.apiKey && previous?.baseUrl === config.baseUrl && previous?.protocol === config.protocol && previous?.model === config.model;
        if (!selected && !unchanged) throw new Error("请重新加载模型，并从列表中选择。");
        const next = normalizeSettings(input, s.settings);
        const savedConfig = { ...config, modelSource: selected?.source || previous?.modelSource || "remote", modelListAt: discovered?.at || previous?.modelListAt, catalogVersion: selected?.source === "catalog" ? "2026-10-15" : previous?.catalogVersion };
        next.gateway = savedConfig; next.gateways = { ...s.settings.gateways, [config.provider]: savedConfig }; s.settings = next;
        for (const job of Object.values(s.jobs)) if (job.data?.automatic && !(job.type === "report" ? next.autoReports : next.autoCollect) && ["queued", "running"].includes(job.status)) {
          job.status = "cancelled"; job.runId = null; controllers.get(job.id)?.abort();
        }
        addAudit(s, "保存设置"); return {};
      });
    }
    case "currentVideo": {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      let tab = tabs.find(t => parseVideoUrl(t.url || ""));
      if (!tab) tab = (await chrome.tabs.query({ url: "https://www.bilibili.com/video/*" })).find(t => parseVideoUrl(t.url || ""));
      const parsed = parseVideoUrl(tab?.url || "");
      if (!parsed) throw new Error("打开一个 B 站视频，再点击读取字幕。");
      return loadVideo(parsed, tab.id);
    }
    case "loadVideo": return loadVideo(message.video, message.tabId);
    case "enqueue": {
      if (message.jobType === "translate") throw new Error("翻译功能已移除。");
      if (message.jobType !== "summary") throw new Error("任务类型不受支持。");
      if (!(await readState()).videos[message.key]) throw new Error("请先读取视频。");
      await gateway(); return enqueue(message.jobType, message.key, message.data || {});
    }
    case "cancelJob": controllers.get(message.id)?.abort(); await changeState(s => { if (s.jobs[message.id]) s.jobs[message.id].status = "cancelled"; }); return {};
    case "retryJob": await changeState(s => { const j = s.jobs[message.id]; if (j && ["failed", "cancelled", "unknown"].includes(j.status)) {
      if (message.confirm !== true) throw new Error("重试可能再次产生模型费用，请先确认。");
      j.status = "queued"; j.error = ""; j.runId = null; j.configSignature = "";
    } }); void drain(); return {};
    case "syncCollection": return syncCollection();
    case "processFavorite": {
      const s = await readState();
      const item = Object.values(s.favorites).flatMap(f => f.items).find(v => v.bvid === message.bvid);
      if (!item) throw new Error("请先同步收藏列表。");
      await gateway();
      return enqueue("summary", `bilibili:${item.bvid}:p1`, { video: { bvid: item.bvid, page: 1 } });
    }
    case "syncCreator": {
      const mid = parseSpaceMid(message.url);
      if (!mid) throw new Error("请填写 B 站空间链接，例如 https://space.bilibili.com/123456。");
      const client = await biliClient();
      const info = await client.getCreatorInfo(mid).catch(() => null);
      const result = await client.getCreatorVideos(mid, { maxPages: 10 });
      if (!result.items.length) throw new Error("没有读到公开作品，请确认链接与登录状态。");
      const epoch = (await readState()).epoch;
      await changeState(s => {
        if (s.epoch !== epoch) throw new Error("资料已清除，同步已停止。");
        s.creator = { mid, name: info?.name || "", items: result.items, total: result.total,
          truncated: result.hasMore, fetchedAt: Date.now() };
        s.coverage.creator = { at: Date.now(), count: result.items.length, truncated: result.hasMore };
        addAudit(s, "同步 UP 主作品");
      });
      return { count: result.items.length, total: result.total, name: info?.name || "", truncated: result.hasMore };
    }
    case "queueCreator": {
      const state = await readState();
      if (!state.creator?.items?.length) throw new Error("请先同步 UP 主作品。");
      await gateway();
      const limit = Math.min(50, Math.max(1, Number(message.limit) || state.settings.batchLimit));
      const summarized = new Set(Object.values(state.videos).filter(v => v.summary).map(v => v.bvid));
      const pending = state.creator.items.filter(item => !summarized.has(item.bvid));
      let queued = 0;
      for (const item of pending.slice(0, limit)) {
        const result = await enqueue("summary", `bilibili:${item.bvid}:p1`, { save: true, video: { bvid: item.bvid, page: 1 } });
        if (result.jobId) queued += 1;
      }
      if (message.digest !== false) await enqueue("collection", `creator:${state.creator.mid}`, { save: true });
      return { queued, remaining: Math.max(0, pending.length - queued), total: pending.length };
    }
    case "processCreator": {
      const state = await readState();
      const item = state.creator?.items?.find(v => v.bvid === message.bvid);
      if (!item) throw new Error("请先同步 UP 主作品。");
      await gateway();
      return enqueue("summary", `bilibili:${item.bvid}:p1`, { video: { bvid: item.bvid, page: 1 } });
    }
    case "saveFolders": await changeState(s => {
      const known = new Set(s.folders.map(f => String(f.id)));
      s.settings.folders = [...new Set((message.folders || []).map(String))].filter(id => known.has(id));
      addAudit(s, "更新收藏夹选择");
    }); return {};
    case "report": {
      const kind = message.kind === "weekly" ? "weekly" : "daily";
      const s = await readState(); await gateway();
      return enqueue("report", `${kind}:${dateKey(Date.now(), s.settings.timezone)}`, { kind });
    }
    case "ask": {
      if (inFlight.has(`ask:${message.key}`)) throw new Error("正在回答上一个问题，请稍候。");
      const task = askVideo(message.key, String(message.question || "")); inFlight.set(`ask:${message.key}`, task);
      try { return await task; } finally { inFlight.delete(`ask:${message.key}`); }
    }
    case "summarizeConversation": {
      const state = await readState(), conversation = state.conversations[message.key];
      if (!conversation?.messages?.length) throw new Error("先围绕视频提问，再整理讨论。");
      const revision = conversation.updatedAt;
      const input = JSON.stringify(conversation.messages);
      if (input.length > 70000) throw new Error("讨论内容较长，暂不能完整整理。你仍可导出全部对话；本次未截断或发送讨论。");
      const result = await ai([{ role: "system", content: GROUNDED_SYSTEM }, { role: "user", content:
        `整理以下讨论为中文Markdown：我的问题、讨论结论、我的判断（只保留用户明确表达的判断）、尚未解决的问题、下一步。不要将AI意见写成用户结论。\n${input}` }]);
      await changeState(s => {
        const current = s.conversations[message.key];
        if (s.epoch !== state.epoch || !current) throw new Error("讨论已清除，本次结果不再保存。");
        if (current.summary) (current.summaryHistory ||= []).push({ text: current.summary, at: Date.now() });
        Object.assign(current, { summary: result.text, summaryModel: result.model, summaryStale: current.updatedAt !== revision });
      }); return {};
    }
    case "saveConversationSummary": await changeState(s => {
      if (!s.conversations[message.key]) throw new Error("讨论不存在。");
      const current = s.conversations[message.key];
      if (current.summary && current.summary !== String(message.text || "")) (current.summaryHistory ||= []).push({ text: current.summary, at: Date.now() });
      s.conversations[message.key].summary = String(message.text || "").slice(0, 100000);
      s.conversations[message.key].summaryStale = false;
    }); return {};
    case "note": await changeState(s => {
      const video = s.videos[message.key]; if (!video) throw new Error("请先读取视频。");
      const text = String(message.text || "").trim(); if (!text) throw new Error("请先填写笔记。");
      video.notes ||= []; video.notes.push({ id: crypto.randomUUID(), text: text.slice(0, 12000), start: Math.max(0, Number(message.start) || 0), at: Date.now() });
    }); return {};
    case "saveVideoSummary": await changeState(s => {
      const video = s.videos[message.key]; if (!video) throw new Error("视频记录不存在。");
      const edited = String(message.text || "").slice(0, 100000);
      if (video.summary === edited) return;
      preserveSummary(video);
      video.summary = edited; video.summaryEdited = true; video.updatedAt = Date.now();
    }); return {};
    case "deleteNote": await changeState(s => { const v = s.videos[message.key]; if (v) v.notes = v.notes.filter(n => n.id !== message.id); }); return {};
    case "seek": {
      const video = (await readState()).videos[message.key]; if (!video) throw new Error("视频记录不存在。");
      const tabs = await chrome.tabs.query({ url: `https://www.bilibili.com/video/${video.bvid}*` });
      const tab = tabs.find(t => parseVideoUrl(t.url)?.page === video.page);
      if (!tab) { const url = new URL(video.url); url.searchParams.set("t", String(Math.floor(Number(message.start) || 0))); await chrome.tabs.create({ url: url.toString() }); return {}; }
      await chrome.tabs.sendMessage(tab.id, { type: "seek", start: Math.max(0, Number(message.start) || 0) }); return {};
    }
    case "openApp": await chrome.tabs.create({ url: chrome.runtime.getURL(`app.html#${["library","reports","settings","vault"].includes(message.section) ? message.section : "library"}`) }); return {};
    case "reset": {
      if (message.confirm !== "清除本插件资料") throw new Error("请确认清除范围。");
      for (const controller of controllers.values()) controller.abort();
      await changeState(s => { s.epoch = (s.epoch || 0) + 1; s.videos = {}; s.conversations = {}; s.events = {}; s.reports = {}; s.jobs = {}; s.account = null; s.favorites = {}; s.creator = null; s.folders = []; s.coverage = {}; s.settings.autoCollect = false; s.settings.autoReports = false; s.settings.folders = []; addAudit(s, "清除学习资料"); }); return {};
    }
    default: throw new Error("暂不支持此操作。");
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  dispatch(message, sender).then(data => respond({ ok: true, data })).catch(error => respond({ ok: false, error: error.message || "操作失败，请重试。" }));
  return true;
});

// A page-held port with a heartbeat keeps the MV3 worker alive during a long batch.
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "bili-study-keepalive") return;
  void drain();
  port.onMessage.addListener(() => {});
});

chrome.action.onClicked.addListener(async tab => { if (tab.id) await chrome.sidePanel.open({ tabId: tab.id }); });

async function broadcastActive(tab) {
  const parsed = parseVideoUrl(tab?.url || "");
  try { chrome.runtime.sendMessage({ type: "activeVideo", video: parsed }, () => void chrome.runtime.lastError); } catch { /* no panel open */ }
}
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab) void broadcastActive(tab);
});
chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
  if (info.url || info.status === "complete") void broadcastActive(tab);
});
async function setup() {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await chrome.alarms.create("bili-study-tick", { periodInMinutes: 1 });
}
chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(() => { void setup(); void drain(); });
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== "bili-study-tick") return;
  const s = await readState();
  if (s.settings.autoCollect && Date.now() - (s.coverage.lastAutoSync || 0) > 30 * 60000) {
    await changeState(s => { s.coverage.lastAutoSync = Date.now(); });
    try { await syncCollection(); } catch (error) { await changeState(s => { s.coverage.autoSyncError = error.message; }); }
  }
  if (s.settings.autoReports) {
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: s.settings.timezone, hour: "numeric", hourCycle: "h23" }).format(new Date()));
    if (hour >= s.settings.dailyHour) {
      const day = dateKey(Date.now(), s.settings.timezone);
      for (const kind of ["daily", "weekly"]) {
        if (kind === "weekly" && new Date(`${day}T12:00:00Z`).getUTCDay() !== 0) continue;
        const key = `${kind}:${day}`;
        if (!s.reports[key] && !Object.values(s.jobs).some(j => j.key === key)) await enqueue("report", key, { kind, automatic: true });
      }
    }
  }
  void drain();
});

// ESM exports support isolated lifecycle tests; the runtime message boundary remains dispatch.
export { dispatch, drain };
