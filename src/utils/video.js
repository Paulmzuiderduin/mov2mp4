export function fileBaseName(name) {
  const withoutPath = name.replace(/^.*[\\/]/, '');
  return withoutPath.replace(/\.[^.]+$/, '');
}

export function safeDownloadName(name) {
  return `${fileBaseName(name).replace(/[^\w.-]+/g, '-').replace(/-+/g, '-') || 'video'}.mp4`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** idx;
  return `${value.toFixed(value >= 100 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

export function makeId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
