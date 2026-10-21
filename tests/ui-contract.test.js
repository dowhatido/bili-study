import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = name => readFile(new URL(name, import.meta.url), "utf8");

function ids(html) {
  return [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
}

test("the workbench exposes exactly three top-level destinations", async () => {
  const html = await read("../app.html");
  const navigation = /<nav aria-label="学习工作台">([\s\S]*?)<\/nav>/.exec(html)?.[1] || "";
  assert.deepEqual(
    [...navigation.matchAll(/<a href="#[^"]+">([^<]+)<\/a>/g)].map(match => match[1]),
    ["学习库", "学习回顾", "设置"],
  );
});

test("the side panel is scoped to the current video", async () => {
  const html = await read("../panel.html");
  assert.doesNotMatch(html, /class="panel-footer"/);
  assert.doesNotMatch(html, /data-open=/);
  assert.match(html, /<a class="workspace-entry"[^>]*>打开工作台<\/a>/);
  assert.match(html, /<div id="translationActions" class="translation-actions" hidden>/);
  assert.match(html, /data-panel="transcript"[^>]*>学习<\/button>/);
});

test("the knowledge base is managed inside settings", async () => {
  const html = await read("../app.html");
  assert.doesNotMatch(html, /data-page="vault"/);
  assert.match(html, /data-page="settings"/);
  assert.match(html, /id="connectVault"/);
  assert.match(html, /id="vaultDocuments"/);
});

test("pages keep unique ids and the hidden fallback remains enforceable", async () => {
  for (const name of ["../panel.html", "../app.html"]) {
    const pageIds = ids(await read(name));
    assert.equal(new Set(pageIds).size, pageIds.length, `${name} contains duplicate ids`);
  }
  const css = await read("../styles.css");
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
  assert.match(css, /linear-gradient\(to right, #1e2a24 0 236px/);
});
