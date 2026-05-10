import { useRef } from 'react';

export default function ConverterPanel({ 
  isDragging, 
  setIsDragging, 
  handleDrop, 
  speedMode, 
  setSpeedMode, 
  isBusy, 
  queuedCount, 
  hasItems,
  onAddFiles, 
  onStartConversion, 
  onClearQueue,
  onDownloadAll,
  doneCount,
  modeDescription,
  largeFileNote
}) {
  const inputRef = useRef(null);

  const triggerPicker = () => {
    if (inputRef.current) inputRef.current.click();
  };

  return (
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
          Add a .MOV file. Conversion runs in this tab, then your MP4 is ready to download.
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
          <button
            type="button"
            onClick={triggerPicker}
            className="button button-secondary choose-cta"
          >
            Choose files
          </button>
          <button
            type="button"
            onClick={onStartConversion}
            className="button button-primary primary-cta"
            disabled={isBusy || queuedCount === 0}
          >
            {isBusy ? 'Converting...' : 'Convert to MP4'}
          </button>
          {doneCount > 1 && (
            <button
              type="button"
              onClick={onDownloadAll}
              className="button button-accent"
            >
              Download All (ZIP)
            </button>
          )}
          <button
            type="button"
            onClick={onClearQueue}
            className="button button-ghost"
            disabled={!hasItems || isBusy}
          >
            Clear
          </button>
        </div>

        <div className="large-file-note" role="status" aria-live="polite">
          <strong>Before you start:</strong>
          <span>{largeFileNote}</span>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept=".mov,video/quicktime"
          multiple
          onChange={(event) => onAddFiles(event.target.files)}
          hidden
        />
      </section>
    </div>
  );
}
