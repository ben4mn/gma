// A tiny element builder. Text always goes in as text nodes (never HTML), so
// names and captions people type can't inject markup. Styles go through the
// CSSOM because the CSP forbids inline style attributes.

export function h(tag, props = null, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
      else if (key === 'style') Object.assign(el.style, value);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'value') el.value = value;
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key in el && typeof value !== 'string') el[key] = value;
      else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Replace everything inside `el`. */
export function mount(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

/** A button that asks "Tap again to …" before it acts; it settles back after a few seconds. */
export function confirmButton({ label, confirmLabel, className = 'btn btn--quiet', onConfirm }) {
  let armed = false;
  let timer = null;
  const button = h('button', { type: 'button', class: className }, label);
  const disarm = () => {
    armed = false;
    button.textContent = label;
    button.classList.remove('is-armed');
  };
  button.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      button.textContent = confirmLabel;
      button.classList.add('is-armed');
      timer = setTimeout(disarm, 5000);
      return;
    }
    clearTimeout(timer);
    button.disabled = true;
    try {
      await onConfirm();
    } finally {
      button.disabled = false;
      disarm();
    }
  });
  return button;
}
