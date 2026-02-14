import { useState } from "react";
import { useSnapshot } from "valtio";
import { Settings, Eye, Grid3x3, Layers } from "lucide-react";
import { sceneState } from "../state/sceneStore";
import { Button } from "./ui/button";
import { Toggle } from "./ui/toggle";
import ThemeToggle from "./ThemeToggle";

const RENDER_LABELS = ["Lit", "Depth", "Normals", "Shape ID", "Iterations"];

export default function SettingsPanel() {
  const snap = useSnapshot(sceneState);
  const [open, setOpen] = useState(false);

  return (
    <div className="fixed bottom-6 right-6 z-100 flex flex-col items-end gap-2">
      {open && (
        <div className="bg-accent border border-border rounded-md p-3 space-y-3 w-48">
          <span className="text-[11px] text-muted-foreground uppercase tracking-wide">
            Settings
          </span>

          {/* Theme */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-foreground">Theme</span>
            <ThemeToggle />
          </div>

          {/* Ground plane */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-foreground">Ground</span>
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

          {/* Debug chunks */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-foreground">Debug Chunks</span>
            <Toggle
              pressed={snap.showDebugChunks}
              onPressedChange={() => {
                sceneState.showDebugChunks = !sceneState.showDebugChunks;
              }}
              size="icon"
              title="Debug Chunks"
              className="h-7 w-7"
            >
              <Grid3x3 size={16} />
            </Toggle>
          </div>

          {/* Render mode */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-foreground">Render</span>
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
      )}

      <Button
        variant="outline"
        size="icon"
        onClick={() => setOpen(!open)}
        title="Settings"
        className="bg-accent border-border text-muted-foreground hover:text-foreground"
      >
        <Settings size={18} />
      </Button>
    </div>
  );
}
