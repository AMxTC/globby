import { Raycaster, Vector2, Vector3, Plane, Matrix4, type PerspectiveCamera } from "three";

const _vpMat = new Matrix4();
import {
  sceneState, sceneRefs, isShapeTool, pushUndo, undo,
  startDrag, updateBase, lockBase,
  updateHeight, commitHeight,
  startRadiusDrag, updateRadius, commitRadius,
  selectShape, toggleShapeSelection, enterEditMode, exitEditMode,
  scaleShape, editPolyVertices, recenterPolyBounds,
  addPenVertex, closePen,
  duplicateSelectedShapes,
  type Vec3,
  type SDFShape,
} from "../state/sceneStore";
import type { GPURenderer } from "./renderer";
import { worldAABBToScreenRect, eulerToMatrix3, projectRayOnAxisDir, projectRayOnPlane, worldToScreen } from "../lib/math3d";
import { computeFaceDrag, detectFace, type FaceDragParams, type FaceResult } from "../lib/editFace";
import { setRawCursor, makePushPullArrowCursor, makeHoverArrowCursor } from "../lib/cursors";

/** Intersect two 2D lines (p0+t*d0) and (p1+s*d1). Returns the intersection point,
 *  or null if lines are parallel. */
function lineLineIntersect2D(
  p0: [number, number], d0: [number, number],
  p1: [number, number], d1: [number, number],
): [number, number] | null {
  const det = d0[0] * d1[1] - d0[1] * d1[0];
  if (Math.abs(det) < 1e-10) return null; // parallel
  const dx = p1[0] - p0[0];
  const dz = p1[1] - p0[1];
  const t = (dx * d1[1] - dz * d1[0]) / det;
  return [p0[0] + t * d0[0], p0[1] + t * d0[1]];
}

/** Move edge ei along normal by localDelta, then project adjacent vertices
 *  along their original edge directions to preserve edge orientations. */
function pushPullPolyEdge(
  startVerts: [number, number][],
  ei: number,
  nx: number, nz: number,
  localDelta: number,
): [number, number][] {
  const count = startVerts.length;
  const j = (ei + 1) % count;
  const newVerts = startVerts.map(v => [...v] as [number, number]);

  // Pushed edge: offset both endpoints along normal
  const pushedA: [number, number] = [startVerts[ei][0] + nx * localDelta, startVerts[ei][1] + nz * localDelta];
  const pushedB: [number, number] = [startVerts[j][0] + nx * localDelta, startVerts[j][1] + nz * localDelta];
  // Direction of the pushed edge (same as original edge direction)
  const edgeDir: [number, number] = [startVerts[j][0] - startVerts[ei][0], startVerts[j][1] - startVerts[ei][1]];

  // Previous edge: prev -> ei. Its direction stays fixed.
  const prev = (ei - 1 + count) % count;
  const prevDir: [number, number] = [startVerts[ei][0] - startVerts[prev][0], startVerts[ei][1] - startVerts[prev][1]];
  const intA = lineLineIntersect2D(startVerts[prev], prevDir, pushedA, edgeDir);
  newVerts[ei] = intA ?? pushedA;

  // Next edge: j -> next. Its direction stays fixed.
  const next = (j + 1) % count;
  const nextDir: [number, number] = [startVerts[next][0] - startVerts[j][0], startVerts[next][1] - startVerts[j][1]];
  const intB = lineLineIntersect2D(startVerts[next], nextDir, pushedA, edgeDir);
  newVerts[j] = intB ?? pushedB;

  return newVerts;
}

/** Compute the world-space push/pull axis direction for a detected face. */
function computeAxisDir(
  face: FaceResult,
  shape: SDFShape,
  worldPos: [number, number, number],
): Vec3 {
  // Polygon edge: compute edge normal as axis
  if (face.edgeIdx !== undefined && shape.type === "polygon" && shape.vertices) {
    const verts = shape.vertices;
    const count = verts.length;
    const ei = face.edgeIdx;
    const v0 = verts[ei];
    const v1 = verts[(ei + 1) % count];
    const edx = v1[0] - v0[0];
    const edz = v1[1] - v0[1];
    let nx = edz, nz = -edx;
    const nLen = Math.sqrt(nx * nx + nz * nz);
    if (nLen > 1e-12) { nx /= nLen; nz /= nLen; }
    const mx = (v0[0] + v1[0]) * 0.5;
    const mz = (v0[1] + v1[1]) * 0.5;
    if (nx * mx + nz * mz < 0) { nx = -nx; nz = -nz; }
    const m = eulerToMatrix3(shape.rotation[0], shape.rotation[1], shape.rotation[2]);
    return [
      m[0] * nx + m[6] * nz,
      m[1] * nx + m[7] * nz,
      m[2] * nx + m[8] * nz,
    ];
  }

  if (shape.type === "sphere") {
    const dx = worldPos[0] - shape.position[0];
    const dy = worldPos[1] - shape.position[1];
    const dz = worldPos[2] - shape.position[2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return len > 1e-6 ? [dx / len, dy / len, dz / len] : [1, 0, 0];
  }

  if (
    (shape.type === "cylinder" || shape.type === "cone" || shape.type === "pyramid") &&
    face.axis !== "y"
  ) {
    const m = eulerToMatrix3(shape.rotation[0], shape.rotation[1], shape.rotation[2]);
    const dx = worldPos[0] - shape.position[0];
    const dy = worldPos[1] - shape.position[1];
    const dz = worldPos[2] - shape.position[2];
    const lx = m[0] * dx + m[1] * dy + m[2] * dz;
    const lz = m[6] * dx + m[7] * dy + m[8] * dz;
    const rLen = Math.sqrt(lx * lx + lz * lz);
    const nx = rLen > 1e-6 ? lx / rLen : 1;
    const nz = rLen > 1e-6 ? lz / rLen : 0;
    return [
      m[0] * nx + m[6] * nz,
      m[1] * nx + m[7] * nz,
      m[2] * nx + m[8] * nz,
    ];
  }

  // Box faces & cap faces: use the local axis from rotation matrix
  const m = eulerToMatrix3(shape.rotation[0], shape.rotation[1], shape.rotation[2]);
  return [
    m[face.axisIdx * 3 + 0],
    m[face.axisIdx * 3 + 1],
    m[face.axisIdx * 3 + 2],
  ];
}

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

// --- Push/Pull helpers ---

type PushPullDrag = FaceDragParams & {
  shapeId: string;
  startT: number;      // ray parameter at drag start
  axis?: "x" | "y" | "z";  // needed for computeFaceDrag shape dispatch
  edgeIdx?: number;                    // polygon edge index
  edgeNormal2D?: [number, number];     // local 2D outward normal of the edge
  startVertices?: [number, number][];  // snapshot of vertices at drag start
  startBoundingRadius?: number;        // snapshot of size[0] at drag start
};

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
  let pushPullDrag: PushPullDrag | null = null;
  // Shape drag state (click+drag selected shape to move in camera plane)
  let selectPickResult: { shapeId: string | null } | null = null; // async pick result from pointerdown
  let shapeDrag: {
    shapeIds: string[];
    startPositions: Vec3[];
    planeNormal: Vec3;
    planeOrigin: Vec3;
    startHit: Vec3;
  } | null = null;
  const PEN_CLOSE_PX = 20; // screen-pixel distance to first vertex to close

  // Serialises all GPU picks (hover + click) through a single promise chain
  // so only one mapAsync is in-flight at a time.
  let pickChain: Promise<void> = Promise.resolve();
  let hoverPickQueued = false;
  const HOVER_PICK_INTERVAL = 50; // ms throttle for hover GPU picks
  let lastHoverPickTime = 0;

  function updateHoverCursor(e: PointerEvent) {
    if (pushPullDrag || hoverPickQueued) return;
    const now = performance.now();
    if (now - lastHoverPickTime < HOVER_PICK_INTERVAL) return;
    lastHoverPickTime = now;

    const renderer = getRenderer();
    if (!renderer) return;

    const dpr = window.devicePixelRatio;
    const rect = canvas.getBoundingClientRect();
    const pixelX = (e.clientX - rect.left) * dpr;
    const pixelY = (e.clientY - rect.top) * dpr;

    hoverPickQueued = true;
    pickChain = pickChain.then(() => {
      hoverPickQueued = false;
      // Bail if drag started or tool changed while queued
      if (pushPullDrag || sceneState.activeTool !== "pushpull") return;
      return renderer.pickWorldPos(pixelX, pixelY).then((result) => {
        if (pushPullDrag || sceneState.activeTool !== "pushpull") return;

        if (!result || !result.shapeId) {
          setRawCursor(null);
          return;
        }
        const shape = sceneState.shapes.find((s) => s.id === result.shapeId);
        if (!shape) { setRawCursor(null); return; }

        const face = detectFace(result.worldPos as Vec3, shape);
        if (!face) { setRawCursor(null); return; }

        const axisDir = computeAxisDir(face, shape, result.worldPos);
        setRawCursor(makeHoverArrowCursor(cursorAngle(shape.position, axisDir, face.negative)));
      });
    }).catch(() => {});
  }

  function axisDirToScreenAngle(shapePos: Vec3, axisDir: Vec3): number {
    camera.updateMatrixWorld();
    _vpMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    const [sx0, sy0] = worldToScreen(shapePos, _vpMat, cw, ch);
    const [sx1, sy1] = worldToScreen(
      [shapePos[0] + axisDir[0], shapePos[1] + axisDir[1], shapePos[2] + axisDir[2]],
      _vpMat, cw, ch,
    );
    const dx = sx1 - sx0;
    const dy = sy1 - sy0;
    return Math.atan2(dx, -dy) * (180 / Math.PI);
  }

  function cursorAngle(pos: Vec3, axisDir: Vec3, negative: boolean): number {
    return axisDirToScreenAngle(pos, axisDir) + (negative ? 180 : 0);
  }

  function isNearFirstVertex(clickX: number, clickY: number): boolean {
    const verts = sceneState.penVertices;
    if (verts.length < 3) return false;
    camera.updateMatrixWorld();
    _vpMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    const floorY = sceneState.penFloorY;
    const [sx, sy, vis] = worldToScreen([verts[0][0], floorY, verts[0][1]], _vpMat, cw, ch);
    if (!vis) return false;
    const rect = canvas.getBoundingClientRect();
    const px = clickX - rect.left;
    const py = clickY - rect.top;
    const dx = px - sx;
    const dy = py - sy;
    return Math.sqrt(dx * dx + dy * dy) < PEN_CLOSE_PX;
  }

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

      // Fire async GPU pick so we know if the click hit a selected shape (for drag-move)
      selectPickResult = null;
      const renderer = getRenderer();
      if (renderer) {
        const { px, py } = cssRectToDevicePixels(e.clientX, e.clientY, 0, 0, canvas);
        renderer.pickWorldPos(px, py).then((result) => {
          if (!marqueeStart) return; // already committed/cancelled
          selectPickResult = { shapeId: result?.shapeId ?? null };
        });
      }
      return;
    }

    // --- Push/Pull tool handling ---
    if (tool === "pushpull") {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      canvas.setPointerCapture(e.pointerId);

      const dpr = window.devicePixelRatio;
      const rect = canvas.getBoundingClientRect();
      const pixelX = (e.clientX - rect.left) * dpr;
      const pixelY = (e.clientY - rect.top) * dpr;
      const clientX = e.clientX;
      const clientY = e.clientY;

      const renderer = getRenderer();
      if (!renderer) {
        canvas.releasePointerCapture(e.pointerId);
        return;
      }

      pickChain = pickChain.then(() => renderer.pickWorldPos(pixelX, pixelY)).then((result) => {
        // Stale check: tool changed or drag already started while awaiting pick
        if (sceneState.activeTool !== "pushpull" || pushPullDrag) {
          canvas.releasePointerCapture(e.pointerId);
          return;
        }

        if (!result || !result.shapeId) {
          canvas.releasePointerCapture(e.pointerId);
          return;
        }

        const shape = sceneState.shapes.find((s) => s.id === result.shapeId);
        if (!shape) {
          canvas.releasePointerCapture(e.pointerId);
          return;
        }

        const face = detectFace(result.worldPos as Vec3, shape);
        if (!face) {
          canvas.releasePointerCapture(e.pointerId);
          return;
        }

        const axisDir = computeAxisDir(face, shape, result.worldPos);

        // Polygon edge push/pull: extra state for edge constraint
        if (face.edgeIdx !== undefined && shape.type === "polygon" && shape.vertices) {
          const verts = shape.vertices;
          const count = verts.length;
          const ei = face.edgeIdx;
          const v0 = verts[ei];
          const v1 = verts[(ei + 1) % count];
          const edx = v1[0] - v0[0];
          const edz = v1[1] - v0[1];
          let nx = edz, nz = -edx;
          const nLen = Math.sqrt(nx * nx + nz * nz);
          if (nLen > 1e-12) { nx /= nLen; nz /= nLen; }
          const mx = (v0[0] + v1[0]) * 0.5;
          const mz = (v0[1] + v1[1]) * 0.5;
          if (nx * mx + nz * mz < 0) { nx = -nx; nz = -nz; }

          const startT = projectRayOnAxisDir(
            camera, canvas, clientX, clientY,
            shape.position, axisDir,
          );

          pushPullDrag = {
            shapeId: shape.id,
            axisIdx: face.axisIdx,
            negative: face.negative,
            axisDir,
            startT,
            startPos: [...shape.position] as Vec3,
            startSize: [...shape.size] as Vec3,
            startScale: shape.scale,
            axis: face.axis,
            edgeIdx: ei,
            edgeNormal2D: [nx, nz],
            startVertices: verts.map(v => [...v] as [number, number]),
            startBoundingRadius: shape.size[0],
          };
          setRawCursor(makePushPullArrowCursor(cursorAngle(shape.position, axisDir, face.negative)));
          return;
        }

        // Project ray onto that axis to get startT
        const startT = projectRayOnAxisDir(
          camera, canvas, clientX, clientY,
          shape.position, axisDir,
        );

        pushPullDrag = {
          shapeId: shape.id,
          axisIdx: face.axisIdx,
          negative: face.negative,
          axisDir,
          startT,
          startPos: [...shape.position] as Vec3,
          startSize: [...shape.size] as Vec3,
          startScale: shape.scale,
          axis: face.axis,
        };
        setRawCursor(makePushPullArrowCursor(cursorAngle(shape.position, axisDir, face.negative)));
      }).catch(() => {});
      return;
    }

    // --- Polygon pen tool handling ---
    if (tool === "polygon") {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();

      const { phase } = sceneState.drag;

      // Height phase: commit on click
      if (phase === "height") {
        commitHeight();
        return;
      }

      // Vertex placement phase
      const floorHit = getFloorPoint(e, canvas, camera);

      // Check screen-space close before async GPU pick
      if (isNearFirstVertex(e.clientX, e.clientY)) {
        closePen(0.10);
        return;
      }

      // Pre-compute plane projection for subsequent vertices (event won't survive async)
      const penPlaneHit = sceneState.penVertices.length > 0
        ? getPlanePoint(e, canvas, camera, sceneState.penFloorY)
        : null;

      // Try GPU pick for surface placement
      const dpr = window.devicePixelRatio;
      const rect = canvas.getBoundingClientRect();
      const pixelX = (e.clientX - rect.left) * dpr;
      const pixelY = (e.clientY - rect.top) * dpr;
      const renderer = getRenderer();

      if (renderer) {
        renderer.pickWorldPos(pixelX, pixelY).then((result) => {
          if (sceneState.activeTool !== "polygon") return;
          if (sceneState.drag.phase === "height") return;

          const verts = sceneState.penVertices;

          if (verts.length === 0) {
            // First vertex: establish the drawing plane from the hit Y
            let x: number, z: number, floorY: number;
            if (result) {
              x = result.worldPos[0];
              z = result.worldPos[2];
              floorY = result.worldPos[1];
            } else if (floorHit) {
              x = floorHit[0];
              z = floorHit[2];
              floorY = FLOOR_Y;
            } else {
              return;
            }
            sceneState.penFloorY = floorY;
            addPenVertex(x, z);
          } else {
            // Subsequent vertices: project onto the established penFloorY plane
            if (!penPlaneHit) return;
            addPenVertex(penPlaneHit[0], penPlaneHit[2]);
          }

          // Auto-close at max vertices
          if (sceneState.penVertices.length >= 16) {
            closePen(0.10);
          }
        });
      } else if (floorHit) {
        const verts = sceneState.penVertices;
        if (verts.length === 0) {
          sceneState.penFloorY = FLOOR_Y;
        }
        addPenVertex(floorHit[0], floorHit[2]);
        if (sceneState.penVertices.length >= 16) {
          closePen(0.10);
        }
      }
      return;
    }

    // --- Shape tool handling (existing code) ---
    if (!isShapeTool(tool)) return;
    if (e.button !== 0) return;

    const { phase } = sceneState.drag;

    if (phase === "idle") {
      e.preventDefault();
      e.stopImmediatePropagation();

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
    // --- Pen tool cursor tracking ---
    if (sceneState.activeTool === "polygon" && sceneState.penVertices.length > 0 && sceneState.drag.phase !== "height") {
      const floorY = sceneState.penFloorY;
      const pt = getPlanePoint(e, canvas, camera, floorY);
      if (pt) {
        sceneRefs.penCursorXZ = [pt[0], pt[2]];
      }
    } else {
      sceneRefs.penCursorXZ = null;
    }

    // --- Push/Pull hover cursor ---
    if (sceneState.activeTool === "pushpull" && !pushPullDrag) {
      updateHoverCursor(e);
    }

    // --- Push/Pull drag ---
    if (pushPullDrag) {
      e.stopImmediatePropagation();
      const currentT = projectRayOnAxisDir(
        camera, canvas, e.clientX, e.clientY,
        pushPullDrag.startPos, pushPullDrag.axisDir,
      );
      const delta = currentT - pushPullDrag.startT;

      const shape = sceneState.shapes.find((s) => s.id === pushPullDrag!.shapeId);
      if (!shape) return;

      // Polygon edge drag: offset edge along normal, constrain adjacent edges
      if (pushPullDrag.edgeIdx !== undefined && pushPullDrag.edgeNormal2D && pushPullDrag.startVertices) {
        const localDelta = delta / shape.scale;
        const [nx, nz] = pushPullDrag.edgeNormal2D;
        const newVerts = pushPullPolyEdge(pushPullDrag.startVertices, pushPullDrag.edgeIdx, nx, nz, localDelta);
        shape.vertices = newVerts;
        shape.position = [...pushPullDrag.startPos] as Vec3;
        recenterPolyBounds(shape);
        sceneState.version++;
        return;
      }

      const { newSize, newPos } = computeFaceDrag(pushPullDrag, delta, shape.type, pushPullDrag.axis);
      shape.size = newSize;
      shape.position = newPos;
      sceneState.version++;
      return;
    }

    // --- Shape drag (move selected shapes in camera plane) ---
    if (shapeDrag) {
      e.stopImmediatePropagation();
      const hit = projectRayOnPlane(camera, canvas, e.clientX, e.clientY, shapeDrag.planeOrigin, shapeDrag.planeNormal);
      if (!hit) return;
      const dx = hit[0] - shapeDrag.startHit[0];
      const dy = hit[1] - shapeDrag.startHit[1];
      const dz = hit[2] - shapeDrag.startHit[2];
      for (let i = 0; i < shapeDrag.shapeIds.length; i++) {
        const s = sceneState.shapes.find((sh) => sh.id === shapeDrag!.shapeIds[i]);
        if (!s) continue;
        const sp = shapeDrag.startPositions[i];
        s.position = [sp[0] + dx, sp[1] + dy, sp[2] + dz];
      }
      sceneState.version++;
      return;
    }

    // --- Marquee drag ---
    if (marqueeStart) {
      const dx = e.clientX - marqueeStart.x;
      const dy = e.clientY - marqueeStart.y;
      if (!sceneState.marquee && Math.sqrt(dx * dx + dy * dy) > MARQUEE_THRESHOLD) {
        // Check if we clicked any shape → select it (if needed) and start shape drag
        if (selectPickResult?.shapeId) {
          const hitId = selectPickResult.shapeId;
          const alreadySelected = sceneState.selectedShapeIds.includes(hitId);

          // Push undo before selection change so both selection + move are one undo step
          if (!alreadySelected) {
            pushUndo();
            if (marqueeStart.shiftKey) {
              toggleShapeSelection(hitId);
            } else {
              selectShape(hitId);
            }
          }

          // Compute camera-plane through centroid of selected shapes
          camera.updateMatrixWorld();
          const fwd: Vec3 = [
            -camera.matrixWorld.elements[8],
            -camera.matrixWorld.elements[9],
            -camera.matrixWorld.elements[10],
          ];
          const ids = [...sceneState.selectedShapeIds];
          const startPositions: Vec3[] = [];
          let cx = 0, cy = 0, cz = 0;
          for (const id of ids) {
            const s = sceneState.shapes.find((sh) => sh.id === id);
            if (!s) continue;
            startPositions.push([...s.position] as Vec3);
            cx += s.position[0]; cy += s.position[1]; cz += s.position[2];
          }
          const n = startPositions.length || 1;
          const planeOrigin: Vec3 = [cx / n, cy / n, cz / n];
          // Project start mouse position onto this plane
          const startHit = projectRayOnPlane(camera, canvas, marqueeStart.x, marqueeStart.y, planeOrigin, fwd);
          if (startHit) {
            e.stopImmediatePropagation();
            if (sceneRefs.controls) sceneRefs.controls.enabled = false;

            // Alt+drag: duplicate shapes first, then drag the copies
            if (e.altKey) {
              if (alreadySelected) pushUndo(); // undo before duplicateSelectedShapes snapshots
              const newIds = duplicateSelectedShapes(); // pushes undo internally
              const dupPositions: Vec3[] = [];
              for (const nid of newIds) {
                const s = sceneState.shapes.find((sh) => sh.id === nid);
                if (s) dupPositions.push([...s.position] as Vec3);
              }
              shapeDrag = { shapeIds: newIds, startPositions: dupPositions, planeNormal: fwd, planeOrigin, startHit };
            } else {
              // Undo already pushed above if we changed selection; push now if we didn't
              if (alreadySelected) pushUndo();
              shapeDrag = { shapeIds: ids, startPositions, planeNormal: fwd, planeOrigin, startHit };
            }

            marqueeStart = null;
            selectPickResult = null;
            return;
          }
        }
        // Otherwise start marquee
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
      if (e.buttons & 1) e.stopImmediatePropagation();
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
      if (e.buttons & 1) e.stopImmediatePropagation();
      const worldY = getHeightFromRay(e, canvas, camera, extrudeCornerX, extrudeCornerZ);
      updateHeight(worldY);
    } else if (phase === "radius") {
      const floorY = sceneState.drag.baseFloorY;
      const point = getPlanePoint(e, canvas, camera, floorY);
      if (!point) return;
      if (e.buttons & 1) e.stopImmediatePropagation();
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
        vpMat, cw, ch, shape.vertices,
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
    if (sceneRefs.pointerConsumed) {
      sceneRefs.pointerConsumed = false;
      return;
    }
    const renderer = getRenderer();
    if (!renderer) return;
    const { px, py } = cssRectToDevicePixels(clientX, clientY, 0, 0, canvas);
    renderer.pickWorldPos(px, py).then((result) => {
      if (result && result.shapeId) {
        // Don't reset edit mode if shape is already selected
        if (sceneState.editMode === "edit" && sceneState.selectedShapeIds.includes(result.shapeId)) return;
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
    // --- Push/Pull commit ---
    if (pushPullDrag) {
      canvas.releasePointerCapture(e.pointerId);

      const shape = sceneState.shapes.find((s) => s.id === pushPullDrag!.shapeId);
      if (shape) {
        // Polygon edge commit
        if (pushPullDrag.edgeIdx !== undefined && pushPullDrag.edgeNormal2D && pushPullDrag.startVertices) {
          const currentT = projectRayOnAxisDir(
            camera, canvas, e.clientX, e.clientY,
            pushPullDrag.startPos, pushPullDrag.axisDir,
          );
          const delta = currentT - pushPullDrag.startT;
          const localDelta = delta / shape.scale;
          const [nx, nz] = pushPullDrag.edgeNormal2D;

          // Build final vertices with constrained adjacent edges
          const finalVerts = pushPullPolyEdge(pushPullDrag.startVertices, pushPullDrag.edgeIdx, nx, nz, localDelta);

          // Restore to start state before undo commit
          shape.vertices = pushPullDrag.startVertices.map(v => [...v] as [number, number]);
          shape.size = [pushPullDrag.startBoundingRadius!, shape.size[1], shape.size[2]];
          shape.position = [...pushPullDrag.startPos] as Vec3;
          sceneState.version++;

          // Commit via editPolyVertices (pushes undo)
          editPolyVertices(pushPullDrag.shapeId, finalVerts);

          setRawCursor(makeHoverArrowCursor(cursorAngle(shape.position, pushPullDrag.axisDir, pushPullDrag.negative)));
          pushPullDrag = null;
          return;
        }

        const currentT = projectRayOnAxisDir(
          camera, canvas, e.clientX, e.clientY,
          pushPullDrag.startPos, pushPullDrag.axisDir,
        );
        const delta = currentT - pushPullDrag.startT;

        // Restore shape to start state
        shape.position = [...pushPullDrag.startPos] as Vec3;
        shape.size = [...pushPullDrag.startSize] as Vec3;
        sceneState.version++;

        // Compute final new size and position
        const { newSize, newPos } = computeFaceDrag(pushPullDrag, delta, shape.type, pushPullDrag.axis);

        pushUndo();
        scaleShape(pushPullDrag.shapeId, newSize, newPos);
      }

      const endShape = sceneState.shapes.find((s) => s.id === pushPullDrag!.shapeId);
      setRawCursor(endShape
        ? makeHoverArrowCursor(cursorAngle(endShape.position, pushPullDrag!.axisDir, pushPullDrag!.negative))
        : null,
      );
      pushPullDrag = null;
      return;
    }

    // --- Shape drag commit ---
    if (shapeDrag) {
      canvas.releasePointerCapture(e.pointerId);
      if (sceneRefs.controls) sceneRefs.controls.enabled = true;
      // Check if anything actually moved — if not, undo the no-op snapshot
      let moved = false;
      for (let i = 0; i < shapeDrag.shapeIds.length; i++) {
        const s = sceneState.shapes.find((sh) => sh.id === shapeDrag!.shapeIds[i]);
        if (!s) continue;
        const sp = shapeDrag.startPositions[i];
        if (s.position[0] !== sp[0] || s.position[1] !== sp[1] || s.position[2] !== sp[2]) {
          moved = true;
          break;
        }
      }
      if (!moved) undo();
      shapeDrag = null;
      selectPickResult = null;
      return;
    }

    // --- Marquee / click select ---
    if (marqueeStart) {
      const marqueeRect = sceneState.marquee
        ? { x1: sceneState.marquee.x1, y1: sceneState.marquee.y1, x2: sceneState.marquee.x2, y2: sceneState.marquee.y2 }
        : null;
      const shiftKey = marqueeStart.shiftKey;
      const isSelectTool = sceneState.activeTool === "select";
      canvas.releasePointerCapture(marqueeStart.pointerId);
      marqueeStart = null;
      selectPickResult = null;
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
      lockBase();
    } else if (phase === "radius") {
      commitRadius();
    }
  }

  function onDblClick(e: MouseEvent) {
    // Polygon tool: double-click to close polygon
    if (sceneState.activeTool === "polygon") {
      if (sceneState.penVertices.length >= 3 && sceneState.drag.phase !== "height") {
        e.preventDefault();
        e.stopImmediatePropagation();
        // The second click of the dblclick already added a duplicate vertex — remove it
        sceneState.penVertices.pop();
        if (sceneState.penVertices.length >= 3) {
          closePen(0.10);
        }
      }
      return;
    }

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
