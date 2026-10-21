import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ROOT_FILES = new Set(['manifest.json', 'app.html', 'panel.html', 'styles.css']);
const PRIVATE_NAME = /(?:^|[-_.])(?:secrets?|credentials?|api[-_]?keys?|tokens?|passwords?|private|fixtures?|tests?|output|node_modules)(?:$|[-_.])/i;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export function isRuntimePath(relative) {
  if (typeof relative !== 'string' || !relative || relative.startsWith('/') || relative.includes('\\')) return false;
  const parts = relative.split('/');
  if (parts.some((part) => !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part) || PRIVATE_NAME.test(part))) return false;
  return ROOT_FILES.has(relative) || (parts[0] === 'src' && parts.length >= 2 && relative.endsWith('.js'));
}

async function checkedFile(relative, root, runtimeOnly) {
  if (!(runtimeOnly ? isRuntimePath(relative) : relative === 'package.json')) throw new Error('文件不在允许读取的范围内。');
  const resolvedRoot = await realpath(root);
  if (resolvedRoot !== path.resolve(root)) throw new Error('项目根目录不能是符号链接。');
  let current = root;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const entry = await lstat(current);
    if (entry.isSymbolicLink() || (index < parts.length - 1 && !entry.isDirectory())) {
      throw new Error(`拒绝符号链接或非目录路径：${relative}`);
    }
  }
  const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_FILE_BYTES) throw new Error(`文件不是普通文件或超过 5 MiB：${relative}`);
    const chunks = [];
    let bytes = 0;
    while (true) {
      const buffer = Buffer.alloc(65536);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > MAX_FILE_BYTES) throw new Error(`文件超过 5 MiB：${relative}`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error(`读取时文件发生变化，请重试：${relative}`);
    return Buffer.concat(chunks);
  } finally {
    await handle.close();
  }
}

export const readRuntimeFile = (relative, root = PROJECT_ROOT) => checkedFile(relative, root, true);

async function discoverSources(root) {
  const files = [];
  async function visit(relative) {
    const stat = await lstat(path.join(root, relative));
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`运行目录不能是符号链接：${relative}`);
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(entry.name) || PRIVATE_NAME.test(entry.name)) continue;
      const name = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`运行目录包含符号链接：${name}`);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile() && isRuntimePath(name)) files.push(name);
    }
  }
  await visit('src');
  return files.sort();
}

function parseJson(buffer, name) {
  try { return JSON.parse(buffer.toString('utf8')); } catch { throw new Error(`JSON 无法解析：${name}`); }
}

function manifestReferences(manifest) {
  const refs = [];
  const add = (value, label, classic = false) => {
    if (value === undefined) return;
    if (typeof value !== 'string' || !value) throw new Error(`manifest 引用格式不正确：${label}`);
    refs.push({ value, from: 'manifest.json', label, classic });
  };
  const icons = (value, label) => {
    if (typeof value === 'string') add(value, label);
    else if (value && typeof value === 'object') Object.entries(value).forEach(([size, file]) => add(file, `${label}.${size}`));
  };
  add(manifest.background?.service_worker, 'background.service_worker', manifest.background?.type !== 'module');
  add(manifest.action?.default_popup, 'action.default_popup');
  add(manifest.side_panel?.default_path, 'side_panel.default_path');
  add(manifest.options_ui?.page, 'options_ui.page');
  add(manifest.options_page, 'options_page');
  add(manifest.devtools_page, 'devtools_page');
  icons(manifest.icons, 'icons');
  icons(manifest.action?.default_icon, 'action.default_icon');
  for (const [index, item] of (manifest.content_scripts ?? []).entries()) {
    for (const file of item.js ?? []) add(file, `content_scripts[${index}].js`, true);
    for (const file of item.css ?? []) add(file, `content_scripts[${index}].css`);
  }
  for (const page of manifest.sandbox?.pages ?? []) add(page, 'sandbox.pages');
  for (const page of Object.values(manifest.chrome_url_overrides ?? {})) add(page, 'chrome_url_overrides');
  for (const item of manifest.declarative_net_request?.rule_resources ?? []) add(item.path, 'rule_resources.path');
  for (const item of manifest.web_accessible_resources ?? []) {
    for (const file of item.resources ?? []) add(file, 'web_accessible_resources');
  }
  return refs;
}

export function sourceReferences(source, from) {
  const refs = [];
  const add = (value, classic = false) => refs.push({ value, from, label: from, classic });
  if (from.endsWith('.html')) {
    const html = source.replace(/<!--[\s\S]*?-->/g, '');
    for (const tag of html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
      const attrs = new Map();
      for (const attr of tag[2].matchAll(/([a-z_:][a-z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
        attrs.set(attr[1].toLowerCase(), attr[2] ?? attr[3] ?? attr[4]);
      }
      const type = tag[1].toLowerCase();
      for (const attr of ['src', 'href']) {
        const value = attrs.get(attr);
        if (!value || value.startsWith('#')) continue;
        if (type === 'link' && attr === 'href' && attrs.get('rel')?.toLowerCase() === 'icon' && value === 'data:,') continue;
        if (/^(?:https?:|mailto:|data:|\/\/)/i.test(value)) {
          if (type === 'script' || type === 'link') throw new Error(`运行脚本和样式不得引用站外资源：${from}`);
          continue;
        }
        add(value, type === 'script' && attrs.get('type') !== 'module');
      }
    }
  } else if (from.endsWith('.js')) {
    for (const regex of [
      /\b(?:import|export)\s+(?:[^;'"`]*?\s+from\s*)?["']([^"']+)["']/g,
      /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
      /\bnew\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
    ]) for (const match of source.matchAll(regex)) add(match[1]);
  } else if (from.endsWith('.css')) {
    for (const match of source.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)|@import\s+["']([^"']+)["']/g)) {
      const value = match[1] ?? match[2];
      if (!/^(?:data:|https?:|#)/i.test(value)) add(value);
    }
  }
  return refs;
}

function resolveReference(ref, files, version) {
  const value = ref.value;
  if (/[\\\u0000-\u001f\u007f%]/u.test(value) || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(value)) {
    throw new Error(`不允许的运行引用：${ref.label}`);
  }
  if (ref.from.endsWith('.js') && !value.startsWith('.') && !value.startsWith('/')) {
    throw new Error(`浏览器运行脚本不能使用未打包的依赖：${ref.from}`);
  }
  const [beforeHash] = value.split('#');
  const [pathname, query = ''] = beforeHash.split('?');
  const params = new URLSearchParams(query);
  for (const key of ['v', 'version']) {
    if (params.has(key) && params.get(key) !== version) throw new Error(`资源版本与 manifest 不一致：${ref.from}`);
  }
  const relative = path.posix.normalize(pathname.startsWith('/') ? pathname.slice(1) : path.posix.join(path.posix.dirname(ref.from), pathname));
  if (value.includes('*') && ref.label === 'web_accessible_resources') {
    const expression = new RegExp(`^${relative.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    if (![...files.keys()].some((file) => expression.test(file))) throw new Error('manifest 资源通配符没有匹配任何运行文件。');
    return;
  }
  if (!isRuntimePath(relative) || !files.has(relative)) throw new Error(`运行引用缺失或不在白名单：${ref.from} → ${relative}`);
  return relative;
}

/** Shared allowlist/snapshot used by check, package and preview; never scans user storage. */
export async function inspectRuntime(root = PROJECT_ROOT) {
  const pkg = parseJson(await checkedFile('package.json', root, false), 'package.json');
  const files = new Map();
  for (const name of [...ROOT_FILES, ...await discoverSources(root)].sort()) files.set(name, await readRuntimeFile(name, root));
  const manifest = parseJson(files.get('manifest.json'), 'manifest.json');
  if (pkg.type !== 'module' || manifest.manifest_version !== 3) throw new Error('项目必须使用 ESM 和 MV3 manifest。');
  if (typeof manifest.version !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)
    || manifest.version.split('.').some((part) => Number(part) > 65535 || (part.length > 1 && part.startsWith('0')))
    || manifest.version.split('.').every((part) => Number(part) === 0)) throw new Error('manifest 版本不符合 Chrome 格式。');
  if (pkg.version !== manifest.version || (manifest.version_name !== undefined && manifest.version_name !== pkg.version)) {
    throw new Error('package.json、manifest.json 或 version_name 的版本不一致。');
  }
  const refs = manifestReferences(manifest);
  for (const [name, buffer] of files) {
    const source = buffer.toString('utf8');
    // High-confidence literal checks only; never print the matched value or source line.
    if (/\bsk-[A-Za-z0-9_-]{20,}\b/.test(source)
      || /\b(?:apiKey|api_key|access_token|refresh_token|SESSDATA|bili_jct)\s*[:=]\s*["'][^"'\s]{12,}["']/i.test(source)) {
      throw new Error(`运行文件疑似包含硬编码凭据，请安全审查后再打包：${name}`);
    }
    refs.push(...sourceReferences(source, name));
  }
  const classic = new Set();
  for (const ref of refs) {
    const target = resolveReference(ref, files, pkg.version);
    if (target && ref.classic) classic.add(target);
  }
  let jsCount = 0;
  for (const [name, buffer] of files) {
    if (!name.endsWith('.js')) continue;
    const syntax = spawnSync(process.execPath, [`--input-type=${classic.has(name) ? 'commonjs' : 'module'}`, '--check'], {
      input: buffer, encoding: 'utf8', timeout: 10000, maxBuffer: 128 * 1024,
    });
    if (syntax.error || syntax.status !== 0) throw new Error(`JavaScript 语法检查失败：${name}（未输出源码或可能的敏感值）。`);
    jsCount += 1;
  }
  return { version: pkg.version, manifest, files, jsCount, referenceCount: refs.length };
}

export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(metaUrl);
}

if (isMain(import.meta.url)) {
  try {
    const result = await inspectRuntime();
    console.log(`检查通过：v${result.version}，${result.files.size} 个运行文件，${result.jsCount} 个 JS，${result.referenceCount} 项本地引用。`);
  } catch (error) {
    console.error(`检查失败：${error.message}`);
    process.exitCode = 1;
  }
}
