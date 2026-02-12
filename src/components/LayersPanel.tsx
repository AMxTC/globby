import { useState } from "react";
import { useSnapshot } from "valtio";
import {
  ChevronUp,
  ChevronDown,
  Plus,
  Trash2,
  Layers,
  PanelRightClose,
  PanelRightOpen,
  Eye,
  EyeOff,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Fader } from "./ui/fader";
import {
  sceneState,
  addLayer,
  removeLayer,
  renameLayer,
  setLayerTransferMode,
  setLayerOpacity,
  setLayerTransferParam,
  setActiveLayer,
  toggleLayerVisibility,
  reorderLayers,
} from "../state/sceneStore";
import type { Layer } from "../state/sceneStore";
import type { TransferMode } from "../constants";

const TRANSFER_MODES: { value: TransferMode; label: string }[] = [
  { value: "union", label: "Union" },
  { value: "smooth_union", label: "Smooth Union" },
  { value: "subtract", label: "Subtract" },
  { value: "intersect", label: "Intersect" },
  { value: "addition", label: "Addition" },
  { value: "multiply", label: "Multiply" },
  { value: "pipe", label: "Pipe" },
  { value: "engrave", label: "Engrave" },
];

// Modes that expose a parameter slider
const MODE_PARAM: Partial<Record<TransferMode, string>> = {
  smooth_union: "Smoothness",
  pipe: "Thickness",
  engrave: "Depth",
};

export default function LayersPanel() {
  const snap = useSnapshot(sceneState);
  const [open, setOpen] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const activeLayer = snap.layers.find((l) => l.id === snap.activeLayerId);

  function startEditing(layer: { id: string; name: string }) {
    setEditingId(layer.id);
    setEditName(layer.name);
  }

  function commitEdit() {
    if (editingId && editName.trim()) {
      renameLayer(editingId, editName.trim());
    }
    setEditingId(null);
  }

  const layersReversed = [...snap.layers].reverse();

  if (!open) {
    return (
      <div className="fixed top-3 right-3 z-50">
        <Button
          variant="outline"
          size="icon"
          onClick={() => setOpen(true)}
          title="Show Layers"
          className="bg-accent border-border shadow-md text-muted-foreground"
        >
          <PanelRightOpen size={18} />
        </Button>
      </div>
    );
  }

  return (
    <div className="fixed top-0 right-0 h-full w-56 bg-accent border-l border-border flex flex-col z-50">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border">
        <Layers size={16} className="text-muted-foreground shrink-0" />
        <span className="text-sm font-medium text-foreground flex-1">
          Layers
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          onClick={() => addLayer()}
          title="Add Layer"
        >
          <Plus size={16} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          onClick={() => setOpen(false)}
          title="Collapse Panel"
        >
          <PanelRightClose size={16} />
        </Button>
      </div>

      {/* Active layer controls */}
      {activeLayer && (
        <div className="px-3 py-2.5 border-b border-border space-y-2">
          {/* Opacity */}
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-muted-foreground w-10 shrink-0">
              Opacity
            </label>
            <Fader
              value={activeLayer.opacity}
              onChange={(v) => setLayerOpacity(activeLayer.id, v)}
              display="percent"
              className="flex-1"
            />
          </div>
          {/* Transfer mode */}
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-muted-foreground w-10 shrink-0">
              Mode
            </label>
            <select
              className="flex-1 text-xs bg-background text-foreground rounded-sm border border-border px-1.5 py-1 outline-none focus:ring-1 focus:ring-ring cursor-pointer"
              value={activeLayer.transferMode}
              onChange={(e) =>
                setLayerTransferMode(
                  activeLayer.id,
                  e.target.value as Layer["transferMode"],
                )
              }
            >
              {TRANSFER_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          {/* Mode-specific parameter */}
          {MODE_PARAM[activeLayer.transferMode as TransferMode] && (
            <div className="flex items-center gap-2">
              <label
                className="text-[11px] text-muted-foreground w-10 shrink-0 truncate"
                title={MODE_PARAM[activeLayer.transferMode as TransferMode]}
              >
                {MODE_PARAM[activeLayer.transferMode as TransferMode]}
              </label>
              <Fader
                value={activeLayer.transferParam}
                onChange={(v) => setLayerTransferParam(activeLayer.id, v)}
                display="percent"
                className="flex-1"
              />
            </div>
          )}
        </div>
      )}

      {/* Layer list */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        <div className="p-2 space-y-0.5 flex flex-col gap-1">
          {layersReversed.map((layer) => {
            const isActive = layer.id === snap.activeLayerId;
            const originalIndex = snap.layers.findIndex(
              (l) => l.id === layer.id,
            );

            return (
              <div
                key={layer.id}
                className={cn(
                  "rounded-sm px-2 py-1.5 cursor-pointer transition-colors flex items-center gap-1.5",
                  isActive
                    ? "bg-muted ring-1 ring-primary/50"
                    : "hover:bg-muted/60",
                )}
                onClick={() => setActiveLayer(layer.id)}
              >
                {/* Visibility toggle */}
                <button
                  className={cn(
                    "p-0.5 rounded-sm transition-colors shrink-0",
                    layer.visible
                      ? "text-muted-foreground hover:text-foreground"
                      : "text-muted-foreground/40 hover:text-muted-foreground",
                  )}
                  title={layer.visible ? "Hide Layer" : "Show Layer"}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleLayerVisibility(layer.id);
                  }}
                >
                  {layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                </button>

                {/* Name */}
                <div className="flex-1 min-w-0">
                  {editingId === layer.id ? (
                    <input
                      className="w-full bg-background text-foreground text-sm px-1.5 py-0.5 rounded-sm border border-border outline-none focus:ring-1 focus:ring-ring"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onBlur={commitEdit}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitEdit();
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span
                      className={cn(
                        "block truncate text-sm",
                        isActive
                          ? "text-foreground font-medium"
                          : "text-muted-foreground",
                        !layer.visible && "opacity-50",
                      )}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        startEditing(layer);
                      }}
                      title="Double-click to rename"
                    >
                      {layer.name}
                    </span>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center shrink-0">
                  <button
                    className="p-0.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-25 disabled:pointer-events-none transition-colors"
                    title="Move Up"
                    disabled={originalIndex >= snap.layers.length - 1}
                    onClick={(e) => {
                      e.stopPropagation();
                      reorderLayers(originalIndex, originalIndex + 1);
                    }}
                  >
                    <ChevronUp size={14} />
                  </button>
                  <button
                    className="p-0.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-25 disabled:pointer-events-none transition-colors"
                    title="Move Down"
                    disabled={originalIndex <= 0}
                    onClick={(e) => {
                      e.stopPropagation();
                      reorderLayers(originalIndex, originalIndex - 1);
                    }}
                  >
                    <ChevronDown size={14} />
                  </button>
                  {snap.layers.length > 1 && (
                    <button
                      className="p-0.5 rounded-sm text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                      title="Delete Layer"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeLayer(layer.id);
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
