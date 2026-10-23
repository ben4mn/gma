// "Message to the whole family": record (a big red button), a visible countdown
// from 60 s that stops itself, hear it back, then "Send to everyone". The screen
// says plainly, at every step, that the whole family will hear it.
import { h, photo, icon } from '../lib/dom.js';
import { createRecorder, MAX_MS } from '../lib/recorder.js';
import { formatCountdown } from '../lib/time.js';
import { SENT_MS } from './item.js';

// Taps this soon after a voice screen changes are ignored: the second tap of a
// double tap (or a tap aimed at Stop just as the 60 s ran out) must not land on
// whatever the next screen put under her finger.
export const SETTLE_MS = 700;

export function renderVoice(ctx, params = {}) {
  const root = h('main', { class: 'screen-voice' });
  let take = null;        // {blob, durationMs, filename}; kept until a new take replaces it
  let player = null;      // the <audio> made for one playback
  let playerUrl = null;
  let sentTimer = null;
  let recorder = null;    // the one recorder; a stray one's result is ignored
  let starting = false;   // asking for the microphone: further taps wait
  let gone = false;       // the screen was left
  let shownAt = 0;

  // A click handler that ignores taps while the screen is still settling.
  const settled = (fn) => (event) => {
    if (Date.now() - shownAt < SETTLE_MS) return;
    fn(event);
  };

  const familyPrint = () => h('figure', { class: 'print voice-print' },
    ctx.state.familyPhoto ? photo(ctx.state.familyPhoto) : h('div', { class: 'voice-print-empty' }, icon('family')));

  const everyone = () => h('p', { class: 'voice-everyone' }, icon('family'),
    h('span', {}, 'The ', h('b', {}, 'whole family'), ' will hear it.'));

  function layout(...right) {
    return h('div', { class: 'voice-layout' }, familyPrint(), h('div', { class: 'voice-side' },
      h('h1', { class: 'voice-title' }, 'A message for the whole family'),
      everyone(),
      ...right));
  }

  function stopPlayback() {
    if (player) { player.pause(); player.removeAttribute('src'); player.load(); player = null; }
    if (playerUrl) { URL.revokeObjectURL(playerUrl); playerUrl = null; }
    ctx.setBusy(false);
  }

  function readyScreen(note) {
    // After "Record again" her last message is still here until a new one is made.
    const keep = take && h('button', { class: 'again-btn keep-btn', type: 'button', onClick: settled(() => show(recordedScreen())) },
      icon('back'), 'Keep my last message');
    return layout(
      h('p', { class: 'voice-help' }, note ?? (take
        ? 'Your last message is still here. Tap the red button to record a new one.'
        : 'Tap the red button and speak. Tap it again when you’re done.')),
      h('div', { class: 'voice-controls' },
        h('button', { class: 'rec-btn', type: 'button', onClick: settled(startRecording) },
          h('span', { class: 'rec-disc' }, icon('mic')), 'Tap to record'),
        keep));
  }

  function recordingScreen() {
    const count = h('span', { class: 'countdown-time' }, formatCountdown(MAX_MS));
    const bar = h('span', { class: 'countdown-bar' });
    const el = layout(
      h('p', { class: 'voice-help' }, 'I’m listening. Tap the button when you’re done.'),
      h('div', { class: 'voice-controls' },
        h('button', { class: 'rec-btn is-recording', type: 'button', onClick: settled(() => recorder?.stop()) },
          h('span', { class: 'rec-disc' }, icon('stop')), 'Stop'),
        h('div', { class: 'countdown', role: 'timer', 'aria-live': 'off' },
          count, h('span', { class: 'countdown-label' }, 'left'),
          h('span', { class: 'countdown-track' }, bar))));
    el.update = (leftMs) => {
      count.textContent = formatCountdown(leftMs);
      bar.style.transform = `scaleX(${leftMs / MAX_MS})`;
    };
    return el;
  }

  function recordedScreen() {
    const listen = h('button', { class: 'listen-btn', type: 'button' }, icon('play'), 'Hear it');
    listen.addEventListener('click', settled(() => {
      if (player) { stopPlayback(); listen.replaceChildren(icon('play'), 'Hear it'); return; }
      playerUrl = URL.createObjectURL(take.blob);
      player = new Audio(playerUrl);
      player.addEventListener('ended', () => { stopPlayback(); listen.replaceChildren(icon('play'), 'Hear it'); });
      ctx.setBusy(true);
      listen.replaceChildren(icon('stop'), 'Stop');
      player.play().catch(() => { stopPlayback(); listen.replaceChildren(icon('play'), 'Hear it'); });
    }));
    return layout(
      h('p', { class: 'voice-help' }, `Your message is ${Math.max(1, Math.round(take.durationMs / 1000))} seconds long. Hear it, then send it.`),
      h('div', { class: 'voice-controls voice-controls--recorded' },
        listen,
        h('button', { class: 'send-all-btn', type: 'button', onClick: settled(send) }, 'Send to everyone'),
        // kept clear of where Stop was (see .again-btn), and it throws nothing away
        h('button', { class: 'again-btn', type: 'button', onClick: settled(() => { stopPlayback(); show(readyScreen()); }) },
          icon('again'), 'Record again')));
  }

  function sentScreen() {
    sentTimer = setTimeout(() => ctx.home(), SENT_MS);
    return h('div', { class: 'sent sent--voice', role: 'status', 'aria-live': 'polite' },
      familyPrint(),
      h('div', { class: 'sent-words' },
        h('p', { class: 'sent-check' }, icon('check'), 'Done'),
        h('p', { class: 'sent-title' }, 'Sent to everyone'),
        h('p', { class: 'sent-sub' }, 'The whole family will hear your voice.'),
        h('button', { class: 'ok-btn', type: 'button', onClick: () => ctx.home() }, 'OK')));
  }

  async function startRecording(event) {
    // One recorder at a time: a double tap must not open the microphone twice.
    if (starting || recorder) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      show(readyScreen('The microphone isn’t answering right now. Please try again a little later.'));
      return;
    }
    starting = true;
    if (event?.currentTarget) event.currentTarget.disabled = true;
    const screen = recordingScreen();
    const rec = createRecorder({
      onTick: (left) => { if (recorder === rec) screen.update(left); },
      onDone: (result) => {
        if (recorder !== rec || gone) return; // a recorder that was replaced or left behind
        recorder = null;
        ctx.setBusy(false);
        take = result;
        show(recordedScreen());
      },
    });
    recorder = rec;
    try {
      ctx.setBusy(true);
      await rec.start();
      if (recorder !== rec || gone) { rec.cancel(); return; }
      show(screen);
    } catch {
      if (recorder !== rec || gone) return;
      ctx.setBusy(false);
      recorder = null;
      show(readyScreen('The microphone isn’t answering right now. Please try again a little later.'));
    } finally {
      starting = false;
    }
  }

  function send() {
    stopPlayback();
    ctx.send('voice', { audio: take.blob, filename: take.filename, duration_ms: take.durationMs });
    take = null;
    show(sentScreen());
  }

  function show(el) {
    shownAt = Date.now();
    root.replaceChildren(el);
  }

  if (params.view === 'recording') { const s = recordingScreen(); s.update(42_400); show(s); }
  else if (params.view === 'sent') show(sentScreen());
  else show(readyScreen());

  return {
    el: root,
    destroy() {
      gone = true;
      clearTimeout(sentTimer);
      const rec = recorder;
      recorder = null;
      rec?.cancel();
      stopPlayback();
    },
  };
}
