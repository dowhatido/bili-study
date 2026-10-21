export const SCHEMA_VERSION = 1;
export const DEFAULT_SETTINGS = Object.freeze({
  gateway: { provider: "deepseek", protocol: "openai", baseUrl: "https://api.deepseek.com", apiKey: "", model: "" },
  gateways: {}, folders: [], autoCollect: false, autoReports: false, batchLimit: 5,
  timezone: "Asia/Shanghai", dailyHour: 21, weekDay: 0,
});

export function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, epoch: 0, settings: structuredClone(DEFAULT_SETTINGS), account: null,
    videos: {}, conversations: {}, events: {}, jobs: {}, reports: {}, favorites: {}, creator: null, folders: [], coverage: {}, audit: [] };
}

let mutation = Promise.resolve();
export async function readState() {
  if (!globalThis.chrome?.storage?.local) return emptyState();
  const { biliStudy } = await chrome.storage.local.get("biliStudy");
  if (!biliStudy) return emptyState();
  return { ...emptyState(), ...biliStudy, settings: { ...structuredClone(DEFAULT_SETTINGS), ...biliStudy.settings } };
}

export function changeState(fn) {
  const next = mutation.then(async () => {
    const state = await readState();
    const result = await fn(state);
    try { await chrome.storage.local.set({ biliStudy: state }); }
    catch { throw new Error("本地资料未能保存，可能已达到浏览器容量上限。请先导出资料并检查可用空间；原有资料未自动清除。"); }
    return result;
  });
  mutation = next.catch(() => {});
  return next;
}

export function addAudit(state, action, result = "完成") {
  state.audit.unshift({ action, result, at: Date.now() });
  state.audit = state.audit.slice(0, 200);
}

export function publicState(state) {
  const copy = structuredClone(state);
  // Settings UI is extension-only; content scripts never receive any stored state.
  copy.settings.gateway.apiKey = "";
  copy.settings.gateway.hasKey = Boolean(state.settings.gateway.apiKey);
  for (const gateway of Object.values(copy.settings.gateways || {})) {
    gateway.hasKey = Boolean(gateway.apiKey); gateway.apiKey = "";
  }
  return copy;
}

export function normalizeSettings(input, previous = DEFAULT_SETTINGS) {
  const candidate = { ...previous, ...input };
  const zones = ["Asia/Shanghai", "UTC", "America/Los_Angeles", "Europe/London", Intl.DateTimeFormat().resolvedOptions().timeZone];
  return { ...candidate, folders: [...new Set((candidate.folders || []).map(String))],
    batchLimit: Math.min(50, Math.max(1, Number(candidate.batchLimit) || 5)),
    timezone: zones.includes(candidate.timezone) ? candidate.timezone : "Asia/Shanghai",
    autoCollect: Boolean(candidate.autoCollect), autoReports: Boolean(candidate.autoReports),
    dailyHour: Math.min(23, Math.max(0, Math.trunc(Number(candidate.dailyHour) || 0))),
  };
}
