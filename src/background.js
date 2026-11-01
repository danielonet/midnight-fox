/*
 * Midnight Fox – background script.
 *  - Asks sites for their own dark mode (prefers-color-scheme: dark).
 *  - Keyboard shortcuts.
 *  - Injects CSS for pages whose Content Security Policy blocks our <style>.
 */
'use strict';

const MF = globalThis.MidnightFox;
const api = globalThis.browser;

async function getSettings() {
  const stored = await api.storage.local.get(null);
  return { ...MF.DEFAULTS, ...stored };
}

// Firefox 106+: make pages see prefers-color-scheme: dark, so sites that
// have a dark mode use it. Those pages are then detected and left alone.
async function applyColorScheme(settings) {
  const setting = api.browserSettings && api.browserSettings.overrideContentColorScheme;
  if (!setting) return;
  try {
    await setting.set({ value: settings.enabled && settings.useNativeDark ? 'dark' : 'system' });
  } catch (e) {
    console.warn('Midnight Fox: could not set the content colour scheme', e);
  }
}

async function updateBadge(settings) {
  await api.action.setBadgeText({ text: settings.enabled ? '' : 'off' });
  await api.action.setBadgeBackgroundColor({ color: '#5a5f6d' });
}

async function refresh() {
  const settings = await getSettings();
  await applyColorScheme(settings);
  await updateBadge(settings);
}

api.runtime.onInstalled.addListener(async () => {
  const stored = await api.storage.local.get(null);
  const missing = {};
  for (const [k, v] of Object.entries(MF.DEFAULTS)) if (!(k in stored)) missing[k] = v;
  if (Object.keys(missing).length) await api.storage.local.set(missing);
  await refresh();
});
api.runtime.onStartup.addListener(refresh);
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ('enabled' in changes || 'useNativeDark' in changes)) refresh();
});

/* ---------- keyboard shortcuts ---------- */

function hostOf(url) {
  try {
    const u = new URL(url);
    return /^https?:|^file:/.test(u.protocol) ? u.hostname : '';
  } catch (e) {
    return '';
  }
}

async function toggleSite(tab) {
  const host = tab && hostOf(tab.url);
  if (!host) return;
  const settings = await getSettings();
  let isActive = false;
  try {
    const status = await api.tabs.sendMessage(tab.id, { type: 'mf-status' }, { frameId: 0 });
    isActive = !!(status && status.active);
  } catch (e) { /* no content script on this page */ }
  const sites = { ...settings.sites };
  if (isActive) sites[host] = 'off';
  else if (sites[host] === 'off') delete sites[host]; // back to automatic
  else sites[host] = 'on';
  await api.storage.local.set({ sites });
}

api.commands.onCommand.addListener(async (command, tab) => {
  if (!tab) [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (command === 'toggle-site') await toggleSite(tab);
  if (command === 'toggle-global') {
    const { enabled } = await getSettings();
    await api.storage.local.set({ enabled: !enabled });
  }
});

/* ---------- CSP fallback: inject CSS for a frame ---------- */

const injected = new Map(); // "tab:frame:name" -> css text

api.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'mf-css' || !sender.tab) return undefined;
  const target = { tabId: sender.tab.id, frameIds: [sender.frameId || 0] };
  const key = `${sender.tab.id}:${sender.frameId || 0}:${msg.name}`;
  return (async () => {
    const prev = injected.get(key);
    if (prev) await api.scripting.removeCSS({ target, css: prev }).catch(() => {});
    if (msg.css) {
      await api.scripting.insertCSS({ target, css: msg.css, origin: 'USER' });
      injected.set(key, msg.css);
    } else {
      injected.delete(key);
    }
  })().catch(() => {});
});

const forgetTab = (tabId) => {
  for (const key of injected.keys()) if (key.startsWith(`${tabId}:`)) injected.delete(key);
};
api.tabs.onRemoved.addListener(forgetTab);
api.tabs.onUpdated.addListener((tabId, info) => { if (info.status === 'loading') forgetTab(tabId); });
