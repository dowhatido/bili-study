const DB_NAME = "bili-study-vault";
function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("handles");
    request.onerror = () => reject(new Error("无法读取知识库连接，请重新选择文件夹。"));
    request.onsuccess = () => resolve(request.result);
  });
}
export async function vaultHandle() {
  const db = await database();
  try { return await new Promise((resolve, reject) => {
    const request = db.transaction("handles").objectStore("handles").get("vault");
    request.onsuccess = () => resolve(request.result || null); request.onerror = () => reject(request.error);
  }); } finally { db.close(); }
}
export async function connectVault() {
  if (!window.showDirectoryPicker) throw new Error("当前浏览器不支持选择文件夹，可先下载 Markdown，再放入知识库。");
  const handle = await window.showDirectoryPicker({ id: "bili-study-vault", mode: "readwrite" });
  const db = await database();
  try { await new Promise((resolve, reject) => {
    const transaction = db.transaction("handles", "readwrite");
    transaction.objectStore("handles").put(handle, "vault");
    transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
  }); } finally { db.close(); }
  return handle;
}
export async function disconnectVault() {
  const db = await database();
  try { await new Promise((resolve, reject) => {
    const t = db.transaction("handles", "readwrite"); t.objectStore("handles").delete("vault");
    t.oncomplete = resolve; t.onerror = () => reject(t.error);
  }); } finally { db.close(); }
}
export async function writeSnapshot(handle, doc, now = Date.now(), random = crypto.randomUUID()) {
  if (!handle) throw new Error("请先选择知识库文件夹。");
  if (!doc || !["视频资料", "视频讨论", "学习回顾"].includes(doc.category) || !/^[^/\\\u0000-\u001f]+\.md$/.test(doc.filename) || typeof doc.text !== "string") throw new Error("保存内容不正确，未写入文件。");
  let permission = await handle.queryPermission({ mode: "readwrite" });
  if (permission !== "granted") permission = await handle.requestPermission({ mode: "readwrite" });
  if (permission !== "granted") throw new Error("尚未获得写入权限，请重新连接知识库。");
  const root = await handle.getDirectoryHandle("Bili Study", { create: true });
  const folder = await root.getDirectoryHandle(doc.category, { create: true });
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const filename = doc.filename.replace(/\.md$/, "") + `-${stamp}-${random.slice(0, 8)}.md`;
  try { await folder.getFileHandle(filename); throw new Error("同名快照已经存在，原文件未修改。请重新保存。"); }
  catch (error) { if (error.name !== "NotFoundError") throw error; }
  const file = await folder.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  try { await writable.write(doc.text); await writable.close(); } catch (error) {
    await writable.abort().catch(() => {}); throw new Error("保存未完成，资料仍保留在插件中，请重试。");
  }
  const saved = await file.getFile();
  if (await saved.text() !== doc.text) throw new Error("保存后的内容核对未通过，请检查知识库文件；插件资料仍保留。");
  return `Bili Study/${doc.category}/${filename}`;
}
export async function saveToVault(doc) {
  const save = async () => writeSnapshot(await vaultHandle(), doc);
  return globalThis.navigator?.locks ? navigator.locks.request("bili-study-vault-write", save) : save();
}
