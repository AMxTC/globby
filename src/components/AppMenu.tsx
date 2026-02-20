import { useState, useEffect, useRef } from "react";
import { EllipsisVertical, FilePlus, Settings, Keyboard } from "lucide-react";
import { Button } from "./ui/button";
import { resetScene } from "../state/sceneStore";
import SettingsModal from "./SettingsModal";
import ShortcutsModal from "./ShortcutsModal";

const itemClass =
  "flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground transition-colors text-left";

export default function AppMenu() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Close menu on click-outside or Escape
  useEffect(() => {
    if (!menuOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setMenuOpen(false);
      }
    }
    function onClickOutside(e: MouseEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        btnRef.current &&
        !btnRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    }
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onClickOutside, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onClickOutside, true);
    };
  }, [menuOpen]);

  return (
    <>
      <div className="fixed top-3 left-3 z-50">
        <Button
          ref={btnRef}
          variant="outline"
          size="icon"
          onClick={() => setMenuOpen((v) => !v)}
          title="Menu"
          className="bg-accent border-border text-muted-foreground"
        >
          <EllipsisVertical size={18} />
        </Button>

        {menuOpen && (
          <div
            ref={menuRef}
            className="absolute left-0 top-full mt-1 min-w-[180px] rounded-md border border-border bg-background text-foreground shadow-md py-1"
          >
            <button
              className={itemClass}
              onClick={() => {
                setMenuOpen(false);
                if (
                  window.confirm(
                    "Create a new scene? All unsaved work will be lost.",
                  )
                ) {
                  resetScene();
                }
              }}
            >
              <FilePlus size={14} className="shrink-0" />
              <span className="flex-1">New...</span>
            </button>

            <div className="my-1 h-px bg-border" />

            <button
              className={itemClass}
              onClick={() => {
                setMenuOpen(false);
                setSettingsOpen(true);
              }}
            >
              <Settings size={14} className="shrink-0" />
              <span className="flex-1">Settings...</span>
            </button>

            <button
              className={itemClass}
              onClick={() => {
                setMenuOpen(false);
                setShortcutsOpen(true);
              }}
            >
              <Keyboard size={14} className="shrink-0" />
              <span className="flex-1">Shortcuts</span>
            </button>
          </div>
        )}
      </div>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
      <ShortcutsModal
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />
    </>
  );
}
