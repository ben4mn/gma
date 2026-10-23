// The frame's clock. The Pi has no battery clock: after a power cut it boots on
// the time it last saved, hours behind if the outage was long, and only NTP or
// the server can put it right. So the frame trusts its clock only once it has
// one of those: the server's `now` from a fresh /api/frame/state (kept as an
// offset), or a jump of the system clock while the page runs (NTP stepping it).
// Until then it shows no time and keeps the mode it last knew, rather than
// a confidently wrong big clock or a night that starts at 2 pm.

export const CLOCK_STEP_MS = 2 * 60_000; // a jump this big is NTP setting the clock, not drift

export function createFrameClock({
  wall = () => Date.now(),
  mono = () => performance.now(),
  stepMs = CLOCK_STEP_MS,
} = {}) {
  let offset = 0;          // server time − this machine's time
  let trusted = false;
  let base = wall() - mono(); // moves only when someone sets the system clock

  return {
    /** The best time we have (trusted or not). */
    now: () => wall() + offset,
    get trusted() { return trusted; },
    get offset() { return offset; },

    /** A fresh server time: from now on the clock is right. */
    sync(serverNow) {
      if (!Number.isFinite(serverNow)) return;
      offset = serverNow - wall();
      trusted = true;
      base = wall() - mono();
    },

    /** Fixtures and tests: a set offset that counts as trusted. */
    pin(newOffset) {
      offset = newOffset;
      trusted = true;
    },

    /**
     * Notice the system clock being set. Before a sync this is NTP putting the
     * Pi right, so the clock becomes trusted; after one, the offset is moved by
     * the same amount so the time on screen doesn't jump. True when it jumped.
     */
    check() {
      const nowBase = wall() - mono();
      const step = nowBase - base;
      if (Math.abs(step) < stepMs) return false;
      base = nowBase;
      if (trusted) offset -= step;
      else { offset = 0; trusted = true; }
      return true;
    },
  };
}

/** Night now, or the mode we last knew while the clock can't be trusted. */
export function nightMode({ trusted, night, lastKnown }) {
  return trusted ? night : Boolean(lastKnown);
}
