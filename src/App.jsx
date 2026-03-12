import { useEffect, useMemo, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

const CORE_BASE = '/ffmpeg';

const ACCEPT_PATTERN = /\.mov$/i;

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
  const [coreURL, wasmURL] = await Promise.all([
    toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
    toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm')
  ]);
  await ffmpeg.load({ coreURL, wasmURL });
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
      const code = await ffmpeg.exec(command);
      if (code !== 0) {
        const tail = getLogTail();
        throw new Error(
          tail ? `FFmpeg exited with code ${code}. ${tail}` : `FFmpeg exited with code ${code}.`
        );
      }
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Conversion failed.');
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

    if (ignored > 0) {
      setNotice(`${ignored} file(s) skipped: only .MOV files are accepted.`);
    } else {
      setNotice('');
    }

    if (!valid.length) return;

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
          outputName: safeDownloadName(file.name)
        }));
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
    setNotice('');
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
    ffmpegLogRef.current = [];
    const inputName = `input-${item.id}.mov`;
    const outputName = `output-${item.id}.mp4`;

    await ffmpeg.writeFile(inputName, await fetchFile(item.file));

    const logTail = () => {
      const lines = ffmpegLogRef.current.filter(Boolean);
      if (!lines.length) return '';
      return `Last ffmpeg logs: ${lines.slice(-6).join(' | ')}`;
    };

    const primary = [
      '-i',
      inputName,
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
    ];

    const fallbackMpeg4 = [
      '-i',
      inputName,
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
    ];

    const fallbackNoAudio = [
      '-i',
      inputName,
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '22',
      '-movflags',
      '+faststart',
      outputName
    ];

    const fallbackDefault = [
      '-i',
      inputName,
      '-movflags',
      '+faststart',
      outputName
    ];

    try {
      await tryCommands(ffmpeg, [primary, fallbackMpeg4, fallbackNoAudio, fallbackDefault], logTail);
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
                downloadUrl
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
                  error: ''
                }
              : entry
          )
        );

        try {
          await runConversionForItem(item);
        } catch (error) {
          const message = normalizeErrorMessage(error);
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
        </section>

        {engineMessage ? <p className="hint">{engineMessage}</p> : null}
        {notice ? <p className="hint">{notice}</p> : null}

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
                  {item.error ? <p className="error">{item.error}</p> : null}
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
          <p>
            This app tries H.264/AAC first for maximum compatibility, then falls back to a
            secondary codec profile if needed.
          </p>
          <p>Tip: for larger videos, desktop with enough free RAM gives the best results.</p>
        </footer>
      </main>
    </div>
  );
}
