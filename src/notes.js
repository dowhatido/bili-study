import { timeLabel } from "./learning.js";

// Assemble detailed section notes into a readable classroom-style article.
// The model only supplies scaffolding; the body keeps every detailed part.
export function assembleClassNotes(video, parts, meta = {}) {
  const lines = [];
  if (meta.intro) lines.push(`> ${meta.intro}`, "");
  if (Array.isArray(meta.glossary) && meta.glossary.length) {
    lines.push("## 术语表", "");
    for (const row of meta.glossary) {
      if (!row?.term) continue;
      lines.push(`- **${row.term}**：${row.def || ""}`);
    }
    lines.push("");
  }
  parts.forEach((part, index) => {
    const text = typeof part === "string" ? part : part.text;
    const range = typeof part === "string" ? "" : `｜${timeLabel(part.start)} - ${timeLabel(part.end)}`;
    lines.push(`## 第 ${index + 1} 部分${range}`, "", String(text || "").trim(), "");
  });
  if (Array.isArray(meta.checklist) && meta.checklist.length) {
    lines.push("## 可落地清单", "");
    meta.checklist.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
    lines.push("");
  }
  if (Array.isArray(meta.questions) && meta.questions.length) {
    lines.push("## 复习题", "");
    meta.questions.forEach((item, index) => {
      if (!item?.q) return;
      lines.push(`${index + 1}. ${item.q}`, `   - 答案要点：${item.a || "见正文"}`);
    });
    lines.push("");
  }
  lines.push("---", `来源：${video.url || ""} ｜ 字幕：${video.language || "未知"} ｜ 模型：${video.summaryModel || "未记录"}`);
  return lines.join("\n");
}
