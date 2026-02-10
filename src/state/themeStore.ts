import { proxy, subscribe } from "valtio";

type Theme = "light" | "dark";

const stored = localStorage.getItem("theme") as Theme | null;
const initial: Theme = stored ?? "dark";

export const themeState = proxy({ theme: initial });

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

// Apply on load
applyTheme(initial);

// Sync changes to DOM + localStorage
subscribe(themeState, () => {
  applyTheme(themeState.theme);
  localStorage.setItem("theme", themeState.theme);
});

export function toggleTheme() {
  themeState.theme = themeState.theme === "dark" ? "light" : "dark";
}
