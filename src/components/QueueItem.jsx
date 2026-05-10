import { formatBytes } from '../utils/video';

export default function QueueItem({ item, index, isBusy, onRemove }) {
  const statusLabel = (item) => {
    if (item.status === 'done') return 'Ready to download';
    if (item.status === 'converting') return `Converting ${item.progress}%`;
    if (item.status === 'error') return 'Needs another try';
    return 'Ready to convert';
  };

  return (
    <article className="queue-item" style={{ animationDelay: `${index * 40}ms` }}>
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
          onClick={() => onRemove(item.id)}
        >
          Remove
        </button>
      </div>
    </article>
  );
}
