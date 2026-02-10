import { useSnapshot } from "valtio";
import { Sun, Moon } from "lucide-react";
import { themeState, toggleTheme } from "../state/themeStore";
import { Button } from "./ui/button";

export default function ThemeToggle() {
  const { theme } = useSnapshot(themeState);

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggleTheme}
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      className="text-muted-foreground hover:text-foreground rounded-none"
    >
      {theme === "dark" ? <Sun size={20} /> : <Moon size={20} />}
    </Button>
  );
}
