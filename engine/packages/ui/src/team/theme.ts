import { useEffect, useState } from "react";

/**
 * Slice C — the appearance preference.
 *
 * `system` is a stored choice, not a third palette: it resolves through the OS's
 * `prefers-color-scheme` each time that query changes, so a reader who leaves the machine on
 * automatic gets the theme their desktop is already using. Only `dark` and `light` reach the
 * shell, which is why the shell's own tokens need no third block.
 */

export const TEAM_THEME_KEY = "openrig.teamTheme";
export const TEAM_THEME_PREFERENCES = ["dark", "light", "system"] as const;
export type TeamThemePreference = (typeof TEAM_THEME_PREFERENCES)[number];
export type TeamTheme = Exclude<TeamThemePreference, "system">;

const COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)";

export function readTeamThemePreference(): TeamThemePreference {
  try {
    const saved = localStorage.getItem(TEAM_THEME_KEY);
    return (TEAM_THEME_PREFERENCES as readonly string[]).includes(saved ?? "") ? saved as TeamThemePreference : "dark";
  } catch {
    return "dark";
  }
}

export function writeTeamTheme(preference: TeamThemePreference): void {
  try {
    localStorage.setItem(TEAM_THEME_KEY, preference);
  } catch {
    // The choice still applies to this load when storage is unavailable.
  }
}

/** The palette a preference resolves to. `system` follows the OS; the other two are explicit. */
export function resolveTeamTheme(preference: TeamThemePreference, prefersDark: boolean): TeamTheme {
  return preference === "system" ? (prefersDark ? "dark" : "light") : preference;
}

function prefersDarkScheme(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia(COLOR_SCHEME_QUERY).matches;
}

/** The stored preference, the palette it resolves to, and a setter that persists a new choice. */
export function useThemePreference(): {
  preference: TeamThemePreference; theme: TeamTheme; setPreference: (next: TeamThemePreference) => void;
} {
  const [preference, setPreference] = useState<TeamThemePreference>(readTeamThemePreference);
  const [prefersDark, setPrefersDark] = useState(prefersDarkScheme);
  useEffect(() => {
    writeTeamTheme(preference);
    // An explicit choice does not need the OS query, and leaving the listener off keeps a
    // stale media object from re-resolving a theme the reader pinned by hand.
    if (preference !== "system" || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(COLOR_SCHEME_QUERY);
    const update = () => setPrefersDark(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [preference]);
  return { preference, theme: resolveTeamTheme(preference, prefersDark), setPreference };
}
