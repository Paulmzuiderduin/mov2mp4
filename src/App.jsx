import { useEffect, useMemo, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

const CORE_BASE = '/ffmpeg';
const ACCEPT_PATTERN = /\.mov$/i;
const LARGE_FILE_THRESHOLD_BYTES = 300 * 1024 * 1024;

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
    // Ignore serialization failures.
  }
  return 'Unknown conversion error.';
}

function buildFriendlyErrorSummary(message, speedMode) {
  const lower = String(message || '').toLowerCase();

  if (lower.includes('failed to load converter engine') || lower.includes('failed to import ffmpeg-core')) {
    return 'The converter could not start in this browser. Refresh the page and try again.';
  }

  if (lower.includes('still loading')) {
    return 'The converter is still starting. Wait a moment and try again.';
  }

  if (lower.includes('produced no output')) {
    return 'This file could not be turned into a usable MP4 in the browser.';
  }

  if (lower.includes('memory') || lower.includes('out of bounds') || lower.includes('abort')) {
    return 'This file is likely too heavy for this browser session. Try a smaller file or use a desktop browser with more free memory.';
  }

  if (speedMode === 'fastest') {
    return 'This file could not be converted with the current settings. Try Balanced mode for a slower but more compatible export.';
  }

  return 'This file could not be converted in the browser. Try a shorter clip or another browser.';
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

function getOverviewStatus(engineStatus, isBusy, queueLength, queuedCount, doneCount, activeFileName) {
  if (engineStatus === 'loading') {
    return {
      title: 'Starting the converter',
      detail: 'This takes a few seconds the first time you use it.'
    };
  }

  if (engineStatus === 'error') {
    return {
      title: 'Converter not ready',
      detail: 'Refresh the page and try again. If it still fails, try another browser.'
    };
  }

  if (isBusy) {
    return {
      title: activeFileName ? `Converting ${activeFileName}` : 'Converting your file',
      detail: 'Keep this tab open until the MP4 download button appears.'
    };
  }

  if (queueLength === 0) {
    return {
      title: 'Add a .MOV file to begin',
      detail: 'Your video stays on your device. Nothing is uploaded.'
    };
  }

  if (queuedCount > 0) {
    return {
      title: `Ready to convert ${queuedCount} file${queuedCount === 1 ? '' : 's'}`,
      detail: doneCount > 0 ? `${doneCount} file${doneCount === 1 ? '' : 's'} already finished.` : 'Choose Convert to MP4 when you are ready.'
    };
  }

  return {
    title: 'Finished',
    detail: `${doneCount} file${doneCount === 1 ? '' : 's'} ready to download.`
  };
}

export default function App() {
  const ffmpegRef = useRef(null);
  const ffmpegLogRef = useRef([]);
  const activeItemIdRef = useRef(null);
  const inputRef = useRef(null);
  const queueRef = useRef([]);

  const [queue, setQueue] = useState([]);
  const [isBusy, setIsBusy] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [speedMode, setSpeedMode] = useState('fastest');
  const [engineStatus, setEngineStatus] = useState('idle');
  const [engineMessage, setEngineMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [activeFileName, setActiveFileName] = useState('');

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

  const largestFile = useMemo(() => {
    return queue.reduce((largest, item) => (item.file.size > largest.file.size ? item : largest), {
      file: { size: 0 }
    });
  }, [queue]);

  const overviewStatus = useMemo(
    () => getOverviewStatus(engineStatus, isBusy, queue.length, queuedCount, doneCount, activeFileName),
    [activeFileName, doneCount, engineStatus, isBusy, queue.length, queuedCount]
  );

  const modeDescription =
    speedMode === 'fastest'
      ? 'Recommended for most files. It tries the quickest route first and only re-encodes when needed.'
      : 'Use this if Fastest fails or if you want a slower, more compatibility-focused export.';

  const largeFileNote =
    largestFile.file.size >= LARGE_FILE_THRESHOLD_BYTES
      ? `Large file detected (${formatBytes(largestFile.file.size)}). Keep this tab open. Conversion can take several minutes in the browser.`
      : 'Works best for short to medium clips. Very large videos can take longer because conversion happens in your browser.';

  const ensureEngine = async () => {
    if (ffmpegRef.current) return ffmpegRef.current;
    if (engineStatus === 'loading') {
      throw new Error('Engine is still loading.');
    }

    setEngineStatus('loading');
    setEngineMessage('Loading the converter for the first time...');

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
      setEngineMessage('Converter ready.');
      return ffmpeg;
    } catch (error) {
      setEngineStatus('error');
      setEngineMessage('Could not load the converter in this browser.');
      throw error;
    }
  };

  const addFiles = (fileList) => {
    const picked = Array.from(fileList || []);
    if (!picked.length) return;

    const valid = picked.filter((file) => ACCEPT_PATTERN.test(file.name));
    const invalidCount = picked.length - valid.length;

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
          errorDetails: '',
          downloadUrl: '',
          outputName: safeDownloadName(file.name),
          methodUsed: ''
        }));

      const duplicateCount = valid.length - additions.length;
      const messages = [];
      if (additions.length > 0) {
        messages.push(`${additions.length} file${additions.length === 1 ? '' : 's'} added.`);
      }
      if (invalidCount > 0) {
        messages.push(`${invalidCount} skipped because only .MOV files are supported.`);
      }
      if (duplicateCount > 0) {
        messages.push(`${duplicateCount} already in the list.`);
      }
      setNotice(messages.join(' '));

      return prev.concat(additions);
    });
  };

  const clearQueue = () => {
    setQueue((prev) => {
      prev.forEach((item) => {
        if (item.downloadUrl) URL.revokeObjectURL(item.downloadUrl);
      });
      return [];
    });
    setActiveFileName('');
    setNotice('Queue cleared.');
  };

  const removeItem = (id) => {
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

      setQueue((prev) =>
        prev.map((entry) =>
          entry.id === item.id
            ? {
                ...entry,
                status: 'done',
                progress: 100,
                error: '',
                errorDetails: '',
                downloadUrl,
                methodUsed
              }
            : entry
        )
      );

      const durationSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      setNotice(
        `${item.file.name} finished in about ${durationSeconds} second${durationSeconds === 1 ? '' : 's'}.`
      );
    } finally {
      try {
        await ffmpeg.deleteFile(inputName);
      } catch (error) {
        // Ignore cleanup errors.
      }
      try {
        await ffmpeg.deleteFile(outputName);
      } catch (error) {
        // Ignore cleanup errors.
      }
    }
  };

  const startConversion = async () => {
    const pendingIds = queueRef.current
      .filter((item) => item.status === 'queued' || item.status === 'error')
      .map((item) => item.id);

    if (!pendingIds.length || isBusy) return;

    setIsBusy(true);
    setNotice('');

    try {
      for (const id of pendingIds) {
        const item = queueRef.current.find((entry) => entry.id === id);
        if (!item) continue;

        activeItemIdRef.current = id;
        setActiveFileName(item.file.name);
        setQueue((prev) =>
          prev.map((entry) =>
            entry.id === id
              ? {
                  ...entry,
                  status: 'converting',
                  progress: Math.max(entry.progress, 1),
                  error: '',
                  errorDetails: '',
                  methodUsed: ''
                }
              : entry
          )
        );

        try {
          await runConversionForItem(item);
        } catch (error) {
          const details = normalizeErrorMessage(error);
          setQueue((prev) =>
            prev.map((entry) =>
              entry.id === id
                ? {
                    ...entry,
                    status: 'error',
                    error: buildFriendlyErrorSummary(details, speedMode),
                    errorDetails: details,
                    progress: 0
                  }
                : entry
            )
          );
        }
      }
    } finally {
      activeItemIdRef.current = null;
      setActiveFileName('');
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
    if (item.status === 'done') return 'Ready to download';
    if (item.status === 'converting') return `Converting ${item.progress}%`;
    if (item.status === 'error') return 'Needs another try';
    return 'Ready to convert';
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
            Add your QuickTime video, convert it locally in your browser, and download an MP4.
            No upload, no account, no waiting for a server.
          </p>
        </header>

        <section className="top-layout">
          <div
            className={`converter-panel ${isDragging ? 'is-dragging' : ''}`}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
          >
            <div className="converter-panel-header">
              <p className="converter-kicker">Start Here</p>
              <h2 className="converter-title">Convert your .MOV to MP4</h2>
              <p className="converter-sub">
                Drag in your file or pick it manually. The conversion runs in this browser tab,
                then your MP4 is ready to download.
              </p>
            </div>

            <section className="dropzone">
              <div>
                <strong>Drop .MOV files here</strong>
                <p>or choose files manually</p>
              </div>

              <div className="speed-mode" aria-label="Conversion mode">
                <span className="speed-label">Mode</span>
                <button
                  type="button"
                  className={`mode-pill ${speedMode === 'fastest' ? 'is-active' : ''}`}
                  onClick={() => setSpeedMode('fastest')}
                  disabled={isBusy}
                >
                  Fastest (recommended)
                </button>
                <button
                  type="button"
                  className={`mode-pill ${speedMode === 'balanced' ? 'is-active' : ''}`}
                  onClick={() => setSpeedMode('balanced')}
                  disabled={isBusy}
                >
                  Balanced
                </button>
              </div>

              <p className="speed-note">{modeDescription}</p>

              <div className="actions">
                <button type="button" onClick={triggerPicker} className="button button-secondary">
                  Choose files
                </button>
                <button
                  type="button"
                  onClick={startConversion}
                  className="button button-primary primary-cta"
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

              <p className="action-hint">
                You can add multiple files before converting. The converter runs in this tab.
              </p>

              <div className="large-file-note" role="status" aria-live="polite">
                <strong>Before you start:</strong>
                <span>{largeFileNote}</span>
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
          </div>

          <section className="status-panel" aria-live="polite">
            <div>
              <p className="status-kicker">Status</p>
              <h2 className="status-title">{overviewStatus.title}</h2>
              <p className="status-detail">{overviewStatus.detail}</p>
            </div>
            <div className="status-metrics">
              <div className="status-metric">
                <span className="status-metric-label">Files waiting</span>
                <strong>{queuedCount}</strong>
              </div>
              <div className="status-metric">
                <span className="status-metric-label">Completed</span>
                <strong>{doneCount}</strong>
              </div>
              <div className="status-metric">
                <span className="status-metric-label">Converter</span>
                <strong>
                  {engineStatus === 'idle' && 'Not loaded yet'}
                  {engineStatus === 'loading' && 'Starting'}
                  {engineStatus === 'ready' && 'Ready'}
                  {engineStatus === 'error' && 'Unavailable'}
                </strong>
              </div>
            </div>
          </section>

          <section className="workflow" aria-label="How it works">
            <article className="workflow-step">
              <span className="workflow-number">1</span>
              <div>
                <strong>Add your .MOV</strong>
                <p>Drag and drop or choose files from your device.</p>
              </div>
            </article>
            <article className="workflow-step">
              <span className="workflow-number">2</span>
              <div>
                <strong>Convert locally</strong>
                <p>The conversion happens in this tab, so your video stays on your device.</p>
              </div>
            </article>
            <article className="workflow-step">
              <span className="workflow-number">3</span>
              <div>
                <strong>Download the MP4</strong>
                <p>When it finishes, a download button appears next to each file.</p>
              </div>
            </article>
          </section>
        </section>

        {engineMessage ? <p className="hint">{engineMessage}</p> : null}
        {notice ? <p className="hint">{notice}</p> : null}

        <section className="queue">
          {queue.length === 0 ? (
            <article className="empty-card">
              <h2>No files yet</h2>
              <p>Add one or more .MOV files to start the conversion.</p>
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
                  {item.methodUsed ? (
                    <p className="hint item-hint">Method used: {item.methodUsed}</p>
                  ) : null}
                  {item.error ? <p className="error">{item.error}</p> : null}
                  {item.errorDetails ? (
                    <details className="error-details">
                      <summary>Show technical details</summary>
                      <p>{item.errorDetails}</p>
                    </details>
                  ) : null}
                </div>
                <div className="queue-actions">
                  {item.downloadUrl ? (
                    <a className="button button-primary" href={item.downloadUrl} download={item.outputName}>
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
          <p>Runs locally in your browser, so your source file stays on your device.</p>
          <p>If a large file seems slow, keep the tab open and let the progress bar continue.</p>
        </footer>
      </main>
    </div>
  );
}
