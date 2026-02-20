import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { HOTKEYS, type HotkeyDef } from "../lib/hotkeys";

function formatCombo(combo: HotkeyDef["combo"]): string {
  const parts: string[] = [];
  if (combo.meta) parts.push("⌘");
  if (combo.shift) parts.push("⇧");

  const keyMap: Record<string, string> = {
    Backspace: "⌫",
    Delete: "⌦",
    Escape: "Esc",
    Tab: "⇥",
    " ": "Space",
    "?": "?",
  };

  const display = keyMap[combo.key] ?? combo.key.toUpperCase();
  parts.push(display);
  return parts.join("");
}

export default function ShortcutsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  // Deduplicate by name (e.g. Delete has two combos)
  const seen = new Set<string>();
  const unique: HotkeyDef[] = [];
  for (const h of HOTKEYS) {
    if (seen.has(h.name)) continue;
    seen.add(h.name);
    unique.push(h);
  }

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/40"
      onPointerDown={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div className="w-80 max-h-[80vh] rounded-lg border border-border bg-background text-foreground shadow-xl flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <span className="text-sm font-medium">Keyboard Shortcuts</span>
          <button
            className="p-1 rounded-sm text-muted-foreground hover:text-foreground transition-colors"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        <div className="overflow-y-auto p-2">
          {unique.map((h) => (
            <div
              key={h.name}
              className="flex items-center justify-between px-2 py-1.5 rounded-sm hover:bg-accent/50"
            >
              <div className="min-w-0">
                <div className="text-sm text-foreground">{h.name}</div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {h.description}
                </div>
              </div>
              <kbd className="ml-3 shrink-0 text-xs font-mono bg-muted text-muted-foreground px-1.5 py-0.5 rounded border border-border">
                {formatCombo(h.combo)}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
