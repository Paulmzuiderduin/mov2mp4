function isUmamiAvailable() {
  return typeof window !== 'undefined' && typeof window.umami?.track === 'function';
}

// Keep event data useful for product decisions without sending filenames or video content.
export function trackEvent(name, data = {}) {
  if (!isUmamiAvailable()) return;

  try {
    window.umami.track(name, data);
  } catch {
    // Analytics must never interrupt a conversion.
  }
}
