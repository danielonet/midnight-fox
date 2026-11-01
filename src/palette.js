/*
 * Midnight Fox – themes and colour maths.
 * Shared by the content script, the popup and the background script.
 */
(function (root) {
  'use strict';

  // Each theme describes the dark palette a light page is remapped into.
  //   bg      – main page background (what white becomes)
  //   surface – raised areas: cards, inputs, darker greys of the original
  //   border  – lines and separators
  //   fg      – main text (what black becomes)
  //   muted   – secondary / light grey text
  //   accent  – selection highlight
  const THEMES = {
    midnight: {
      name: 'Midnight',
      description: 'Cool blue-grey, easy on the eyes',
      bg: '#16181d', surface: '#242832', border: '#3a404d',
      fg: '#e4e6eb', muted: '#a3a9b6', accent: '#7aa2f7'
    },
    oled: {
      name: 'OLED Black',
      description: 'Pure black for OLED screens',
      bg: '#000000', surface: '#141414', border: '#2e2e2e',
      fg: '#e8e8e8', muted: '#9a9a9a', accent: '#5fb3ff'
    },
    dim: {
      name: 'Dim Grey',
      description: 'Soft, low-contrast neutral grey',
      bg: '#2a2b2e', surface: '#36383c', border: '#4a4d52',
      fg: '#d6d7d9', muted: '#a0a2a6', accent: '#9ab8e8'
    },
    sepia: {
      name: 'Sepia Night',
      description: 'Warm brown tones for long reading',
      bg: '#1e1913', surface: '#2c251c', border: '#4a3f30',
      fg: '#eadcc3', muted: '#b9a88b', accent: '#e0a96d'
    },
    nord: {
      name: 'Nord',
      description: 'Arctic, north-bluish palette',
      bg: '#2e3440', surface: '#3b4252', border: '#4c566a',
      fg: '#eceff4', muted: '#c0c8d6', accent: '#88c0d0'
    },
    solarized: {
      name: 'Solarized Dark',
      description: 'The classic teal-tinted dark scheme',
      bg: '#002b36', surface: '#073642', border: '#1f4e5a',
      fg: '#dfe3d6', muted: '#93a1a1', accent: '#268bd2'
    }
  };

  const DEFAULTS = {
    enabled: true,
    theme: 'midnight',
    brightness: 0,     // -20 … 20, shifts background lightness
    contrast: 0,       // -20 … 20, shifts text lightness
    dimImages: false,
    useNativeDark: true, // ask sites for their own dark mode first
    sites: {}          // hostname -> 'auto' | 'on' | 'off'
  };

  /* ---------- colour helpers ---------- */

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  const RGB_RE = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i;

  let probeCtx = null;
  const parseCache = new Map();

  // Parses any CSS colour string into {r,g,b,a}; returns null when it can't.
  function parseColor(str) {
    if (!str) return null;
    str = String(str).trim();
    const cached = parseCache.get(str);
    if (cached !== undefined) return cached;
    let out = null;
    const m = RGB_RE.exec(str);
    if (m) {
      let a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      out = { r: +m[1], g: +m[2], b: +m[3], a };
    } else if (str[0] === '#') {
      out = parseHex(str);
    } else if (str === 'transparent') {
      out = { r: 0, g: 0, b: 0, a: 0 };
    } else if (!/var\(|currentcolor|inherit|initial|unset|revert/i.test(str)) {
      out = parseWithCanvas(str);
    }
    if (parseCache.size > 5000) parseCache.clear();
    parseCache.set(str, out);
    return out;
  }

  function parseHex(str) {
    let h = str.slice(1);
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) return null;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
    };
  }

  // Fallback for named colours, hsl(), oklch(), color(), etc.
  function parseWithCanvas(str) {
    try {
      if (!probeCtx) {
        const c = document.createElement('canvas');
        c.width = c.height = 1;
        probeCtx = c.getContext('2d', { willReadFrequently: true });
      }
      probeCtx.clearRect(0, 0, 1, 1);
      probeCtx.fillStyle = '#010203';
      probeCtx.fillStyle = str;
      if (probeCtx.fillStyle === '#010203' && !/^#010203$/i.test(str)) return null; // invalid
      probeCtx.fillRect(0, 0, 1, 1);
      const d = probeCtx.getImageData(0, 0, 1, 1).data;
      return d[3] === 0 ? { r: 0, g: 0, b: 0, a: 0 } : { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    } catch (e) {
      return null;
    }
  }

  function toCss(c) {
    const r = Math.round(c.r), g = Math.round(c.g), b = Math.round(c.b);
    if (c.a >= 1) return `rgb(${r}, ${g}, ${b})`;
    return `rgba(${r}, ${g}, ${b}, ${+c.a.toFixed(3)})`;
  }

  function rgbToHsl({ r, g, b }) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }

  function hslToRgb(h, s, l, a = 1) {
    if (s === 0) return { r: l * 255, g: l * 255, b: l * 255, a };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = (t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return { r: f(h + 1 / 3) * 255, g: f(h) * 255, b: f(h - 1 / 3) * 255, a };
  }

  // Perceptual lightness (CIE L*), 0 = black, 1 = white.
  function lightness({ r, g, b }) {
    const lin = (v) => {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    const y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const l = y <= 216 / 24389 ? (y * 24389) / 27 : 116 * Math.cbrt(y) - 16;
    return l / 100;
  }

  const chroma = ({ r, g, b }) => (Math.max(r, g, b) - Math.min(r, g, b)) / 255;

  const mix = (a, b, t) => ({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
    a: 1
  });

  function shiftLightness(c, delta) {
    if (!delta) return c;
    const [h, s, l] = rgbToHsl(c);
    return hslToRgb(h, s, clamp(l + delta, 0, 1), c.a);
  }

  /* ---------- palette mapper ---------- */

  // Builds functions that translate an original (light-page) colour into
  // the chosen dark theme. Hue is kept for coloured elements so buttons,
  // links and badges stay recognisable; greys take the theme's own tint.
  function createMapper(themeId, opts = {}) {
    const theme = THEMES[themeId] || THEMES[DEFAULTS.theme];
    const bright = clamp(+opts.brightness || 0, -20, 20) / 100;
    const contrast = clamp(+opts.contrast || 0, -20, 20) / 100;

    const T = {
      bg: shiftLightness(parseHex(theme.bg), bright),
      surface: shiftLightness(parseHex(theme.surface), bright),
      border: shiftLightness(parseHex(theme.border), bright),
      fg: shiftLightness(parseHex(theme.fg), contrast),
      muted: shiftLightness(parseHex(theme.muted), contrast),
      accent: parseHex(theme.accent)
    };
    const borderHi = shiftLightness(T.border, 0.1);
    const surfaceL = rgbToHsl(T.surface)[2];
    const fgL = rgbToHsl(T.fg)[2];

    const caches = { bg: new Map(), fg: new Map(), border: new Map(), icon: new Map() };

    function cached(kind, fn) {
      const cache = caches[kind];
      return (str) => {
        let v = cache.get(str);
        if (v === undefined) {
          const c = parseColor(str);
          v = c && c.a > 0 ? fn(c) : null;
          v = v ? toCss(v) : null;
          cache.set(str, v);
        }
        return v;
      };
    }

    function bgColor(c) {
      const L = lightness(c);
      // Keep dark translucent overlays (modal backdrops, shadows) as they are.
      if (c.a < 0.95 && L < 0.25) return null;
      const t = clamp((1 - L) * 1.5, 0, 1);
      const base = mix(T.bg, T.surface, t);
      const ch = chroma(c);
      if (ch < 0.08) return { ...base, a: c.a };
      const [h] = rgbToHsl(c);
      const baseL = rgbToHsl(base)[2];
      const sat = clamp(0.2 + ch * 0.6, 0, 0.75);
      const l = clamp(baseL + 0.03 + ch * 0.14, 0, Math.max(0.45, surfaceL));
      return hslToRgb(h, sat, l, c.a);
    }

    function fgColor(c) {
      const L = lightness(c);
      const ch = chroma(c);
      if (ch < 0.1) {
        const t = clamp((L - 0.3) / 0.6, 0, 1);
        return { ...mix(T.fg, T.muted, t), a: c.a };
      }
      const [h, s] = rgbToHsl(c);
      const l = clamp(0.72 + contrast + (0.4 - L) * 0.08, 0.6, Math.max(0.85, fgL));
      return hslToRgb(h, clamp(s, 0.35, 0.85), l, c.a);
    }

    function borderColor(c) {
      const ch = chroma(c);
      if (ch < 0.1) {
        const t = clamp(1 - lightness(c), 0, 1) * 0.7;
        return { ...mix(T.border, borderHi, t), a: c.a };
      }
      const [h, s] = rgbToHsl(c);
      return hslToRgb(h, Math.min(s, 0.6), 0.42, c.a);
    }

    // SVG fill/stroke: recolour neutral icons only, keep coloured logos.
    function iconColor(c) {
      return chroma(c) < 0.1 ? fgColor(c) : null;
    }

    const mapBg = cached('bg', bgColor);
    const COLOR_IN_STR = /rgba?\([^)]*\)/g;

    return {
      theme,
      themeId: THEMES[themeId] ? themeId : DEFAULTS.theme,
      colors: {
        bg: toCss(T.bg), surface: toCss(T.surface), border: toCss(T.border),
        fg: toCss(T.fg), muted: toCss(T.muted), accent: toCss(T.accent)
      },
      bg: mapBg,
      fg: cached('fg', fgColor),
      border: cached('border', borderColor),
      icon: cached('icon', iconColor),
      // Remaps every colour stop inside a computed gradient string.
      gradient(str) {
        return str.replace(COLOR_IN_STR, (m) => mapBg(m) || m);
      }
    };
  }

  root.MidnightFox = {
    THEMES,
    DEFAULTS,
    createMapper,
    color: { parseColor, toCss, lightness, chroma, rgbToHsl, hslToRgb, mix }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
