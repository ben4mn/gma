// The voice recorder: one take of at most MAX_MS, stopped by a tap or by itself.
// The microphone is released as soon as a take ends.

export const MAX_MS = 60_000;

/** The best format this browser records in; '' lets MediaRecorder choose. */
export function pickMimeType(isTypeSupported) {
  const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return options.find((t) => { try { return isTypeSupported(t); } catch { return false; } }) ?? '';
}

export function fileNameFor(mimeType) {
  if (mimeType.includes('mp4')) return 'voice.m4a';
  if (mimeType.includes('ogg')) return 'voice.ogg';
  return 'voice.webm';
}

export function createRecorder({ maxMs = MAX_MS, onTick, onDone }) {
  let stream = null;
  let rec = null;
  let chunks = [];
  let startedAt = 0;
  let ticker = null;
  let cancelled = false;

  function release() {
    clearInterval(ticker);
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  async function start() {
    cancelled = false;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t));
    rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    chunks = [];
    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    rec.onstop = () => {
      const durationMs = Math.min(Date.now() - startedAt, maxMs);
      release();
      if (cancelled) return;
      const type = rec.mimeType || mimeType || 'audio/webm';
      onDone?.({ blob: new Blob(chunks, { type }), durationMs, filename: fileNameFor(type) });
    };
    rec.start(1000);
    startedAt = Date.now();
    onTick?.(maxMs);
    ticker = setInterval(() => {
      const left = maxMs - (Date.now() - startedAt);
      onTick?.(Math.max(0, left));
      if (left <= 0) stop();
    }, 250);
  }

  function stop() {
    clearInterval(ticker);
    if (rec && rec.state !== 'inactive') rec.stop();
    else release();
  }

  /** Stop and throw the take away (leaving the screen mid-recording). */
  function cancel() {
    cancelled = true;
    stop();
  }

  return { start, stop, cancel, get recording() { return rec?.state === 'recording'; } };
}
