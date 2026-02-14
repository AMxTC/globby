import { Raycaster, Vector2, Vector3, Plane, Matrix4, type PerspectiveCamera } from "three";
import {
  sceneState, isShapeTool,
  startDrag, updateBase, lockBase,
  updateHeight, commitHeight,
  startRadiusDrag, updateRadius, commitRadius,
  selectShape, toggleShapeSelection, enterEditMode, exitEditMode,
  type Vec3,
} from "../state/sceneStore";
import type { GPURenderer } from "./renderer";
import { worldAABBToScreenRect } from "../lib/math3d";

const FLOOR_Y = 0;
const raycaster = new Raycaster();
const mouse = new Vector2();
const floorPlane = new Plane(new Vector3(0, 1, 0), -FLOOR_Y); // y = FLOOR_Y
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

const MARQUEE_THRESHOLD = 4; // px distance before drag becomes marquee

function commitSelection(ids: string[], shift: boolean) {
  if (shift) {
    const existing = new Set(sceneState.selectedShapeIds);
    for (const id of ids) existing.add(id);
    sceneState.selectedShapeIds = [...existing];
  } else {
    sceneState.selectedShapeIds = ids;
  }
  if (sceneState.selectedShapeIds.length !== 1) {
    sceneState.editMode = "object";
  }
}

/** Convert CSS-space rect to device-pixel rect relative to the canvas. */
function cssRectToDevicePixels(
  cssLeft: number, cssTop: number, cssW: number, cssH: number,
  canvas: HTMLCanvasElement,
): { px: number; py: number; pw: number; ph: number } {
  const dpr = window.devicePixelRatio;
  const rect = canvas.getBoundingClientRect();
  return {
    px: (cssLeft - rect.left) * dpr,
    py: (cssTop - rect.top) * dpr,
    pw: cssW * dpr,
    ph: cssH * dpr,
  };
}

export function setupPointer(
  canvas: HTMLCanvasElement,
  camera: PerspectiveCamera,
  getRenderer: () => GPURenderer | null,
): () => void {
  let extrudeCornerX = 0;
  let extrudeCornerZ = 0;
  let marqueeStart: { x: number; y: number; pointerId: number; shiftKey: boolean } | null = null;

  function onPointerDown(e: PointerEvent) {
    const tool = sceneState.activeTool;

    // --- Select tool handling ---
    if (tool === "select") {
      if (e.button !== 0) return;

      e.preventDefault();
      // Don't stopImmediatePropagation here — let OrbitControls see the
      // pointerdown so orbit/pan still works until the marquee threshold
      // is crossed (at which point pointermove will block it).

      marqueeStart = { x: e.clientX, y: e.clientY, pointerId: e.pointerId, shiftKey: e.shiftKey };
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    // --- Shape tool handling (existing code) ---
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
        renderer.pickWorldPos(pixelX, pixelY).then((result) => {
          // If drag was cancelled while we were waiting, bail
          if (sceneState.drag.phase !== "idle" || !isShapeTool(sceneState.activeTool)) return;

          let point: Vec3;
          let floorY: number;

          if (result) {
            // Hit a shape surface — place on top
            point = [result.worldPos[0], result.worldPos[1], result.worldPos[2]];
            floorY = result.worldPos[1];
          } else {
            // No shape hit — use floor plane
            if (!floorHit) {
              canvas.releasePointerCapture(e.pointerId);
              return;
            }
            point = floorHit;
            floorY = FLOOR_Y;
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
          startRadiusDrag(floorHit, FLOOR_Y);
        } else {
          startDrag(floorHit, FLOOR_Y);
        }
      }
    } else if (phase === "height") {
      e.preventDefault();
      e.stopImmediatePropagation();
      commitHeight();
    }
  }

  function onPointerMove(e: PointerEvent) {
    // --- Marquee drag ---
    if (marqueeStart) {
      const dx = e.clientX - marqueeStart.x;
      const dy = e.clientY - marqueeStart.y;
      if (!sceneState.marquee && Math.sqrt(dx * dx + dy * dy) > MARQUEE_THRESHOLD) {
        sceneState.marquee = {
          x1: marqueeStart.x,
          y1: marqueeStart.y,
          x2: e.clientX,
          y2: e.clientY,
        };
      }
      if (sceneState.marquee) {
        sceneState.marquee.x2 = e.clientX;
        sceneState.marquee.y2 = e.clientY;
        e.stopImmediatePropagation();
      }
      // Sub-threshold moves propagate to orbit controls normally
      return;
    }

    // --- Shape creation drag ---
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

  /** Window mode (L→R): select shapes whose screen AABB fits entirely inside the marquee. */
  function selectWindow(cssLeft: number, cssTop: number, cssW: number, cssH: number, shift: boolean) {
    const rect = canvas.getBoundingClientRect();
    const mLeft = cssLeft - rect.left;
    const mTop = cssTop - rect.top;
    const mRight = mLeft + cssW;
    const mBottom = mTop + cssH;

    const vpMat = new Matrix4();
    camera.updateMatrixWorld();
    vpMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    const ids: string[] = [];
    const visibleLayerIds = new Set(
      sceneState.layers.filter((l) => l.visible).map((l) => l.id),
    );
    for (const shape of sceneState.shapes) {
      if (!visibleLayerIds.has(shape.layerId)) continue;
      const sr = worldAABBToScreenRect(
        shape.position, shape.size, shape.rotation, shape.scale,
        vpMat, cw, ch,
      );
      if (!sr) continue;
      if (sr.minX >= mLeft && sr.minY >= mTop && sr.maxX <= mRight && sr.maxY <= mBottom) {
        ids.push(shape.id);
      }
    }
    commitSelection(ids, shift);
  }

  /** Crossing mode (R→L): select any shape with a visible pixel inside the marquee via GPU readback. */
  function selectCrossing(cssLeft: number, cssTop: number, cssW: number, cssH: number, shift: boolean) {
    const renderer = getRenderer();
    if (!renderer) return;
    const { px, py, pw, ph } = cssRectToDevicePixels(cssLeft, cssTop, cssW, cssH, canvas);
    renderer.pickRegionShapeIds(px, py, pw, ph).then((regionIds) => {
      commitSelection([...regionIds], shift);
    });
  }

  /** Single-pixel click select via GPU pick. */
  function selectClick(clientX: number, clientY: number, shift: boolean) {
    const renderer = getRenderer();
    if (!renderer) return;
    const { px, py } = cssRectToDevicePixels(clientX, clientY, 0, 0, canvas);
    renderer.pickWorldPos(px, py).then((result) => {
      if (result && result.shapeId) {
        if (shift) {
          toggleShapeSelection(result.shapeId);
        } else {
          selectShape(result.shapeId);
        }
      } else if (!shift) {
        selectShape(null);
      }
    });
  }

  function onPointerUp(e: PointerEvent) {
    // --- Marquee / click select ---
    if (marqueeStart) {
      const marqueeRect = sceneState.marquee
        ? { x1: sceneState.marquee.x1, y1: sceneState.marquee.y1, x2: sceneState.marquee.x2, y2: sceneState.marquee.y2 }
        : null;
      const shiftKey = marqueeStart.shiftKey;
      const isSelectTool = sceneState.activeTool === "select";
      canvas.releasePointerCapture(marqueeStart.pointerId);
      marqueeStart = null;
      sceneState.marquee = null;

      // Tool switched mid-drag (e.g. hotkey) — just clean up
      if (!isSelectTool) return;

      if (marqueeRect) {
        const isWindow = marqueeRect.x2 >= marqueeRect.x1;
        const left = Math.min(marqueeRect.x1, marqueeRect.x2);
        const top = Math.min(marqueeRect.y1, marqueeRect.y2);
        const width = Math.abs(marqueeRect.x2 - marqueeRect.x1);
        const height = Math.abs(marqueeRect.y2 - marqueeRect.y1);

        if (isWindow) {
          selectWindow(left, top, width, height, shiftKey);
        } else {
          selectCrossing(left, top, width, height, shiftKey);
        }
      } else {
        selectClick(e.clientX, e.clientY, shiftKey);
      }
      return;
    }

    const { phase } = sceneState.drag;

    if (phase === "base") {
      canvas.releasePointerCapture(e.pointerId);
      lockBase();
    } else if (phase === "radius") {
      canvas.releasePointerCapture(e.pointerId);
      commitRadius();
    }
  }

  function onDblClick(e: MouseEvent) {
    if (sceneState.activeTool !== "select") return;
    if (e.button !== 0) return;

    if (sceneState.selectedShapeIds.length === 1) {
      if (sceneState.editMode === "edit") {
        exitEditMode();
      } else {
        enterEditMode();
      }
    }
  }

  canvas.addEventListener("pointerdown", onPointerDown, true);
  canvas.addEventListener("pointermove", onPointerMove, true);
  canvas.addEventListener("pointerup", onPointerUp, true);
  canvas.addEventListener("dblclick", onDblClick);

  return () => {
    canvas.removeEventListener("pointerdown", onPointerDown, true);
    canvas.removeEventListener("pointermove", onPointerMove, true);
    canvas.removeEventListener("pointerup", onPointerUp, true);
    canvas.removeEventListener("dblclick", onDblClick);
  };
}
