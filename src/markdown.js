import { timeLabel, targetLanguage } from "./learning.js";

export function safeFilename(value) {
  const clean = String(value || "未命名").normalize("NFKC").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ").replace(/[. ]+$/, "").trim().slice(0, 90);
  return clean || "未命名";
}
function yaml(value) { return JSON.stringify(String(value || "")); }
function heading(value) { return safeContent(String(value || "未命名").replace(/[\r\n]/g, " ")); }
function safeContent(value) {
  // Keep useful Markdown, but do not create active HTML or auto-fetching image/wiki embeds.
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/!\[/g, "\\![");
}
function sourceUrl(video, start) {
  const url = new URL(video.url || `https://www.bilibili.com/video/${video.bvid}/`);
  if (url.origin !== "https://www.bilibili.com" || !/^\/video\/BV[a-zA-Z0-9]+\/?$/.test(url.pathname)) throw new Error("视频来源地址不正确，未导出资料。");
  if (start !== undefined) url.searchParams.set("t", String(Math.floor(start)));
  return url.toString();
}
function frontmatter(type, data) {
  return ["---", `type: ${type}`, ...Object.entries(data).map(([k, v]) => `${k}: ${yaml(v)}`), "---", ""].join("\n");
}
export function videoMarkdown(video, { bilingual = false } = {}) {
  if (!video) throw new Error("请先选择视频。");
  if (bilingual && (!video.segments?.length || video.segments.some(s => !video.translations?.[s.id]?.trim()) || video.translationTarget !== targetLanguage(video.language))) {
    throw new Error("双语字幕尚未完整，请先完成翻译再保存。");
  }
  const partTitle = video.partTitle && video.partTitle !== video.title && !/^(?:lv_0_|Camera_xhs_)/.test(video.partTitle)
    ? ` · ${video.partTitle}` : "";
  const title = `${video.title}${partTitle}`;
  const text = [frontmatter("bili-video", { source: video.url, bvid: video.bvid, cid: video.cid, language: video.language,
    model: video.summaryModel, updated: new Date(video.updatedAt || Date.now()).toISOString() }),
  `# ${heading(title)}`, "", `- UP 主：${safeContent(video.author || "未知")}`, `- 来源：[打开视频](${sourceUrl(video)})`, "",
  "## 视频摘要", "", safeContent(video.summary || "尚未生成摘要。"), "", "## 个人笔记", "",
  ...(video.notes || []).map(n => `- [${timeLabel(n.start)}](${sourceUrl(video, n.start)}) ${safeContent(n.text)}`), "",
  bilingual ? "## 双语字幕" : "## 原文字幕", "",
  ...(video.segments || []).flatMap(s => [`### [${timeLabel(s.start)}](${sourceUrl(video, s.start)})`, "", `**原文**\n\n${safeContent(s.text)}`, "",
    ...(bilingual ? [`**${video.translationTarget === "en" ? "英文" : "中文"}**\n\n${safeContent(video.translations[s.id])}`, ""] : [])]),
  "---", "AI 生成内容请结合视频核对。", ""].join("\n");
  return { filename: `${safeFilename(title)}-${video.bvid}-${video.cid}.md`, text, category: "视频资料" };
}
export function conversationMarkdown(video, conversation, { summaryOnly = false } = {}) {
  if (summaryOnly && !conversation.summary) throw new Error("请先整理本次讨论。");
  const label = summaryOnly ? "讨论笔记" : "完整对话";
  const text = [frontmatter("bili-conversation", { source: video.url, bvid: video.bvid, cid: video.cid,
    conversation: conversation.id, updated: new Date().toISOString() }), `# ${label} · ${heading(video.title)}`, "",
    `[视频来源](${sourceUrl(video)})`, "", conversation.summaryStale ? "讨论有新内容，以下总结尚未更新；完整对话保留如下。" : "", conversation.summary ? `## 讨论总结\n\n${safeContent(conversation.summary)}` : "",
    ...(!summaryOnly ? (conversation.messages || []).flatMap(m => [`## ${m.role === "user" ? "我的问题" : "AI 回答"}`, "", safeContent(m.content), "",
      ...(m.citations || []).map(c => `- [${timeLabel(c.start)}](${sourceUrl(video, c.start)}) ${safeContent(c.text)}`), ""]) : [])].join("\n");
  return { filename: `${safeFilename(video.title)}-${video.bvid}-${video.cid}-${label}.md`, text, category: "视频讨论" };
}
export function reportMarkdown(report) {
  return { filename: `${report.kind === "daily" ? "日报" : "周报"}-${report.start}-${report.end}.md`, category: "学习回顾",
    text: [frontmatter("bili-report", { start: report.start, end: report.end, timezone: report.timeZone, model: report.model }),
      `# ${report.kind === "daily" ? "今天的学习札记" : "这一周的学习札记"}`, "", ...(report.counts ? [`观看 ${report.counts.viewed} 个视频；收藏 ${report.counts.favorited} 个视频；分享入口点击 ${report.counts.shareIntent} 次。`, ""] : []), safeContent(report.text), "", "## 可追溯来源", "",
      ...report.videos.map(v => `- [${v.title}](${v.url})`), "", "转发仅记录本插件观察到的分享入口点击，不代表分享成功或完整转发历史。", ""].join("\n") };
}
export function collectionMarkdown(creator) {
  const title = `${creator.name || "UP 主"}作品汇总`;
  const items = creator.items || [];
  const missing = items.filter(item => !item.summarized);
  return {
    filename: `${safeFilename(title)}-${creator.mid}.md`,
    category: "学习回顾",
    text: [frontmatter("bili-collection", { mid: creator.mid, total: items.length,
      covered: creator.covered ?? items.length - missing.length, model: creator.summaryModel,
      updated: new Date(creator.summaryAt || Date.now()).toISOString() }),
      `# ${heading(title)}`, "",
      `- 作品总数：${items.length}`, `- 已覆盖：${creator.covered ?? items.length - missing.length}`,
      `- 汇总模型：${creator.summaryModel || "未知"}`, "",
      creator.summary || "尚未生成汇总。", "",
      "## 作品清单", "",
      ...items.map(item => `- [${heading(item.title)}](${item.url}) ${timeLabel(item.duration || 0)}${item.summarized ? "" : "（未生成摘要）"}`),
      "", "---", "AI 生成内容请结合原视频核对。", ""].join("\n"),
  };
}
export function downloadMarkdown(doc) {
  const url = URL.createObjectURL(new Blob([doc.text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a"); a.href = url; a.download = doc.filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
