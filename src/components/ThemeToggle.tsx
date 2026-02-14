import { useSnapshot } from "valtio";
import { Sun, Moon, CloudSun } from "lucide-react";
import { themeState, cycleTheme } from "../state/themeStore";
import { Button } from "./ui/button";

const ICONS = {
  light: Sun,
  grey: CloudSun,
  dark: Moon,
} as const;

const LABELS = {
  light: "Light",
  grey: "Grey",
  dark: "Dark",
} as const;

export default function ThemeToggle() {
  const { theme } = useSnapshot(themeState);
  const Icon = ICONS[theme];

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={cycleTheme}
      title={`Theme: ${LABELS[theme]}`}
      className="text-muted-foreground hover:text-foreground rounded-none h-7 w-7"
    >
      <Icon size={20} />
    </Button>
  );
}
