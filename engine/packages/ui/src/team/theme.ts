/**
 * U10 — the team surface has one theme.
 *
 * The direction reviewed and accepted for U10 is a single light paper palette: three themes
 * multiplied every visual decision by three, and the ink skin's video and grain sat behind a
 * diff. The preference is kept as a stored value so a later dark option can read it; the
 * surface always resolves to `light` today.
 */

export const TEAM_THEME_KEY = "openrig.teamTheme";
export const TEAM_THEME_PREFERENCES = ["light"] as const;
export type TeamThemePreference = (typeof TEAM_THEME_PREFERENCES)[number];
export type TeamTheme = TeamThemePreference;

export function readTeamThemePreference(): TeamThemePreference {
  return "light";
}

export function writeTeamTheme(_preference: TeamThemePreference): void {
  // Nothing to persist while there is one palette.
}

export function useThemePreference(): {
  preference: TeamThemePreference; theme: TeamTheme; setPreference: (next: TeamThemePreference) => void;
} {
  return { preference: "light", theme: "light", setPreference: writeTeamTheme };
}