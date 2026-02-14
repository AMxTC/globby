import { proxy } from "valtio";
import { SHAPE_TYPES, type ShapeType, type TransferMode } from "../constants";

export type Vec3 = [number, number, number];

export interface SDFShape {
  id: string;
  type: ShapeType;
  position: Vec3;
  rotation: Vec3;   // Euler angles [rx, ry, rz] radians, XYZ intrinsic
  size: Vec3;
  scale: number;    // Uniform scale (>0), default 1
  layerId: string;
  fx?: string;      // WGSL function body, undefined = identity
}

export interface Layer {
  id: string;
  name: string;
  transferMode: TransferMode;
  opacity: number; // 0..1
  transferParam: number; // 0..1, mode-specific parameter
  visible: boolean;
  fx?: string;     // WGSL function body, undefined = identity
}

export interface DragState {
  active: boolean;
  phase: "idle" | "base" | "height" | "radius";
  startPoint: Vec3;
  baseFloorY: number;
  baseHalfX: number;
  baseHalfZ: number;
  baseMidX: number;
  baseMidZ: number;
  baseRadius: number;
  previewPosition: Vec3;
  previewSize: Vec3;
}

export const sceneState = proxy({
  shapes: [
    { id: "1", type: "box", position: [0, 0.5, 0] as Vec3, rotation: [0, 0, 0] as Vec3, size: [0.5, 0.5, 0.5] as Vec3, scale: 1, layerId: "1" },
  ] as SDFShape[],
  layers: [
    { id: "1", name: "Layer 1", transferMode: "union", opacity: 1, transferParam: 0.5, visible: true },
  ] as Layer[],
  activeLayerId: "1" as string,
  activeTool: "select" as "select" | ShapeType,
  selectedShapeId: null as string | null,
  editMode: "object" as "object" | "edit",
  showDebugChunks: false,
  showGroundPlane: true,
  renderMode: 0 as 0 | 1 | 2 | 3 | 4, // 0=lit, 1=depth, 2=normals, 3=shape ID, 4=iterations
  drag: {
    active: false,
    phase: "idle",
    startPoint: [0, 0, 0] as Vec3,
    baseFloorY: 0,
    baseHalfX: 0,
    baseHalfZ: 0,
    baseMidX: 0,
    baseMidZ: 0,
    baseRadius: 0,
    previewPosition: [0, 0, 0] as Vec3,
    previewSize: [0.01, 0.01, 0.01] as Vec3,
  } as DragState,
  fxError: null as string | null,
  fxCompiling: false,
  version: 1,
});

let nextId = 2; // Shape "1" (default cube) already exists
let nextLayerId = 2; // Layer "1" already exists

// --- Undo/Redo ---

type ShapeSnapshot = {
  id: string;
  type: ShapeType;
  position: Vec3;
  rotation: Vec3;
  size: Vec3;
  scale: number;
  layerId: string;
  fx?: string;
}[];

interface SceneSnapshot {
  shapes: ShapeSnapshot;
  layers: Layer[];
  activeLayerId: string;
}

const MAX_UNDO = 100;
const undoStack: SceneSnapshot[] = [];
const redoStack: SceneSnapshot[] = [];

function snapshot(): SceneSnapshot {
  return {
    shapes: sceneState.shapes.map((s) => ({
      id: s.id,
      type: s.type,
      position: [...s.position] as Vec3,
      rotation: [...s.rotation] as Vec3,
      size: [...s.size] as Vec3,
      scale: s.scale,
      layerId: s.layerId,
      fx: s.fx,
    })),
    layers: sceneState.layers.map((l) => ({ ...l })),
    activeLayerId: sceneState.activeLayerId,
  };
}

function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
}

function restore(snap: SceneSnapshot) {
  sceneState.shapes.splice(0, sceneState.shapes.length, ...snap.shapes);
  sceneState.layers.splice(0, sceneState.layers.length, ...snap.layers);
  sceneState.activeLayerId = snap.activeLayerId;
  // Keep nextId above any restored id
  for (const s of snap.shapes) {
    const n = Number(s.id);
    if (n >= nextId) nextId = n + 1;
  }
  for (const l of snap.layers) {
    const n = Number(l.id);
    if (n >= nextLayerId) nextLayerId = n + 1;
  }
  sceneState.selectedShapeId = null;
  sceneState.version++;
}

export function undo() {
  if (undoStack.length === 0) return;
  redoStack.push(snapshot());
  restore(undoStack.pop()!);
}

export function redo() {
  if (redoStack.length === 0) return;
  undoStack.push(snapshot());
  restore(redoStack.pop()!);
}

export function addShape(shape: Omit<SDFShape, "id" | "layerId">) {
  pushUndo();
  sceneState.shapes.push({
    ...shape,
    id: String(nextId++),
    layerId: sceneState.activeLayerId,
  });
  sceneState.version++;
}

export function setTool(tool: "select" | ShapeType) {
  sceneState.activeTool = tool;
}

export function isShapeTool(tool: string): tool is ShapeType {
  return (SHAPE_TYPES as readonly string[]).includes(tool);
}

// --- Layer CRUD ---

export function addLayer() {
  pushUndo();
  const id = String(nextLayerId++);
  sceneState.layers.push({
    id,
    name: `Layer ${id}`,
    transferMode: "union",
    opacity: 1,
    transferParam: 0.5,
    visible: true,
  });
  sceneState.activeLayerId = id;
  sceneState.version++;
}

export function removeLayer(id: string) {
  if (sceneState.layers.length <= 1) return;
  pushUndo();
  const idx = sceneState.layers.findIndex((l) => l.id === id);
  if (idx < 0) return;
  sceneState.layers.splice(idx, 1);
  // Remove shapes on that layer
  sceneState.shapes = sceneState.shapes.filter((s) => s.layerId !== id);
  // If active layer was removed, switch to first layer
  if (sceneState.activeLayerId === id) {
    sceneState.activeLayerId = sceneState.layers[0].id;
  }
  sceneState.selectedShapeId = null;
  sceneState.version++;
}

export function renameLayer(id: string, name: string) {
  const layer = sceneState.layers.find((l) => l.id === id);
  if (layer) layer.name = name;
}

export function setLayerTransferMode(id: string, mode: TransferMode) {
  const layer = sceneState.layers.find((l) => l.id === id);
  if (!layer) return;
  pushUndo();
  layer.transferMode = mode;
  sceneState.version++;
}

export function setLayerOpacity(id: string, opacity: number) {
  const layer = sceneState.layers.find((l) => l.id === id);
  if (!layer) return;
  layer.opacity = Math.max(0, Math.min(1, opacity));
  sceneState.version++;
}

export function setLayerTransferParam(id: string, param: number) {
  const layer = sceneState.layers.find((l) => l.id === id);
  if (!layer) return;
  layer.transferParam = Math.max(0, Math.min(1, param));
  sceneState.version++;
}

export function toggleLayerVisibility(id: string) {
  const layer = sceneState.layers.find((l) => l.id === id);
  if (!layer) return;
  layer.visible = !layer.visible;
  sceneState.version++;
}

export function setActiveLayer(id: string) {
  sceneState.activeLayerId = id;
}

export function reorderLayers(fromIndex: number, toIndex: number) {
  if (fromIndex === toIndex) return;
  pushUndo();
  const [layer] = sceneState.layers.splice(fromIndex, 1);
  sceneState.layers.splice(toIndex, 0, layer);
  sceneState.version++;
}

export function setShapeFx(id: string, fx: string | undefined) {
  const shape = sceneState.shapes.find((s) => s.id === id);
  if (!shape) return;
  shape.fx = fx;
  sceneState.version++;
}

export function setLayerFx(id: string, fx: string | undefined) {
  const layer = sceneState.layers.find((l) => l.id === id);
  if (!layer) return;
  layer.fx = fx;
  sceneState.version++;
}

export function startDrag(worldPoint: Vec3, floorY: number = 0) {
  sceneState.drag.active = true;
  sceneState.drag.phase = "base";
  sceneState.drag.startPoint = worldPoint;
  sceneState.drag.baseFloorY = floorY;
  sceneState.drag.previewPosition = worldPoint;
  sceneState.drag.previewSize = [0.01, 0.01, 0.01];
}

export function startRadiusDrag(center: Vec3, floorY: number = 0) {
  sceneState.drag.active = true;
  sceneState.drag.phase = "radius";
  sceneState.drag.startPoint = center;
  sceneState.drag.baseFloorY = floorY;
  sceneState.drag.previewPosition = center;
  sceneState.drag.previewSize = [0.01, 0.01, 0.01];
}

export function updateRadius(worldPoint: Vec3) {
  if (sceneState.drag.phase !== "radius") return;
  const [sx, , sz] = sceneState.drag.startPoint;
  const [cx, , cz] = worldPoint;
  const floor = sceneState.drag.baseFloorY;
  const radius = Math.sqrt((cx - sx) ** 2 + (cz - sz) ** 2);
  sceneState.drag.baseRadius = radius;
  sceneState.drag.previewPosition = [sx, floor + radius, sz];
  sceneState.drag.previewSize = [radius, radius, radius];
}

export function commitRadius() {
  if (sceneState.drag.phase !== "radius") return;
  const { previewPosition, previewSize } = sceneState.drag;

  if (previewSize[0] > 0.02) {
    addShape({
      type: "sphere",
      position: [...previewPosition] as Vec3,
      rotation: [0, 0, 0],
      size: [...previewSize] as Vec3,
      scale: 1,
    });
  }

  resetDrag();
}

export function updateBase(worldPoint: Vec3) {
  if (sceneState.drag.phase !== "base") return;
  const [sx, , sz] = sceneState.drag.startPoint;
  const [cx, , cz] = worldPoint;
  const floor = sceneState.drag.baseFloorY;
  const halfY = 0.01;

  const tool = sceneState.activeTool;

  if (tool === "box") {
    // Rectangular base
    const halfX = Math.abs(cx - sx) / 2;
    const halfZ = Math.abs(cz - sz) / 2;
    const midX = (sx + cx) / 2;
    const midZ = (sz + cz) / 2;

    sceneState.drag.baseHalfX = halfX;
    sceneState.drag.baseHalfZ = halfZ;
    sceneState.drag.baseMidX = midX;
    sceneState.drag.baseMidZ = midZ;
    sceneState.drag.previewPosition = [midX, floor + halfY, midZ];
    sceneState.drag.previewSize = [halfX, halfY, halfZ];
  } else {
    // Circular base (cylinder, pyramid, cone)
    const radius = Math.sqrt((cx - sx) ** 2 + (cz - sz) ** 2);
    sceneState.drag.baseRadius = radius;
    sceneState.drag.baseMidX = sx;
    sceneState.drag.baseMidZ = sz;
    sceneState.drag.baseHalfX = radius;
    sceneState.drag.baseHalfZ = radius;
    sceneState.drag.previewPosition = [sx, floor + halfY, sz];
    sceneState.drag.previewSize = [radius, halfY, radius];
  }
}

export function lockBase() {
  if (sceneState.drag.phase !== "base") return;
  const { baseHalfX, baseHalfZ, baseRadius } = sceneState.drag;
  const tool = sceneState.activeTool;
  const threshold = 0.05;

  if (tool === "box") {
    if (baseHalfX < threshold && baseHalfZ < threshold) {
      cancelDrag();
      return;
    }
  } else {
    if (baseRadius < threshold) {
      cancelDrag();
      return;
    }
  }

  sceneState.drag.phase = "height";
}

export function updateHeight(worldY: number) {
  if (sceneState.drag.phase !== "height") return;
  const { baseMidX, baseMidZ, baseHalfX, baseHalfZ, baseRadius, baseFloorY } =
    sceneState.drag;
  const floor = baseFloorY;
  const tool = sceneState.activeTool;

  const height = Math.max(worldY - floor, 0.02);
  const halfY = height / 2;

  if (tool === "box") {
    sceneState.drag.previewPosition = [baseMidX, floor + halfY, baseMidZ];
    sceneState.drag.previewSize = [baseHalfX, halfY, baseHalfZ];
  } else {
    // cylinder, pyramid, cone: size = [radius, halfHeight, radius]
    sceneState.drag.previewPosition = [baseMidX, floor + halfY, baseMidZ];
    sceneState.drag.previewSize = [baseRadius, halfY, baseRadius];
  }
}

export function commitHeight() {
  if (sceneState.drag.phase !== "height") return;
  const { previewPosition, previewSize } = sceneState.drag;
  const tool = sceneState.activeTool;

  if (previewSize[1] > 0.02) {
    addShape({
      type: tool as ShapeType,
      position: [...previewPosition] as Vec3,
      rotation: [0, 0, 0],
      size: [...previewSize] as Vec3,
      scale: 1,
    });
  }

  resetDrag();
}

export function cancelDrag() {
  resetDrag();
}

function resetDrag() {
  sceneState.drag.active = false;
  sceneState.drag.phase = "idle";
  sceneState.drag.previewSize = [0.01, 0.01, 0.01];
  sceneState.drag.baseFloorY = 0;
  sceneState.drag.baseHalfX = 0;
  sceneState.drag.baseHalfZ = 0;
  sceneState.drag.baseMidX = 0;
  sceneState.drag.baseMidZ = 0;
  sceneState.drag.baseRadius = 0;
}

export function selectShape(id: string | null) {
  sceneState.selectedShapeId = id;
  sceneState.editMode = "object";
}

export function deleteSelectedShape() {
  const id = sceneState.selectedShapeId;
  if (!id) return;
  const idx = sceneState.shapes.findIndex((s) => s.id === id);
  if (idx >= 0) {
    pushUndo();
    sceneState.shapes.splice(idx, 1);
    sceneState.selectedShapeId = null;
    sceneState.version++;
  }
}

export function duplicateShape(id: string): string | null {
  const shape = sceneState.shapes.find((s) => s.id === id);
  if (!shape) return null;
  pushUndo();
  const newId = String(nextId++);
  sceneState.shapes.push({
    id: newId,
    type: shape.type,
    position: [...shape.position] as Vec3,
    rotation: [...shape.rotation] as Vec3,
    size: [...shape.size] as Vec3,
    scale: shape.scale,
    layerId: shape.layerId,
    fx: shape.fx,
  });
  sceneState.selectedShapeId = newId;
  sceneState.version++;
  return newId;
}

export function moveShape(id: string, newPosition: Vec3) {
  const shape = sceneState.shapes.find((s) => s.id === id);
  if (!shape) return;
  pushUndo();
  shape.position = newPosition;
  sceneState.version++;
}

export function rotateShape(id: string, newRotation: Vec3) {
  const shape = sceneState.shapes.find((s) => s.id === id);
  if (!shape) return;
  pushUndo();
  shape.rotation = newRotation;
  sceneState.version++;
}

export function scaleShape(id: string, newSize: Vec3, newPosition?: Vec3, newScale?: number) {
  const shape = sceneState.shapes.find((s) => s.id === id);
  if (!shape) return;
  pushUndo();
  shape.size = newSize;
  if (newPosition) shape.position = newPosition;
  if (newScale !== undefined) shape.scale = newScale;
  sceneState.version++;
}

export function moveShapeToLayer(id: string, layerId: string) {
  const shape = sceneState.shapes.find((s) => s.id === id);
  if (!shape) return;
  pushUndo();
  shape.layerId = layerId;
  sceneState.version++;
}

export function enterEditMode() {
  if (!sceneState.selectedShapeId) return;
  sceneState.editMode = "edit";
}

export function exitEditMode() {
  sceneState.editMode = "object";
}

// Non-proxied refs for Three.js objects (valtio proxy would break them)
export const sceneRefs: {
  camera: import("three").PerspectiveCamera | null;
  controls:
    | import("three/examples/jsm/controls/OrbitControls.js").OrbitControls
    | null;
  canvas: HTMLCanvasElement | null;
  updateGizmoOverlay:
    | ((vpMat: import("three").Matrix4, w: number, h: number) => void)
    | null;
} = {
  camera: null,
  controls: null,
  canvas: null,
  updateGizmoOverlay: null,
};

declare global {
  interface Window {
    sceneState: typeof sceneState;
  }
}

window.sceneState = sceneState;
