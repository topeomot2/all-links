import { describe, expect, it } from 'vitest';

import { DEFAULT_THEME_ID, THEMES, themeById, themeVariables } from './themes.js';

describe('Themes', () => {
  it('resolves a known id', () => {
    const theme = themeById(DEFAULT_THEME_ID);

    expect(theme.id).toBe(DEFAULT_THEME_ID);
  });

  it('falls back to the default rather than rendering unstyled', () => {
    for (const id of [undefined, '', 'no-such-theme']) {
      expect(themeById(id).id).toBe(DEFAULT_THEME_ID);
    }
  });

  it('gives every theme an accent — the monogram has nothing to draw without one', () => {
    for (const theme of THEMES.values()) {
      expect(theme.accent, theme.id).toMatch(/^#[0-9a-f]{6}$/);
      expect(theme.onAccent, theme.id).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('keys every theme by its own id, so a lookup cannot return a different theme', () => {
    for (const [id, theme] of THEMES) {
      expect(theme.id).toBe(id);
    }
  });

  it('emits custom properties the document can inline, with no selector of its own', () => {
    const css = themeVariables(themeById(DEFAULT_THEME_ID));

    expect(css).toContain('--accent:');
    expect(css).not.toContain('}');
  });
});
