import { Raycaster, Vector2, Vector3, Plane, type PerspectiveCamera } from "three";
import {
  sceneState, isShapeTool,
  startDrag, updateBase, lockBase,
  updateHeight, commitHeight, cancelDrag,
  startRadiusDrag, updateRadius, commitRadius,
} from "../state/sceneStore";
import { BOUNDS } from "../constants";
import type { Vec3 } from "../sdf";
import type { GPURenderer } from "./renderer";

const raycaster = new Raycaster();
const mouse = new Vector2();
const floorPlane = new Plane(new Vector3(0, 1, 0), BOUNDS); // y = -BOUNDS
const intersection = new Vector3();

function setMouseNDC(e: PointerEvent, canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
}

function getFloorPoint(
  event: PointerEvent,
  canvas: HTMLCanvasElement,
  camera: PerspectiveCamera,
): Vec3 | null {
  setMouseNDC(event, canvas);
  raycaster.setFromCamera(mouse, camera);
  const hit = raycaster.ray.intersectPlane(floorPlane, intersection);
  if (!hit) return null;
  return [hit.x, hit.y, hit.z];
}

// Intersect a horizontal plane at the given Y
function getPlanePoint(
  event: PointerEvent,
  canvas: HTMLCanvasElement,
  camera: PerspectiveCamera,
  planeY: number,
): Vec3 | null {
  setMouseNDC(event, canvas);
  raycaster.setFromCamera(mouse, camera);
  const plane = new Plane(new Vector3(0, 1, 0), -planeY);
  const hit = raycaster.ray.intersectPlane(plane, intersection);
  if (!hit) return null;
  return [hit.x, hit.y, hit.z];
}

// Find the Y on a vertical line (at cornerX, cornerZ) closest to the mouse ray.
function getHeightFromRay(
  event: PointerEvent,
  canvas: HTMLCanvasElement,
  camera: PerspectiveCamera,
  cornerX: number,
  cornerZ: number,
): number {
  setMouseNDC(event, canvas);
  raycaster.setFromCamera(mouse, camera);

  const ro = raycaster.ray.origin;
  const rd = raycaster.ray.direction;

  const baseY = sceneState.drag.baseFloorY;
  const anchor = new Vector3(cornerX, baseY, cornerZ);
  const up = new Vector3(0, 1, 0);

  const w0 = new Vector3().subVectors(ro, anchor);
  const a = rd.dot(rd);
  const b = rd.dot(up);
  const c = up.dot(up);
  const d = rd.dot(w0);
  const e = up.dot(w0);

  const denom = a * c - b * b;
  if (Math.abs(denom) < 1e-8) {
    return baseY + 0.5;
  }

  const t = (a * e - b * d) / denom;

  return baseY + Math.max(t, 0);
}

export function setupPointer(
  canvas: HTMLCanvasElement,
  camera: PerspectiveCamera,
  getRenderer: () => GPURenderer | null,
): () => void {
  let extrudeCornerX = 0;
  let extrudeCornerZ = 0;

  function onPointerDown(e: PointerEvent) {
    const tool = sceneState.activeTool;
    if (!isShapeTool(tool)) return;
    if (e.button !== 0) return;

    const { phase } = sceneState.drag;

    if (phase === "idle") {
      e.preventDefault();
      e.stopImmediatePropagation();
      canvas.setPointerCapture(e.pointerId);

      // Compute floor hit eagerly (event coords won't survive async)
      const floorHit = getFloorPoint(e, canvas, camera);

      // Try GPU pick for surface hit, then fall back to floor plane
      const dpr = window.devicePixelRatio;
      const rect = canvas.getBoundingClientRect();
      const pixelX = (e.clientX - rect.left) * dpr;
      const pixelY = (e.clientY - rect.top) * dpr;

      const renderer = getRenderer();
      if (renderer) {
        renderer.pickWorldPos(pixelX, pixelY).then((worldPos) => {
          // If drag was cancelled while we were waiting, bail
          if (sceneState.drag.phase !== "idle" || !isShapeTool(sceneState.activeTool)) return;

          let point: Vec3;
          let floorY: number;

          if (worldPos) {
            // Hit a shape surface — place on top
            point = [worldPos[0], worldPos[1], worldPos[2]];
            floorY = worldPos[1];
          } else {
            // No shape hit — use floor plane
            if (!floorHit) {
              canvas.releasePointerCapture(e.pointerId);
              return;
            }
            point = floorHit;
            floorY = -BOUNDS;
          }

          if (tool === "sphere") {
            startRadiusDrag(point, floorY);
          } else {
            startDrag(point, floorY);
          }
        });
      } else {
        // No renderer yet — just use floor
        if (!floorHit) {
          canvas.releasePointerCapture(e.pointerId);
          return;
        }
        if (tool === "sphere") {
          startRadiusDrag(floorHit, -BOUNDS);
        } else {
          startDrag(floorHit, -BOUNDS);
        }
      }
    } else if (phase === "height") {
      e.preventDefault();
      e.stopImmediatePropagation();
      commitHeight();
    }
  }

  function onPointerMove(e: PointerEvent) {
    const { phase } = sceneState.drag;

    if (phase === "base") {
      const floorY = sceneState.drag.baseFloorY;
      const point = getPlanePoint(e, canvas, camera, floorY);
      if (!point) return;
      e.stopImmediatePropagation();
      updateBase(point);

      const tool = sceneState.activeTool;
      if (tool === "box") {
        extrudeCornerX = point[0];
        extrudeCornerZ = point[2];
      } else {
        const [sx, , sz] = sceneState.drag.startPoint;
        const dx = point[0] - sx;
        const dz = point[2] - sz;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > 0.001) {
          extrudeCornerX = sx + dx / dist * sceneState.drag.baseRadius;
          extrudeCornerZ = sz + dz / dist * sceneState.drag.baseRadius;
        } else {
          extrudeCornerX = sx + sceneState.drag.baseRadius;
          extrudeCornerZ = sz;
        }
      }
    } else if (phase === "height") {
      e.stopImmediatePropagation();
      const worldY = getHeightFromRay(e, canvas, camera, extrudeCornerX, extrudeCornerZ);
      updateHeight(worldY);
    } else if (phase === "radius") {
      const floorY = sceneState.drag.baseFloorY;
      const point = getPlanePoint(e, canvas, camera, floorY);
      if (!point) return;
      e.stopImmediatePropagation();
      updateRadius(point);
    }
  }

  function onPointerUp(e: PointerEvent) {
    const { phase } = sceneState.drag;

    if (phase === "base") {
      canvas.releasePointerCapture(e.pointerId);
      lockBase();
    } else if (phase === "radius") {
      canvas.releasePointerCapture(e.pointerId);
      commitRadius();
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && sceneState.drag.phase !== "idle") {
      cancelDrag();
    }
  }

  canvas.addEventListener("pointerdown", onPointerDown, true);
  canvas.addEventListener("pointermove", onPointerMove, true);
  canvas.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("keydown", onKeyDown);

  return () => {
    canvas.removeEventListener("pointerdown", onPointerDown, true);
    canvas.removeEventListener("pointermove", onPointerMove, true);
    canvas.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("keydown", onKeyDown);
  };
}
