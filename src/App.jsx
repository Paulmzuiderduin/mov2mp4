import { useEffect, useMemo, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

const CORE_BASE = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';

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

  const [coreURL, wasmURL, workerURL] = await Promise.all([
    toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
    toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
    toBlobURL(`${CORE_BASE}/ffmpeg-core.worker.js`, 'text/javascript')
  ]);

  await ffmpeg.load({ coreURL, wasmURL, workerURL });
  return ffmpeg;
}

async function tryCommands(ffmpeg, commands) {
  let lastError = null;
  for (const command of commands) {
    try {
      await ffmpeg.exec(command);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Conversion failed.');
}

export default function App() {
  const ffmpegRef = useRef(null);
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
    setEngineMessage('Converter engine laden...');

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

      ffmpegRef.current = ffmpeg;
      setEngineStatus('ready');
      setEngineMessage('Engine klaar.');
      return ffmpeg;
    } catch (error) {
      setEngineStatus('error');
      setEngineMessage('Laden van converter engine mislukt.');
      throw error;
    }
  };

  const addFiles = (fileList) => {
    const picked = Array.from(fileList || []);
    if (!picked.length) return;

    const valid = picked.filter((file) => ACCEPT_PATTERN.test(file.name));
    const ignored = picked.length - valid.length;

    if (ignored > 0) {
      setNotice(`${ignored} bestand(en) overgeslagen: alleen .MOV wordt toegevoegd.`);
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
    const inputName = `input-${item.id}.mov`;
    const outputName = `output-${item.id}.mp4`;

    await ffmpeg.writeFile(inputName, await fetchFile(item.file));

    const primary = [
      '-i',
      inputName,
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '22',
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      '-movflags',
      '+faststart',
      outputName
    ];

    const fallback = [
      '-i',
      inputName,
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-c:v',
      'mpeg4',
      '-q:v',
      '4',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      outputName
    ];

    try {
      await tryCommands(ffmpeg, [primary, fallback]);
      const data = await ffmpeg.readFile(outputName);
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
          const message =
            error instanceof Error ? error.message : 'Onbekende fout tijdens converteren.';
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
    if (item.status === 'done') return 'Klaar';
    if (item.status === 'converting') return `Converteren ${item.progress}%`;
    if (item.status === 'error') return 'Fout';
    return 'In wachtrij';
  };

  return (
    <div className="app-shell">
      <div className="background-orb background-orb-a" />
      <div className="background-orb background-orb-b" />

      <main className="page">
        <header className="hero">
          <p className="hero-tag">Paul Zuiderduin tools</p>
          <h1>.MOV naar .mp4 zonder gedoe</h1>
          <p className="hero-sub">
            Sleep je bestanden erin, converteer lokaal in je browser en download direct als mp4.
            Geen upload, geen account.
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
            <strong>Sleep .MOV bestanden hierheen</strong>
            <p>of kies bestanden handmatig</p>
          </div>
          <div className="actions">
            <button type="button" onClick={triggerPicker} className="button button-secondary">
              Kies bestanden
            </button>
            <button
              type="button"
              onClick={startConversion}
              className="button button-primary"
              disabled={isBusy || queuedCount === 0}
            >
              {isBusy ? 'Converteren...' : 'Converteer naar mp4'}
            </button>
            <button
              type="button"
              onClick={clearQueue}
              className="button button-ghost"
              disabled={queue.length === 0 || isBusy}
            >
              Leegmaken
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
              {engineStatus === 'idle' && 'Nog niet geladen'}
              {engineStatus === 'loading' && 'Laden...'}
              {engineStatus === 'ready' && 'Klaar'}
              {engineStatus === 'error' && 'Fout'}
            </strong>
          </span>
          <span>Wachtrij: {queuedCount}</span>
          <span>Klaar: {doneCount}</span>
        </section>

        {engineMessage ? <p className="hint">{engineMessage}</p> : null}
        {notice ? <p className="hint">{notice}</p> : null}

        <section className="queue">
          {queue.length === 0 ? (
            <article className="empty-card">
              <h2>Nog geen bestanden</h2>
              <p>Voeg een of meer .MOV bestanden toe om te starten.</p>
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
                      Download mp4
                    </a>
                  ) : null}
                  <button
                    type="button"
                    className="button button-ghost"
                    disabled={isBusy && item.status === 'converting'}
                    onClick={() => removeItem(item.id)}
                  >
                    Verwijder
                  </button>
                </div>
              </article>
            ))
          )}
        </section>

        <footer className="footer-note">
          <p>
            Deze app probeert eerst H.264/AAC voor maximale compatibiliteit en valt terug op een
            tweede codec-profiel als dat nodig is.
          </p>
          <p>Tip: bij grote videobestanden werkt dit het best op desktop met voldoende vrije RAM.</p>
        </footer>
      </main>
    </div>
  );
}

