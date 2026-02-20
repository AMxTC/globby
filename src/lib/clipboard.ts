import {
  sceneState,
  addShape,
  deleteSelectedShapes,
  type Vec3,
  type SDFShape,
} from "../state/sceneStore";

let clipboard: Omit<SDFShape, "id" | "layerId">[] = [];

function cloneShape(shape: SDFShape): Omit<SDFShape, "id" | "layerId"> {
  return {
    type: shape.type,
    position: [...shape.position] as Vec3,
    rotation: [...shape.rotation] as Vec3,
    size: [...shape.size] as Vec3,
    scale: shape.scale,
    fx: shape.fx,
    fxParams: shape.fxParams ? ([...shape.fxParams] as Vec3) : undefined,
    vertices: shape.vertices
      ? shape.vertices.map((v) => [...v] as [number, number])
      : undefined,
    capped: shape.capped,
    wallThickness: shape.wallThickness,
  };
}

export function copyShapes() {
  const ids = sceneState.selectedShapeIds;
  if (ids.length === 0) return;
  clipboard = [];
  for (const id of ids) {
    const shape = sceneState.shapes.find((s) => s.id === id);
    if (!shape) continue;
    clipboard.push(cloneShape(shape));
  }
}

export function pasteShapes() {
  if (clipboard.length === 0) return;
  const newIds: string[] = [];
  for (const item of clipboard) {
    addShape({
      ...item,
      position: [...item.position] as Vec3,
      rotation: [...item.rotation] as Vec3,
      size: [...item.size] as Vec3,
      vertices: item.vertices
        ? item.vertices.map((v) => [...v] as [number, number])
        : undefined,
      fxParams: item.fxParams ? ([...item.fxParams] as Vec3) : undefined,
    });
    const last = sceneState.shapes[sceneState.shapes.length - 1];
    if (last) newIds.push(last.id);
  }
  sceneState.selectedShapeIds = newIds;
}

export function cutShapes() {
  const ids = sceneState.selectedShapeIds;
  if (ids.length === 0) return;
  clipboard = [];
  for (const id of ids) {
    const shape = sceneState.shapes.find((s) => s.id === id);
    if (!shape) continue;
    clipboard.push(cloneShape(shape));
  }
  deleteSelectedShapes();
}

export function hasClipboard(): boolean {
  return clipboard.length > 0;
}
