import { proxy } from "valtio";
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
    {
      id: "1",
      type: "box",
      position: [0, 0.5, 0] as Vec3,
      rotation: [0, 0, 0] as Vec3,
      size: [0.5, 0.5, 0.5] as Vec3,
      scale: 1,
      layerId: "1",
    },
  ] as SDFShape[],
  layers: [
    {
      id: "1",
      name: "Layer 1",
      transferMode: "union",
      opacity: 1,
      transferParam: 0.5,
      visible: true,
    },
  ] as Layer[],
  activeLayerId: "1" as string,
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
  fxParams?: Vec3;
  vertices?: [number, number][];
  capped?: boolean;
  wallThickness?: number;
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
  // Keep nextId above any restored id
  for (const s of snap.shapes) {
    const n = Number(s.id);
    if (n >= nextId) nextId = n + 1;
  }
  for (const l of snap.layers) {
    const n = Number(l.id);
    if (n >= nextLayerId) nextLayerId = n + 1;
  }
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
  const newShape: SDFShape = {
    ...shape,
    id: String(nextId++),
    layerId: sceneState.activeLayerId,
  };
  sceneState.shapes.push(newShape);
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
  });

  cancelPen();
}

export function cancelPen() {
  sceneState.penVertices.splice(0, sceneState.penVertices.length);
  sceneState.penFloorY = 0;
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

  addShape({
    type: "sphere",
    position: [sx, floor + r, sz],
    rotation: [0, 0, 0],
    size: [r, r, r],
    scale: 1,
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


  const { previewPosition, previewSize } = sceneState.drag;

  addShape({
    type: tool as ShapeType,
    position: [...previewPosition] as Vec3,
    rotation: [0, 0, 0],
    size: [...previewSize] as Vec3,
    scale: 1,
  });

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

export function selectAll() {
  const visibleLayerIds = new Set(
    sceneState.layers.filter((l) => l.visible).map((l) => l.id),
  );
  sceneState.selectedShapeIds = sceneState.shapes
    .filter((s) => visibleLayerIds.has(s.layerId))
    .map((s) => s.id);
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
    fxParams: shape.fxParams ? [...shape.fxParams] as Vec3 : undefined,
    vertices: shape.vertices ? shape.vertices.map(v => [...v] as [number, number]) : undefined,
    capped: shape.capped,
    wallThickness: shape.wallThickness,
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
      fxParams: shape.fxParams ? [...shape.fxParams] as Vec3 : undefined,
      vertices: shape.vertices ? shape.vertices.map(v => [...v] as [number, number]) : undefined,
      capped: shape.capped,
      wallThickness: shape.wallThickness,
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
  // Recompute bounding radius
  let maxR = 0;
  for (const [vx, vz] of newVerts) maxR = Math.max(maxR, Math.sqrt(vx * vx + vz * vz));
  shape.size = [maxR, shape.size[1], shape.size[2]];
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

/** Recenter polygon vertices around their centroid, adjusting position to compensate. */
export function recenterPolygon(shapeId: string) {
  const shape = sceneState.shapes.find(s => s.id === shapeId);
  if (!shape?.vertices || shape.vertices.length < 3) return;

  // Use bounding box center (not centroid) for tightest AABB
  let minX = Infinity, maxX = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const [vx, vz] of shape.vertices) {
    if (vx < minX) minX = vx;
    if (vx > maxX) maxX = vx;
    if (vz < minZ) minZ = vz;
    if (vz > maxZ) maxZ = vz;
  }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;

  // Skip if already centered
  if (Math.abs(cx) < 1e-6 && Math.abs(cz) < 1e-6) return;

  pushUndo();

  // Recenter vertices
  shape.vertices = shape.vertices.map(([vx, vz]) => [vx - cx, vz - cz] as [number, number]);

  // Transform local centroid offset to world space and adjust position
  const m = eulerToMatrix3(shape.rotation[0], shape.rotation[1], shape.rotation[2]);
  const s = shape.scale;
  shape.position = [
    shape.position[0] + (m[0] * cx + m[6] * cz) * s,
    shape.position[1] + (m[1] * cx + m[7] * cz) * s,
    shape.position[2] + (m[2] * cx + m[8] * cz) * s,
  ];

  // Recompute bounding radius
  let maxR = 0;
  for (const [vx, vz] of shape.vertices) maxR = Math.max(maxR, Math.sqrt(vx * vx + vz * vz));
  shape.size = [maxR, shape.size[1], shape.size[2]];
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
};

declare global {
  interface Window {
    sceneState: typeof sceneState;
  }
}

window.sceneState = sceneState;
