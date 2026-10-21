// Page-side auto-save orchestration. Kept pure so it can be tested without a
// real directory handle; the handle itself is covered by vault tests.
export async function flushVaultQueue(videos, { save, mark, limit = 3 } = {}) {
  if (typeof save !== "function" || typeof mark !== "function") throw new Error("INVALID_ARGUMENT");
  const pending = Object.values(videos || {}).filter(video => video?.vaultPending && video.summary);
  for (const video of pending.slice(0, limit)) {
    try {
      const path = await save(video);
      await mark(video.key, { path });
    } catch (error) {
      await mark(video.key, { error: error?.message || "保存失败" });
    }
  }
  return { total: pending.length, processed: Math.min(pending.length, limit) };
}
