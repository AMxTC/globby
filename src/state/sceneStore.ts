import { proxy } from "valtio";
import { BOUNDS, SHAPE_TYPES, type ShapeType } from "../constants";

export type Vec3 = [number, number, number];

export interface SDFShape {
  id: string;
  type: ShapeType;
  position: Vec3;
  size: Vec3;
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

export interface GizmoDrag {
  active: boolean;
  axis: "x" | "y" | "z";
  shapeId: string;
  startMousePos: Vec3;
  startShapePos: Vec3;
  previewPos: Vec3;
}

export const sceneState = proxy({
  shapes: [] as SDFShape[],
  activeTool: "select" as "select" | ShapeType,
  selectedShapeId: null as string | null,
  gizmoDrag: {
    active: false,
    axis: "x" as "x" | "y" | "z",
    shapeId: "",
    startMousePos: [0, 0, 0] as Vec3,
    startShapePos: [0, 0, 0] as Vec3,
    previewPos: [0, 0, 0] as Vec3,
  } as GizmoDrag,
  drag: {
    active: false,
    phase: "idle",
    startPoint: [0, 0, 0] as Vec3,
    baseFloorY: -BOUNDS,
    baseHalfX: 0,
    baseHalfZ: 0,
    baseMidX: 0,
    baseMidZ: 0,
    baseRadius: 0,
    previewPosition: [0, 0, 0] as Vec3,
    previewSize: [0.01, 0.01, 0.01] as Vec3,
  } as DragState,
  version: 0,
});

let nextId = 1;

export function addShape(shape: Omit<SDFShape, "id">) {
  sceneState.shapes.push({ ...shape, id: String(nextId++) });
  sceneState.version++;
}

export function setTool(tool: "select" | ShapeType) {
  sceneState.activeTool = tool;
}

export function isShapeTool(tool: string): tool is ShapeType {
  return (SHAPE_TYPES as readonly string[]).includes(tool);
}

export function startDrag(worldPoint: Vec3, floorY: number = -BOUNDS) {
  sceneState.drag.active = true;
  sceneState.drag.phase = "base";
  sceneState.drag.startPoint = worldPoint;
  sceneState.drag.baseFloorY = floorY;
  sceneState.drag.previewPosition = worldPoint;
  sceneState.drag.previewSize = [0.01, 0.01, 0.01];
}

export function startRadiusDrag(center: Vec3, floorY: number = -BOUNDS) {
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
      size: [...previewSize] as Vec3,
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
      size: [...previewSize] as Vec3,
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
  sceneState.drag.baseFloorY = -BOUNDS;
  sceneState.drag.baseHalfX = 0;
  sceneState.drag.baseHalfZ = 0;
  sceneState.drag.baseMidX = 0;
  sceneState.drag.baseMidZ = 0;
  sceneState.drag.baseRadius = 0;
}

export function selectShape(id: string | null) {
  sceneState.selectedShapeId = id;
}

export function moveShape(id: string, newPosition: Vec3) {
  const shape = sceneState.shapes.find((s) => s.id === id);
  if (!shape) return;
  shape.position = newPosition;
  sceneState.version++;
}

export function startGizmoDrag(
  axis: "x" | "y" | "z",
  shapeId: string,
  mousePos: Vec3,
  shapePos: Vec3,
) {
  sceneState.gizmoDrag.active = true;
  sceneState.gizmoDrag.axis = axis;
  sceneState.gizmoDrag.shapeId = shapeId;
  sceneState.gizmoDrag.startMousePos = mousePos;
  sceneState.gizmoDrag.startShapePos = shapePos;
  sceneState.gizmoDrag.previewPos = [...shapePos] as Vec3;
}

export function updateGizmoDrag(previewPos: Vec3) {
  sceneState.gizmoDrag.previewPos = previewPos;
}

export function commitGizmoDrag() {
  if (!sceneState.gizmoDrag.active) return;
  const { shapeId, previewPos } = sceneState.gizmoDrag;
  moveShape(shapeId, [...previewPos] as Vec3);
  resetGizmoDrag();
}

export function cancelGizmoDrag() {
  resetGizmoDrag();
}

function resetGizmoDrag() {
  sceneState.gizmoDrag.active = false;
  sceneState.gizmoDrag.shapeId = "";
}
