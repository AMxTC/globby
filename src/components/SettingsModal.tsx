import { useEffect, useRef } from "react";
import { useSnapshot } from "valtio";
import { X, Layers, Grid3x3, Eye, Bug } from "lucide-react";
import { sceneState } from "../state/sceneStore";
import { Toggle } from "./ui/toggle";
import ThemeToggle from "./ThemeToggle";

const RENDER_LABELS = ["Lit", "Depth", "Normals", "Shape ID", "Iterations"];

export default function SettingsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const snap = useSnapshot(sceneState);
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

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/40"
      onPointerDown={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div className="w-72 rounded-lg border border-border bg-background text-foreground shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <span className="text-sm font-medium">Settings</span>
          <button
            className="p-1 rounded-sm text-muted-foreground hover:text-foreground transition-colors"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">Theme</span>
            <ThemeToggle />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">Ground</span>
            <Toggle
              pressed={snap.showGroundPlane}
              onPressedChange={() => {
                sceneState.showGroundPlane = !sceneState.showGroundPlane;
              }}
              size="icon"
              title="Ground Shadows"
              className="h-7 w-7"
            >
              <Layers size={16} />
            </Toggle>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">Grid</span>
            <Toggle
              pressed={snap.showGrid}
              onPressedChange={() => {
                sceneState.showGrid = !sceneState.showGrid;
              }}
              size="icon"
              title="Grid"
              className="h-7 w-7"
            >
              <Grid3x3 size={16} />
            </Toggle>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">Debug Chunks</span>
            <Toggle
              pressed={snap.showDebugChunks}
              onPressedChange={() => {
                sceneState.showDebugChunks = !sceneState.showDebugChunks;
              }}
              size="icon"
              title="Debug Chunks"
              className="h-7 w-7"
            >
              <Bug size={16} />
            </Toggle>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">Render</span>
            <Toggle
              pressed={snap.renderMode !== 0}
              onPressedChange={() => {
                sceneState.renderMode = ((snap.renderMode + 1) % 5) as
                  | 0
                  | 1
                  | 2
                  | 3
                  | 4;
              }}
              size="icon"
              title={`Render: ${RENDER_LABELS[snap.renderMode]}`}
              className="h-7 w-7"
            >
              <div className="relative">
                <Eye size={16} />
                {snap.renderMode !== 0 && (
                  <span className="absolute -top-1 -right-1.5 text-[7px] font-bold leading-none">
                    {["", "Z", "N", "ID", "It"][snap.renderMode]}
                  </span>
                )}
              </div>
            </Toggle>
          </div>
        </div>
      </div>
    </div>
  );
}
