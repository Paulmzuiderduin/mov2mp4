export default function StatusPanel({ title, detail, queuedCount, doneCount, engineStatus }) {
  return (
    <section className="status-panel" aria-live="polite">
      <div>
        <p className="status-kicker">Status</p>
        <h2 className="status-title">{title}</h2>
        <p className="status-detail">{detail}</p>
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
  );
}
