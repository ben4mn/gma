// Admin (Ben): people and invites, uploads, the frame, preset messages and
// night hours. Each section is its own path under /admin.
import { h, mount, confirmButton } from '../../shared/dom.js';
import { icon } from '../../shared/icons.js';
import { api } from '../../shared/api.js';
import { agoLabel, whenLabel } from '../../shared/time.js';
import { renditionUrl, ownerOf } from '../data.js';
import { pageHead, errorNote } from './shell.js';

const SECTIONS = [
  { slug: 'people', label: 'People' },
  { slug: 'uploads', label: 'Uploads' },
  { slug: 'frame', label: 'The frame' },
  { slug: 'messages', label: 'Messages' },
  { slug: 'night', label: 'Night hours' },
];

const listOf = (res, ...keys) => (Array.isArray(res) ? res : keys.map((k) => res?.[k]).find(Array.isArray) ?? []);

/** A link shown once, with Copy and (where the phone can) Share. */
function onceLink(url, { title, note }) {
  const status = h('p', { class: 'body-text', role: 'status' });
  return h('div', { class: 'note note--ok' },
    h('p', { class: 'note-title' }, title),
    note ? h('p', null, note) : null,
    h('p', { class: 'once-link' }, url),
    h('div', { class: 'row' },
      h('button', {
        type: 'button', class: 'btn btn--secondary',
        onclick: async () => {
          try { await navigator.clipboard.writeText(url); status.textContent = 'Copied.'; } catch { status.textContent = 'Press and hold the link to copy it.'; }
        },
      }, icon('copy'), 'Copy link'),
      navigator.share ? h('button', {
        type: 'button', class: 'btn btn--secondary',
        onclick: () => navigator.share({ title: 'Grandma’s family', text: 'Here’s your invite to Grandma’s family photos.', url }).catch(() => {}),
      }, icon('share'), 'Share') : null),
    status);
}

function row(main, meta, actions, thumb) {
  return h('div', { class: 'card-row' }, thumb ?? null,
    h('div', { class: 'card-main' }, h('p', { class: 'card-name' }, main), meta ? h('p', { class: 'card-meta' }, meta) : null),
    actions ? h('div', { class: 'row' }, actions) : null);
}

function section(slot, loader) {
  const reload = async () => {
    try { await loader(reload); } catch (err) { mount(slot, errorNote(err.message, reload)); }
  };
  mount(slot, h('p', { class: 'quiet-line' }, 'Loading…'));
  reload();
}

// Must match the server's limit (server/src/lib/people.js).
const MAX_SHORT_NAME = 30;

/** What Grandma's frame calls someone ("Mike", "Grandpa Joe"); it defaults to the first word of their name. */
export function grandmaNameOf(person) {
  const chosen = typeof person?.short_name === 'string' ? person.short_name.trim() : '';
  return chosen || (typeof person?.name === 'string' ? person.name.trim().split(/\s+/)[0] : '') || '';
}

/** "Grandma calls them Mike · Change", which opens a one-line form. Saves with PATCH /api/admin/people/:id. */
function grandmaName(person) {
  const wrap = h('div', { class: 'grandma-name' });
  const fieldId = `short-${person.id}`;
  let current = grandmaNameOf(person);
  let saved = '';

  const showLine = () => mount(wrap,
    h('p', { class: 'card-meta' }, 'Grandma calls them ', h('b', null, current || 'nothing yet'), saved ? ` · ${saved}` : null),
    h('button', { type: 'button', class: 'btn btn--quiet', 'aria-label': `Change what Grandma calls ${person.name}`, onclick: showForm }, 'Change'));

  function showForm() {
    const input = h('input', { class: 'input', id: fieldId, value: current, maxlength: String(MAX_SHORT_NAME), autocomplete: 'off', autocapitalize: 'words', enterkeyhint: 'done' });
    const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
    const save = h('button', { type: 'submit', class: 'btn btn--sage' }, 'Save');
    const form = h('form', { class: 'grandma-name-form', novalidate: true },
      h('div', { class: 'field' },
        h('label', { for: fieldId }, 'What Grandma calls them'),
        h('small', null, `Shown on her frame: “3 photos from ${current || 'Mike'}”.`),
        input),
      error,
      h('div', { class: 'row' }, save, h('button', { type: 'button', class: 'btn btn--quiet', onclick: () => { saved = ''; showLine(); } }, 'Cancel')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const value = input.value.trim().replace(/\s+/g, ' ');
      error.hidden = true;
      if (!value) { error.textContent = 'Add the name Grandma knows them by.'; error.hidden = false; return; }
      save.disabled = true;
      try {
        const res = await api.patch(`/api/admin/people/${encodeURIComponent(person.id)}`, { short_name: value });
        const stored = (res?.user ?? res?.person)?.short_name;
        current = typeof stored === 'string' && stored.trim() ? stored.trim() : value;
        person.short_name = current;
        saved = 'saved';
        showLine();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        save.disabled = false;
      }
    });
    mount(wrap, form);
    input.focus();
  }

  showLine();
  return wrap;
}

function people(slot) {
  const created = h('div');
  const name = h('input', { class: 'input', id: 'inv-name', autocomplete: 'off' });
  const email = h('input', { class: 'input', id: 'inv-email', type: 'email', autocomplete: 'off', autocapitalize: 'off' });
  const role = h('select', { class: 'select', id: 'inv-role' }, h('option', { value: 'member' }, 'Family member'), h('option', { value: 'admin' }, 'Admin (can manage everything)'));
  const send = h('input', { type: 'checkbox', id: 'inv-send', checked: true });
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const submit = h('button', { type: 'submit', class: 'btn btn--primary btn--block' }, 'Create invite');
  const form = h('form', { class: 'card', novalidate: true },
    h('div', { class: 'field' }, h('label', { for: 'inv-name' }, 'Name'), name),
    h('div', { class: 'field' }, h('label', { for: 'inv-email' }, 'Email'), email),
    h('div', { class: 'field' }, h('label', { for: 'inv-role' }, 'Role'), role),
    h('label', { class: 'check', for: 'inv-send' }, send, 'Email the invite to them'),
    error, submit);
  const lists = h('div');

  const loadLists = async (reload) => {
    const res = await api.get('/api/admin/people');
    const users = listOf(res, 'people', 'users');
    const invites = listOf(res, 'invites').filter((i) => !i.used_at && !i.revoked_at);
    mount(lists,
      invites.length ? [h('h2', { class: 'section-title' }, 'Waiting to join'), h('div', { class: 'card' }, invites.map((inv) => row(
        inv.name || inv.email,
        `${inv.email || 'No email'} · expires ${whenLabel(inv.expires_at)}`,
        confirmButton({ label: 'Cancel invite', confirmLabel: 'Tap again to cancel', onConfirm: async () => { await api.del(`/api/admin/invites/${encodeURIComponent(inv.id)}`); reload(); } }))))] : null,
      h('h2', { class: 'section-title' }, `Family (${users.filter((u) => u.status !== 'removed').length})`),
      h('div', { class: 'card' }, users.map((u) => h('div', { class: 'person' },
        row(
          u.name,
          [u.email, u.role === 'admin' ? 'admin' : null, u.status === 'pending' ? 'hasn’t signed in yet' : null, u.status === 'removed' ? 'removed' : null].filter(Boolean).join(' · '),
          u.status === 'removed'
            ? h('button', { type: 'button', class: 'btn btn--quiet', onclick: async () => { await api.post(`/api/admin/people/${encodeURIComponent(u.id)}/restore`); reload(); } }, 'Restore')
            : confirmButton({ label: 'Remove', confirmLabel: 'Tap again: signs them out everywhere', onConfirm: async () => { await api.post(`/api/admin/people/${encodeURIComponent(u.id)}/remove`); reload(); } })),
        u.status === 'removed' ? null : grandmaName(u)))));
  };
  section(lists, loadLists);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.hidden = true;
    if (!name.value.trim()) { error.textContent = 'Add their name.'; error.hidden = false; return; }
    submit.disabled = true;
    try {
      const res = await api.post('/api/admin/invites', { name: name.value.trim(), email: email.value.trim(), role: role.value, send: send.checked });
      const url = res?.url ?? res?.link ?? res?.invite_url ?? res?.invite?.url;
      mount(created, onceLink(url ?? '(the server didn’t return a link)', {
        title: send.checked && email.value.trim() ? `Invite emailed to ${name.value.trim()}` : `Invite for ${name.value.trim()}`,
        note: 'You can also send this link yourself, by text for example. It works once, for 14 days, and won’t be shown again.',
      }));
      form.reset();
      send.checked = true;
      section(lists, loadLists);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });

  mount(slot, h('h2', { class: 'section-title' }, 'Invite someone'), created, form, lists);
}

function uploads(slot) {
  const filters = [['', 'All'], ['ready', 'Live'], ['processing', 'Getting ready'], ['failed', 'Failed'], ['hidden', 'Hidden']];
  let status = '';
  const bar = h('div', { class: 'row' });
  const list = h('div');
  const draw = () => {
    mount(bar, filters.map(([value, label]) => h('button', { type: 'button', class: value === status ? 'btn btn--sage' : 'btn btn--secondary', 'aria-pressed': String(value === status), onclick: () => { status = value; draw(); } }, label)));
    section(list, async (reload) => {
      const items = listOf(await api.get(`/api/admin/items${status ? `?status=${status}` : ''}`), 'items');
      if (!items.length) { mount(list, h('p', { class: 'body-text body-text--muted' }, 'Nothing here.')); return; }
      mount(list, h('div', { class: 'card' }, items.map((item) => {
        const owner = ownerOf(item);
        const thumb = item.status === 'ready' || item.status === 'hidden' ? h('img', { class: 'thumb', src: renditionUrl(item, 'thumb') ?? '', alt: '', loading: 'lazy' }) : h('span', { class: 'thumb' });
        const id = encodeURIComponent(item.id);
        return row(
          item.caption || (item.kind === 'video' ? 'Video' : 'Photo'),
          [`${owner.name}`, whenLabel(item.created_at), item.status === 'ready' ? null : item.status, item.error].filter(Boolean).join(' · '),
          [
            item.status === 'hidden'
              ? h('button', { type: 'button', class: 'btn btn--quiet', onclick: async () => { await api.post(`/api/admin/items/${id}/unhide`); reload(); } }, 'Show')
              : item.status === 'ready' ? h('button', { type: 'button', class: 'btn btn--quiet', onclick: async () => { await api.post(`/api/admin/items/${id}/hide`); reload(); } }, 'Hide') : null,
            confirmButton({ label: 'Delete', confirmLabel: 'Tap again to delete', onConfirm: async () => { await api.del(`/api/admin/items/${id}`); reload(); } }),
          ],
          thumb);
      })));
    });
  };
  mount(slot, h('h2', { class: 'section-title' }, 'Uploads'), h('p', { class: 'body-text body-text--muted' }, 'Hidden photos leave Grandma’s frame and the family feed, but aren’t deleted.'), bar, list);
  draw();
}

function frame(slot) {
  const paired = h('div');
  const health = h('div');
  const list = h('div');
  const name = h('input', { class: 'input', id: 'dev-name', value: 'Grandma’s frame' });
  const submit = h('button', { type: 'submit', class: 'btn btn--primary btn--block' }, 'Pair a frame');
  const form = h('form', { class: 'card', novalidate: true }, h('div', { class: 'field' }, h('label', { for: 'dev-name' }, 'Name'), name), submit);

  const loadDevices = () => section(list, async (reload) => {
    const devices = listOf(await api.get('/api/admin/devices'), 'devices');
    mount(list, devices.length ? h('div', { class: 'card' }, devices.map((d) => {
      const id = encodeURIComponent(d.id);
      const meta = d.revoked_at ? 'Unpaired' : d.last_seen_at ? `Last seen ${agoLabel(d.last_seen_at)}` : 'Not seen yet';
      return row(d.name, meta, d.revoked_at ? null : [
        h('button', { type: 'button', class: 'btn btn--quiet', onclick: async (e) => { await api.post(`/api/admin/devices/${id}/reload`); e.target.textContent = 'Reload sent'; } }, 'Reload'),
        confirmButton({ label: 'Unpair', confirmLabel: 'Tap again to unpair', onConfirm: async () => { await api.post(`/api/admin/devices/${id}/revoke`); reload(); } }),
      ]);
    })) : h('p', { class: 'body-text body-text--muted' }, 'No frame is paired yet.'));
  });

  section(health, async () => {
    const hl = await api.get('/api/admin/health');
    const facts = [
      hl?.queue_depth != null ? `${hl.queue_depth} waiting to be processed` : null,
      hl?.failed_jobs ? `${hl.failed_jobs} failed` : null,
      hl?.disk_free_bytes != null ? `${(hl.disk_free_bytes / 1024 ** 3).toFixed(1)} GB free` : null,
      hl?.frame_last_seen ? `frame seen ${agoLabel(hl.frame_last_seen)}` : null,
    ].filter(Boolean);
    mount(health, facts.length ? h('p', { class: 'body-text body-text--muted' }, facts.join(' · ')) : null);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    try {
      const res = await api.post('/api/admin/devices', { name: name.value.trim() || 'Grandma’s frame' });
      const url = res?.url ?? res?.pairing_url ?? res?.link;
      mount(paired, onceLink(url ?? '(the server didn’t return a link)', { title: 'Frame link', note: 'Put this link into the frame’s kiosk setup now. It’s shown only once; if you lose it, unpair and pair again.' }));
      loadDevices();
    } catch (err) {
      mount(paired, errorNote(err.message));
    } finally {
      submit.disabled = false;
    }
  });

  mount(slot, h('h2', { class: 'section-title' }, 'Grandma’s frame'), health, list, h('h2', { class: 'section-title' }, 'Pair a new frame'), paired, form);
  loadDevices();
}

function messages(slot) {
  section(slot, async () => {
    let presets = listOf(await api.get('/api/admin/presets'), 'presets').slice().sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
    const status = h('p', { class: 'body-text', role: 'status' });
    const rows = h('div');
    const draw = () => {
      mount(rows, presets.map((p, i) => {
        const input = h('input', { class: 'input', value: p.text, maxlength: '40', 'aria-label': `Message ${i + 1}`, oninput: (e) => { p.text = e.target.value; } });
        const active = h('input', { type: 'checkbox', checked: p.active !== 0 && p.active !== false, onchange: (e) => { p.active = e.target.checked ? 1 : 0; draw(); } });
        return h('div', { class: 'card' },
          h('div', { class: 'preset-row' }, input,
            h('div', { class: 'preset-tools' },
              h('button', { type: 'button', class: 'icon-btn', disabled: i === 0, 'aria-label': 'Move up', onclick: () => { [presets[i - 1], presets[i]] = [presets[i], presets[i - 1]]; draw(); } }, '↑'),
              h('button', { type: 'button', class: 'icon-btn', disabled: i === presets.length - 1, 'aria-label': 'Move down', onclick: () => { [presets[i + 1], presets[i]] = [presets[i], presets[i + 1]]; draw(); } }, '↓'))),
          h('label', { class: 'check' }, active, 'Show on Grandma’s screen'));
      }));
      const shown = presets.filter((p) => p.active !== 0 && p.active !== false).length;
      status.textContent = shown > 8 ? `${shown} are turned on, but Grandma’s screen fits 8. Turn some off.` : `${shown} of 8 spaces used on Grandma’s screen.`;
    };
    const save = h('button', {
      type: 'button', class: 'btn btn--primary btn--block',
      onclick: async () => {
        const clean = presets.map((p, i) => ({ ...p, text: p.text.trim(), sort: i })).filter((p) => p.text);
        try {
          const res = await api.put('/api/admin/presets', { presets: clean });
          presets = listOf(res, 'presets').length ? listOf(res, 'presets') : clean;
          draw();
          status.textContent = 'Saved. Grandma’s frame updates in a moment.';
        } catch (err) { status.textContent = err.message; }
      },
    }, 'Save messages');
    mount(slot,
      h('h2', { class: 'section-title' }, 'Messages Grandma can send'),
      h('p', { class: 'body-text body-text--muted' }, 'Short and warm works best. They show on her screen in this order.'),
      rows,
      h('div', { class: 'stack' },
        h('button', { type: 'button', class: 'btn btn--secondary btn--block', onclick: () => { presets.push({ id: null, text: '', active: 1 }); draw(); rows.lastElementChild?.querySelector('input')?.focus(); } }, icon('plus'), 'Add a message'),
        save),
      status);
    draw();
  });
}

function night(slot) {
  section(slot, async () => {
    const settings = await api.get('/api/admin/settings');
    const s = settings?.settings ?? settings ?? {};
    const start = h('input', { class: 'input', type: 'time', id: 'night-start', value: s.night_start ?? '21:00' });
    const end = h('input', { class: 'input', type: 'time', id: 'night-end', value: s.night_end ?? '07:00' });
    const status = h('p', { class: 'body-text', role: 'status' });
    const form = h('form', { class: 'card', novalidate: true },
      h('div', { class: 'times' },
        h('div', { class: 'field' }, h('label', { for: 'night-start' }, 'Dim at'), start),
        h('div', { class: 'field' }, h('label', { for: 'night-end' }, 'Wake at'), end)),
      h('button', { type: 'submit', class: 'btn btn--primary btn--block' }, 'Save night hours'),
      status);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api.put('/api/admin/settings', { night_start: start.value, night_end: end.value });
        status.textContent = 'Saved.';
      } catch (err) { status.textContent = err.message; }
    });
    mount(slot,
      h('h2', { class: 'section-title' }, 'Night hours'),
      h('p', { class: 'body-text body-text--muted' }, `At night the frame dims and the slideshow rests behind a big clock. The first tap only wakes the screen.${s.timezone ? ` Times are in ${s.timezone}.` : ''}`),
      form);
  });
}

const RENDER = { people, uploads, frame, messages, night };

export function adminScreen(main, ctx) {
  const slug = RENDER[ctx.params.section] ? ctx.params.section : 'people';
  const slot = h('div');
  mount(main,
    pageHead({ eyebrow: 'Admin', title: 'Looking after the family app' }),
    h('nav', { class: 'subnav', 'aria-label': 'Admin sections' },
      SECTIONS.map((s) => h('a', { href: `/admin/${s.slug}`, 'aria-current': s.slug === slug ? 'page' : null }, s.label))),
    slot);
  RENDER[slug](slot);
}
