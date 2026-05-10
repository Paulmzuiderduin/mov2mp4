import { FFmpeg } from '@ffmpeg/ffmpeg';

export const CORE_BASE = '/ffmpeg';
export const ACCEPT_PATTERN = /\.mov$/i;
export const LARGE_FILE_THRESHOLD_BYTES = 300 * 1024 * 1024;

export async function createFFmpeg(progressHandler) {
  const ffmpeg = new FFmpeg();
  ffmpeg.on('progress', progressHandler);
  await ffmpeg.load({
    coreURL: `${CORE_BASE}/ffmpeg-core.js`,
    wasmURL: `${CORE_BASE}/ffmpeg-core.wasm`
  });
  return ffmpeg;
}

export function normalizeErrorMessage(error) {
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

export function buildFriendlyErrorSummary(message, speedMode) {
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

export async function tryCommands(ffmpeg, commands, getLogTail) {
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

export function buildConversionPlans(inputName, outputName, speedMode) {
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

export function getOverviewStatus(engineStatus, isBusy, queueLength, queuedCount, doneCount, activeFileName) {
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
