// Safe Markdown-lite renderer: trusted DOM construction, no innerHTML.
export function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function inline(target, text) {
  const parts = String(text ?? "").split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  for (const part of parts) {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      target.append(element("strong", part.slice(2, -2)));
    } else if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      target.append(element("code", part.slice(1, -1)));
    } else {
      target.append(document.createTextNode(part));
    }
  }
}

export function renderProse(target, text) {
  target.replaceChildren();
  let list = null;
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) { list = null; continue; }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      list = null;
      const node = element("h3");
      inline(node, heading[2]);
      target.append(node);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    const ordered = /^\s*(\d+)[.)]\s+(.+)$/.exec(line);
    if (bullet || ordered) {
      if (!list) { list = element("ul", undefined, "md-list"); target.append(list); }
      const item = element("li");
      if (ordered) item.dataset.marker = `${ordered[1]}.`;
      inline(item, bullet ? bullet[1] : ordered[2]);
      list.append(item);
      continue;
    }

    list = null;
    const paragraph = element("p");
    inline(paragraph, line);
    target.append(paragraph);
  }
  if (!target.children.length) target.append(element("p", "暂无内容。", "muted"));
}
