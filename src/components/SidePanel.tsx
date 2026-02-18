import { useState, useRef, useCallback, useEffect } from "react";
import { useSnapshot } from "valtio";
import {
  ChevronUp,
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  Layers,
  PanelRightClose,
  PanelRightOpen,
  Eye,
  EyeOff,
  SlidersHorizontal,
  SquareFunction,
  Settings,
  Grid3x3,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Fader } from "./ui/fader";
import { NumberInput } from "./ui/number-input";
import { Toggle } from "./ui/toggle";
import ThemeToggle from "./ThemeToggle";
import {
  sceneState,
  pushUndo,
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
  setShapeFx,
  setLayerFx,
  setShapeFxParams,
  setLayerFxParams,
  recenterPolygon,
  setShapeCapped,
  setShapeWallThickness,
} from "../state/sceneStore";
import { FxEditor } from "./FxEditor";
import type { Layer, Vec3 } from "../state/sceneStore";
import type { TransferMode, ShapeType } from "../constants";

const TRANSFER_MODES: { value: TransferMode; label: string }[] = [
  { value: "union", label: "Union" },
  { value: "smooth_union", label: "Smooth Union" },
  { value: "subtract", label: "Subtract" },
  { value: "smooth_subtract", label: "Smooth Subtract" },
  { value: "intersect", label: "Intersect" },
  { value: "addition", label: "Addition" },
  { value: "multiply", label: "Multiply" },
  { value: "pipe", label: "Pipe" },
  { value: "engrave", label: "Engrave" },
];

const MODE_PARAM: Partial<Record<TransferMode, string>> = {
  smooth_union: "Smoothness",
  smooth_subtract: "Smoothness",
  pipe: "Thickness",
  engrave: "Depth",
};

const RENDER_LABELS = ["Lit", "Depth", "Normals", "Shape ID", "Iterations"];

const MIN_SECTION_HEIGHT = 80;
const HEADER_HEIGHT = 33;
const DIVIDER_HEIGHT = 4;
const DEG = Math.PI / 180;

type SectionKey = "settings" | "layers" | "properties";
const SECTION_KEYS: SectionKey[] = ["settings", "layers", "properties"];

// --- Small sub-components ---

function SectionHeader({
  icon: Icon,
  title,
  collapsed,
  onToggle,
  actions,
}: {
  icon: LucideIcon;
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  actions?: React.ReactNode;
}) {
  return (
    <div
      className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0 cursor-pointer select-none"
      onClick={onToggle}
    >
      <ChevronRight
        size={12}
        className={cn(
          "transition-transform text-muted-foreground",
          !collapsed && "rotate-90",
        )}
      />
      <Icon size={14} className="text-muted-foreground" />
      <span className="text-xs font-medium text-foreground flex-1">
        {title}
      </span>
      {actions}
    </div>
  );
}

function FxSection({
  enabled,
  onToggle,
  expanded,
  onToggleExpand,
  code,
  onChange,
  fxParams,
  onFxParamsChange,
  onStart,
  error,
  compiling,
}: {
  enabled: boolean;
  onToggle: () => void;
  expanded: boolean;
  onToggleExpand: () => void;
  code: string;
  onChange: (code: string) => void;
  fxParams: Vec3;
  onFxParamsChange: (params: Vec3) => void;
  onStart?: () => void;
  error: string | null;
  compiling?: boolean;
}) {
  return (
    <div>
      <div className="flex items-center gap-1">
        <button
          className={cn(
            "flex items-center gap-1 text-[11px] transition-colors",
            enabled
              ? "text-primary"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={onToggle}
          title={enabled ? "Disable Fx" : "Enable Fx"}
        >
          <SquareFunction size={14} />
          <span>Fx</span>
        </button>
        {compiling && (
          <span className="text-[10px] text-muted-foreground animate-pulse ml-1">
            compiling...
          </span>
        )}
        <button
          className="p-0.5 rounded-sm text-muted-foreground hover:text-foreground transition-colors ml-auto"
          onClick={onToggleExpand}
        >
          <ChevronRight
            size={12}
            className={cn("transition-transform", expanded && "rotate-90")}
          />
        </button>
      </div>
      {expanded && (
        <div className="mt-1">
          <FxEditor
            code={code}
            onChange={onChange}
            fxParams={fxParams}
            onFxParamsChange={onFxParamsChange}
            onStart={onStart}
            error={error}
            readOnly={!enabled}
          />
        </div>
      )}
    </div>
  );
}

function DragDivider({
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
}) {
  return (
    <div
      className="h-1 cursor-row-resize bg-border hover:bg-primary/40 transition-colors shrink-0"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
}

// --- Divider drag hook ---

function useDividerDrag(
  sectionHeights: Record<SectionKey, number>,
  setSectionHeights: React.Dispatch<
    React.SetStateAction<Record<SectionKey, number>>
  >,
) {
  // Snapshot start state on pointer down, use delta approach on move
  const dragState = useRef<{
    above: SectionKey;
    below: SectionKey;
    startY: number;
    startAboveHeight: number;
    startBelowHeight: number;
  } | null>(null);

  const onPointerDown = useCallback(
    (above: SectionKey, below: SectionKey) => (e: React.PointerEvent) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragState.current = {
        above,
        below,
        startY: e.clientY,
        startAboveHeight: sectionHeights[above],
        startBelowHeight: sectionHeights[below],
      };
    },
    [sectionHeights],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragState.current;
      if (!drag) return;

      const delta = e.clientY - drag.startY;
      const totalSpace = drag.startAboveHeight + drag.startBelowHeight;
      const newAbove = Math.max(
        MIN_SECTION_HEIGHT,
        Math.min(
          totalSpace - MIN_SECTION_HEIGHT,
          drag.startAboveHeight + delta,
        ),
      );
      const newBelow = totalSpace - newAbove;

      setSectionHeights((prev) => ({
        ...prev,
        [drag.above]: newAbove,
        [drag.below]: newBelow,
      }));
    },
    [setSectionHeights],
  );

  const onPointerUp = useCallback(() => {
    dragState.current = null;
  }, []);

  return { onPointerDown, onPointerMove, onPointerUp };
}

// --- Section height management ---

function getExpandedKeys(collapsed: Record<SectionKey, boolean>): SectionKey[] {
  return SECTION_KEYS.filter((k) => !collapsed[k]);
}

function initSectionHeights(
  containerHeight: number,
  collapsed: Record<SectionKey, boolean>,
): Record<SectionKey, number> {
  const expandedKeys = getExpandedKeys(collapsed);
  if (expandedKeys.length === 0)
    return { settings: 0, layers: 0, properties: 0 };
  const headerTotal = SECTION_KEYS.length * HEADER_HEIGHT;
  const dividerCount = Math.max(0, expandedKeys.length - 1);
  const available =
    containerHeight - headerTotal - dividerCount * DIVIDER_HEIGHT;
  const each = Math.max(MIN_SECTION_HEIGHT, available / expandedKeys.length);
  return { settings: each, layers: each, properties: each };
}

function collapseSection(
  key: SectionKey,
  collapsed: Record<SectionKey, boolean>,
  sectionHeights: Record<SectionKey, number>,
): {
  collapsed: Record<SectionKey, boolean>;
  heights: Record<SectionKey, number>;
} | null {
  const expandedKeys = getExpandedKeys(collapsed);
  if (expandedKeys.length <= 1) return null;

  const idx = SECTION_KEYS.indexOf(key);
  const remaining = expandedKeys.filter((k) => k !== key);
  const recipient =
    remaining.find((k) => SECTION_KEYS.indexOf(k) > idx) ??
    remaining[remaining.length - 1];

  return {
    collapsed: { ...collapsed, [key]: true },
    heights: {
      ...sectionHeights,
      [key]: 0,
      [recipient]: sectionHeights[recipient] + sectionHeights[key],
    },
  };
}

function expandSection(
  key: SectionKey,
  collapsed: Record<SectionKey, boolean>,
  sectionHeights: Record<SectionKey, number>,
): {
  collapsed: Record<SectionKey, boolean>;
  heights: Record<SectionKey, number>;
} {
  const expandedKeys = getExpandedKeys(collapsed);
  const totalExpanded = expandedKeys.reduce(
    (sum, k) => sum + sectionHeights[k],
    0,
  );

  const newCount = expandedKeys.length + 1;
  const share = totalExpanded / newCount;
  const scale = totalExpanded > 0 ? (totalExpanded - share) / totalExpanded : 0;

  const heights = { ...sectionHeights };
  for (const k of expandedKeys) {
    heights[k] = sectionHeights[k] * scale;
  }
  heights[key] = share;

  return { collapsed: { ...collapsed, [key]: false }, heights };
}

// --- Main component ---

export default function SidePanel() {
  const snap = useSnapshot(sceneState);
  const [open, setOpen] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [showLayerFx, setShowLayerFx] = useState(false);
  const [showShapeFx, setShowShapeFx] = useState(false);

  const [collapsed, setCollapsed] = useState<Record<SectionKey, boolean>>({
    settings: true,
    layers: false,
    properties: false,
  });

  const [sectionHeights, setSectionHeights] = useState<
    Record<SectionKey, number>
  >({
    settings: 0,
    layers: 0,
    properties: 0,
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);

  const activeLayer = snap.layers.find((l) => l.id === snap.activeLayerId);
  const selectedShape =
    snap.selectedShapeIds.length === 1
      ? snap.shapes.find((s) => s.id === snap.selectedShapeIds[0])
      : null;

  // Initialize section heights from container on first render
  useEffect(() => {
    if (initializedRef.current || !containerRef.current) return;
    setSectionHeights(
      initSectionHeights(containerRef.current.clientHeight, collapsed),
    );
    initializedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const {
    onPointerDown: dividerPointerDown,
    onPointerMove: dividerPointerMove,
    onPointerUp: dividerPointerUp,
  } = useDividerDrag(sectionHeights, setSectionHeights);

  function toggleSection(key: SectionKey) {
    if (!collapsed[key]) {
      const result = collapseSection(key, collapsed, sectionHeights);
      if (!result) return;
      setCollapsed(result.collapsed);
      setSectionHeights(result.heights);
    } else {
      const result = expandSection(key, collapsed, sectionHeights);
      setCollapsed(result.collapsed);
      setSectionHeights(result.heights);
    }
  }

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
      className="fixed top-0 right-0 h-full w-56 bg-accent border-l border-border flex flex-col z-50 overflow-hidden"
    >
      {/* === Settings Section === */}
      <SectionHeader
        icon={Settings}
        title="Settings"
        collapsed={collapsed.settings}
        onToggle={() => toggleSection("settings")}
        actions={
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
            title="Collapse Panel"
          >
            <PanelRightClose size={16} />
          </Button>
        }
      />
      {!collapsed.settings && (
        <div
          className="overflow-y-auto overflow-x-hidden min-h-0"
          style={{ height: sectionHeights.settings }}
        >
          <SettingsBody />
        </div>
      )}

      {/* Divider between Settings and Layers */}
      {!collapsed.settings && !collapsed.layers && (
        <DragDivider
          onPointerDown={dividerPointerDown("settings", "layers")}
          onPointerMove={dividerPointerMove}
          onPointerUp={dividerPointerUp}
        />
      )}

      {/* === Layers Section === */}
      <SectionHeader
        icon={Layers}
        title="Layers"
        collapsed={collapsed.layers}
        onToggle={() => toggleSection("layers")}
      />
      {!collapsed.layers && (
        <div
          className="flex flex-col min-h-0 overflow-hidden"
          style={{ height: sectionHeights.layers }}
        >
          {/* Active layer controls */}
          {activeLayer && (
            <div className="px-3 py-2.5 border-b border-border space-y-2 shrink-0">
              <div className="flex items-center gap-2">
                <label className="text-[11px] text-muted-foreground w-10 shrink-0">
                  Strength
                </label>
                <Fader
                  value={activeLayer.opacity}
                  onStart={pushUndo}
                  onChange={(v) => setLayerOpacity(activeLayer.id, v)}
                  display="percent"
                  className="flex-1"
                />
              </div>
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
                    onStart={pushUndo}
                    onChange={(v) => setLayerTransferParam(activeLayer.id, v)}
                    display="percent"
                    className="flex-1"
                  />
                </div>
              )}
              <FxSection
                enabled={activeLayer.fx != null}
                onToggle={() =>
                  setLayerFx(
                    activeLayer.id,
                    activeLayer.fx != null ? undefined : "return distance;",
                  )
                }
                expanded={showLayerFx}
                onToggleExpand={() => setShowLayerFx(!showLayerFx)}
                code={activeLayer.fx ?? "return distance;"}
                onChange={(c) => setLayerFx(activeLayer.id, c)}
                fxParams={(activeLayer.fxParams ?? [0, 0, 0]) as Vec3}
                onFxParamsChange={(p) => setLayerFxParams(activeLayer.id, p)}
                onStart={pushUndo}
                error={snap.fxError}
                compiling={snap.fxCompiling}
              />
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

                    {layer.fx != null && (
                      <span
                        title="Has fx"
                        className="shrink-0 text-muted-foreground flex items-center"
                      >
                        <SquareFunction size={14} />
                      </span>
                    )}

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
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Add / Delete layer buttons */}
          <div className="flex items-center gap-1 px-2 py-1.5 border-t border-border shrink-0 justify-end">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={() => addLayer()}
              title="Add Layer"
            >
              <Plus size={16} />
            </Button>
            {snap.layers.length > 1 && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                onClick={() => removeLayer(snap.activeLayerId)}
                title="Delete Layer"
              >
                <Trash2 size={16} />
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Divider between Layers and Properties */}
      {!collapsed.layers && !collapsed.properties && (
        <DragDivider
          onPointerDown={dividerPointerDown("layers", "properties")}
          onPointerMove={dividerPointerMove}
          onPointerUp={dividerPointerUp}
        />
      )}

      {/* === Properties Section === */}
      <SectionHeader
        icon={SlidersHorizontal}
        title="Properties"
        collapsed={collapsed.properties}
        onToggle={() => toggleSection("properties")}
      />
      {!collapsed.properties && (
        <div
          className="flex-1 overflow-y-auto overflow-x-hidden min-h-0"
          style={{ height: sectionHeights.properties }}
        >
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
              fx={selectedShape.fx}
              fxParams={(selectedShape.fxParams ?? [0, 0, 0]) as Vec3}
              fxError={snap.fxError}
              showShapeFx={showShapeFx}
              onToggleShapeFx={() => setShowShapeFx(!showShapeFx)}
              capped={selectedShape.capped}
              wallThickness={selectedShape.wallThickness}
            />
          ) : snap.selectedShapeIds.length > 1 ? (
            <div className="flex items-center justify-center h-full text-[11px] text-muted-foreground">
              {snap.selectedShapeIds.length} shapes selected
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-[11px] text-muted-foreground">
              No selection
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Settings body ---

function SettingsBody() {
  const snap = useSnapshot(sceneState);

  return (
    <div className="p-3 space-y-3">
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
          <Grid3x3 size={16} />
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
  polygon: [
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
  fx,
  fxParams,
  capped,
  wallThickness,
  fxError,
  showShapeFx,
  onToggleShapeFx,
}: {
  shapeId: string;
  shapeType: ShapeType;
  size: Vec3;
  position: Vec3;
  rotation: Vec3;
  scale: number;
  layerId: string;
  layers: Layer[];
  fx?: string;
  fxParams: Vec3;
  fxError: string | null;
  capped?: boolean;
  wallThickness?: number;
  showShapeFx: boolean;
  onToggleShapeFx: () => void;
}) {
  const params = SHAPE_PARAMS[shapeType];

  return (
    <div className="p-3 space-y-3">
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
              onStart={pushUndo}
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

      {shapeType === "polygon" && (
        <>
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-muted-foreground w-10 shrink-0">
              Capped
            </label>
            <Toggle
              pressed={capped !== false}
              onPressedChange={(v) => setShapeCapped(shapeId, v)}
              size="sm"
              className="h-7 px-2 text-[11px]"
            >
              {capped !== false ? "On" : "Off"}
            </Toggle>
          </div>
          {capped === false && (
            <div className="flex items-center gap-2">
              <label className="text-[11px] text-muted-foreground w-10 shrink-0">
                Wall
              </label>
              <NumberInput
                value={wallThickness ?? 0.03}
                onStart={pushUndo}
                onChange={(v) => setShapeWallThickness(shapeId, v)}
                step={0.01}
                precision={2}
                min={0.01}
                max={0.5}
              />
            </div>
          )}
        </>
      )}

      <div className="space-y-1">
        <span className="text-[11px] text-muted-foreground uppercase tracking-wide">
          Position
        </span>
        <div className="flex items-center gap-1">
          {(["X", "Y", "Z"] as const).map((axis, i) => (
            <div
              key={axis}
              className="flex-1 min-w-0 flex items-center gap-0.5"
            >
              <label className="text-[10px] text-muted-foreground shrink-0">
                {axis}
              </label>
              <NumberInput
                value={position[i]}
                onStart={pushUndo}
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

      <div className="space-y-1">
        <span className="text-[11px] text-muted-foreground uppercase tracking-wide">
          Rotation
        </span>
        <div className="flex items-center gap-1">
          {(["X", "Y", "Z"] as const).map((axis, i) => (
            <div
              key={axis}
              className="flex-1 min-w-0 flex items-center gap-0.5"
            >
              <label className="text-[10px] text-muted-foreground shrink-0">
                {axis}
              </label>
              <NumberInput
                value={rotation[i] / DEG}
                onStart={pushUndo}
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
            onStart={pushUndo}
            onChange={(v) => {
              scaleShape(shapeId, size, undefined, v);
            }}
            step={0.01}
            precision={2}
            min={0.01}
          />
        </div>
      </div>

      <FxSection
        enabled={fx != null}
        onToggle={() =>
          setShapeFx(shapeId, fx != null ? undefined : "return distance;")
        }
        expanded={showShapeFx}
        onToggleExpand={onToggleShapeFx}
        code={fx ?? "return distance;"}
        onChange={(c) => setShapeFx(shapeId, c)}
        fxParams={fxParams}
        onFxParamsChange={(p) => setShapeFxParams(shapeId, p)}
        onStart={pushUndo}
        error={fxError}
      />
    </div>
  );
}
