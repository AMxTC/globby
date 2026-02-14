import { proxy, subscribe } from "valtio";

export type Theme = "light" | "dark" | "grey";

const THEMES: Theme[] = ["light", "grey", "dark"];

const stored = localStorage.getItem("theme") as Theme | null;
const initial: Theme = stored && THEMES.includes(stored) ? stored : "dark";

export const themeState = proxy({ theme: initial });

function applyTheme(theme: Theme) {
  const root = document.documentElement.classList;
  root.remove("dark", "grey");
  if (theme !== "light") root.add(theme);
}

// Apply on load
applyTheme(initial);

// Sync changes to DOM + localStorage
subscribe(themeState, () => {
  applyTheme(themeState.theme);
  localStorage.setItem("theme", themeState.theme);
});

export function cycleTheme() {
  const idx = THEMES.indexOf(themeState.theme);
  themeState.theme = THEMES[(idx + 1) % THEMES.length];
}
