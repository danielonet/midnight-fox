'use strict';

const MF = globalThis.MidnightFox;
const api = globalThis.browser;
const I18N = globalThis.MidnightFoxI18n;
const $ = (id) => document.getElementById(id);

let settings = { ...MF.DEFAULTS };
let host = '';
let tabId = null;
let t = I18N.translator(I18N.FALLBACK);

// status reason -> [translation key, highlighted]
const STATUS = {
  auto: ['sApplied', true],
  forced: ['sApplied', true],
  'native-dark': ['sNative', false],
  'site-off': ['sSiteOff', false],
  disabled: ['sDisabled', false],
  loading: ['sLoading', false]
};

/* ---------- language ---------- */

function buildLanguages() {
  const sel = $('language');
  sel.replaceChildren();
  const auto = document.createElement('option');
  auto.value = 'auto';
  sel.append(auto);
  for (const [code, l] of Object.entries(I18N.LANGUAGES)) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = `${l.flag}  ${l.name}`;
    sel.append(opt);
  }
}

function applyLanguage() {
  const lang = I18N.resolve(settings.language);
  t = I18N.translator(lang);
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  const auto = $('language').options[0];
  auto.textContent = `🌐  ${t('auto')}`;
  $('language').value = I18N.LANGUAGES[settings.language] ? settings.language : 'auto';
}

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
  $('site-host').textContent = host || t('cantDarken');

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
    const [key, on] = STATUS[s.reason] || ['', false];
    el.textContent = key ? t(key) : '';
    el.classList.toggle('on', on);
  } catch (e) {
    el.textContent = t('sReload');
    el.classList.remove('on');
  }
}

/* ---------- events ---------- */

function wire() {
  $('language').addEventListener('change', (e) => {
    save({ language: e.target.value });
    applyLanguage();
    render();
    refreshStatus();
  });

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
    const { sites, ...rest } = MF.DEFAULTS; // language is kept on reset
    save(rest).then(render);
  });

  $('grant').addEventListener('click', async () => {
    const ok = await api.permissions.request({ origins: ['<all_urls>'] });
    if (ok) $('permission').hidden = true;
  });

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const k of Object.keys(changes)) settings[k] = changes[k].newValue ?? MF.DEFAULTS[k];
    if (changes.language) applyLanguage();
    render();
    setTimeout(refreshStatus, 150);
  });
}

async function init() {
  buildThemes();
  buildLanguages();
  wire();
  settings = { language: 'auto', ...MF.DEFAULTS, ...(await api.storage.local.get(null)) };
  applyLanguage();
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
