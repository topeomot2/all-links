/**
 * The preset visual styles a Page selects by id (`CONTEXT.md` — Theme).
 *
 * T2 needs exactly one thing from a Theme — the accent colour the monogram is
 * drawn in — so this ships the seam and a single default. **T4 designs the 4–6
 * presets** (accent, type, layout, monogram treatment) and adds them here; the
 * renderer consumes tokens, so a new Theme is a new entry and nothing else.
 */

export interface Theme {
  id: string;
  /** Human-readable, for the dashboard's theme picker (T11). */
  name: string;
  /** The monogram circle and the link affordances. */
  accent: string;
  /** Text drawn on top of `accent` — the monogram's letter. */
  onAccent: string;
  background: string;
  surface: string;
  text: string;
  muted: string;
}

const SLATE: Theme = {
  id: 'slate',
  name: 'Slate',
  accent: '#4f46e5',
  onAccent: '#ffffff',
  background: '#0b0d12',
  surface: '#161a23',
  text: '#f3f4f6',
  muted: '#9ca3af',
};

export const DEFAULT_THEME_ID = SLATE.id;

export const THEMES: ReadonlyMap<string, Theme> = new Map([[SLATE.id, SLATE]]);

/**
 * An unknown or missing `themeId` resolves to the default. A Page whose Theme
 * was retired must still render — an unstyled document is worse than a
 * differently-styled one.
 */
export function themeById(id: string | undefined): Theme {
  return (id ? THEMES.get(id) : undefined) ?? SLATE;
}

/**
 * The Theme as custom properties, with no selector — the caller places them,
 * so the same tokens serve a `:root` block today and a scoped one later.
 */
export function themeVariables(theme: Theme): string {
  return [
    `--accent:${theme.accent}`,
    `--on-accent:${theme.onAccent}`,
    `--background:${theme.background}`,
    `--surface:${theme.surface}`,
    `--text:${theme.text}`,
    `--muted:${theme.muted}`,
  ].join(';');
}
