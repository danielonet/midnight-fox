'use strict';

const MF = globalThis.MidnightFox;
const api = globalThis.browser;
const $ = (id) => document.getElementById(id);

let settings = { ...MF.DEFAULTS };
let host = '';
let tabId = null;

const STATUS = {
  auto: ['Dark palette applied', true],
  forced: ['Dark palette applied', true],
  'native-dark': ['Site is already dark', false],
  'site-off': ['Off for this site', false],
  disabled: ['Turned off', false],
  loading: ['Loading…', false]
};

const save = (patch) => {
  Object.assign(settings, patch);
  return api.storage.local.set(patch);
};

function hostOf(url) {
  try {
    const u = new URL(url);
    return /^https?:|^file:/.test(u.protocol) ? u.hostname : '';
  } catch (e) {
    return '';
  }
}

/* ---------- theme cards ---------- */

function buildThemes() {
  const box = $('themes');
  for (const [id, t] of Object.entries(MF.THEMES)) {
    const btn = document.createElement('button');
    btn.className = 'theme';
    btn.dataset.theme = id;
    btn.setAttribute('role', 'radio');
    btn.title = `${t.name} – ${t.description}`;

    const preview = document.createElement('div');
    preview.className = 'preview';
    preview.style.background = t.bg;
    const line = (color, width) => {
      const el = document.createElement('div');
      el.className = 'line';
      el.style.background = color;
      el.style.width = width;
      return el;
    };
    const card = document.createElement('div');
    card.className = 'card';
    card.style.background = t.surface;
    card.style.border = `1px solid ${t.border}`;
    const dot = document.createElement('div');
    dot.className = 'dot';
    dot.style.background = t.accent;
    card.append(dot);
    preview.append(line(t.fg, '80%'), line(t.muted, '55%'), card);

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = t.name;

    btn.append(preview, name);
    btn.addEventListener('click', () => {
      save({ theme: id });
      render();
    });
    box.append(btn);
  }
}

/* ---------- rendering ---------- */

function render() {
  document.body.classList.toggle('off', !settings.enabled);
  $('enabled').checked = settings.enabled;

  for (const btn of document.querySelectorAll('.theme')) {
    btn.setAttribute('aria-checked', String(btn.dataset.theme === settings.theme));
  }

  const mode = (host && settings.sites[host]) || 'auto';
  for (const btn of document.querySelectorAll('.segmented button')) {
    btn.setAttribute('aria-checked', String(btn.dataset.mode === mode));
    btn.disabled = !host;
  }
  $('site-host').textContent = host || 'This page can’t be darkened';

  for (const key of ['brightness', 'contrast']) {
    $(key).value = settings[key];
    const v = +settings[key];
    $(`${key}-out`).textContent = v > 0 ? `+${v}` : String(v);
  }
  $('dimImages').checked = settings.dimImages;
  $('useNativeDark').checked = settings.useNativeDark;
}

async function refreshStatus() {
  const el = $('status');
  if (!host || tabId === null) {
    el.textContent = '';
    return;
  }
  try {
    const s = await api.tabs.sendMessage(tabId, { type: 'mf-status' }, { frameId: 0 });
    const [text, on] = STATUS[s.reason] || ['', false];
    el.textContent = text;
    el.classList.toggle('on', on);
  } catch (e) {
    el.textContent = 'Reload the page to apply';
    el.classList.remove('on');
  }
}

/* ---------- events ---------- */

function wire() {
  $('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }).then(render));

  for (const btn of document.querySelectorAll('.segmented button')) {
    btn.addEventListener('click', () => {
      const sites = { ...settings.sites };
      if (btn.dataset.mode === 'auto') delete sites[host];
      else sites[host] = btn.dataset.mode;
      save({ sites }).then(render);
    });
  }

  for (const key of ['brightness', 'contrast']) {
    let timer = 0;
    $(key).addEventListener('input', (e) => {
      settings[key] = +e.target.value;
      render();
      clearTimeout(timer);
      timer = setTimeout(() => save({ [key]: settings[key] }), 120);
    });
  }

  for (const key of ['dimImages', 'useNativeDark']) {
    $(key).addEventListener('change', (e) => save({ [key]: e.target.checked }));
  }

  $('reset').addEventListener('click', () => {
    const { sites, ...rest } = MF.DEFAULTS;
    save(rest).then(render);
  });

  $('grant').addEventListener('click', async () => {
    const ok = await api.permissions.request({ origins: ['<all_urls>'] });
    if (ok) $('permission').hidden = true;
  });

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const k of Object.keys(changes)) settings[k] = changes[k].newValue ?? MF.DEFAULTS[k];
    render();
    setTimeout(refreshStatus, 150);
  });
}

async function init() {
  buildThemes();
  wire();
  settings = { ...MF.DEFAULTS, ...(await api.storage.local.get(null)) };
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    tabId = tab.id;
    host = hostOf(tab.url || '');
  }
  render();
  refreshStatus();

  // Firefox MV3 lets users withhold website access; offer to grant it.
  try {
    const granted = await api.permissions.contains({ origins: ['<all_urls>'] });
    $('permission').hidden = granted;
  } catch (e) { /* ignore */ }
}

init();
