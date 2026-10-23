// Sends one file with tus in 32 MB chunks (Cloudflare caps a request at 100 MB)
// and resumes an interrupted upload of the same file from where it stopped.
import { Upload } from '../vendor/tus-js-client/tus.js';

export const CHUNK_SIZE = 32 * 1024 * 1024;

const TYPES = { heic: 'image/heic', heif: 'image/heif', mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/x-m4v', '3gp': 'video/3gpp', webm: 'video/webm', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif' };

function typeOf(file) {
  return file.type || TYPES[file.name.split('.').pop()?.toLowerCase()] || 'application/octet-stream';
}

function readableError(err) {
  const status = err?.originalResponse?.getStatus?.();
  const body = err?.originalResponse?.getBody?.();
  try {
    const message = JSON.parse(body)?.error?.message;
    if (message) return message;
  } catch { /* not JSON */ }
  if (status === 413) return 'That file is too big to send.';
  if (status === 401) return 'You’ve been signed out. Sign in again, then send it again.';
  if (status >= 400 && status < 500) return 'The family app couldn’t accept this file.';
  return 'It stopped partway. Tap Try again and it will carry on.';
}

export function sendFile(file, { caption = '', batchId, onProgress, onSuccess, onError }) {
  const upload = new Upload(file, {
    endpoint: '/api/uploads/',
    chunkSize: CHUNK_SIZE,
    retryDelays: [0, 2000, 5000, 10000, 20000, 30000],
    storeFingerprintForResuming: true,
    removeFingerprintOnSuccess: true,
    metadata: { filename: file.name, filetype: typeOf(file), caption, batch_id: batchId },
    onProgress: (sent, total) => onProgress?.(sent, total),
    onSuccess: () => onSuccess?.(),
    onError: (err) => onError?.(readableError(err)),
    onShouldRetry: (err) => {
      const status = err?.originalResponse?.getStatus?.() ?? 0;
      return !(status >= 400 && status < 500) || status === 409 || status === 423 || status === 429;
    },
  });
  upload.findPreviousUploads()
    .then((previous) => { if (previous.length) upload.resumeFromPreviousUpload(previous[0]); })
    .catch(() => {})
    .finally(() => upload.start());
  return { abort: () => upload.abort() };
}

export function newBatchId() {
  return crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
