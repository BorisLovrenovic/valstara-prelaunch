export const themePreferenceKey = 'valstara-theme';

export type Theme = 'dark' | 'light';

export function isTheme(value: string | null): value is Theme {
  return value === 'dark' || value === 'light';
}

export function resolveTheme(
  storedTheme: string | null,
  systemPrefersDark: boolean,
): Theme {
  return isTheme(storedTheme)
    ? storedTheme
    : systemPrefersDark
      ? 'dark'
      : 'light';
}

export function readThemePreference(): Theme | null {
  try {
    const storedTheme = localStorage.getItem('valstara-theme');
    return isTheme(storedTheme) ? storedTheme : null;
  } catch {
    return null;
  }
}

export function writeThemePreference(theme: Theme): void {
  try {
    localStorage.setItem('valstara-theme', theme);
  } catch {
    // The active page can still use its data-theme attribute.
  }
}

export const themeBootstrapScript = String.raw`
  (() => {
    try {
      const theme = localStorage.getItem('valstara-theme');
      if (theme === 'dark' || theme === 'light') {
        document.documentElement.dataset.theme = theme;
      }
    } catch {
      // The CSS media query remains the no-storage fallback.
    }
  })();
`;
