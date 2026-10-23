import { PROVIDERS, normalizeGateway, getPermissionOrigin } from "./gateway.js";
import { emptyState } from "./store.js";
import { timeLabel } from "./learning.js";
import { videoMarkdown, conversationMarkdown, reportMarkdown, downloadMarkdown } from "./markdown.js";
import { connectVault, disconnectVault, vaultHandle, saveToVault } from "./vault.js";
import { element, renderProse } from "./prose.js";
import { flushVaultQueue } from "./vault-queue.js";

const $ = id => document.getElementById(id);
const panel = document.body.dataset.surface === "panel";
const extension = Boolean(globalThis.chrome?.runtime?.id);
let state = emptyState(), selectedKey = "", mode = "subtitles", currentReport = "", modelGeneration = 0;
let initialSettings = true, lastConversation = "", lastTranscriptSignature = "";
let busyCount = 0;
let lastState = "";
let lastGatewayOrigin = "";
let activeInfo = null;
let selectionInitialized = false;
let libraryTab = "all";
const seenSummaries = new Map();

function notice(text, error = false) {
  const node = $("notice"); node.textContent = error ? String(text).replace(/API/g, "服务") : text; node.classList.toggle("error", error); node.hidden = !text;
}
async function rpc(type, payload = {}) {
  if (!extension) {
    if (type === "state") return emptyState();
    throw new Error("请在 Edge 或 Chrome 中加载 Bili Study 后使用此功能。");
  }
  const response = await new Promise(resolve => {
    try { chrome.runtime.sendMessage({ type, ...payload }, value => { void chrome.runtime.lastError; resolve(value); }); }
    catch { resolve(undefined); }
  });
  if (!response?.ok) throw new Error(response?.error || "连接已中断，请刷新后重试。");
  return response.data;
}
async function perform(button, action, label = "正在处理…") {
  if (button?.disabled) return;
  const previous = button?.textContent; busyCount++;
  if (button) { button.disabled = true; button.textContent = label; }
  notice("");
  try { await action(); await refresh(); }
  catch (error) {
    if (error.name === "AbortError") return;
    if (error.name === "ReferenceError" || error.name === "TypeError") {
      console.error(error);
      notice("操作未完成，请刷新页面后重试。", true);
    } else notice(error.message || "操作未完成，请重试。", true);
  }
  finally { busyCount--; if (button?.isConnected) { button.disabled = false; button.textContent = previous; } if (panel && !video()) renderPanel(); }
}
function listen(id, fn, label) { $(id)?.addEventListener("click", event => perform(event.currentTarget, () => fn(event), label)); }
function button(text, fn, className = "quiet") {
  const b = element("button", text, className); b.type = "button";
  b.onclick = event => perform(event.currentTarget, fn); return b;
}
function video() { return state.videos[selectedKey]; }
function draftDirty() {
  const current = video();
  if (!current) return false;
  const summary = ($("summaryDraft")?.value || "").trim();
  const savedSummary = (current.summary || "").trim();
  const chat = ($("discussionSummary")?.value || "").trim();
  const savedChat = (state.conversations[selectedKey]?.summary || "").trim();
  const note = ($("noteText")?.value || "").trim();
  return (summary && summary !== savedSummary) || chat !== savedChat || Boolean(note);
}
function applyActiveVideo(active) {
  if (!panel) return;
  activeInfo = active || null;
  if (!active) {
    if (!selectedKey) return;
    if (draftDirty() && !confirm("当前视频有未保存的编辑，切换到其他页面会丢失。是否继续？")) return;
    selectedKey = ""; lastTranscriptSignature = ""; lastConversation = ""; renderPanel(); return;
  }
  const match = Object.values(state.videos).find(v => v.bvid === active.bvid && (v.page || 1) === (active.page || 1));
  const nextKey = match?.key || "";
  if (nextKey === selectedKey) return;
  if (draftDirty() && !confirm("当前视频有未保存的编辑，切换视频会丢失。是否继续？")) return;
  selectedKey = nextKey; lastTranscriptSignature = ""; lastConversation = "";
  renderPanel();
}
if (panel && extension) {
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === "activeVideo") applyActiveVideo(message.video);
  });
}
function usablePart(value) { return Boolean(value) && !/^(?:lv_0_|Camera_xhs_)/.test(value) && value !== "P1"; }
function languageLabel(source) {
  if (/^(?:ai-)?(?:zh|cmn|yue)/i.test(source || "")) return "中文字幕";
  if (/^en/i.test(source || "")) return "英文字幕";
  return "原文字幕";
}
const prose = (node, text) => renderProse(node, text);

// Turn [g12] citation markers into clickable time labels using the transcript.
function linkCitations(node, segments) {
  const starts = new Map((segments || []).map(s => [s.id, s.start]));
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const targets = [];
  while (walker.nextNode()) {
    if (/\[g\d+\]/.test(walker.currentNode.nodeValue)) targets.push(walker.currentNode);
  }
  for (const text of targets) {
    const fragment = document.createDocumentFragment();
    for (const part of text.nodeValue.split(/(\[g\d+\])/g)) {
      const hit = /^\[(g\d+)\]$/.exec(part);
      if (hit && starts.has(hit[1])) {
        const chip = element("button", timeLabel(starts.get(hit[1])), "cite-chip");
        chip.type = "button";
        chip.title = `引用段落 ${hit[1]}`;
        chip.onclick = () => perform(chip, () => rpc("seek", { key: selectedKey, start: starts.get(hit[1]) }));
        fragment.append(chip);
      } else if (!hit) {
        fragment.append(document.createTextNode(part));
      }
    }
    text.replaceWith(fragment);
  }
}
function renderJobs(container, jobs) {
  if (!container) return;
  jobs = jobs.filter(job => job.type !== "translate");
  container.replaceChildren();
  if (!jobs.length) { container.append(element("p", "暂无处理任务。", "muted")); return; }
  const names = { summary: "精读", report: "学习回顾", collection: "作品汇总" };
  const statuses = { queued: "排队中", running: "处理中", done: "已完成", failed: "需要重试", cancelled: "已取消", unknown: "处理已中断" };
  const summaryJobs = jobs.filter(j => j.type === "summary");
  const doneCount = summaryJobs.filter(j => j.status === "done").length;
  const totalCount = summaryJobs.length;
  for (const job of jobs.slice(0, 30)) {
    const row = element("div", undefined, "job"), info = element("div");
    row.dataset.status = job.status;
    const v = state.videos[job.key];
    const position = job.type === "summary" && totalCount > 1 ? `（第 ${Math.min(doneCount + 1, totalCount)}/${totalCount} 个）` : "";
    info.append(element("p", `${names[job.type]}，${statuses[job.status]}${position}`), element("small", v?.title || job.data?.video?.bvid || ""), element("p", job.error || job.progress, "muted compact"));
    if (job.stepTotal) {
      const bar = element("div", undefined, "job-bar");
      const fill = element("span");
      fill.style.transform = `scaleX(${Math.max(0, Math.min(1, (job.step || 0) / job.stepTotal))})`;
      bar.append(fill); info.append(bar);
    }
    row.append(info);
    if (["failed", "cancelled", "unknown"].includes(job.status)) row.append(button("重试", () => { if (confirm("重试会再次调用模型，可能重复计费。是否继续？")) return rpc("retryJob", { id: job.id, confirm: true }); }));
    if (["queued", "running"].includes(job.status)) row.append(button("取消", () => rpc("cancelJob", { id: job.id })));
    container.append(row);
  }
}

function unfinishedJobs() {
  return Object.values(state.jobs || {}).filter(job => job.type !== "translate" && ["queued", "running", "failed", "unknown"].includes(job.status));
}

function jobsSummary(jobs) {
  const counts = jobs.reduce((result, job) => {
    result[job.status] = (result[job.status] || 0) + 1;
    return result;
  }, {});
  const parts = [];
  if (counts.running) parts.push(`${counts.running} 个处理中`);
  if (counts.queued) parts.push(`${counts.queued} 个排队中`);
  if (counts.failed) parts.push(`${counts.failed} 个需要重试`);
  if (counts.unknown) parts.push(`${counts.unknown} 个处理已中断`);
  return parts.join("，") || `${jobs.length} 个任务未完成`;
}

function renderPanelQueue(jobs) {
  const container = $("jobStatus");
  if (!container) return;
  container.replaceChildren();
  container.hidden = !jobs.length;
  container.classList.toggle("error", jobs.some(job => ["failed", "unknown"].includes(job.status)));
  if (!jobs.length) return;
  const row = element("div", undefined, "queue-summary-row");
  row.append(element("span", jobsSummary(jobs)));
  row.append(button("查看任务", () => rpc("openApp", { section: "library" })));
  container.append(row);
}

function renderQueueOverview(jobs) {
  const container = $("queueOverview");
  if (!container) return;
  container.replaceChildren();
  container.hidden = !jobs.length;
  container.classList.toggle("error", jobs.some(job => ["failed", "unknown"].includes(job.status)));
  if (!jobs.length) return;
  const row = element("div", undefined, "queue-summary-row");
  row.append(element("span", jobsSummary(jobs)));
  row.append(button("查看任务", () => selectLibraryTab("jobs")));
  container.append(row);
}

function selectPanel(name) {
  document.querySelectorAll(".panel-view").forEach(n => { n.hidden = n.id !== name; });
  document.querySelectorAll("[data-panel]").forEach(b => b.dataset.panel === name ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"));
}
function renderPanel() {
  const videos = Object.values(state.videos).sort((a,b) => b.updatedAt - a.updatedAt);
  if (selectedKey && !state.videos[selectedKey]) selectedKey = "";
  // Auto-select only on first load. An empty selection afterwards means
  // "the active tab has no stored transcript yet".
  if (!selectedKey && !selectionInitialized && videos[0]) selectedKey = videos[0].key;
  selectionInitialized = true;
  const v = video();
  if (v?.summary) {
    const previous = seenSummaries.get(selectedKey);
    if (previous !== undefined && previous !== v.summary) {
      mode = "summary";
      document.body.dataset.readmode = mode;
      document.querySelectorAll("[data-mode]").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.mode === "summary")));
      notice("精读已生成，可以直接阅读和编辑。");
    }
    seenSummaries.set(selectedKey, v.summary);
  }
  $("videoTitle").textContent = v ? v.title : (activeInfo ? "当前视频尚未读取" : "从一个好问题开始");
  $("videoEyebrow").textContent = v ? `当前视频，${languageLabel(v.language)}` : "当前视频";
  $("videoMeta").textContent = v
    ? `${v.author || "未知 UP 主"} · 第 ${v.page || 1} P${usablePart(v.partTitle) ? `｜${v.partTitle}` : ""}`
    : (activeInfo ? `${activeInfo.bvid} · 第 ${activeInfo.page || 1} P｜点击右上角读取字幕` : "打开 B 站视频，读取字幕后开始学习。");
  const picker = $("videoPicker"); picker.hidden = videos.length < 2;
  picker.replaceChildren(...videos.map(v => { const option = element("option", `${v.title} / P${v.page || 1}`); option.value = v.key; return option; })); picker.value = selectedKey;
  $("readVideo").textContent = v ? "更新字幕" : activeInfo ? "读取字幕" : "读取当前视频";
  $("readVideo").classList.toggle("primary", !v);
  $("readVideo").classList.toggle("quiet", Boolean(v));
  $("summarize").textContent = v?.summary ? "重新生成精读" : "生成精读";
  for (const id of ["summarize", "exportVideo", "saveVideo"]) $(id).disabled = !v;
  // Jobs belong to the queue, not to the currently selected video.
  const activeJobs = unfinishedJobs();
  if (!v) {
    lastTranscriptSignature = ""; lastConversation = "";
    $("transcriptRows").replaceChildren(element("p", "读取视频字幕后开始学习。"));
    $("summaryText").textContent = "读完字幕后，把重点整理成一篇课堂精读。"; $("summaryDraft").value = "";
    $("summaryHistory").replaceChildren(); $("chatMessages").replaceChildren(); $("discussionSummary").value = ""; $("notesList").replaceChildren();
    renderPanelQueue(activeJobs);
    return;
  }
  renderPanelQueue(activeJobs);
  const signature = `${selectedKey}:${mode}:${v.segments?.length}`;
  if (signature !== lastTranscriptSignature) {
    lastTranscriptSignature = signature; $("transcriptRows").replaceChildren(); $("transcriptRows").classList.remove("empty");
    for (const s of v.segments || []) {
      const row = element("div", undefined, "transcript-row");
      row.append(button(timeLabel(s.start), () => rpc("seek", { key: v.key, start: s.start }), "timestamp"));
      const content = element("div"); content.append(element("p", s.text));
      row.append(content); $("transcriptRows").append(row);
    }
  }
  prose($("summaryText"), v.summary || "点击生成精读，把字幕整理成有结构、可回看的学习文章。");
  linkCitations($("summaryText"), v.segments);
  if (document.activeElement !== $("summaryDraft")) $("summaryDraft").value = v.summary || "";
  const history = $("summaryHistory");
  const historySignature = `${selectedKey}:${v.summaryHistory?.length || 0}`;
  if (history.dataset.revision !== historySignature) { history.dataset.revision = historySignature; history.replaceChildren();
  for (const previous of [...(v.summaryHistory || [])].reverse()) {
    const details = element("details"); details.append(element("summary", `${new Date(previous.at).toLocaleString("zh-CN")} · ${previous.edited ? "我的编辑" : "生成精读"}`));
    const text = element("div", undefined, "prose"); prose(text, previous.text); details.append(text); history.append(details);
  }
  }
  $("summaryText").classList.toggle("empty", !v.summary);
  renderChat(); renderNotes();
}
function renderChat() {
  const conversation = state.conversations[selectedKey];
  const signature = `${selectedKey}:${conversation?.messages?.length}:${conversation?.summary || ""}`;
  if (signature === lastConversation) return; lastConversation = signature;
  const container = $("chatMessages"); container.replaceChildren();
  if (!conversation?.messages?.length) container.append(element("p", "可以询问作者的论据、观点的适用条件，或选一段字幕继续讨论。", "muted empty"));
  for (const m of conversation?.messages || []) {
    const row = element("div", undefined, `message ${m.role}`);
    row.append(element("div", m.role === "user" ? "我的问题" : "AI 回答", "message-label"));
    const content = element("div", undefined, "message-text"); prose(content, m.content); row.append(content);
    if (m.partial) row.append(element("p", "本次依据相关片段回答，未覆盖全部字幕。", "muted compact"));
    if (m.role === "assistant" && !m.citations?.length) row.append(element("p", "本次回答没有可核对的段落引用，请结合字幕判断。", "muted compact"));
    if (m.citations?.length) {
      const refs = element("div", undefined, "citations");
      m.citations.forEach(c => refs.append(button(`来源 ${timeLabel(c.start)}`, () => rpc("seek", { key: selectedKey, start: c.start })))); row.append(refs);
    }
    container.append(row);
  }
  if (document.activeElement !== $("discussionSummary")) $("discussionSummary").value = conversation?.summary || "";
  $("discussionStale").hidden = !conversation?.summaryStale;
}
function renderNotes() {
  const container = $("notesList"); container.replaceChildren();
  const notes = video()?.notes || [];
  if (!notes.length) container.append(element("p", "还没有个人笔记。", "muted empty"));
  for (const note of notes) {
    const row = element("div", undefined, "item"); row.append(button(timeLabel(note.start), () => rpc("seek", { key: selectedKey, start: note.start }), "timestamp"), element("p", note.text));
    row.append(button("删除这条笔记", async () => { if (confirm("删除这条插件内的笔记？已保存到知识库的文件会保留。")) await rpc("deleteNote", { key: selectedKey, id: note.id }); })); container.append(row);
  }
}

async function requestPermission(gateway) {
  if (!extension) return;
  const origin = getPermissionOrigin(gateway.baseUrl);
  if (new URL(gateway.baseUrl).protocol === "http:" && !confirm(`此连接未加密，密钥和学习内容会以明文发送到 ${new URL(gateway.baseUrl).origin}。确定继续？`)) throw new Error("已取消连接，请使用加密的服务地址。");
  if (!await chrome.permissions.request({ origins: [origin] })) throw new Error("请允许访问所选模型服务后重试。");
}
function gatewayForm() { return { provider: $("provider").value, protocol: $("protocol").value, baseUrl: $("baseUrl").value.trim(), apiKey: $("apiKey").value.trim(), model: $("model").value }; }
function resetModels() { modelGeneration++; $("model").replaceChildren(element("option", "请先加载模型")); $("model").firstChild.value = ""; $("model").disabled = true; $("modelStatus").textContent = ""; }
function fillGateway(config) {
  $("provider").value = config.provider; $("protocol").value = config.protocol;
  $("protocol").disabled = config.provider !== "custom";
  $("baseUrl").value = config.baseUrl; $("apiKey").value = "";
  const protocolField = $("protocol").closest("div");
  if (protocolField) protocolField.hidden = config.provider !== "custom";
  try { lastGatewayOrigin = new URL(config.baseUrl).origin; } catch { lastGatewayOrigin = ""; }
  $("apiKey").placeholder = config.hasKey ? "已保存密钥，留空继续使用" : "填写服务商提供的密钥";
  resetModels();
  if (config.model) {
    const option = element("option", config.model); option.value = config.model; $("model").replaceChildren(option); $("model").disabled = false;
    if (config.modelSource === "catalog") $("modelStatus").textContent = "所选模型来自官方目录；账号能否使用，以生成结果为准。";
  }
}
function renderSettings() {
  if (!initialSettings) return; initialSettings = false;
  const cfg = state.settings; fillGateway({ ...cfg.gateway, hasKey: cfg.gateway.hasKey });
  for (const id of ["autoCollect", "autoReports"]) $(id).checked = cfg[id];
  for (const id of ["batchLimit", "timezone", "dailyHour"]) $(id).value = cfg[id];
}
function renderFolders() {
  const container = $("folderList"); if (!container) return; container.replaceChildren();
  if (!state.folders.length) { container.textContent = "同步后，选择你希望持续整理的收藏夹。"; return; }
  for (const folder of state.folders) {
    const row = element("label", undefined, "folder"), input = element("input"); input.type = "checkbox"; input.value = folder.id;
    input.checked = state.settings.folders.includes(String(folder.id)); row.append(input, element("span", folder.title), element("small", `${folder.count || 0} 个视频`)); container.append(row);
  }
}
function renderCreator() {
  const creator = state.creator, info = $("creatorInfo"), list = $("creatorList"), queue = $("queueCreator");
  if (!info || !list || !queue) return;
  if (!creator?.items?.length) {
    info.textContent = "同步后可以逐条整理，或按每轮上限批量整理。";
    list.replaceChildren();
    list.hidden = true;
    queue.disabled = true;
    queue.textContent = "整理未处理作品";
    return;
  }
  const minutes = Math.round(creator.items.reduce((total, item) => total + (item.duration || 0), 0) / 60);
  info.textContent = `${creator.name || "该 UP 主"}，${creator.items.length} 个作品，约 ${minutes} 分钟${creator.truncated ? "，超过本次读取范围" : ""}。`;
  list.replaceChildren();
  list.hidden = true;
  queue.disabled = false;
  queue.textContent = `整理未处理作品并生成汇总（每轮 ${state.settings.batchLimit} 个）`;
}

function collectLibraryItems() {
  const items = new Map();
  const ensure = bvid => {
    if (!items.has(bvid)) items.set(bvid, {
      bvid, title: "", author: "", page: 1, url: `https://www.bilibili.com/video/${bvid}/`,
      sources: new Set(), favorite: false, creator: false, video: null, updatedAt: 0,
    });
    return items.get(bvid);
  };
  for (const video of Object.values(state.videos)) {
    const item = ensure(video.bvid);
    Object.assign(item, {
      title: video.title || item.title,
      author: video.author || item.author,
      page: video.page || item.page,
      url: video.url || item.url,
      video,
      updatedAt: Math.max(item.updatedAt, video.updatedAt || 0),
    });
    item.sources.add("视频页");
  }
  for (const folder of Object.values(state.favorites || {})) {
    for (const favorite of folder.items || []) {
      const item = ensure(favorite.bvid);
      item.favorite = true;
      item.sources.add("收藏夹");
      item.title ||= favorite.title || favorite.bvid;
      item.url = favorite.url || item.url;
    }
  }
  for (const creatorItem of state.creator?.items || []) {
    const item = ensure(creatorItem.bvid);
    item.creator = true;
    item.sources.add("UP 主");
    item.title ||= creatorItem.title || creatorItem.bvid;
    item.url = creatorItem.url || item.url;
  }
  return [...items.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title, "zh-CN"));
}

function libraryItemStatus(item) {
  const key = item.video?.key || `bilibili:${item.bvid}:p1`;
  const active = Object.values(state.jobs || {}).find(job => job.key === key && ["queued", "running"].includes(job.status));
  if (active) return active.status === "running" ? "处理中" : "排队中";
  return item.video?.summary ? "已整理" : "待整理";
}

function renderLibrary() {
  if (!$("videoLibrary")) return;
  $("accountInfo").textContent = state.account ? `已连接：${state.account.name}` : "尚未连接 B 站账号。";
  renderCreator();
  renderFolders();
  const jobs = Object.values(state.jobs || {}).sort((a,b) => b.createdAt - a.createdAt);
  renderQueueOverview(unfinishedJobs());
  renderJobs($("allJobs"), jobs);
  const query = $("searchVideos").value.trim().toLowerCase();
  const container = $("videoLibrary");
  container.replaceChildren();
  const items = collectLibraryItems().filter(item => {
    if (libraryTab === "processed" && !item.video?.summary) return false;
    if (libraryTab === "pending" && item.video?.summary) return false;
    return !query || item.title.toLowerCase().includes(query) || item.bvid.toLowerCase().includes(query);
  });
  const emptyText = query
    ? "没有匹配的视频。"
    : libraryTab === "processed"
      ? "还没有已整理的视频。"
      : libraryTab === "pending"
        ? "没有等待整理的视频。"
        : "还没有视频资料。点击“添加内容”，从收藏夹或 UP 主作品开始。";
  if (!items.length) container.append(element("p", emptyText, "muted"));
  for (const item of items) {
    const status = libraryItemStatus(item);
    const row = element("article", undefined, "item library-item");
    const heading = element("div", undefined, "library-item-heading");
    heading.append(element("h3", item.title || item.bvid));
    const tags = element("div", undefined, "item-tags");
    for (const source of item.sources) tags.append(element("span", source, "item-tag"));
    tags.append(element("span", status, `item-tag status-${status === "已整理" ? "done" : status === "待整理" ? "pending" : "running"}`));
    row.append(heading, tags);
    const meta = [item.author || "", item.page ? `第 ${item.page} P` : ""].filter(Boolean).join("，");
    if (meta) row.append(element("p", meta, "muted compact"));
    row.append(element("p", (item.video?.summary || item.video?.segments?.length ? "字幕已读取，可以继续整理。" : "等待读取视频字幕后整理。").slice(0, 200), "library-brief"));
    if (item.video?.vaultError) row.append(element("p", `未写入知识库：${item.video.vaultError}`, "muted compact"));
    const actions = element("div", undefined, "actions");
    const link = element("a", "打开视频");
    link.href = item.url; link.target = "_blank"; link.rel = "noreferrer";
    actions.append(link);
    if (item.video) {
      actions.append(button(item.video.summary ? "重新整理" : "生成精读", () => rpc("enqueue", { jobType: "summary", key: item.video.key })));
      if (item.video.summary) actions.append(button("保存到知识库", () => saveDocument(videoMarkdown(item.video))));
    } else if (item.creator) {
      actions.append(button("整理作品", async () => { await rpc("processCreator", { bvid: item.bvid }); notice("作品已加入整理队列。"); }));
    } else if (item.favorite) {
      actions.append(button("整理视频", async () => { await rpc("processFavorite", { bvid: item.bvid }); notice("视频已加入整理队列。"); }));
    }
    row.append(actions);
    container.append(row);
  }
  const truncated = Object.values(state.coverage || {}).some(coverage => coverage?.truncated);
  $("collectionCoverage").textContent = state.coverage?.autoSyncError || (truncated ? "部分记录超过本次读取范围，当前列表与报告不代表全部历史。" : "");
}

function selectLibraryTab(name) {
  libraryTab = ["all", "processed", "pending", "jobs"].includes(name) ? name : "all";
  setSourcePanel(false);
  document.querySelectorAll("[data-library-tab]").forEach(tab => {
    if (tab.dataset.libraryTab === libraryTab) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  });
  const jobsMode = libraryTab === "jobs";
  document.querySelectorAll("[data-library-panel]").forEach(panel => { panel.hidden = panel.dataset.libraryPanel !== (jobsMode ? "jobs" : "data"); });
  $("searchVideos").hidden = jobsMode;
  renderLibrary();
}

function setSourcePanel(open) {
  const panel = $("sourcePanel"), toggle = $("toggleSources");
  if (!panel || !toggle) return;
  panel.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  toggle.textContent = open ? "收起添加内容" : "添加内容";
}
function renderReports() {
  const reports = Object.values(state.reports).sort((a,b) => b.createdAt - a.createdAt), container = $("reportList"); container.replaceChildren();
  if (!reports.length) container.append(element("p", "同步记录后，生成第一份学习回顾。", "muted"));
  if (!currentReport && reports[0]) currentReport = reports[0].id;
  for (const r of reports) {
    const b = button(`${r.kind === "daily" ? "日报" : "周报"}  ${r.start} 至 ${r.end}`, () => { currentReport = r.id; renderReports(); }, "report-choice");
    b.setAttribute("aria-pressed", String(currentReport === r.id)); container.append(b);
  }
  const report = state.reports[currentReport]; $("reportBody").hidden = !report; $("reportActions").hidden = !report;
  if (report) { prose($("reportBody"), report.text); $("reportBody").prepend(element("p", `观看 ${report.counts.viewed} 个视频，收藏 ${report.counts.favorited} 个视频，分享入口点击 ${report.counts.shareIntent} 次`, "report-counts")); }
}
async function renderVault() {
  try {
    const handle = await vaultHandle();
    $("vaultStatus").textContent = handle ? `已选择：${handle.name}` : "尚未连接知识库。";
    $("disconnectVault").disabled = !handle;
  } catch { $("vaultStatus").textContent = "无法读取保存位置，请重新连接。"; }
  const container = $("vaultDocuments"); container.replaceChildren();
  for (const v of Object.values(state.videos)) {
    const row = element("article", undefined, "item"); row.append(element("h3", v.title));
    const actions = element("div", undefined, "actions");
    actions.append(button("保存字幕与精读到知识库", () => saveDocument(videoMarkdown(v))));
    const conversation = state.conversations[v.key];
    if (conversation?.messages?.length) actions.append(button("保存完整对话到知识库", () => saveDocument(conversationMarkdown(v, conversation))));
    row.append(actions); container.append(row);
  }
  if (!container.children.length) container.append(element("p", "还没有可保存的资料。", "muted"));
}
async function saveDocument(doc) {
  try { const path = await saveToVault(doc); notice(`已保存到 ${path}`); }
  catch(error) { throw new Error(`${error.message} 也可以使用导出功能保存文件。`); }
}
async function flushVault() {
  if (!extension || panel) return;
  const pending = Object.values(state.videos || {}).filter(v => v.vaultPending && v.summary);
  if (!pending.length) return;
  let handle = null;
  try { handle = await vaultHandle(); } catch { return; }
  if (!handle) return;
  await flushVaultQueue(state.videos, {
    save: async (video) => saveToVault(videoMarkdown(video)),
    mark: async (key, patch) => rpc("savedToVault", { key, ...patch }),
  });
}
async function refresh() {
  state = await rpc("state");
  await flushVault().catch(() => {});
  const snapshot = JSON.stringify(state);
  if (snapshot === lastState) return;
  lastState = snapshot;
  if (panel) renderPanel();
  else {
    renderSettings();
    renderLibrary();
    renderReports();
    if (location.hash === "#settings") void renderVault();
  }
}
function route() {
  const requested = location.hash.slice(1);
  const name = requested === "vault" ? "settings" : ["library", "reports", "settings"].includes(requested) ? requested : "library";
  if (name !== "library") setSourcePanel(false);
  document.querySelectorAll("[data-page]").forEach(n => { n.hidden = n.dataset.page !== name; });
  document.querySelectorAll(".sidebar nav a").forEach(a => a.hash === `#${name}` ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current"));
  if (name === "settings") void renderVault();
}

if (panel) {
  document.querySelectorAll("[data-panel]").forEach(b => b.onclick = () => selectPanel(b.dataset.panel));
  listen("readVideo", async () => { const v = await rpc("currentVideo"); selectedKey = v.key; lastTranscriptSignature = ""; notice("字幕已读取，可以开始提问。"); }, "正在读取…");
  $("videoPicker").onchange = () => { selectedKey = $("videoPicker").value; renderPanel(); };
  document.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => {
    mode = b.dataset.mode; document.body.dataset.readmode = mode;
    document.querySelectorAll("[data-mode]").forEach(x => x.setAttribute("aria-pressed", String(x === b))); renderPanel();
  });
  listen("summarize", async () => { await rpc("enqueue", { jobType: "summary", key: selectedKey }); notice("正在分段精读并整理视频。"); });
  listen("exportVideo", async () => {
    const v = video(); if (!v) throw new Error("请先读取视频字幕。");
    downloadMarkdown(videoMarkdown(v)); notice("Markdown 已导出。");
  });
  listen("saveVideo", () => saveDocument(videoMarkdown(video())));
  listen("saveSummaryDraft", async () => { await rpc("saveVideoSummary", { key: selectedKey, text: $("summaryDraft").value }); notice("精读编辑已保存到插件本地。"); });
  $("chatForm").onsubmit = event => {
    event.preventDefault(); const key = selectedKey, question = $("question").value.trim();
    perform(event.submitter, async () => { await rpc("ask", { key, question }); $("question").value = ""; }, "正在思考…");
  };
  listen("summarizeChat", async () => { await rpc("summarizeConversation", { key: selectedKey }); $("discussionDetails").open = true; }, "正在整理…");
  listen("saveDiscussionDraft", async () => { await rpc("saveConversationSummary", { key: selectedKey, text: $("discussionSummary").value }); notice("讨论笔记已保存到插件本地。"); });
  listen("saveDiscussion", async () => {
    await rpc("saveConversationSummary", { key: selectedKey, text: $("discussionSummary").value });
    const latest = await rpc("state"); await saveDocument(conversationMarkdown(video(), latest.conversations[selectedKey]));
  });
  listen("exportDiscussion", () => downloadMarkdown(conversationMarkdown(video(), state.conversations[selectedKey] || {})));
  $("noteForm").onsubmit = event => { event.preventDefault(); perform(event.submitter, async () => {
    await rpc("note", { key: selectedKey, text: $("noteText").value, start: $("noteTime").value }); $("noteText").value = ""; notice("笔记已保存。");
  }); };
} else {
  for (let hour=0; hour<24; hour++) { const o=element("option",`${String(hour).padStart(2,"0")}:00`); o.value=hour; $("dailyHour").append(o); }
  $("toggleSources").onclick = () => setSourcePanel($("sourcePanel").hidden);
  document.querySelectorAll("[data-library-tab]").forEach(tab => {
    tab.onclick = () => selectLibraryTab(tab.dataset.libraryTab);
  });
  $("provider").onchange = () => {
    const id = $("provider").value;
    const preset = PROVIDERS.find(x => x.id === id);
    const saved = state.settings.gateways?.[id];
    fillGateway(saved || { provider: id, protocol: preset?.protocol || "openai", baseUrl: preset?.baseUrl || "", model: "" });
  };
  $("baseUrl").addEventListener("input", () => {
    try { const origin = new URL($("baseUrl").value).origin; if (origin !== lastGatewayOrigin) { $("apiKey").value = ""; $("apiKey").placeholder = "填写服务商提供的密钥"; lastGatewayOrigin = origin; } } catch { /* An unfinished address is not a destination. */ }
    resetModels();
  });
  $("apiKey").addEventListener("input", resetModels);
  $("protocol").onchange = resetModels;
  listen("loadModels", async () => {
    const config = normalizeGateway(gatewayForm());
    const saved = state.settings.gateways?.[config.provider] || state.settings.gateway;
    if (!config.apiKey && !(saved?.hasKey && saved.baseUrl === config.baseUrl && saved.protocol === config.protocol)) throw new Error("请填写访问密钥后加载模型。");
    await requestPermission(config);
    const generation = modelGeneration; $("modelStatus").textContent = "正在连接模型服务…";
    try {
      const { models } = await rpc("loadModels", { gateway: config });
      if (generation !== modelGeneration) return;
      $("model").replaceChildren();
      const placeholder = element("option", models.length ? "选择一个模型" : "服务没有返回可用模型"); placeholder.value=""; $("model").append(placeholder);
      for (const model of models) { const id = typeof model === "string" ? model : model.id; const option = element("option", model.name || id); option.value = id; $("model").append(option); }
      $("model").disabled = !models.length; $("modelStatus").textContent = models.length ? (models.some(m => m.source === "catalog") ? `已列出 ${models.length} 个官方目录模型；账号能否使用，以生成结果为准。` : `找到 ${models.length} 个模型，请选择文本对话模型后保存。`) : "请核对服务地址和账号权限后重试。";
    } catch(error) { $("modelStatus").textContent = error.message.replace(/API/g, "服务"); throw error; }
  }, "正在加载…");
  $("settingsForm").onsubmit = event => {
    event.preventDefault(); perform(event.submitter, async () => {
      const config = normalizeGateway(gatewayForm()); if (!config.model) throw new Error("请先加载并选择模型。"); await requestPermission(config);
      const settings = { ...state.settings, gateway: config, autoCollect: $("autoCollect").checked, autoReports: $("autoReports").checked,
        batchLimit: Number($("batchLimit").value), timezone: $("timezone").value, dailyHour: Number($("dailyHour").value) };
      await rpc("saveSettings", { settings }); initialSettings = true; $("saveStatus").textContent = "设置已保存"; notice("设置已保存。");
    }, "正在保存…");
  };
  listen("syncCollection", async () => { const result = await rpc("syncCollection"); state = await rpc("state"); renderLibrary(); notice(`已同步收藏夹与观看记录${result.queued ? `，已加入 ${result.queued} 个整理任务` : ""}。`); }, "正在同步…");
  listen("syncCreator", async () => {
    const url = $("creatorUrl").value.trim();
    if (!url) throw new Error("请先填写 UP 主空间链接。");
    const result = await rpc("syncCreator", { url });
    state = await rpc("state"); renderLibrary();
    notice(`已同步 ${result.count} 个作品${result.name ? `：${result.name}` : ""}。`);
  }, "正在同步…");
  listen("queueCreator", async () => {
    const result = await rpc("queueCreator", {});
    notice(result.queued ? `已加入 ${result.queued} 个整理任务${result.remaining ? `，还有 ${result.remaining} 个待处理` : ""}。` : "没有需要整理的作品。");
  }, "正在加入…");
  listen("saveFolders", async () => {
    const folders = [...$("folderList").querySelectorAll("input:checked")].map(x => x.value);
    await rpc("saveFolders", { folders }); notice("收藏夹选择已保存。");
  });
  $("searchVideos").oninput = renderLibrary;
  listen("dailyReport", async () => { await rpc("report", { kind: "daily" }); notice("正在生成今天的学习回顾。"); });
  listen("weeklyReport", async () => { await rpc("report", { kind: "weekly" }); notice("正在生成本周至今的学习回顾。"); });
  listen("exportReport", () => downloadMarkdown(reportMarkdown(state.reports[currentReport])));
  listen("saveReport", () => saveDocument(reportMarkdown(state.reports[currentReport])));
  listen("connectVault", async () => { const handle = await connectVault(); notice(`已连接 ${handle.name}。`); await renderVault(); }, "正在连接…");
  listen("disconnectVault", async () => { await disconnectVault(); await renderVault(); notice("已断开连接，知识库文件保留。"); });
  listen("resetData", async () => {
    if (!confirm("清除本插件的视频、对话、报告和账号关联，并关闭自动整理？模型连接和知识库文件会保留。")) return;
    await rpc("reset", { confirm: "清除本插件资料" }); selectedKey = ""; currentReport = ""; initialSettings = true; notice("本插件学习资料已清除。");
  });
  setSourcePanel(false);
  window.addEventListener("hashchange", route); route();
}

await refresh().catch(error => notice(error.message, true));
if (panel && extension) {
  rpc("activeVideo").then(active => { if (active) applyActiveVideo(active); }).catch(() => {});
}
if (!panel) { renderFolders(); route(); }
if (extension) setInterval(() => { if (!busyCount) void refresh().catch(error => notice(error.message, true)); }, 1200);
if (extension && !panel) {
  // Keep the service worker alive while the workbench stays open (long batches).
  try {
    const keepalive = chrome.runtime.connect({ name: "bili-study-keepalive" });
    keepalive.onDisconnect.addListener(() => { void chrome.runtime.lastError; });
    setInterval(() => { try { keepalive.postMessage("ping"); } catch { /* worker restarting */ } }, 20000);
  } catch { /* port is an optimisation, not a requirement */ }
}
