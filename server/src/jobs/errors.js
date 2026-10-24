// Errors a job throws on purpose. `userMessage` is the kind sentence the owner
// sees on a failed upload; `permanent` skips the retries (trying again would
// fail the same way, e.g. a video that is too long).

export const DEFAULT_PHOTO_MESSAGE = "We couldn't open this photo. Please try sending it again, or send a different copy.";
export const DEFAULT_VIDEO_MESSAGE = "We couldn't get this video ready. Please try sending it again.";
export const DEFAULT_VOICE_MESSAGE = "We couldn't get this voice message ready.";

export class JobError extends Error {
  constructor(message, { userMessage = null, permanent = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'JobError';
    this.userMessage = userMessage;
    this.permanent = permanent;
  }
}

export function permanentError(message, userMessage) {
  return new JobError(message, { userMessage, permanent: true });
}

// "3 minutes", "1 minute 30 seconds", "45 seconds".
export function describeSeconds(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(s / 60);
  const seconds = s % 60;
  const part = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (!minutes) return part(seconds, 'second');
  return seconds ? `${part(minutes, 'minute')} ${part(seconds, 'second')}` : part(minutes, 'minute');
}

// errno codes that mean the media drive (or a file on it) went away, not that
// the photo or video is bad: a USB drive that dropped gives EIO, a remount
// ENOENT or ESTALE. These are retried, never turned into a permanent failure.
export const MEDIA_IO_CODES = Object.freeze(['EIO', 'ENOENT', 'ENXIO', 'ESTALE', 'ENODEV', 'ENOTCONN']);

export function mediaIoError(err) {
  return MEDIA_IO_CODES.includes(err?.code);
}
