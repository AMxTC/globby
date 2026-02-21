import { proxy, subscribe } from "valtio";
import { subscribeKey } from "valtio/utils";
import { nanoid } from "nanoid";
import { SHAPE_TYPES, type ShapeType, type TransferMode } from "../constants";
import { rotateVecAroundAxis, composeWorldRotation, eulerToMatrix3 } from "../lib/math3d";

export type Vec3 = [number, number, number];

export interface SDFShape {
  id: string;
  type: ShapeType;
  position: Vec3;
  rotation: Vec3; // Euler angles [rx, ry, rz] radians, XYZ intrinsic
  size: Vec3;
  scale: number; // Uniform scale (>0), default 1
  layerId: string;
  fx?: string; // WGSL function body, undefined = identity
  fxParams?: Vec3; // Runtime fx params [0..1] packed into GPU buffer
  vertices?: [number, number][]; // 2D XZ polygon vertices (max 16), only for polygon type
  capped?: boolean; // Polygon extrusion: true (default) = solid, false = walls only
  wallThickness?: number; // Wall thickness when uncapped (world units, default 0.03)
  isMask?: boolean; // When true, shape is a mask (subtracted from layer's main shapes)
}

export interface Layer {
  id: string;
  name: string;
  transferMode: TransferMode;
  opacity: number; // 0..1
  transferParam: number; // 0..1, mode-specific parameter
  visible: boolean;
  fx?: string; // WGSL function body, undefined = identity
  fxParams?: Vec3; // Runtime fx params [0..1] packed into GPU buffer
  maskEnabled?: boolean; // Toggle mask on/off (defaults true when mask shapes exist)
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

const defaultLayerId = nanoid();

export const sceneState = proxy({
  shapes: [
    {
      id: nanoid(),
      type: "box",
      position: [0, 0.5, 0] as Vec3,
      rotation: [0, 0, 0] as Vec3,
      size: [0.5, 0.5, 0.5] as Vec3,
      scale: 1,
      layerId: defaultLayerId,
    },
  ] as SDFShape[],
  layers: [
    {
      id: defaultLayerId,
      name: "Layer 1",
      transferMode: "union",
      opacity: 1,
      transferParam: 0.5,
      visible: true,
    },
  ] as Layer[],
  activeLayerId: defaultLayerId as string,
  activeTool: "select" as "select" | "pushpull" | ShapeType,
  selectedShapeIds: [] as string[],
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
  marquee: null as { x1: number; y1: number; x2: number; y2: number } | null,
  fxError: null as string | null,
  fxCompiling: false,
  penVertices: [] as [number, number][],
  penFloorY: 0,
  maskEditLayerId: null as string | null,
  version: 1,
});

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
  fxParams?: Vec3;
  vertices?: [number, number][];
  capped?: boolean;
  wallThickness?: number;
  isMask?: boolean;
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
      fxParams: s.fxParams ? [...s.fxParams] as Vec3 : undefined,
      vertices: s.vertices ? s.vertices.map(v => [...v] as [number, number]) : undefined,
      capped: s.capped,
      wallThickness: s.wallThickness,
      isMask: s.isMask,
    })),
    layers: sceneState.layers.map((l) => ({ ...l })),
    activeLayerId: sceneState.activeLayerId,
  };
}

export function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
}

function restore(snap: SceneSnapshot) {
  sceneState.shapes.splice(0, sceneState.shapes.length, ...snap.shapes);
  sceneState.layers.splice(0, sceneState.layers.length, ...snap.layers);
  sceneState.activeLayerId = snap.activeLayerId;
  sceneState.selectedShapeIds = [];
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
  // When in mask edit mode, force isMask = true
  const isMask = sceneState.maskEditLayerId !== null ? true : shape.isMask;
  const newShape: SDFShape = {
    ...shape,
    id: nanoid(),
    layerId: sceneState.activeLayerId,
    isMask,
  };
  sceneState.shapes.push(newShape);
  // Auto-enable mask on layer when first mask shape is added
  if (isMask) {
    const layer = sceneState.layers.find((l) => l.id === newShape.layerId);
    if (layer && layer.maskEnabled === undefined) {
      layer.maskEnabled = true;
    }
  }
  sceneState.version++;
}

export function setTool(tool: "select" | "pushpull" | ShapeType) {
  if (sceneState.activeTool === "polygon" && tool !== "polygon") {
    cancelPen();
  }
  sceneState.activeTool = tool;
}

export function isShapeTool(tool: string): tool is ShapeType {
  return (SHAPE_TYPES as readonly string[]).includes(tool);
}

export function isDrawTool(tool: string): boolean {
  return tool === "polygon";
}

// --- Pen tool ---

const MAX_PEN_VERTICES = 16;

export function addPenVertex(x: number, z: number) {
  if (sceneState.penVertices.length >= MAX_PEN_VERTICES) return;
  sceneState.penVertices.push([x, z]);
}

export function closePen(height: number) {
  const verts = sceneState.penVertices;
  if (verts.length < 3) {
    cancelPen();
    return;
  }

  const isMask = sceneRefs.pendingMaskShape;
  sceneRefs.pendingMaskShape = false;

  // Center vertices around bounding box center for tightest AABB
  let minX = Infinity, maxX = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const [vx, vz] of verts) {
    if (vx < minX) minX = vx;
    if (vx > maxX) maxX = vx;
    if (vz < minZ) minZ = vz;
    if (vz > maxZ) maxZ = vz;
  }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;

  const centered = verts.map(([vx, vz]) => [vx - cx, vz - cz] as [number, number]);

  // Compute bounding radius for AABB
  let maxR = 0;
  for (const [vx, vz] of centered) {
    const r = Math.sqrt(vx * vx + vz * vz);
    if (r > maxR) maxR = r;
  }

  const halfH = height / 2;
  const floorY = sceneState.penFloorY;

  addShape({
    type: "polygon",
    position: [cx, floorY + halfH, cz],
    rotation: [0, 0, 0],
    size: [maxR, halfH, verts.length], // size.x=bounding radius, size.y=halfHeight, size.z=vertex count
    scale: 1,
    vertices: centered,
    isMask: isMask || undefined,
  });

  cancelPen();
}

export function cancelPen() {
  sceneState.penVertices.splice(0, sceneState.penVertices.length);
  sceneState.penFloorY = 0;
  sceneRefs.pendingMaskShape = false;
}

// --- Layer CRUD ---

export function addLayer() {
  pushUndo();
  const id = nanoid();
  const num = sceneState.layers.length + 1;
  sceneState.layers.push({
    id,
    name: `Layer ${num}`,
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
  sceneState.selectedShapeIds = [];
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

export function toggleLayerMask(id: string) {
  const layer = sceneState.layers.find((l) => l.id === id);
  if (!layer) return;
  // Only toggle if layer has mask shapes
  const hasMask = sceneState.shapes.some((s) => s.layerId === id && s.isMask);
  if (!hasMask) return;
  pushUndo();
  layer.maskEnabled = layer.maskEnabled === false ? true : false;
  sceneState.version++;
}

export function enterMaskEdit(layerId: string) {
  sceneState.maskEditLayerId = layerId;
  sceneState.selectedShapeIds = [];
  sceneState.activeLayerId = layerId;
  sceneState.version++;
}

export function exitMaskEdit() {
  sceneState.maskEditLayerId = null;
  sceneState.selectedShapeIds = [];
  sceneState.version++;
}

export function moveSelectedToLayer(layerId: string) {
  const ids = sceneState.selectedShapeIds;
  if (ids.length === 0) return;
  pushUndo();
  const idSet = new Set(ids);
  for (const shape of sceneState.shapes) {
    if (idSet.has(shape.id)) shape.layerId = layerId;
  }
  sceneState.version++;
}

export function duplicateLayer(id: string) {
  const layer = sceneState.layers.find((l) => l.id === id);
  if (!layer) return;
  pushUndo();
  const newLayerId = nanoid();
  const idx = sceneState.layers.indexOf(layer);
  sceneState.layers.splice(idx + 1, 0, {
    id: newLayerId,
    name: `${layer.name} Copy`,
    transferMode: layer.transferMode,
    opacity: layer.opacity,
    transferParam: layer.transferParam,
    visible: layer.visible,
    fx: layer.fx,
    fxParams: layer.fxParams ? [...layer.fxParams] as Vec3 : undefined,
    maskEnabled: layer.maskEnabled,
  });
  // Duplicate all shapes on the layer
  for (const shape of [...sceneState.shapes]) {
    if (shape.layerId !== id) continue;
    sceneState.shapes.push({
      id: nanoid(),
      type: shape.type,
      position: [...shape.position] as Vec3,
      rotation: [...shape.rotation] as Vec3,
      size: [...shape.size] as Vec3,
      scale: shape.scale,
      layerId: newLayerId,
      fx: shape.fx,
      fxParams: shape.fxParams ? [...shape.fxParams] as Vec3 : undefined,
      vertices: shape.vertices ? shape.vertices.map(v => [...v] as [number, number]) : undefined,
      capped: shape.capped,
      wallThickness: shape.wallThickness,
      isMask: shape.isMask,
    });
  }
  sceneState.activeLayerId = newLayerId;
  sceneState.version++;
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

export function setShapeFxParams(id: string, params: Vec3) {
  const shape = sceneState.shapes.find((s) => s.id === id);
  if (!shape) return;
  shape.fxParams = params;
  sceneState.version++;
}

export function setLayerFxParams(id: string, params: Vec3) {
  const layer = sceneState.layers.find((l) => l.id === id);
  if (!layer) return;
  layer.fxParams = params;
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
  const minRadius = 0.02;
  const r = Math.max(sceneState.drag.previewSize[0], minRadius);
  const [sx, , sz] = sceneState.drag.startPoint;
  const floor = sceneState.drag.baseFloorY;

  const isMask = sceneRefs.pendingMaskShape;
  sceneRefs.pendingMaskShape = false;

  addShape({
    type: "sphere",
    position: [sx, floor + r, sz],
    rotation: [0, 0, 0],
    size: [r, r, r],
    scale: 1,
    isMask: isMask || undefined,
  });

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
  const tool = sceneState.activeTool;
  const minBase = 0.01;

  if (tool === "box") {
    sceneState.drag.baseHalfX = Math.max(sceneState.drag.baseHalfX, minBase);
    sceneState.drag.baseHalfZ = Math.max(sceneState.drag.baseHalfZ, minBase);
  } else {
    sceneState.drag.baseRadius = Math.max(sceneState.drag.baseRadius, minBase);
    sceneState.drag.baseHalfX = sceneState.drag.baseRadius;
    sceneState.drag.baseHalfZ = sceneState.drag.baseRadius;
  }

  sceneState.drag.phase = "height";
}

export function updateHeight(worldY: number) {
  if (sceneState.drag.phase !== "height") return;
  const { baseMidX, baseMidZ, baseHalfX, baseHalfZ, baseRadius, baseFloorY } =
    sceneState.drag;
  const floor = baseFloorY;
  const tool = sceneState.activeTool;

  const height = Math.max(worldY - floor, 0.01);
  const halfY = height / 2;

  if (tool === "polygon") {
    // Polygon height phase: just update the height preview
    sceneState.drag.previewPosition = [baseMidX, floor + halfY, baseMidZ];
    sceneState.drag.previewSize = [0.01, halfY, 0.01];
  } else if (tool === "box") {
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
  const tool = sceneState.activeTool;

  const isMask = sceneRefs.pendingMaskShape;
  sceneRefs.pendingMaskShape = false;

  const { previewPosition, previewSize } = sceneState.drag;

  addShape({
    type: tool as ShapeType,
    position: [...previewPosition] as Vec3,
    rotation: [0, 0, 0],
    size: [...previewSize] as Vec3,
    scale: 1,
    isMask: isMask || undefined,
  });

  resetDrag();
}

export function cancelDrag() {
  resetDrag();
}

function resetDrag() {
  sceneRefs.pendingMaskShape = false;
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
  sceneState.selectedShapeIds = id ? [id] : [];
  sceneState.editMode = "object";
  sceneRefs.selectedPolyVertIdx = null;
}

export function toggleShapeSelection(id: string) {
  const idx = sceneState.selectedShapeIds.indexOf(id);
  if (idx >= 0) {
    sceneState.selectedShapeIds.splice(idx, 1);
  } else {
    sceneState.selectedShapeIds.push(id);
  }
  if (sceneState.selectedShapeIds.length !== 1) {
    sceneState.editMode = "object";
  }
}

export function selectShapesOnLayer(layerId: string) {
  sceneState.selectedShapeIds = sceneState.shapes
    .filter((s) => s.layerId === layerId)
    .map((s) => s.id);
  sceneState.editMode = "object";
}

export function selectAll() {
  if (sceneState.maskEditLayerId !== null) {
    // In mask edit mode, only select mask shapes on the edited layer
    sceneState.selectedShapeIds = sceneState.shapes
      .filter((s) => s.layerId === sceneState.maskEditLayerId && s.isMask)
      .map((s) => s.id);
  } else {
    const visibleLayerIds = new Set(
      sceneState.layers.filter((l) => l.visible).map((l) => l.id),
    );
    sceneState.selectedShapeIds = sceneState.shapes
      .filter((s) => visibleLayerIds.has(s.layerId))
      .map((s) => s.id);
  }
  if (sceneState.selectedShapeIds.length !== 1) {
    sceneState.editMode = "object";
  }
}

export function deleteSelectedShapes() {
  const ids = sceneState.selectedShapeIds;
  if (ids.length === 0) return;
  pushUndo();
  const idSet = new Set(ids);
  sceneState.shapes = sceneState.shapes.filter((s) => !idSet.has(s.id));
  sceneState.selectedShapeIds = [];
  sceneState.version++;
}

export function duplicateShape(id: string): string | null {
  const shape = sceneState.shapes.find((s) => s.id === id);
  if (!shape) return null;
  pushUndo();
  const newId = nanoid();
  sceneState.shapes.push({
    id: newId,
    type: shape.type,
    position: [...shape.position] as Vec3,
    rotation: [...shape.rotation] as Vec3,
    size: [...shape.size] as Vec3,
    scale: shape.scale,
    layerId: shape.layerId,
    fx: shape.fx,
    fxParams: shape.fxParams ? [...shape.fxParams] as Vec3 : undefined,
    vertices: shape.vertices ? shape.vertices.map(v => [...v] as [number, number]) : undefined,
    capped: shape.capped,
    wallThickness: shape.wallThickness,
    isMask: shape.isMask,
  });
  sceneState.selectedShapeIds = [newId];
  sceneState.version++;
  return newId;
}

export function duplicateSelectedShapes(): string[] {
  const ids = sceneState.selectedShapeIds;
  if (ids.length === 0) return [];
  pushUndo();
  const newIds: string[] = [];
  for (const id of ids) {
    const shape = sceneState.shapes.find((s) => s.id === id);
    if (!shape) continue;
    const newId = nanoid();
    sceneState.shapes.push({
      id: newId,
      type: shape.type,
      position: [...shape.position] as Vec3,
      rotation: [...shape.rotation] as Vec3,
      size: [...shape.size] as Vec3,
      scale: shape.scale,
      layerId: shape.layerId,
      fx: shape.fx,
      fxParams: shape.fxParams ? [...shape.fxParams] as Vec3 : undefined,
      vertices: shape.vertices ? shape.vertices.map(v => [...v] as [number, number]) : undefined,
      capped: shape.capped,
      wallThickness: shape.wallThickness,
      isMask: shape.isMask,
    });
    newIds.push(newId);
  }
  sceneState.selectedShapeIds = newIds;
  sceneState.version++;
  return newIds;
}

export function moveShape(id: string, newPosition: Vec3) {
  const shape = sceneState.shapes.find((s) => s.id === id);
  if (!shape) return;
  shape.position = newPosition;
  sceneState.version++;
}

export function rotateShape(id: string, newRotation: Vec3) {
  const shape = sceneState.shapes.find((s) => s.id === id);
  if (!shape) return;
  shape.rotation = newRotation;
  sceneState.version++;
}

export function scaleShape(
  id: string,
  newSize: Vec3,
  newPosition?: Vec3,
  newScale?: number,
) {
  const shape = sceneState.shapes.find((s) => s.id === id);
  if (!shape) return;
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

export function moveShapes(ids: string[], delta: Vec3) {
  pushUndo();
  for (const id of ids) {
    const shape = sceneState.shapes.find((s) => s.id === id);
    if (!shape) continue;
    shape.position = [
      shape.position[0] + delta[0],
      shape.position[1] + delta[1],
      shape.position[2] + delta[2],
    ];
  }
  sceneState.version++;
}

export function rotateShapesAroundPivot(
  ids: string[],
  pivot: Vec3,
  axis: Vec3,
  angle: number,
) {
  pushUndo();
  for (const id of ids) {
    const shape = sceneState.shapes.find((s) => s.id === id);
    if (!shape) continue;
    // Orbit position around pivot
    const rel: Vec3 = [
      shape.position[0] - pivot[0],
      shape.position[1] - pivot[1],
      shape.position[2] - pivot[2],
    ];
    const rotated = rotateVecAroundAxis(rel, axis, angle);
    shape.position = [
      pivot[0] + rotated[0],
      pivot[1] + rotated[1],
      pivot[2] + rotated[2],
    ];
    // Compose world rotation onto existing euler
    shape.rotation = composeWorldRotation(shape.rotation, axis, angle);
  }
  sceneState.version++;
}

export function scaleShapesAroundPivot(
  ids: string[],
  pivot: Vec3,
  scaleFactor: number,
) {
  pushUndo();
  for (const id of ids) {
    const shape = sceneState.shapes.find((s) => s.id === id);
    if (!shape) continue;
    // Scale distance from pivot
    shape.position = [
      pivot[0] + (shape.position[0] - pivot[0]) * scaleFactor,
      pivot[1] + (shape.position[1] - pivot[1]) * scaleFactor,
      pivot[2] + (shape.position[2] - pivot[2]) * scaleFactor,
    ];
    shape.scale = shape.scale * scaleFactor;
  }
  sceneState.version++;
}

export function flipShapes(ids: string[], axis: 0 | 1 | 2) {
  if (ids.length === 0) return;
  pushUndo();
  // Compute centroid
  let cx = 0, cy = 0, cz = 0, count = 0;
  for (const id of ids) {
    const shape = sceneState.shapes.find((s) => s.id === id);
    if (!shape) continue;
    cx += shape.position[0];
    cy += shape.position[1];
    cz += shape.position[2];
    count++;
  }
  if (count === 0) return;
  const centroid: Vec3 = [cx / count, cy / count, cz / count];
  for (const id of ids) {
    const shape = sceneState.shapes.find((s) => s.id === id);
    if (!shape) continue;
    // Mirror position on the given axis relative to the centroid
    shape.position[axis] = 2 * centroid[axis] - shape.position[axis];
    // For polygons, mirror vertices on the relevant local axis
    if (shape.type === "polygon" && shape.vertices) {
      const localAxis: 0 | 1 | -1 = axis === 0 ? 0 : axis === 2 ? 1 : -1; // x->0, z->1
      if (localAxis >= 0) {
        const la = localAxis as 0 | 1;
        for (let i = 0; i < shape.vertices.length; i++) {
          shape.vertices[i][la] = -shape.vertices[i][la];
        }
        // Reverse winding order to maintain correct normals
        shape.vertices.reverse();
      }
    }
  }
  sceneState.version++;
}

export function distributeShapes(ids: string[], axis: 0 | 1 | 2) {
  if (ids.length < 3) return;
  // Gather shapes with their positions
  const entries: { shape: SDFShape; pos: number }[] = [];
  for (const id of ids) {
    const shape = sceneState.shapes.find((s) => s.id === id);
    if (!shape) continue;
    entries.push({ shape, pos: shape.position[axis] });
  }
  if (entries.length < 3) return;
  pushUndo();
  // Sort by position on the axis
  entries.sort((a, b) => a.pos - b.pos);
  const first = entries[0].pos;
  const last = entries[entries.length - 1].pos;
  const step = (last - first) / (entries.length - 1);
  for (let i = 1; i < entries.length - 1; i++) {
    entries[i].shape.position[axis] = first + step * i;
  }
  sceneState.version++;
}

export function enterEditMode() {
  if (sceneState.selectedShapeIds.length !== 1) return;
  sceneState.editMode = "edit";
}

export function exitEditMode() {
  sceneState.editMode = "object";
  sceneRefs.selectedPolyVertIdx = null;
}

export function editPolyVertices(shapeId: string, newVerts: [number, number][]) {
  pushUndo();
  const shape = sceneState.shapes.find(s => s.id === shapeId);
  if (!shape) return;
  shape.vertices = newVerts.map(v => [...v] as [number, number]);
  recenterPolyBounds(shape);
  sceneState.version++;
}

export function insertPolyVertex(shapeId: string, afterIdx: number, localXZ: [number, number]) {
  const shape = sceneState.shapes.find(s => s.id === shapeId);
  if (!shape?.vertices || shape.vertices.length >= MAX_PEN_VERTICES) return;
  pushUndo();
  shape.vertices.splice(afterIdx + 1, 0, localXZ);
  // Recompute bounding radius
  let maxR = 0;
  for (const [vx, vz] of shape.vertices) maxR = Math.max(maxR, Math.sqrt(vx * vx + vz * vz));
  shape.size = [maxR, shape.size[1], shape.vertices.length];
  sceneState.version++;
}

export function deletePolyVertex(shapeId: string, vertIdx: number) {
  const shape = sceneState.shapes.find(s => s.id === shapeId);
  if (!shape?.vertices || shape.vertices.length <= 3) return;
  if (vertIdx < 0 || vertIdx >= shape.vertices.length) return;
  pushUndo();
  shape.vertices.splice(vertIdx, 1);
  // Recompute bounding radius
  let maxR = 0;
  for (const [vx, vz] of shape.vertices) maxR = Math.max(maxR, Math.sqrt(vx * vx + vz * vz));
  shape.size = [maxR, shape.size[1], shape.vertices.length];
  sceneRefs.selectedPolyVertIdx = null;
  sceneState.version++;
}

export function setShapeCapped(shapeId: string, capped: boolean) {
  const shape = sceneState.shapes.find(s => s.id === shapeId);
  if (!shape) return;
  pushUndo();
  shape.capped = capped;
  sceneState.version++;
}

export function setShapeWallThickness(shapeId: string, thickness: number) {
  const shape = sceneState.shapes.find(s => s.id === shapeId);
  if (!shape) return;
  shape.wallThickness = Math.max(0.01, Math.min(0.5, thickness));
  sceneState.version++;
}

/** Recenter polygon vertices around their bbox center, adjust position to compensate,
 *  and recompute bounding radius. Mutates shape in place. Returns true if anything changed. */
export function recenterPolyBounds(shape: SDFShape): boolean {
  if (!shape.vertices || shape.vertices.length < 3) return false;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [vx, vz] of shape.vertices) {
    if (vx < minX) minX = vx; if (vx > maxX) maxX = vx;
    if (vz < minZ) minZ = vz; if (vz > maxZ) maxZ = vz;
  }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  if (Math.abs(cx) > 1e-6 || Math.abs(cz) > 1e-6) {
    for (let i = 0; i < shape.vertices.length; i++) {
      shape.vertices[i] = [shape.vertices[i][0] - cx, shape.vertices[i][1] - cz];
    }
    const m = eulerToMatrix3(shape.rotation[0], shape.rotation[1], shape.rotation[2]);
    const s = shape.scale;
    shape.position = [
      shape.position[0] + (m[0] * cx + m[6] * cz) * s,
      shape.position[1] + (m[1] * cx + m[7] * cz) * s,
      shape.position[2] + (m[2] * cx + m[8] * cz) * s,
    ];
  }
  let maxR = 0;
  for (const [vx, vz] of shape.vertices) maxR = Math.max(maxR, Math.sqrt(vx * vx + vz * vz));
  shape.size = [maxR, shape.size[1], shape.size[2]];
  return true;
}

/** Recenter polygon vertices (with undo). */
export function recenterPolygon(shapeId: string) {
  const shape = sceneState.shapes.find(s => s.id === shapeId);
  if (!shape?.vertices || shape.vertices.length < 3) return;
  pushUndo();
  recenterPolyBounds(shape);
  sceneState.version++;
}

// Non-proxied refs for Three.js objects (valtio proxy would break them)
export const sceneRefs: {
  camera: import("three").PerspectiveCamera | null;
  controls:
    | import("three/examples/jsm/controls/OrbitControls.js").OrbitControls
    | null;
  canvas: HTMLCanvasElement | null;
  updateTranslateGumball:
    | ((vpMat: import("three").Matrix4, w: number, h: number) => void)
    | null;
  updateEditGizmo:
    | ((vpMat: import("three").Matrix4, w: number, h: number) => void)
    | null;
  updatePenOverlay:
    | ((vpMat: import("three").Matrix4, w: number, h: number) => void)
    | null;
  penCursorXZ: [number, number] | null;
  editPolyDragIdx: number | null;
  editPolyStartVerts: [number, number][] | null;
  editPolyStartPos: Vec3 | null;
  selectedPolyVertIdx: number | null;
  /** Set true by overlay handlers to suppress the next canvas select/deselect */
  pointerConsumed: boolean;
  /** Captures Ctrl state at draw start for mask shape creation */
  pendingMaskShape: boolean;
} = {
  camera: null,
  controls: null,
  canvas: null,
  updateTranslateGumball: null,
  updateEditGizmo: null,
  updatePenOverlay: null,
  penCursorXZ: null,
  editPolyDragIdx: null,
  editPolyStartVerts: null,
  editPolyStartPos: null,
  selectedPolyVertIdx: null,
  pointerConsumed: false,
  pendingMaskShape: false,
};

// --- Auto-save to localStorage ---

const SCENE_STORAGE_KEY = "globby-scene";

// Restore from localStorage on module load
try {
  const raw = localStorage.getItem(SCENE_STORAGE_KEY);
  if (raw) {
    const saved = JSON.parse(raw) as {
      shapes: SceneSnapshot["shapes"];
      layers: SceneSnapshot["layers"];
      activeLayerId: string;
      showGroundPlane?: boolean;
      renderMode?: number;
    };
    if (saved.shapes?.length) {
      sceneState.shapes.splice(0, sceneState.shapes.length, ...saved.shapes);
      sceneState.layers.splice(0, sceneState.layers.length, ...saved.layers);
      sceneState.activeLayerId = saved.activeLayerId;
      if (saved.showGroundPlane !== undefined) sceneState.showGroundPlane = saved.showGroundPlane;
      if (saved.renderMode !== undefined) sceneState.renderMode = saved.renderMode as 0 | 1 | 2 | 3 | 4;
      sceneState.version++;
    }
  }
} catch { /* ignore corrupt data */ }

// Debounced save (1s) — only triggers on persistent keys, not transient
// state like drag, marquee, selectedShapeIds, etc.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const data = {
        shapes: sceneState.shapes.map((s) => ({
          id: s.id,
          type: s.type,
          position: [...s.position],
          rotation: [...s.rotation],
          size: [...s.size],
          scale: s.scale,
          layerId: s.layerId,
          fx: s.fx,
          fxParams: s.fxParams ? [...s.fxParams] : undefined,
          vertices: s.vertices ? s.vertices.map(v => [...v]) : undefined,
          capped: s.capped,
          wallThickness: s.wallThickness,
          isMask: s.isMask,
        })),
        layers: sceneState.layers.map((l) => ({ ...l })),
        activeLayerId: sceneState.activeLayerId,
        showGroundPlane: sceneState.showGroundPlane,
        renderMode: sceneState.renderMode,
      };
      localStorage.setItem(SCENE_STORAGE_KEY, JSON.stringify(data));
    } catch { /* quota exceeded etc */ }
  }, 1000);
}
subscribe(sceneState.shapes, scheduleSave);
subscribe(sceneState.layers, scheduleSave);
subscribeKey(sceneState, "activeLayerId", scheduleSave);
subscribeKey(sceneState, "showGroundPlane", scheduleSave);
subscribeKey(sceneState, "renderMode", scheduleSave);

// --- Reset scene ---

export function resetScene() {
  localStorage.removeItem(SCENE_STORAGE_KEY);
  undoStack.length = 0;
  redoStack.length = 0;
  const layerId = nanoid();
  sceneState.shapes.splice(0, sceneState.shapes.length, {
    id: nanoid(),
    type: "box",
    position: [0, 0.5, 0] as Vec3,
    rotation: [0, 0, 0] as Vec3,
    size: [0.5, 0.5, 0.5] as Vec3,
    scale: 1,
    layerId,
  });
  sceneState.layers.splice(0, sceneState.layers.length, {
    id: layerId,
    name: "Layer 1",
    transferMode: "union",
    opacity: 1,
    transferParam: 0.5,
    visible: true,
  });
  sceneState.activeLayerId = layerId;
  sceneState.activeTool = "select";
  sceneState.selectedShapeIds = [];
  sceneState.editMode = "object";
  sceneState.version++;
}

declare global {
  interface Window {
    sceneState: typeof sceneState;
  }
}

window.sceneState = sceneState;
