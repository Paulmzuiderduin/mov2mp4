import { useEffect, useMemo, useState } from 'react';
import JSZip from 'jszip';
import { useFFmpegQueue } from './hooks/useFFmpegQueue';
import { ACCEPT_PATTERN, LARGE_FILE_THRESHOLD_BYTES, getOverviewStatus } from './utils/ffmpeg';
import { formatBytes } from './utils/video';

import Hero from './components/Hero';
import StatusPanel from './components/StatusPanel';
import ConverterPanel from './components/ConverterPanel';
import QueueItem from './components/QueueItem';
import SecuritySection from './components/SecuritySection';

export default function App() {
  const [speedMode, setSpeedMode] = useState('fastest');
  const [isDragging, setIsDragging] = useState(false);
  const [theme, setTheme] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('theme') || 'auto';
    }
    return 'auto';
  });

  const {
    queue,
    isBusy,
    engineStatus,
    engineMessage,
    notice,
    activeFileName,
    addFiles,
    startConversion,
    removeItem,
    clearQueue,
    setNotice
  } = useFFmpegQueue(speedMode);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'auto') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', theme);
    }
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  const doneCount = useMemo(() => queue.filter((item) => item.status === 'done').length, [queue]);
  const queuedCount = useMemo(() => queue.filter((item) => item.status === 'queued' || item.status === 'error').length, [queue]);

  const largestFile = useMemo(() => {
    return queue.reduce((largest, item) => (item.file.size > largest.file.size ? item : largest), {
      file: { size: 0 }
    });
  }, [queue]);

  const overviewStatus = useMemo(
    () => getOverviewStatus(engineStatus, isBusy, queue.length, queuedCount, doneCount, activeFileName),
    [activeFileName, doneCount, engineStatus, isBusy, queue.length, queuedCount]
  );

  const handleDownloadAll = async () => {
    const finishedItems = queue.filter(item => item.status === 'done' && item.downloadUrl);
    if (finishedItems.length === 0) return;

    setNotice('Creating ZIP archive...');
    const zip = new JSZip();

    try {
      await Promise.all(finishedItems.map(async (item) => {
        const response = await fetch(item.downloadUrl);
        const blob = await response.blob();
        zip.file(item.outputName, blob);
      }));

      const content = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(content);
      const link = document.createElement('a');
      link.href = url;
      link.download = `converted-videos-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      setNotice(`ZIP archive created with ${finishedItems.length} files.`);
    } catch (error) {
      setNotice('Failed to create ZIP archive.');
    }
  };

  const modeDescription = speedMode === 'fastest'
    ? 'Recommended for most files. It tries the quickest route first and only re-encodes when needed.'
    : 'Use this if Fastest fails or if you want a slower, more compatibility-focused export.';

  const largeFileNote = largestFile.file.size >= LARGE_FILE_THRESHOLD_BYTES
    ? `Large file detected (${formatBytes(largestFile.file.size)}). Conversion may take longer in this tab.`
    : 'Large videos can take longer because conversion happens in your browser.';

  return (
    <div className="app-shell">
      <div className="background-orb background-orb-a" />
      <div className="background-orb background-orb-b" />

      <button 
        className="theme-toggle" 
        onClick={toggleTheme} 
        aria-label="Toggle dark mode"
      >
        {theme === 'dark' ? '☀️' : '🌙'}
      </button>

      <main className="page">
        <Hero />

        <section className="top-layout">
          <ConverterPanel 
            isDragging={isDragging}
            setIsDragging={setIsDragging}
            handleDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              addFiles(e.dataTransfer.files, ACCEPT_PATTERN);
            }}
            speedMode={speedMode}
            setSpeedMode={setSpeedMode}
            isBusy={isBusy}
            queuedCount={queuedCount}
            hasItems={queue.length > 0}
            onAddFiles={(files) => addFiles(files, ACCEPT_PATTERN)}
            onStartConversion={() => startConversion(speedMode)}
            onClearQueue={clearQueue}
            onDownloadAll={handleDownloadAll}
            doneCount={doneCount}
            modeDescription={modeDescription}
            largeFileNote={largeFileNote}
          />

          <StatusPanel 
            {...overviewStatus}
            queuedCount={queuedCount}
            doneCount={doneCount}
            engineStatus={engineStatus}
          />
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
              <QueueItem 
                key={item.id}
                item={item}
                index={index}
                isBusy={isBusy}
                onRemove={removeItem}
              />
            ))
          )}
        </section>

        <SecuritySection />
      </main>
    </div>
  );
}
