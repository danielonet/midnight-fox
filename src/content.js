/*
 * Midnight Fox – content script.
 *
 * 1. Waits for the page to load and checks whether it is already dark
 *    (its own dark mode, or a dark design). Those pages are left alone.
 * 2. Otherwise it reads the computed colours of every element and remaps
 *    them into the chosen dark theme through generated CSS rules:
 *    each element gets a data attribute pointing at a rule such as
 *    [data-midnight-fox="12"] { color: …!important; background-color: …!important }
 * 3. A MutationObserver keeps new or changed content in sync, and
 *    :hover / :focus rules from the page's stylesheets are remapped too.
 * 4. Hover and focus colours that can't be read up front (CSS variables,
 *    stylesheets from other domains, inset box-shadows) are checked live
 *    as the pointer or focus moves, and remapped on the spot.
 */
(() => {
  'use strict';

  if (window.__midnightFoxLoaded) return;
  window.__midnightFoxLoaded = true;

  const MF = globalThis.MidnightFox;
  const api = globalThis.browser || globalThis.chrome;
  const doc = document;
  let rootEl = doc.documentElement;

  const ATTR = 'data-midnight-fox';
  const SHEET_ATTR = 'data-midnight-fox-sheet';
  const INLINE_ATTR = 'data-midnight-fox-inline';
  const LIVE_ATTR = 'data-midnight-fox-live';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const TRANSPARENT = 'rgba(0, 0, 0, 0)';
  const isTop = window === window.top;
  const host = siteHost();
  const { parseColor, lightness, contrastRatio } = MF.color;

  // Blue text is only allowed on things that can be clicked.
  const CLICKABLE = 'a[href],area[href],button,[role="link"],[role="button"],[onclick],input[type="button"],input[type="submit"]';
  const CLICKABLE_SEL_RE = /(^|[\s>+~,(])a(?![\w-])|href|link|button|btn/i;
  const TEXT_TAGS = new Set(['input', 'textarea', 'select', 'button', 'option']);
  const SKIP_TAGS = new Set([
    'head', 'script', 'style', 'link', 'meta', 'title', 'noscript', 'template',
    'base', 'br', 'wbr', 'param', 'source', 'track'
  ]);
  const STATE_RE = /:(hover|focus|focus-within|focus-visible|active|checked)\b/;
  const MAX_STATE_RULES = 4000;

  let settings = { ...MF.DEFAULTS };
  let mapper = null;
  let active = false;
  let reason = 'loading';
  let observer = null;
  let sheets = null;

  // Per element: the original (light-page) text colour it renders with.
  const state = new WeakMap();
  // Per element: the decl read from it, and inline colours we had to override.
  const decls = new WeakMap();
  const inlined = new WeakMap();
  // Generated rules: key -> id, id -> original colour set.
  const ruleIds = new Map();
  const ruleDecls = [];

  const COLOR_IN_STR = /rgba?\([^)]*\)/g;
  const isLight = (c) => !!c && c.a >= 0.3 && lightness(c) > 0.6;
  // True when a gradient or shadow string contains a light colour.
  const hasLightColor = (str) => (str.match(COLOR_IN_STR) || []).some((m) => isLight(parseColor(m)));

  function siteHost() {
    try {
      return window.top.location.hostname || location.hostname;
    } catch (e) {
      return location.hostname;
    }
  }

  const siteMode = () => (settings.sites && settings.sites[host]) || 'auto';

  /* ---------------- stylesheets ---------------- */

  // A <style> element filled through CSSOM (insertRule). If the page's CSP
  // blocks it, rules are sent to the background script, which injects them
  // with scripting.insertCSS instead.
  function createSheet(name) {
    const el = doc.createElement('style');
    el.setAttribute(SHEET_ATTR, name);
    let rules = [];
    let remote = false;
    let remoteTimer = 0;

    function rebuildDom() {
      const s = el.sheet;
      while (s.cssRules.length) s.deleteRule(s.cssRules.length - 1);
      const kept = [];
      for (const r of rules) {
        try {
          s.insertRule(r, s.cssRules.length);
          kept.push(r);
        } catch (e) { /* invalid selector from the page – drop it */ }
      }
      rules = kept;
    }

    function pushRemote() {
      clearTimeout(remoteTimer);
      remoteTimer = setTimeout(() => {
        try {
          const p = api.runtime.sendMessage({ type: 'mf-css', name, css: rules.join('\n') });
          if (p && p.catch) p.catch(() => {});
        } catch (e) { /* extension reloaded */ }
      }, 30);
    }

    const sheet = {
      ensure() {
        if (remote || el.isConnected) return;
        rootEl.appendChild(el);
        if (!el.sheet) {
          remote = true;
          el.remove();
          pushRemote();
          return;
        }
        rebuildDom();
      },
      add(rule) {
        sheet.ensure();
        if (remote) {
          rules.push(rule);
          pushRemote();
          return;
        }
        try {
          el.sheet.insertRule(rule, el.sheet.cssRules.length);
          rules.push(rule);
        } catch (e) { /* ignore */ }
      },
      reset(list) {
        rules = list.slice();
        sheet.ensure();
        if (remote) pushRemote();
        else rebuildDom();
      },
      clear() {
        rules = [];
        if (remote) pushRemote();
        else el.remove();
      },
      // Returns false when the sheet can't be switched off (remote mode).
      setDisabled(v) {
        if (remote) return false;
        if (el.sheet) el.sheet.disabled = v;
        return true;
      },
      get remote() { return remote; }
    };
    return sheet;
  }

  function setAllDisabled(v) {
    let ok = true;
    for (const s of Object.values(sheets)) ok = s.setDisabled(v) && ok;
    return ok;
  }

  function withoutTransitions(fn) {
    // Stops CSS transitions from animating light→dark while we re-read colours.
    if (sheets.rules.remote) return fn();
    sheets.notrans.reset(['*,*::before,*::after{transition:none!important}']);
    try {
      fn();
      void getComputedStyle(rootEl).color; // flush styles while transitions are off
    } finally {
      sheets.notrans.clear();
    }
  }

  /* ---------------- base + rule CSS ---------------- */

  function rgba(css, alpha) {
    const c = parseColor(css);
    return c ? `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})` : css;
  }

  function baseRules() {
    const c = mapper.colors;
    const rules = [
      `:root{scrollbar-color:${c.border} ${c.bg}}`,
      `::selection{background-color:${rgba(c.accent, 0.4)}!important;color:${c.fg}!important}`,
      `::placeholder{color:${c.muted}!important;opacity:1!important}`,
      `input,textarea,select,[contenteditable]{caret-color:${c.fg}}`
    ];
    // In frames a transparent page stays transparent (it shows its parent).
    if (isTop) rules.unshift(`html{background-color:${c.bg}!important}`);
    if (settings.dimImages) {
      rules.push('img,picture,video,canvas,svg image{filter:brightness(.82) contrast(1.05)!important}');
    }
    return rules;
  }

  const ruleKey = (d) =>
    [d.color, d.link, d.bg, d.bgImage, d.shadow, d.bt, d.br, d.bb, d.bl, d.fill, d.stroke, d.fix, d.fixFill]
      .map((v) => v || '').join('|');

  function ruleText(id, d) {
    const out = [];
    const add = (prop, v) => { if (v) out.push(`${prop}:${v}!important`); };
    if (d.color) add('color', mapper.fg(d.color, d.link));
    if (d.fix) {
      add('color', d.fix);
      if (d.fixFill) add('-webkit-text-fill-color', d.fix);
    }
    if (d.bg) add('background-color', mapper.bg(d.bg));
    if (d.bgImage) add('background-image', mapper.gradient(d.bgImage));
    if (d.shadow) add('box-shadow', mapper.gradient(d.shadow));
    if (d.bt) add('border-top-color', mapper.border(d.bt));
    if (d.br) add('border-right-color', mapper.border(d.br));
    if (d.bb) add('border-bottom-color', mapper.border(d.bb));
    if (d.bl) add('border-left-color', mapper.border(d.bl));
    if (d.fill) add('fill', mapper.icon(d.fill));
    if (d.stroke) add('stroke', mapper.icon(d.stroke));
    // The id-level boost makes these beat the page's own !important rules.
    return `[${ATTR}="${id}"]:not(#midnight-fox-x){${out.join(';')}}`;
  }

  function ruleId(d) {
    const key = ruleKey(d);
    let id = ruleIds.get(key);
    if (id === undefined) {
      id = ruleDecls.length;
      ruleDecls.push(d);
      ruleIds.set(key, id);
      sheets.rules.add(ruleText(id, d));
    }
    return String(id);
  }

  const rebuildRules = () => sheets.rules.reset(ruleDecls.map((d, i) => ruleText(i, d)));

  /* ---------------- native dark detection ---------------- */

  function canvasColor() {
    const scheme = getComputedStyle(rootEl).colorScheme || '';
    const prefersDark = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
    const dark = /dark/.test(scheme) && (!/light/.test(scheme) || prefersDark);
    return dark ? { r: 28, g: 27, b: 34, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
  }

  let ignoreOwnRootBg = false;
  function effectiveBg(el) {
    for (; el && el.nodeType === 1; el = el.parentElement) {
      const c = parseColor(getComputedStyle(el).backgroundColor);
      if (ignoreOwnRootBg && el === rootEl && c && MF.color.toCss(c) === mapper.colors.bg) continue;
      if (c && c.a >= 0.5) return c;
    }
    // A transparent <html> lets the body's background paint the whole canvas.
    const body = doc.body;
    const bc = body && parseColor(getComputedStyle(body).backgroundColor);
    if (bc && bc.a >= 0.5) return bc;
    return canvasColor();
  }

  // True when the page (with our styles off) already looks dark.
  function pageIsDark() {
    const body = doc.body;
    if (!body) return false;
    const isDark = (c) => lightness(c) < 0.35;
    const bodyDark = isDark(effectiveBg(body));
    const w = window.innerWidth, h = window.innerHeight;
    if (!w || !h) return bodyDark;
    const points = [[0.5, 0.5], [0.25, 0.3], [0.75, 0.3], [0.25, 0.75], [0.75, 0.75]];
    let dark = 0;
    for (const [x, y] of points) {
      const el = doc.elementFromPoint(w * x, h * y);
      if (isDark(el ? effectiveBg(el) : effectiveBg(body))) dark++;
    }
    return dark === points.length || (bodyDark && dark >= 3);
  }

  function decide() {
    if (!settings.enabled) return [false, 'disabled'];
    const mode = siteMode();
    if (mode === 'off') return [false, 'site-off'];
    if (mode === 'on') return [true, 'forced'];
    if (!doc.body) return [true, 'auto'];
    // Measure the page as it looks without us.
    if (!setAllDisabled(true)) {
      setAllDisabled(false);
      if (active) return [true, reason]; // CSP fallback: can't measure without us, keep decision
      ignoreOwnRootBg = true; // our early html background can't be switched off here
    }
    let dark;
    try {
      dark = pageIsDark();
    } finally {
      setAllDisabled(false);
      ignoreOwnRootBg = false;
    }
    return dark ? [false, 'native-dark'] : [true, 'auto'];
  }

  /* ---------------- reading + remapping elements ---------------- */

  const walkerFilter = {
    acceptNode: (n) => (SKIP_TAGS.has(n.localName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  };

  function collect(root, out) {
    if (root.nodeType !== 1 || SKIP_TAGS.has(root.localName) || root.hasAttribute(SHEET_ATTR)) return;
    out.push(root);
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, walkerFilter);
    while (walker.nextNode()) out.push(walker.currentNode);
  }

  const hasBg = (v) => v && v !== TRANSPARENT && v !== 'transparent';

  // Reads an element's original colours. `raw` holds the colours read
  // earlier in this same pass so inherited text colour can be detected.
  function read(el, raw) {
    const cs = getComputedStyle(el);
    const d = {};

    // Text colour inherits, so only set it where it differs from the parent.
    const color = cs.color;
    let orig = color;
    let own = true;
    let link = false;
    const p = el.parentElement;
    if (p && el !== rootEl) {
      const ps = state.get(p);
      if (raw.has(p)) {
        if (color === raw.get(p) && ps) { own = false; orig = ps.orig; link = ps.link; }
      } else if (ps && color === mapper.fg(ps.orig, ps.link)) {
        own = false;
        orig = ps.orig;
        link = ps.link;
      }
    }
    raw.set(el, color);
    if (own) {
      const oc = parseColor(orig);
      link = !!(oc && MF.color.isBlue(oc) && el.closest(CLICKABLE));
      d.color = orig;
      if (link) d.link = true;
    }
    state.set(el, { orig, link });

    // Backgrounds.
    const bg = cs.backgroundColor;
    if (hasBg(bg)) {
      d.bg = bg;
    } else if (el === rootEl && isTop) {
      const body = doc.body;
      const bodyBg = body && getComputedStyle(body).backgroundColor;
      d.bg = hasBg(bodyBg) ? bodyBg : 'rgb(255, 255, 255)';
    }
    const bi = cs.backgroundImage;
    if (bi && bi !== 'none' && bi.includes('gradient')) d.bgImage = bi;
    // A huge inset box-shadow is a common way to fill table cells (Bootstrap 5).
    const sh = cs.boxShadow;
    if (sh && sh !== 'none' && sh.includes('inset') && hasLightColor(sh)) d.shadow = sh;

    // Borders.
    const sides = [['Top', 'bt'], ['Right', 'br'], ['Bottom', 'bb'], ['Left', 'bl']];
    for (const [side, key] of sides) {
      if (cs[`border${side}Width`] !== '0px' && cs[`border${side}Style`] !== 'none') {
        const bc = cs[`border${side}Color`];
        if (hasBg(bc)) d[key] = bc;
      }
    }

    // SVG icons.
    if (el.namespaceURI === SVG_NS) {
      if (cs.fill && cs.fill.startsWith('rgb')) d.fill = cs.fill;
      if (cs.stroke && cs.stroke.startsWith('rgb')) d.stroke = cs.stroke;
    }
    return d;
  }

  /* ---------------- readability guarantee ---------------- */

  const blend = (c, under) => ({
    r: c.r * c.a + under.r * (1 - c.a),
    g: c.g * c.a + under.g * (1 - c.a),
    b: c.b * c.a + under.b * (1 - c.a),
    a: 1
  });

  // The colour actually painted behind an element (as it renders now), or
  // null when it sits on an image and can't be judged.
  function backdropOf(el, memo) {
    if (!el || el.nodeType !== 1) return parseColor(mapper.colors.bg);
    if (memo.has(el)) return memo.get(el);
    const cs = getComputedStyle(el);
    let out;
    if (cs.backgroundImage && cs.backgroundImage.includes('url(')) {
      out = null;
    } else {
      const c = parseColor(cs.backgroundColor);
      if (c && c.a >= 0.99) {
        out = c;
      } else {
        const under = backdropOf(el.parentElement, memo);
        out = !under ? null : c && c.a > 0 ? blend(c, under) : under;
      }
    }
    memo.set(el, out);
    return out;
  }

  function hasText(el) {
    if (TEXT_TAGS.has(el.localName)) return true;
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && n.nodeValue.trim()) return true;
    }
    return false;
  }

  function restoreInline(el) {
    const saved = inlined.get(el);
    if (!saved) return;
    for (const [prop, [value, prio]] of Object.entries(saved)) {
      if (value) el.style.setProperty(prop, value, prio); else el.style.removeProperty(prop);
    }
    inlined.delete(el);
    el.removeAttribute(INLINE_ATTR);
  }

  // Text must never be the same colour as (or close to) what is behind it,
  // whatever the page did. Checks the rendered result and fixes the rest.
  function ensureReadable(list) {
    const memo = new Map();
    const fixes = [];
    for (const el of list) {
      if (!hasText(el)) continue;
      const cs = getComputedStyle(el);
      const color = parseColor(cs.color);
      const fill = parseColor(cs.webkitTextFillColor) || color;
      if (!color || !fill || fill.a < 0.1) continue; // invisible on purpose (clipped gradient text…)
      const bd = backdropOf(el, memo);
      if (!bd) continue;
      const shown = blend(fill, bd);
      const blueText = MF.color.isBlue(shown) && !el.closest(CLICKABLE);
      if (!blueText && contrastRatio(shown, bd) >= 4.5) continue;
      const fixed = mapper.readable(shown, bd, blueText);
      if (!fixed) continue;
      fixes.push({ el, css: MF.color.toCss({ ...fixed, a: 1 }), fixFill: cs.webkitTextFillColor !== cs.color });
    }
    if (!fixes.length) return;

    for (const f of fixes) {
      const d = { ...(decls.get(f.el) || {}), fix: f.css, fixFill: f.fixFill };
      f.el.setAttribute(ATTR, ruleId(d));
    }
    // A page rule with an inline !important still wins; override it inline.
    for (const f of fixes) {
      const now = parseColor(getComputedStyle(f.el).color);
      const want = parseColor(f.css);
      if (now && want && Math.abs(now.r - want.r) + Math.abs(now.g - want.g) + Math.abs(now.b - want.b) < 6) continue;
      const st = f.el.style;
      inlined.set(f.el, {
        color: [st.getPropertyValue('color'), st.getPropertyPriority('color')],
        '-webkit-text-fill-color': [st.getPropertyValue('-webkit-text-fill-color'), st.getPropertyPriority('-webkit-text-fill-color')]
      });
      f.el.setAttribute(INLINE_ATTR, '');
      st.setProperty('color', f.css, 'important');
      if (f.fixFill) st.setProperty('-webkit-text-fill-color', f.css, 'important');
    }
    // Our own inline writes must not wake the observer again.
    if (observer) {
      const rest = observer.takeRecords().filter((r) => !(r.type === 'attributes' && inlined.has(r.target)));
      if (rest.length) onMutations(rest);
    }
  }

  function isEmpty(d) {
    for (const k in d) return false;
    return true;
  }

  // Re-reads and remaps the given subtrees (roots must not contain each other).
  function processRoots(roots, deep = true) {
    const list = [];
    for (const r of roots) {
      if (deep) collect(r, list);
      else if (r.nodeType === 1) list.push(r);
    }
    if (!list.length) return [];

    // Strip our attribute first so we read the page's own colours.
    for (const el of list) {
      if (el.hasAttribute(ATTR)) el.removeAttribute(ATTR);
      if (el.hasAttribute(INLINE_ATTR)) restoreInline(el);
    }

    // Our base sheet paints <html> dark; switch it off while reading it.
    const touchesRoot = list.includes(rootEl);
    if (touchesRoot) sheets.base.setDisabled(true);
    const raw = new Map();
    const before = deep ? null : list.map((el) => state.get(el) && state.get(el).orig);
    let results;
    try {
      results = list.map((el) => read(el, raw));
    } finally {
      if (touchesRoot) sheets.base.setDisabled(false);
    }

    for (let i = 0; i < list.length; i++) {
      const d = results[i];
      decls.set(list[i], d);
      if (isEmpty(d)) continue;
      list[i].setAttribute(ATTR, ruleId(d));
    }
    ensureReadable(list);

    // Shallow update changed the text colour → children need updating too.
    if (!deep) {
      return list.filter((el, i) => before[i] !== undefined && before[i] !== state.get(el).orig);
    }
    return [];
  }

  function stripAll() {
    for (const el of doc.querySelectorAll(`[${ATTR}]`)) el.removeAttribute(ATTR);
    for (const el of doc.querySelectorAll(`[${INLINE_ATTR}]`)) restoreInline(el);
  }

  function fullScan() {
    withoutTransitions(() => {
      stripAll();
      processRoots([rootEl]);
    });
  }

  /* ---------------- :hover / :focus rules ---------------- */

  // Splits "a, b:is(c, d)" at top-level commas only.
  function splitSelectors(text) {
    const out = [];
    let depth = 0, start = 0, quote = '';
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote) { if (ch === quote && text[i - 1] !== '\\') quote = ''; continue; }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === ',' && depth === 0) { out.push(text.slice(start, i).trim()); start = i + 1; }
    }
    out.push(text.slice(start).trim());
    return out.filter(Boolean);
  }

  // Adds an id-level boost so state rules beat the per-element rules.
  function boost(sel) {
    if (sel.includes('&')) return null; // nested CSS – skip
    const m = /^(html|:root)(?=$|[\s.:#[>+~])/i.exec(sel);
    if (m) return `${m[1]}:not(#midnight-fox-x)${sel.slice(m[1].length)}`;
    return `:root:not(#midnight-fox-x) ${sel}`;
  }

  function stateRule(rule) {
    const s = rule.style;
    const out = [];
    const bg = s.getPropertyValue('background-color');
    const color = s.getPropertyValue('color');
    const border = s.getPropertyValue('border-top-color') || s.getPropertyValue('border-color');
    // Lifted a little so the hover highlight stays visible on the dark page.
    const bgv = bg && highlight(bg, parseColor(mapper.colors.bg));
    const cv = color && mapper.fg(color, CLICKABLE_SEL_RE.test(rule.selectorText));
    const bv = border && mapper.border(border);
    if (bgv) out.push(`background-color:${bgv}!important`);
    if (cv) out.push(`color:${cv}!important`);
    if (bv) out.push(`border-color:${bv}!important`);
    if (!out.length) return null;
    const sels = splitSelectors(rule.selectorText).map(boost).filter(Boolean);
    return sels.length ? `${sels.join(',')}{${out.join(';')}}` : null;
  }

  function collectStateRules(rules, out, depth) {
    for (const rule of rules) {
      if (out.length >= MAX_STATE_RULES) return;
      if (rule.selectorText !== undefined) {
        if (STATE_RE.test(rule.selectorText)) {
          const text = stateRule(rule);
          if (text) out.push(text);
        }
      } else if (rule.styleSheet) { // @import
        try { collectStateRules(rule.styleSheet.cssRules, out, depth + 1); } catch (e) { /* cross-origin */ }
      } else if (rule.cssRules && depth < 6) { // @media, @supports, @layer…
        if (rule.media && rule.media.mediaText && !matchMedia(rule.media.mediaText).matches) continue;
        collectStateRules(rule.cssRules, out, depth + 1);
      }
    }
  }

  let stateTimer = 0;
  function scheduleStateScan(delay = 250) {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(scanStateRules, delay);
  }

  function scanStateRules() {
    if (!active) return;
    const out = [];
    for (const sheet of doc.styleSheets) {
      const owner = sheet.ownerNode;
      if (owner && owner.hasAttribute && owner.hasAttribute(SHEET_ATTR)) continue;
      if (sheet.disabled) continue;
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; } // cross-origin sheet
      collectStateRules(rules, out, 0);
      if (out.length >= MAX_STATE_RULES) break;
    }
    sheets.states.reset(out);
  }

  /* ---------------- live :hover / :focus check ---------------- */

  // Some hover colours can't be remapped in advance: CSS variables,
  // stylesheets from other domains, inset box-shadows. When the pointer or
  // focus moves, the elements around it (its ancestors and their direct
  // children, e.g. every cell of a hovered table row) are checked, and any
  // light background or dark text that appeared is remapped.
  const LIVE_PROPS = new Set(['background-color', 'background-image', 'background', 'box-shadow', 'color', 'all']);
  const liveIds = new Map();
  let liveFixed = new Set();
  let hoverTarget = null;
  let liveFrame = 0;

  function liveRuleText(id, d) {
    const out = [];
    if (d.bg) out.push(`background-color:${d.bg}!important`);
    if (d.bgImage) out.push(`background-image:${d.bgImage}!important`);
    if (d.shadow) out.push(`box-shadow:${d.shadow}!important`);
    if (d.color) out.push(`color:${d.color}!important`);
    // Two id-level boosts: beats the per-element rules and the :hover rules.
    return `[${LIVE_ATTR}="${id}"]:not(#midnight-fox-x):not(#midnight-fox-y){${out.join(';')}}`;
  }

  function liveId(d) {
    const key = [d.bg, d.bgImage, d.shadow, d.color].map((v) => v || '').join('|');
    let id = liveIds.get(key);
    if (id === undefined) {
      id = liveIds.size;
      liveIds.set(key, id);
      sheets.live.add(liveRuleText(id, d));
    }
    return String(id);
  }

  // Dark version of a light hover colour that still stands out from what
  // is behind it, so the highlight stays visible.
  function highlight(css, under) {
    const mapped = parseColor(mapper.bg(css));
    if (!mapped) return null;
    if (under && Math.abs(lightness(mapped) - lightness(under)) < 0.05) {
      const [h, s, l] = MF.color.rgbToHsl(mapped);
      return MF.color.toCss(MF.color.hslToRgb(h, s, Math.min(1, l + 0.07), mapped.a));
    }
    return MF.color.toCss(mapped);
  }

  // Jumps colour transitions to their end so we read the final hover colour.
  function settleTransitions(el, cs) {
    if (!el.getAnimations || !cs || cs.transitionDuration.split(',').every((t) => parseFloat(t) === 0)) return;
    for (const a of el.getAnimations()) {
      if (a.transitionProperty && LIVE_PROPS.has(a.transitionProperty)) {
        try { a.finish(); } catch (e) { /* already done */ }
      }
    }
  }

  function liveDecl(el, memo) {
    const cs = getComputedStyle(el);
    const d = {};
    let under;
    const backdrop = () => (under === undefined ? (under = backdropOf(el.parentElement, memo)) : under);
    if (isLight(parseColor(cs.backgroundColor))) d.bg = highlight(cs.backgroundColor, backdrop());
    const bi = cs.backgroundImage;
    if (bi && bi.includes('gradient') && hasLightColor(bi)) d.bgImage = mapper.gradient(bi);
    const sh = cs.boxShadow;
    if (sh && sh.includes('inset') && hasLightColor(sh)) {
      d.shadow = sh.replace(COLOR_IN_STR, (m) => (isLight(parseColor(m)) && highlight(m, backdrop())) || m);
    }
    const col = parseColor(cs.color);
    if (col && col.a >= 0.3 && lightness(col) < 0.45 && hasText(el)) {
      d.color = mapper.fg(cs.color, MF.color.isBlue(col) && !!el.closest(CLICKABLE));
    }
    for (const k in d) if (!d[k]) delete d[k];
    return isEmpty(d) ? null : d;
  }

  function liveCandidates() {
    const out = new Set(liveFixed);
    const starts = [hoverTarget, doc.activeElement];
    for (const start of starts) {
      let depth = 0;
      for (let el = start; el && el.nodeType === 1 && el !== rootEl && depth < 12; el = el.parentElement, depth++) {
        out.add(el);
        if (el.childElementCount <= 60) for (const ch of el.children) out.add(ch);
        if (out.size > 500) break;
      }
    }
    return [...out].filter((el) => el.isConnected && !SKIP_TAGS.has(el.localName) && !el.hasAttribute(SHEET_ATTR));
  }

  function liveCheck() {
    liveFrame = 0;
    if (!active) return;
    const list = liveCandidates();
    // Read each element as the page styles it right now, without our fix.
    for (const el of list) if (el.hasAttribute(LIVE_ATTR)) el.removeAttribute(LIVE_ATTR);
    for (const el of list) settleTransitions(el, getComputedStyle(el));
    const memo = new Map();
    const found = [];
    for (const el of list) {
      const d = liveDecl(el, memo);
      if (d) found.push([el, d]);
    }
    liveFixed = new Set();
    for (const [el, d] of found) {
      el.setAttribute(LIVE_ATTR, liveId(d));
      liveFixed.add(el);
    }
    // Don't let the page animate from its light colour to ours.
    for (const [el] of found) settleTransitions(el, getComputedStyle(el));
  }

  function scheduleLiveCheck() {
    if (active && !liveFrame) liveFrame = requestAnimationFrame(liveCheck);
  }

  function resetLive() {
    if (liveFrame) cancelAnimationFrame(liveFrame);
    liveFrame = 0;
    for (const el of doc.querySelectorAll(`[${LIVE_ATTR}]`)) el.removeAttribute(LIVE_ATTR);
    liveFixed = new Set();
    liveIds.clear();
    sheets.live.clear();
  }

  function watchPointer() {
    const opts = { capture: true, passive: true };
    doc.addEventListener('pointerover', (e) => { hoverTarget = e.target; scheduleLiveCheck(); }, opts);
    doc.addEventListener('pointerout', (e) => {
      if (!e.relatedTarget) { hoverTarget = null; scheduleLiveCheck(); } // left the page
    }, opts);
    for (const type of ['focusin', 'focusout', 'change', 'pointerdown', 'pointerup']) {
      doc.addEventListener(type, scheduleLiveCheck, opts);
    }
  }

  /* ---------------- watching the page ---------------- */

  const queue = new Map(); // element -> deep?
  let flushScheduled = false;

  function enqueue(el, deep) {
    if (!el || el.nodeType !== 1) return;
    queue.set(el, queue.get(el) || deep);
    if (!flushScheduled) {
      flushScheduled = true;
      queueMicrotask(flush);
    }
  }

  function hasQueuedAncestor(el) {
    for (let p = el.parentElement; p; p = p.parentElement) if (queue.get(p) === true) return true;
    return false;
  }

  function flush() {
    flushScheduled = false;
    if (!active) { queue.clear(); return; }
    for (const s of ['base', 'rules', 'states', 'live']) sheets[s].ensure();

    const deep = [], shallow = [];
    let needsQuiet = false;
    for (const [el, isDeep] of queue) {
      if (!el.isConnected || hasQueuedAncestor(el)) continue;
      if (isDeep) deep.push(el); else shallow.push(el);
      if (el.hasAttribute(ATTR)) needsQuiet = true;
    }
    queue.clear();
    if (!deep.length && !shallow.length) return;

    let escalate = [];
    const run = () => {
      processRoots(deep, true);
      escalate = processRoots(shallow, false);
    };
    // Existing elements may have transitions; fresh ones don't need the guard.
    if (needsQuiet) withoutTransitions(run); else run();
    for (const el of escalate) enqueue(el, true);
  }

  function onMutations(muts) {
    let stylesChanged = false;
    for (const m of muts) {
      if (m.type === 'childList') {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.hasAttribute(SHEET_ATTR)) continue;
          const tag = n.localName;
          if (tag === 'style' || tag === 'link') { stylesChanged = true; continue; }
          enqueue(n, true);
        }
        if (m.target.localName === 'style' && !m.target.hasAttribute(SHEET_ATTR)) stylesChanged = true;
      } else if (m.type === 'attributes') {
        // A class change can affect a whole subtree; inline styles usually just the element.
        enqueue(m.target, m.attributeName !== 'style');
      }
    }
    if (stylesChanged) {
      scheduleStateScan();
      scheduleRescan();
    }
    // Pages sometimes wipe <head>/<html> children; put our sheets back.
    if (active) for (const s of ['base', 'rules', 'states', 'live']) sheets[s].ensure();
  }

  // New stylesheet → the page's colours may have changed everywhere.
  let rescanTimer = 0;
  function scheduleRescan() {
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => { if (active) fullScan(); }, 400);
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(onMutations);
    observer.observe(rootEl, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style']
    });
  }

  function stopObserver() {
    if (observer) observer.disconnect();
    observer = null;
    queue.clear();
  }

  /* ---------------- on / off ---------------- */

  function activate() {
    sheets.base.reset(baseRules());
    if (active) return;
    active = true;
    fullScan();
    startObserver();
    scheduleStateScan(0);
  }

  function deactivate() {
    const was = active;
    active = false;
    stopObserver();
    if (was) stripAll();
    resetLive();
    for (const s of ['base', 'rules', 'states']) sheets[s].clear();
    ruleIds.clear();
    ruleDecls.length = 0;
  }

  function evaluate() {
    const [want, why] = decide();
    reason = why;
    if (want) activate();
    else deactivate();
  }

  function onLoad() {
    // Late stylesheets or scripts may have changed the page; check again.
    setTimeout(() => {
      if (!settings.enabled) return;
      const wasActive = active;
      evaluate();
      if (active && wasActive) {
        fullScan();
        scheduleStateScan(0);
      }
    }, 50);
  }

  function onSettingsChanged(changes, area) {
    if (area !== 'local') return;
    const oldMode = siteMode();
    for (const k of Object.keys(changes)) {
      if (k in MF.DEFAULTS) {
        const v = changes[k].newValue;
        settings[k] = v === undefined ? MF.DEFAULTS[k] : v;
      }
    }
    const looks = ['theme', 'brightness', 'contrast', 'dimImages'].some((k) => k in changes);
    if (looks) {
      mapper = MF.createMapper(settings.theme, settings);
      if (active) {
        sheets.base.reset(baseRules());
        rebuildRules();
        scheduleStateScan(0);
        resetLive();
        scheduleLiveCheck();
      }
    }
    if ('enabled' in changes || ('sites' in changes && siteMode() !== oldMode)) {
      if (doc.readyState === 'loading') {
        if (settings.enabled && siteMode() !== 'off') sheets.base.reset(baseRules());
        else sheets.base.clear();
      } else {
        evaluate();
      }
    }
  }

  function onMessage(msg) {
    if (!msg || msg.type !== 'mf-status' || !isTop) return undefined;
    return Promise.resolve({ active, reason, host, mode: siteMode() });
  }

  async function init() {
    try {
      const stored = await api.storage.local.get(null);
      settings = { ...MF.DEFAULTS, ...stored };
    } catch (e) { /* use defaults */ }
    mapper = MF.createMapper(settings.theme, settings);
    sheets = {
      base: createSheet('base'),
      rules: createSheet('rules'),
      states: createSheet('states'),
      live: createSheet('live'),
      notrans: createSheet('notrans')
    };
    watchPointer();

    // Paint the background dark straight away to avoid a white flash.
    if (settings.enabled && siteMode() !== 'off' && doc.readyState === 'loading') {
      sheets.base.reset(baseRules());
    }

    api.storage.onChanged.addListener(onSettingsChanged);
    api.runtime.onMessage.addListener(onMessage);

    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', evaluate, { once: true });
    else evaluate();

    if (doc.readyState !== 'complete') window.addEventListener('load', onLoad, { once: true });
    // A stylesheet <link> finished loading.
    doc.addEventListener('load', (e) => {
      if (active && e.target && e.target.localName === 'link') {
        scheduleStateScan();
        scheduleRescan();
      }
    }, true);
  }

  function start() {
    rootEl = doc.documentElement;
    // Only real HTML pages (not images, plain XML, SVG files…).
    if (!MF || rootEl.localName !== 'html' || !/html/i.test(doc.contentType || 'text/html')) return;
    init().catch((e) => console.error('Midnight Fox:', e));
  }

  if (doc.documentElement) {
    start();
  } else {
    // Very early injection: wait for the <html> element.
    const waiter = new MutationObserver(() => {
      if (!doc.documentElement) return;
      waiter.disconnect();
      start();
    });
    waiter.observe(doc, { childList: true });
  }
})();
