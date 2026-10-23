// When the frame goes back to Home (or back to resting at night) by itself.

export const IDLE_MS = 2 * 60_000;

/**
 * Should an untouched screen go Home now? Never while something she started is
 * still going (a video playing, a recording, a playback), and never from Home itself.
 */
export function shouldGoHome({ screen, lastTouch, now, busy }) {
  if (busy || screen === 'home') return false;
  return now - lastTouch >= IDLE_MS;
}

/** At night an awake Home goes back to resting after the same quiet time. */
export function shouldRest({ night, resting, screen, lastTouch, now, busy }) {
  return night && !resting && screen === 'home' && !busy && now - lastTouch >= IDLE_MS;
}

/** A waiting reload (new version, or Ben pressed Reload) happens only on Home, untouched. */
export function canReload({ screen, lastTouch, now, busy }) {
  return screen === 'home' && !busy && now - lastTouch >= IDLE_MS;
}
