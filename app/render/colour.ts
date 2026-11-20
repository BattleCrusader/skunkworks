/**
 * Colour, in the small amount this box needs: parse what a theme or a palette declared, and say how
 * far apart two colours are.
 *
 * ## Why the server needs to read colours at all
 *
 * The brand accent is a tenant token applied over whatever the theme declares. That is only safe if
 * somebody checks it against the ground the theme actually paints — a brand colour chosen on a white
 * page can be invisible on a dark one. The check has to happen where the answer is known (the server,
 * which has the palette and the theme's own `--bg`), not in a browser that may never open the screen.
 *
 * Deliberately no colour library: hex, `rgb()`, `rgba()` and the handful of named colours a theme
 * uses are all this parses, and anything it cannot parse returns `null` — "unknown", never a guess.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
  /** 0-1. `1` for hex and `rgb()`. */
  a: number;
}

const NAMED: Record<string, string> = {
  white: '#ffffff',
  black: '#000000',
  transparent: '#00000000',
};

const HEX = /^#([0-9a-f]{3,8})$/i;
const FUNC = /^rgba?\(\s*([0-9.]+%?)[\s,]+([0-9.]+%?)[\s,]+([0-9.]+%?)(?:[\s,/]+([0-9.]+%?))?\s*\)$/i;

function channel(raw: string): number {
  const pct = raw.endsWith('%');
  const n = Number.parseFloat(pct ? raw.slice(0, -1) : raw);
  if (!Number.isFinite(n)) return 0;
  const value = pct ? (n / 100) * 255 : n;
  return Math.max(0, Math.min(255, Math.round(value)));
}

function alpha(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const pct = raw.endsWith('%');
  const n = Number.parseFloat(pct ? raw.slice(0, -1) : raw);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(1, pct ? n / 100 : n));
}

/** `null` when the value is not a colour this box understands. */
export function parseColour(input: string): Rgb | null {
  const value = input.trim().toLowerCase();
  if (value === '') return null;
  const named = NAMED[value];
  const text = named ?? value;

  const hex = HEX.exec(text);
  if (hex !== null) {
    const digits = hex[1] ?? '';
    const expand = (s: string): string => s.split('').map((c) => `${c}${c}`).join('');
    if (digits.length === 3) {
      const full = expand(digits);
      return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16), a: 1 };
    }
    if (digits.length === 4) {
      const full = expand(digits);
      return {
        r: parseInt(full.slice(0, 2), 16),
        g: parseInt(full.slice(2, 4), 16),
        b: parseInt(full.slice(4, 6), 16),
        a: parseInt(full.slice(6, 8), 16) / 255,
      };
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: parseInt(digits.slice(0, 2), 16),
        g: parseInt(digits.slice(2, 4), 16),
        b: parseInt(digits.slice(4, 6), 16),
        a: digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1,
      };
    }
    return null;
  }

  const fn = FUNC.exec(text);
  if (fn !== null) {
    return { r: channel(fn[1] ?? '0'), g: channel(fn[2] ?? '0'), b: channel(fn[3] ?? '0'), a: alpha(fn[4]) };
  }
  return null;
}

/** WCAG 2.1 relative luminance. */
export function luminance(colour: Rgb): number {
  const f = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(colour.r) + 0.7152 * f(colour.g) + 0.0722 * f(colour.b);
}

/**
 * Contrast ratio between two colours, 1 to 21 — or `null` when either is translucent.
 *
 * Transparency is where a naive ratio lies: a 10%-white panel over a dark page is *not* a light
 * background, and reporting 15:1 for it would tell an operator their brand colour is safe when it is
 * not. `null` means "this box cannot judge it", and callers must not warn on `null`.
 */
export function contrastRatio(a: Rgb, b: Rgb): number | null {
  if (a.a < 0.999 || b.a < 0.999) return null;
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** The last `--name: value` a stylesheet declares, which is the one the cascade would use. */
export function lastCustomProperty(css: string, name: string): string | null {
  const pattern = new RegExp(`${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*:\\s*([^;}]+)`, 'gi');
  let found: string | null = null;
  for (const match of css.matchAll(pattern)) found = (match[1] ?? '').trim();
  return found;
}

/** `#rrggbb`, for the controls that only speak that (`<input type="color">`). */
export function toHex(colour: Rgb): string {
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  return `#${hex(colour.r)}${hex(colour.g)}${hex(colour.b)}`;
}

/** A colour as `#rrggbb`, or the fallback when it is not a colour this box understands. */
export function hexOr(input: string, fallback: string): string {
  const parsed = parseColour(input);
  return parsed === null || parsed.a < 0.999 ? fallback : toHex(parsed);
}
