import { useState, useRef, useEffect } from 'react';
import { fetchFile } from '@ffmpeg/util';
import { createFFmpeg, buildConversionPlans, tryCommands, normalizeErrorMessage, buildFriendlyErrorSummary } from '../utils/ffmpeg';
import { makeId, safeDownloadName, formatBytes } from '../utils/video';

export function useFFmpegQueue(speedMode) {
  const ffmpegRef = useRef(null);
  const ffmpegLogRef = useRef([]);
  const activeItemIdRef = useRef(null);
  const [queue, setQueue] = useState([]);
  const [isBusy, setIsBusy] = useState(false);
  const [engineStatus, setEngineStatus] = useState('idle');
  const [engineMessage, setEngineMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [activeFileName, setActiveFileName] = useState('');

  const queueRef = useRef(queue);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    return () => {
      queueRef.current.forEach((item) => {
        if (item.downloadUrl) URL.revokeObjectURL(item.downloadUrl);
      });
    };
  }, []);

  const ensureEngine = async () => {
    if (ffmpegRef.current) return ffmpegRef.current;
    if (engineStatus === 'loading') throw new Error('Engine is still loading.');

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
        if (ffmpegLogRef.current.length > 60) ffmpegLogRef.current = ffmpegLogRef.current.slice(-60);
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

  const addFiles = (fileList, ACCEPT_PATTERN) => {
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
      if (additions.length > 0) messages.push(`${additions.length} file${additions.length === 1 ? '' : 's'} added.`);
      if (invalidCount > 0) messages.push(`${invalidCount} skipped because only .MOV files are supported.`);
      if (duplicateCount > 0) messages.push(`${duplicateCount} already in the list.`);
      setNotice(messages.join(' '));

      return prev.concat(additions);
    });
  };

  const runConversionForItem = async (item, currentSpeedMode) => {
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

    const plans = buildConversionPlans(inputName, outputName, currentSpeedMode);

    try {
      const methodUsed = await tryCommands(ffmpeg, plans, logTail);
      const data = await ffmpeg.readFile(outputName);
      if (!(data instanceof Uint8Array) || data.byteLength === 0) {
        throw new Error(logTail() ? `No output. ${logTail()}` : 'No output produced.');
      }
      const blob = new Blob([data.buffer], { type: 'video/mp4' });
      const downloadUrl = URL.createObjectURL(blob);

      setQueue((prev) =>
        prev.map((entry) =>
          entry.id === item.id
            ? { ...entry, status: 'done', progress: 100, downloadUrl, methodUsed }
            : entry
        )
      );

      const durationSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      setNotice(`${item.file.name} finished in ~${durationSeconds}s.`);
    } finally {
      try { await ffmpeg.deleteFile(inputName); } catch (e) {}
      try { await ffmpeg.deleteFile(outputName); } catch (e) {}
    }
  };

  const startConversion = async (currentSpeedMode) => {
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
            entry.id === id ? { ...entry, status: 'converting', progress: Math.max(entry.progress, 1), error: '', errorDetails: '' } : entry
          )
        );

        try {
          await runConversionForItem(item, currentSpeedMode);
        } catch (error) {
          const details = normalizeErrorMessage(error);
          setQueue((prev) =>
            prev.map((entry) =>
              entry.id === id ? { ...entry, status: 'error', error: buildFriendlyErrorSummary(details, currentSpeedMode), errorDetails: details, progress: 0 } : entry
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

  const removeItem = (id) => {
    setQueue((prev) =>
      prev.filter((item) => {
        if (item.id === id && item.downloadUrl) URL.revokeObjectURL(item.downloadUrl);
        return item.id !== id;
      })
    );
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

  return {
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
  };
}
