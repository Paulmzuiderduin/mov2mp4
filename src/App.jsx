import { useEffect, useMemo, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

const CORE_BASE = '/ffmpeg';

const ACCEPT_PATTERN = /\.mov$/i;
const CONSENT_STORAGE_KEY = 'mov2mp4-consent-v1';
const DEFAULT_ANALYTICS_RUNTIME = {
  consent: 'unknown',
  scriptRequested: false,
  scriptReady: false,
  configured: false,
  lastError: null,
  lastEventName: null,
  lastEventAt: null
};

function loadConsentState() {
  if (typeof window === 'undefined') {
    return 'unknown';
  }

  if (typeof window.getMov2Mp4Consent === 'function') {
    const value = window.getMov2Mp4Consent();
    if (value === 'granted' || value === 'denied' || value === 'unknown') {
      return value;
    }
  }

  try {
    const stored = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    if (stored === 'granted' || stored === 'denied') {
      return stored;
    }
  } catch (error) {
    // Ignore local storage access issues.
  }

  return 'unknown';
}

function loadAnalyticsRuntime() {
  if (typeof window === 'undefined') {
    return DEFAULT_ANALYTICS_RUNTIME;
  }

  if (typeof window.getMov2Mp4AnalyticsRuntime === 'function') {
    try {
      const runtime = window.getMov2Mp4AnalyticsRuntime();
      if (runtime && typeof runtime === 'object') {
        return { ...DEFAULT_ANALYTICS_RUNTIME, ...runtime };
      }
    } catch (error) {
      // Ignore runtime getter errors.
    }
  }

  if (window.__mov2mp4AnalyticsRuntime && typeof window.__mov2mp4AnalyticsRuntime === 'object') {
    return { ...DEFAULT_ANALYTICS_RUNTIME, ...window.__mov2mp4AnalyticsRuntime };
  }

  return {
    ...DEFAULT_ANALYTICS_RUNTIME,
    consent: loadConsentState()
  };
}

function trackAnalyticsEvent(eventName, params = {}) {
  if (typeof window === 'undefined' || !eventName) {
    return;
  }

  if (typeof window.trackMov2Mp4Event === 'function') {
    window.trackMov2Mp4Event(eventName, params);
    return;
  }

  if (loadConsentState() === 'granted' && typeof window.gtag === 'function') {
    window.gtag('event', eventName, params);
  }
}

function fileBaseName(name) {
  const withoutPath = name.replace(/^.*[\\/]/, '');
  return withoutPath.replace(/\.[^.]+$/, '');
}

function safeDownloadName(name) {
  return `${fileBaseName(name).replace(/[^\w.-]+/g, '-').replace(/-+/g, '-') || 'video'}.mp4`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** idx;
  return `${value.toFixed(value >= 100 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function makeId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function createFFmpeg(progressHandler) {
  const ffmpeg = new FFmpeg();
  ffmpeg.on('progress', progressHandler);
  await ffmpeg.load({
    coreURL: `${CORE_BASE}/ffmpeg-core.js`,
    wasmURL: `${CORE_BASE}/ffmpeg-core.wasm`
  });
  return ffmpeg;
}

function normalizeErrorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== '{}') return serialized;
  } catch (serializeError) {
    // ignore serialization failure
  }
  return 'Unknown conversion error.';
}

async function tryCommands(ffmpeg, commands, getLogTail) {
  let lastError = null;
  for (const command of commands) {
    try {
      const code = await ffmpeg.exec(command.args);
      if (code !== 0) {
        const tail = getLogTail();
        throw new Error(
          tail
            ? `${command.label} failed (code ${code}). ${tail}`
            : `${command.label} failed (code ${code}).`
        );
      }
      return command.label;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Conversion failed.');
}

function buildConversionPlans(inputName, outputName, speedMode) {
  const directCopy = {
    label: 'Direct stream copy (no re-encode)',
    args: [
      '-i',
      inputName,
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-sn',
      '-dn',
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      outputName
    ]
  };

  if (speedMode === 'fastest') {
    return [
      directCopy,
      {
        label: 'Fast re-encode (H.264/AAC ultrafast)',
        args: [
          '-i',
          inputName,
          '-map',
          '0:v:0',
          '-map',
          '0:a?',
          '-sn',
          '-dn',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-crf',
          '30',
          '-c:a',
          'aac',
          '-b:a',
          '96k',
          '-movflags',
          '+faststart',
          outputName
        ]
      },
      {
        label: 'Fast fallback (MPEG4/AAC)',
        args: [
          '-i',
          inputName,
          '-sn',
          '-dn',
          '-c:v',
          'mpeg4',
          '-q:v',
          '7',
          '-c:a',
          'aac',
          '-b:a',
          '96k',
          '-movflags',
          '+faststart',
          outputName
        ]
      }
    ];
  }

  return [
    directCopy,
    {
      label: 'Balanced re-encode (H.264/AAC)',
      args: [
        '-i',
        inputName,
        '-map',
        '0:v:0',
        '-map',
        '0:a?',
        '-sn',
        '-dn',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '22',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        outputName
      ]
    },
    {
      label: 'Balanced fallback (MPEG4/AAC)',
      args: [
        '-i',
        inputName,
        '-sn',
        '-dn',
        '-c:v',
        'mpeg4',
        '-q:v',
        '5',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        outputName
      ]
    },
    {
      label: 'No-audio fallback',
      args: [
        '-i',
        inputName,
        '-an',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-movflags',
        '+faststart',
        outputName
      ]
    }
  ];
}

export default function App() {
  const ffmpegRef = useRef(null);
  const ffmpegLogRef = useRef([]);
  const hasTrackedModeRef = useRef(false);
  const activeItemIdRef = useRef(null);
  const inputRef = useRef(null);
  const queueRef = useRef([]);

  const [queue, setQueue] = useState([]);
  const [isBusy, setIsBusy] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [speedMode, setSpeedMode] = useState('fastest');
  const [consentState, setConsentState] = useState(loadConsentState);
  const [analyticsRuntime, setAnalyticsRuntime] = useState(loadAnalyticsRuntime);
  const [engineStatus, setEngineStatus] = useState('idle');
  const [engineMessage, setEngineMessage] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(
    () => () => {
      queueRef.current.forEach((item) => {
        if (item.downloadUrl) URL.revokeObjectURL(item.downloadUrl);
      });
    },
    []
  );

  const doneCount = useMemo(
    () => queue.filter((item) => item.status === 'done').length,
    [queue]
  );

  const queuedCount = useMemo(
    () => queue.filter((item) => item.status === 'queued' || item.status === 'error').length,
    [queue]
  );

  const analyticsStatus = useMemo(() => {
    if (consentState !== 'granted') {
      return { level: 'off', message: 'Analytics disabled.' };
    }

    if (analyticsRuntime.lastError === 'script_load_failed' || analyticsRuntime.lastError === 'script_load_timeout') {
      return { level: 'warning', message: 'Analytics blocked by browser/privacy settings.' };
    }

    if (analyticsRuntime.configured || analyticsRuntime.scriptReady) {
      return { level: 'on', message: 'Analytics active.' };
    }

    if (analyticsRuntime.scriptRequested) {
      return { level: 'notice', message: 'Connecting analytics...' };
    }

    return { level: 'notice', message: 'Waiting for analytics startup...' };
  }, [analyticsRuntime, consentState]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const syncConsent = (event) => {
      const nextState = event?.detail?.state;
      if (nextState === 'granted' || nextState === 'denied' || nextState === 'unknown') {
        setConsentState(nextState);
      } else {
        setConsentState(loadConsentState());
      }
    };

    window.addEventListener('mov2mp4-consent-changed', syncConsent);
    return () => window.removeEventListener('mov2mp4-consent-changed', syncConsent);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const syncRuntime = (event) => {
      const runtime = event?.detail;
      if (runtime && typeof runtime === 'object') {
        setAnalyticsRuntime({ ...DEFAULT_ANALYTICS_RUNTIME, ...runtime });
      } else {
        setAnalyticsRuntime(loadAnalyticsRuntime());
      }
    };

    window.addEventListener('mov2mp4-analytics-runtime-changed', syncRuntime);
    return () => window.removeEventListener('mov2mp4-analytics-runtime-changed', syncRuntime);
  }, []);

  useEffect(() => {
    if (consentState !== 'granted') {
      return;
    }
    trackAnalyticsEvent('mov2mp4_view', { page: 'home' });
  }, [consentState]);

  useEffect(() => {
    if (!hasTrackedModeRef.current) {
      hasTrackedModeRef.current = true;
      return;
    }
    trackAnalyticsEvent('mov2mp4_mode_change', { mode: speedMode });
  }, [speedMode]);

  const setConsent = (nextState) => {
    if (typeof window === 'undefined') {
      return;
    }

    if (typeof window.setMov2Mp4Consent === 'function') {
      try {
        window.setMov2Mp4Consent(nextState);
      } catch (error) {
        // Fallback to local storage only.
        try {
          window.localStorage.setItem(CONSENT_STORAGE_KEY, nextState);
        } catch (storageError) {
          // Ignore storage access errors.
        }
      }
      setConsentState(loadConsentState());
      setAnalyticsRuntime(loadAnalyticsRuntime());
      trackAnalyticsEvent('mov2mp4_consent_change', { state: nextState });
      return;
    }

    try {
      window.localStorage.setItem(CONSENT_STORAGE_KEY, nextState);
    } catch (error) {
      // Ignore storage access errors.
    }
    setConsentState(nextState);
    setAnalyticsRuntime((current) => ({ ...current, consent: nextState }));
  };

  const ensureEngine = async () => {
    if (ffmpegRef.current) return ffmpegRef.current;
    if (engineStatus === 'loading') {
      throw new Error('Engine is still loading.');
    }

    setEngineStatus('loading');
    setEngineMessage('Loading converter engine...');

    try {
      const ffmpeg = await createFFmpeg(({ progress }) => {
        const id = activeItemIdRef.current;
        if (!id) return;

        const nextProgress = Math.max(0, Math.min(100, Math.round(progress * 100)));
        setQueue((prev) =>
          prev.map((item) =>
            item.id === id ? { ...item, progress: Math.max(item.progress, nextProgress) } : item
          )
        );
      });

      ffmpeg.on('log', ({ message, type }) => {
        if (!message || (type !== 'stderr' && type !== 'stdout')) return;
        ffmpegLogRef.current.push(message.trim());
        if (ffmpegLogRef.current.length > 60) {
          ffmpegLogRef.current = ffmpegLogRef.current.slice(-60);
        }
      });

      ffmpegRef.current = ffmpeg;
      setEngineStatus('ready');
      setEngineMessage('Engine ready.');
      return ffmpeg;
    } catch (error) {
      setEngineStatus('error');
      setEngineMessage('Failed to load converter engine.');
      throw error;
    }
  };

  const addFiles = (fileList) => {
    const picked = Array.from(fileList || []);
    if (!picked.length) return;

    const valid = picked.filter((file) => ACCEPT_PATTERN.test(file.name));
    const ignored = picked.length - valid.length;
    const totalBytes = valid.reduce((sum, file) => sum + file.size, 0);

    if (ignored > 0) {
      setNotice(`${ignored} file(s) skipped: only .MOV files are accepted.`);
    } else {
      setNotice('');
    }

    if (!valid.length) return;

    trackAnalyticsEvent('mov2mp4_files_added', {
      accepted_count: valid.length,
      ignored_count: ignored,
      total_input_mb: Math.round(totalBytes / (1024 * 1024))
    });

    setQueue((prev) => {
      const existing = new Set(prev.map((item) => `${item.file.name}:${item.file.size}`));
      const additions = valid
        .filter((file) => !existing.has(`${file.name}:${file.size}`))
        .map((file) => ({
          id: makeId(),
          file,
          status: 'queued',
          progress: 0,
          error: '',
          downloadUrl: '',
          outputName: safeDownloadName(file.name),
          methodUsed: ''
        }));
      return prev.concat(additions);
    });
  };

  const clearQueue = () => {
    const currentCount = queueRef.current.length;
    if (currentCount > 0) {
      trackAnalyticsEvent('mov2mp4_queue_clear', { item_count: currentCount });
    }
    setQueue((prev) => {
      prev.forEach((item) => {
        if (item.downloadUrl) URL.revokeObjectURL(item.downloadUrl);
      });
      return [];
    });
    setNotice('');
  };

  const removeItem = (id) => {
    const target = queueRef.current.find((item) => item.id === id);
    if (target) {
      trackAnalyticsEvent('mov2mp4_queue_remove', {
        item_status: target.status,
        file_size_mb: Math.round(target.file.size / (1024 * 1024))
      });
    }
    setQueue((prev) =>
      prev.filter((item) => {
        if (item.id === id && item.downloadUrl) URL.revokeObjectURL(item.downloadUrl);
        return item.id !== id;
      })
    );
  };

  const runConversionForItem = async (item) => {
    const ffmpeg = await ensureEngine();
    const startedAt = Date.now();
    ffmpegLogRef.current = [];
    const inputName = `input-${item.id}.mov`;
    const outputName = `output-${item.id}.mp4`;

    await ffmpeg.writeFile(inputName, await fetchFile(item.file));

    const logTail = () => {
      const lines = ffmpegLogRef.current.filter(Boolean);
      if (!lines.length) return '';
      return `Last ffmpeg logs: ${lines.slice(-6).join(' | ')}`;
    };

    const plans = buildConversionPlans(inputName, outputName, speedMode);

    try {
      const methodUsed = await tryCommands(ffmpeg, plans, logTail);
      const data = await ffmpeg.readFile(outputName);
      if (!(data instanceof Uint8Array) || data.byteLength === 0) {
        const tail = logTail();
        throw new Error(
          tail
            ? `Conversion finished but produced no output file. ${tail}`
            : 'Conversion finished but produced no output file.'
        );
      }
      const blob = new Blob([data.buffer], { type: 'video/mp4' });
      const downloadUrl = URL.createObjectURL(blob);
      const durationSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      const outputMb = Math.round(blob.size / (1024 * 1024));

      trackAnalyticsEvent('mov2mp4_conversion_success', {
        speed_mode: speedMode,
        method: methodUsed,
        input_mb: Math.round(item.file.size / (1024 * 1024)),
        output_mb: outputMb,
        duration_seconds: durationSeconds
      });

      setQueue((prev) =>
        prev.map((entry) =>
          entry.id === item.id
            ? {
                ...entry,
                status: 'done',
                progress: 100,
                error: '',
                downloadUrl,
                methodUsed
              }
            : entry
        )
      );
    } finally {
      try {
        await ffmpeg.deleteFile(inputName);
      } catch (error) {
        // ignore cleanup errors
      }
      try {
        await ffmpeg.deleteFile(outputName);
      } catch (error) {
        // ignore cleanup errors
      }
    }
  };

  const startConversion = async () => {
    const pendingIds = queueRef.current
      .filter((item) => item.status === 'queued' || item.status === 'error')
      .map((item) => item.id);

    if (!pendingIds.length || isBusy) return;

    trackAnalyticsEvent('mov2mp4_conversion_start', {
      queue_count: pendingIds.length,
      speed_mode: speedMode
    });

    setIsBusy(true);
    setNotice('');

    try {
      for (const id of pendingIds) {
        const item = queueRef.current.find((entry) => entry.id === id);
        if (!item) continue;

        activeItemIdRef.current = id;
        setQueue((prev) =>
          prev.map((entry) =>
            entry.id === id
              ? {
                  ...entry,
                  status: 'converting',
                  progress: Math.max(entry.progress, 1),
                  error: '',
                  methodUsed: ''
                }
              : entry
          )
        );

        try {
          await runConversionForItem(item);
        } catch (error) {
          const message = normalizeErrorMessage(error);
          trackAnalyticsEvent('mov2mp4_conversion_error', {
            speed_mode: speedMode,
            file_size_mb: Math.round(item.file.size / (1024 * 1024)),
            error_preview: String(message).slice(0, 140)
          });
          setQueue((prev) =>
            prev.map((entry) =>
              entry.id === id
                ? {
                    ...entry,
                    status: 'error',
                    error: message,
                    progress: 0
                  }
                : entry
            )
          );
        }
      }
    } finally {
      activeItemIdRef.current = null;
      setIsBusy(false);
    }
  };

  const triggerPicker = () => {
    if (inputRef.current) inputRef.current.click();
  };

  const handleDrop = (event) => {
    event.preventDefault();
    setIsDragging(false);
    addFiles(event.dataTransfer.files);
  };

  const statusLabel = (item) => {
    if (item.status === 'done') return 'Done';
    if (item.status === 'converting') return `Converting ${item.progress}%`;
    if (item.status === 'error') return 'Error';
    return 'Queued';
  };

  return (
    <div className="app-shell">
      <div className="background-orb background-orb-a" />
      <div className="background-orb background-orb-b" />

      <main className="page">
        <header className="hero">
          <p className="hero-tag">Paul Zuiderduin Tools</p>
          <h1>.MOV to .mp4, without the hassle</h1>
          <p className="hero-sub">
            Drop your files in, convert locally in your browser, and download instantly as MP4.
            No upload, no account.
          </p>
        </header>

        <section
          className={`dropzone ${isDragging ? 'is-dragging' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
        >
          <div>
            <strong>Drop .MOV files here</strong>
            <p>or choose files manually</p>
          </div>
          <div className="speed-mode">
            <span className="speed-label">Mode</span>
            <button
              type="button"
              className={`mode-pill ${speedMode === 'fastest' ? 'is-active' : ''}`}
              onClick={() => {
                setSpeedMode('fastest');
              }}
              disabled={isBusy}
            >
              Fastest
            </button>
            <button
              type="button"
              className={`mode-pill ${speedMode === 'balanced' ? 'is-active' : ''}`}
              onClick={() => {
                setSpeedMode('balanced');
              }}
              disabled={isBusy}
            >
              Balanced
            </button>
          </div>
          <p className="speed-note">
            Fastest first tries a direct stream copy (often much quicker), then falls back to fast
            re-encoding only if needed.
          </p>
          <div className="actions">
            <button type="button" onClick={triggerPicker} className="button button-secondary">
              Choose files
            </button>
            <button
              type="button"
              onClick={startConversion}
              className="button button-primary"
              disabled={isBusy || queuedCount === 0}
            >
              {isBusy ? 'Converting...' : 'Convert to MP4'}
            </button>
            <button
              type="button"
              onClick={clearQueue}
              className="button button-ghost"
              disabled={queue.length === 0 || isBusy}
            >
              Clear
            </button>
          </div>

          <input
            ref={inputRef}
            type="file"
            accept=".mov,video/quicktime"
            multiple
            onChange={(event) => addFiles(event.target.files)}
            hidden
          />
        </section>

        <section className="status-strip" aria-live="polite">
          <span>
            Engine:{' '}
            <strong>
              {engineStatus === 'idle' && 'Not loaded yet'}
              {engineStatus === 'loading' && 'Loading...'}
              {engineStatus === 'ready' && 'Ready'}
              {engineStatus === 'error' && 'Error'}
            </strong>
          </span>
          <span>Queue: {queuedCount}</span>
          <span>Done: {doneCount}</span>
          <span>Mode: {speedMode === 'fastest' ? 'Fastest' : 'Balanced'}</span>
        </section>

        {engineMessage ? <p className="hint">{engineMessage}</p> : null}
        {notice ? <p className="hint">{notice}</p> : null}

        {consentState === 'unknown' ? (
          <section className="consent-banner" role="region" aria-label="Analytics consent">
            <p>Allow optional analytics so we can improve conversion quality and reliability.</p>
            <div className="consent-actions">
              <button type="button" className="button button-primary" onClick={() => setConsent('granted')}>
                Allow analytics
              </button>
              <button type="button" className="button button-ghost" onClick={() => setConsent('denied')}>
                Decline
              </button>
            </div>
          </section>
        ) : null}

        <section className="queue">
          {queue.length === 0 ? (
            <article className="empty-card">
              <h2>No files yet</h2>
              <p>Add one or more .MOV files to get started.</p>
            </article>
          ) : (
            queue.map((item, index) => (
              <article className="queue-item" key={item.id} style={{ animationDelay: `${index * 40}ms` }}>
                <div className="queue-main">
                  <h3>{item.file.name}</h3>
                  <p>
                    {formatBytes(item.file.size)} · {statusLabel(item)}
                  </p>
                  <div className="progress">
                    <span style={{ width: `${item.progress}%` }} />
                  </div>
                  {item.methodUsed ? <p className="hint item-hint">{item.methodUsed}</p> : null}
                  {item.error ? <p className="error">{item.error}</p> : null}
                </div>
                <div className="queue-actions">
                  {item.downloadUrl ? (
                    <a
                      className="button button-primary"
                      href={item.downloadUrl}
                      download={item.outputName}
                      onClick={() => {
                        trackAnalyticsEvent('mov2mp4_download', {
                          speed_mode: speedMode,
                          method: item.methodUsed || 'unknown',
                          output_name: item.outputName
                        });
                      }}
                    >
                      Download MP4
                    </a>
                  ) : null}
                  <button
                    type="button"
                    className="button button-ghost"
                    disabled={isBusy && item.status === 'converting'}
                    onClick={() => removeItem(item.id)}
                  >
                    Remove
                  </button>
                </div>
              </article>
            ))
          )}
        </section>

        <footer className="footer-note">
          <p>
            Fastest mode can be dramatically quicker for compatible MOV files because it attempts
            direct stream copy before re-encoding.
          </p>
          <p>Tip: for larger videos, desktop with enough free RAM gives the best results.</p>
          <div className="privacy-controls">
            <span>Privacy:</span>
            <button
              type="button"
              className={`privacy-pill ${consentState === 'granted' ? 'is-active' : ''}`}
              onClick={() => setConsent('granted')}
            >
              Analytics on
            </button>
            <button
              type="button"
              className={`privacy-pill ${consentState === 'denied' ? 'is-active' : ''}`}
              onClick={() => setConsent('denied')}
            >
              Analytics off
            </button>
            <span className={`analytics-runtime ${analyticsStatus.level}`}>{analyticsStatus.message}</span>
          </div>
        </footer>
      </main>
    </div>
  );
}
