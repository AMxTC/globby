import { useState, useRef, useCallback } from "react";
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
  SlidersHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Fader } from "./ui/fader";
import { NumberInput } from "./ui/number-input";
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
  moveShapeToLayer,
  moveShape,
  rotateShape,
  scaleShape,
} from "../state/sceneStore";
import type { Layer, Vec3 } from "../state/sceneStore";
import type { TransferMode, ShapeType } from "../constants";

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

const MIN_SECTION_HEIGHT = 120;
const DEG = Math.PI / 180;

export default function SidePanel() {
  const snap = useSnapshot(sceneState);
  const [open, setOpen] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [topHeight, setTopHeight] = useState<number | null>(null); // null = 50%

  const containerRef = useRef<HTMLDivElement>(null);
  const draggingDivider = useRef(false);

  const activeLayer = snap.layers.find((l) => l.id === snap.activeLayerId);
  const selectedShape = snap.selectedShapeId
    ? snap.shapes.find((s) => s.id === snap.selectedShapeId)
    : null;

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

  // --- Divider drag ---
  const onDividerPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      draggingDivider.current = true;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [],
  );

  const onDividerPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingDivider.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const maxHeight = rect.height - MIN_SECTION_HEIGHT;
      const newTop = Math.max(
        MIN_SECTION_HEIGHT,
        Math.min(maxHeight, e.clientY - rect.top),
      );
      setTopHeight(newTop);
    },
    [],
  );

  const onDividerPointerUp = useCallback(() => {
    draggingDivider.current = false;
  }, []);

  if (!open) {
    return (
      <div className="fixed top-3 right-3 z-50">
        <Button
          variant="outline"
          size="icon"
          onClick={() => setOpen(true)}
          title="Show Layers"
          className="bg-accent border-border text-muted-foreground"
        >
          <PanelRightOpen size={18} />
        </Button>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="fixed top-0 right-0 h-full w-56 bg-accent border-l border-border flex flex-col z-50"
    >
      {/* === TOP SECTION: Layers === */}
      <div
        className="flex flex-col min-h-0 overflow-hidden"
        style={{ height: topHeight ?? "50%" }}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border shrink-0">
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
          <div className="px-3 py-2.5 border-b border-border space-y-2 shrink-0">
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

      {/* === DRAG DIVIDER === */}
      <div
        className="h-1 cursor-row-resize bg-border hover:bg-primary/40 transition-colors shrink-0"
        onPointerDown={onDividerPointerDown}
        onPointerMove={onDividerPointerMove}
        onPointerUp={onDividerPointerUp}
      />

      {/* === BOTTOM SECTION: Properties === */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {/* Properties header */}
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border shrink-0">
          <SlidersHorizontal
            size={16}
            className="text-muted-foreground shrink-0"
          />
          <span className="text-sm font-medium text-foreground flex-1">
            Properties
          </span>
        </div>

        {/* Properties content */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          {selectedShape ? (
            <PropertiesContent
              shapeId={selectedShape.id}
              shapeType={selectedShape.type as ShapeType}
              size={[...selectedShape.size] as Vec3}
              position={[...selectedShape.position] as Vec3}
              rotation={[...selectedShape.rotation] as Vec3}
              scale={selectedShape.scale}
              layerId={selectedShape.layerId}
              layers={snap.layers as Layer[]}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-[11px] text-muted-foreground">
              No selection
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Shape parameter configs ---

interface ShapeParamDef {
  label: string;
  get: (size: Vec3) => number;
  set: (size: Vec3, v: number) => Vec3;
}

const SHAPE_PARAMS: Record<ShapeType, ShapeParamDef[]> = {
  box: [
    {
      label: "Width",
      get: (s) => s[0] * 2,
      set: (s, v) => [v / 2, s[1], s[2]],
    },
    {
      label: "Height",
      get: (s) => s[1] * 2,
      set: (s, v) => [s[0], v / 2, s[2]],
    },
    {
      label: "Depth",
      get: (s) => s[2] * 2,
      set: (s, v) => [s[0], s[1], v / 2],
    },
  ],
  sphere: [
    {
      label: "Radius",
      get: (s) => s[0],
      set: (_s, v) => [v, v, v],
    },
  ],
  cylinder: [
    {
      label: "Radius",
      get: (s) => s[0],
      set: (s, v) => [v, s[1], v],
    },
    {
      label: "Height",
      get: (s) => s[1] * 2,
      set: (s, v) => [s[0], v / 2, s[2]],
    },
  ],
  pyramid: [
    {
      label: "Base",
      get: (s) => s[0] * 2,
      set: (s, v) => [v / 2, s[1], v / 2],
    },
    {
      label: "Height",
      get: (s) => s[1] * 2,
      set: (s, v) => [s[0], v / 2, s[2]],
    },
  ],
  cone: [
    {
      label: "Radius",
      get: (s) => s[0],
      set: (s, v) => [v, s[1], v],
    },
    {
      label: "Height",
      get: (s) => s[1] * 2,
      set: (s, v) => [s[0], v / 2, s[2]],
    },
  ],
};

// --- Properties content ---

function PropertiesContent({
  shapeId,
  shapeType,
  size,
  position,
  rotation,
  scale,
  layerId,
  layers,
}: {
  shapeId: string;
  shapeType: ShapeType;
  size: Vec3;
  position: Vec3;
  rotation: Vec3;
  scale: number;
  layerId: string;
  layers: Layer[];
}) {
  const params = SHAPE_PARAMS[shapeType];

  return (
    <div className="p-3 space-y-3">
      {/* Layer assignment */}
      <div className="flex items-center gap-2">
        <label className="text-[11px] text-muted-foreground w-10 shrink-0">
          Layer
        </label>
        <select
          className="flex-1 text-xs bg-background text-foreground rounded-sm border border-border px-1.5 py-1 outline-none focus:ring-1 focus:ring-ring cursor-pointer"
          value={layerId}
          onChange={(e) => moveShapeToLayer(shapeId, e.target.value)}
        >
          {layers.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </div>

      {/* Shape parameters */}
      <div className="space-y-1.5">
        <span className="text-[11px] text-muted-foreground uppercase tracking-wide">
          {shapeType.charAt(0).toUpperCase() + shapeType.slice(1)}
        </span>
        {params.map((p) => (
          <div key={p.label} className="flex items-center gap-2">
            <label className="text-[11px] text-muted-foreground w-10 shrink-0">
              {p.label}
            </label>
            <NumberInput
              value={p.get(size)}
              onChange={(v) => {
                const newSize = p.set(size, v);
                scaleShape(shapeId, newSize as Vec3);
              }}
              step={0.01}
              precision={2}
              min={0.01}
            />
          </div>
        ))}
      </div>

      {/* Position */}
      <div className="space-y-1">
        <span className="text-[11px] text-muted-foreground uppercase tracking-wide">
          Position
        </span>
        <div className="flex items-center gap-1">
          {(["X", "Y", "Z"] as const).map((axis, i) => (
            <div key={axis} className="flex-1 min-w-0 flex items-center gap-0.5">
              <label className="text-[10px] text-muted-foreground shrink-0">
                {axis}
              </label>
              <NumberInput
                value={position[i]}
                onChange={(v) => {
                  const newPos = [...position] as Vec3;
                  newPos[i] = v;
                  moveShape(shapeId, newPos);
                }}
                step={0.01}
                precision={2}
                className="flex-1 w-0"
              />
            </div>
          ))}
        </div>
      </div>

      {/* Rotation */}
      <div className="space-y-1">
        <span className="text-[11px] text-muted-foreground uppercase tracking-wide">
          Rotation
        </span>
        <div className="flex items-center gap-1">
          {(["X", "Y", "Z"] as const).map((axis, i) => (
            <div key={axis} className="flex-1 min-w-0 flex items-center gap-0.5">
              <label className="text-[10px] text-muted-foreground shrink-0">
                {axis}
              </label>
              <NumberInput
                value={rotation[i] / DEG}
                onChange={(v) => {
                  const newRot = [...rotation] as Vec3;
                  newRot[i] = v * DEG;
                  rotateShape(shapeId, newRot);
                }}
                step={1}
                precision={0}
                className="flex-1 w-0"
              />
            </div>
          ))}
        </div>
      </div>

      {/* Scale */}
      <div className="space-y-1.5">
        <span className="text-[11px] text-muted-foreground uppercase tracking-wide">
          Scale
        </span>
        <div className="flex items-center gap-2">
          <label className="text-[11px] text-muted-foreground w-10 shrink-0">
            Uniform
          </label>
          <NumberInput
            value={scale}
            onChange={(v) => {
              scaleShape(shapeId, size, undefined, v);
            }}
            step={0.01}
            precision={2}
            min={0.01}
          />
        </div>
      </div>
    </div>
  );
}
