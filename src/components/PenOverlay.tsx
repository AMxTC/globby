import { useEffect, useRef } from "react";
import type { Matrix4 } from "three";
import {
  sceneState,
  sceneRefs,
  editPolyVertices,
  insertPolyVertex,
  recenterPolyBounds,
} from "../state/sceneStore";
import {
  worldToScreen,
  eulerToMatrix3,
  projectRayOnPlane,
} from "../lib/math3d";
import type { Vec3 } from "../state/sceneStore";
import { CURSORS } from "@/lib/cursors";

const VERTEX_RADIUS = 4;
const FIRST_VERTEX_RADIUS = 4;
const CLOSE_HIT_RADIUS = 10;
const EDIT_VERTEX_RADIUS = 4;
const EDIT_HIT_RADIUS = 10;
const EDGE_SNAP_DIST = 12;

/** Distance from point (px,py) to line segment (ax,ay)-(bx,by), plus closest-point parameter t */
function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { dist: number; t: number } {
  const dx = bx - ax,
    dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-8) return { dist: Math.hypot(px - ax, py - ay), t: 0 };
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx,
    cy = ay + t * dy;
  return { dist: Math.hypot(px - cx, py - cy), t };
}

/** Transform a local-space offset to world-space position */
function localToWorld(
  pos: Vec3,
  m: number[],
  s: number,
  localOffset: Vec3,
): Vec3 {
  const lx = localOffset[0] * s,
    ly = localOffset[1] * s,
    lz = localOffset[2] * s;
  return [
    pos[0] + m[0] * lx + m[3] * ly + m[6] * lz,
    pos[1] + m[1] * lx + m[4] * ly + m[7] * lz,
    pos[2] + m[2] * lx + m[5] * ly + m[8] * lz,
  ];
}

const MAGENTA = "rgba(255,8,138,0.8)";
const MAGENTA_DIM = "rgba(255,8,138,0.4)";
const WHITE = "white";

export default function PenOverlay() {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    // Pre-allocate SVG elements for up to 16 vertices + edges
    const MAX_VERTS = 16;
    const edgeEls: SVGLineElement[] = [];
    const vertEls: SVGCircleElement[] = [];
    let closeHitEl: SVGCircleElement | null = null;

    // Create edge lines
    for (let i = 0; i < MAX_VERTS; i++) {
      const line = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "line",
      );
      line.setAttribute("stroke", MAGENTA);
      line.setAttribute("stroke-width", "1");
      line.setAttribute("stroke-linecap", "round");
      line.setAttribute("pointer-events", "none");
      line.style.display = "none";
      svg.appendChild(line);
      edgeEls.push(line);
    }

    // Create vertex circles
    for (let i = 0; i < MAX_VERTS; i++) {
      const circle = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "circle",
      );
      circle.setAttribute("fill", "white");
      circle.setAttribute("stroke", MAGENTA);
      circle.setAttribute("stroke-width", "1.5");
      circle.setAttribute("pointer-events", "none");
      circle.style.display = "none";
      svg.appendChild(circle);
      vertEls.push(circle);
    }

    // Close hit area (invisible, over first vertex)
    closeHitEl = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "circle",
    );
    closeHitEl.setAttribute("r", String(CLOSE_HIT_RADIUS));
    closeHitEl.setAttribute("fill", "none");
    closeHitEl.setAttribute("stroke", "none");
    closeHitEl.setAttribute("pointer-events", "none");
    closeHitEl.style.display = "none";
    svg.appendChild(closeHitEl);

    // Preview line from last vertex to cursor
    const previewLine = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "line",
    );
    previewLine.setAttribute("stroke", MAGENTA_DIM);
    previewLine.setAttribute("stroke-width", "1.5");
    previewLine.setAttribute("stroke-dasharray", "4 3");
    previewLine.setAttribute("pointer-events", "none");
    previewLine.style.display = "none";
    svg.appendChild(previewLine);

    // Preview line from cursor back to first vertex (closing edge preview)
    const closePreviewLine = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "line",
    );
    closePreviewLine.setAttribute("stroke", "rgba(255,8,138,0.25)");
    closePreviewLine.setAttribute("stroke-width", "1");
    closePreviewLine.setAttribute("stroke-dasharray", "4 3");
    closePreviewLine.setAttribute("pointer-events", "none");
    closePreviewLine.style.display = "none";
    svg.appendChild(closePreviewLine);

    // Height indicator line (during height phase)
    const heightLine = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "line",
    );
    heightLine.setAttribute("stroke", "rgba(255,8,138,0.6)");
    heightLine.setAttribute("stroke-width", "1.5");
    heightLine.setAttribute("stroke-dasharray", "4 3");
    heightLine.setAttribute("pointer-events", "none");
    heightLine.style.display = "none";
    svg.appendChild(heightLine);

    // --- Edit mode: extra SVG elements for vertex hit areas ---
    const editHitEls: SVGCircleElement[] = [];
    for (let i = 0; i < MAX_VERTS; i++) {
      const circle = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "circle",
      );
      circle.setAttribute("r", String(EDIT_HIT_RADIUS));
      circle.setAttribute("fill", "transparent");
      circle.style.cursor = CURSORS.mousePointerInverted;
      circle.setAttribute("pointer-events", "all");
      circle.style.display = "none";
      circle.dataset.vertIdx = String(i);
      svg.appendChild(circle);
      editHitEls.push(circle);
    }

    // --- Edge midpoint indicator ---
    // Visible dot (small, no pointer events)
    const midpointDot = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "circle",
    );
    midpointDot.setAttribute("r", "3");
    midpointDot.setAttribute("fill", MAGENTA);
    midpointDot.setAttribute("stroke", "none");
    midpointDot.setAttribute("pointer-events", "none");
    midpointDot.style.display = "none";
    svg.appendChild(midpointDot);
    // Hit area (transparent, matches snap distance)
    const midpointEl = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "circle",
    );
    midpointEl.setAttribute("r", String(EDGE_SNAP_DIST));
    midpointEl.setAttribute("fill", "transparent");
    midpointEl.setAttribute("stroke", "none");
    midpointEl.setAttribute("pointer-events", "all");
    midpointEl.style.cursor = CURSORS.mousePointer;
    midpointEl.style.display = "none";
    svg.appendChild(midpointEl);

    function showMidpoint(px: number, py: number) {
      const sx = String(px), sy = String(py);
      midpointDot.setAttribute("cx", sx);
      midpointDot.setAttribute("cy", sy);
      midpointDot.style.display = "";
      midpointEl.setAttribute("cx", sx);
      midpointEl.setAttribute("cy", sy);
      midpointEl.style.display = "";
    }
    function hideMidpoint() {
      midpointDot.style.display = "none";
      midpointEl.style.display = "none";
    }

    // Closure-local state for midpoint snapping
    let mouseX = 0,
      mouseY = 0;
    let snapEdgeIdx = -1;
    let snapT = 0;

    function onDocPointerMove(e: PointerEvent) {
      mouseX = e.clientX;
      mouseY = e.clientY;
    }
    document.addEventListener("pointermove", onDocPointerMove);

    function onMidpointPointerDown(e: PointerEvent) {
      if (snapEdgeIdx < 0) return;
      e.preventDefault();
      e.stopPropagation();
      sceneRefs.pointerConsumed = true;

      const shapeId = sceneState.selectedShapeIds[0];
      const shape = sceneState.shapes.find((s) => s.id === shapeId);
      if (!shape?.vertices) return;

      const count = shape.vertices.length;
      const i = snapEdgeIdx;
      const j = (i + 1) % count;
      const t = snapT;
      const localXZ: [number, number] = [
        (1 - t) * shape.vertices[i][0] + t * shape.vertices[j][0],
        (1 - t) * shape.vertices[i][1] + t * shape.vertices[j][1],
      ];

      insertPolyVertex(shapeId, i, localXZ);
      const newIdx = i + 1;
      sceneRefs.selectedPolyVertIndices.clear();
      sceneRefs.selectedPolyVertIndices.add(newIdx);
      hideMidpoint();
      snapEdgeIdx = -1;

      // Start dragging the newly inserted vertex
      sceneRefs.editPolyDragIdx = newIdx;
      sceneRefs.editPolyStartVerts = shape.vertices.map(
        (v) => [...v] as [number, number],
      );
      sceneRefs.editPolyStartPos = [...shape.position] as Vec3;
      if (sceneRefs.controls) sceneRefs.controls.enabled = false;
      const hitEl = editHitEls[newIdx];
      hitEl.setPointerCapture(e.pointerId);
      hitEl.style.cursor = CURSORS.mousePointerInverted;
    }
    midpointEl.addEventListener("pointerdown", onMidpointPointerDown);

    // --- Edit mode drag handlers ---
    function onEditPointerDown(e: PointerEvent) {
      const target = e.target as SVGCircleElement;
      const idx = Number(target.dataset.vertIdx);
      if (isNaN(idx)) return;

      const shapeId = sceneState.selectedShapeIds[0];
      const shape = sceneState.shapes.find((s) => s.id === shapeId);
      if (!shape?.vertices) return;

      e.preventDefault();
      e.stopPropagation();

      // Shift-click: toggle vertex in selection set
      if (e.shiftKey) {
        if (sceneRefs.selectedPolyVertIndices.has(idx)) {
          sceneRefs.selectedPolyVertIndices.delete(idx);
        } else {
          sceneRefs.selectedPolyVertIndices.add(idx);
        }
      } else {
        // If clicking an already-selected vertex, keep the multi-selection for drag
        if (!sceneRefs.selectedPolyVertIndices.has(idx)) {
          sceneRefs.selectedPolyVertIndices.clear();
          sceneRefs.selectedPolyVertIndices.add(idx);
        }
      }

      sceneRefs.editPolyDragIdx = idx;
      sceneRefs.editPolyStartVerts = shape.vertices.map(
        (v) => [...v] as [number, number],
      );
      sceneRefs.editPolyStartPos = [...shape.position] as Vec3;

      // Disable orbit controls during drag
      if (sceneRefs.controls) sceneRefs.controls.enabled = false;

      target.setPointerCapture(e.pointerId);
      target.style.cursor = CURSORS.mousePointerInverted;
    }

    function onEditPointerMove(e: PointerEvent) {
      const idx = sceneRefs.editPolyDragIdx;
      if (idx === null) return;

      const camera = sceneRefs.camera;
      const canvas = sceneRefs.canvas;
      if (!camera || !canvas) return;

      const shapeId = sceneState.selectedShapeIds[0];
      const shape = sceneState.shapes.find((s) => s.id === shapeId);
      if (!shape?.vertices) return;
      const startVerts = sceneRefs.editPolyStartVerts;
      if (!startVerts) return;

      const m = eulerToMatrix3(
        shape.rotation[0],
        shape.rotation[1],
        shape.rotation[2],
      );
      const s = shape.scale;

      // Base plane: normal = local Y axis, origin = shape center offset down by size[1]*scale along local Y
      const localY: Vec3 = [m[3], m[4], m[5]];
      const baseOrigin: Vec3 = [
        shape.position[0] - localY[0] * shape.size[1] * s,
        shape.position[1] - localY[1] * shape.size[1] * s,
        shape.position[2] - localY[2] * shape.size[1] * s,
      ];

      const hit = projectRayOnPlane(
        camera,
        canvas,
        e.clientX,
        e.clientY,
        baseOrigin,
        localY,
      );
      if (!hit) return;

      // World → Local: transpose(m) * (hit - pos) / scale
      const dx = hit[0] - shape.position[0];
      const dy = hit[1] - shape.position[1];
      const dz = hit[2] - shape.position[2];
      const localX = (m[0] * dx + m[1] * dy + m[2] * dz) / s;
      const localZ = (m[6] * dx + m[7] * dy + m[8] * dz) / s;

      // Compute delta from the dragged vertex's start position
      const deltaX = localX - startVerts[idx][0];
      const deltaZ = localZ - startVerts[idx][1];

      // Move all selected vertices by the same delta
      const selected = sceneRefs.selectedPolyVertIndices;
      for (const vi of selected) {
        if (vi >= 0 && vi < shape.vertices.length && vi < startVerts.length) {
          shape.vertices[vi] = [startVerts[vi][0] + deltaX, startVerts[vi][1] + deltaZ];
        }
      }
      // Also move the drag vertex if not in the selection (shouldn't happen, but safety)
      if (!selected.has(idx)) {
        shape.vertices[idx] = [localX, localZ];
      }

      recenterPolyBounds(shape);
      sceneState.version++;
    }

    function onEditPointerUp(e: PointerEvent) {
      const idx = sceneRefs.editPolyDragIdx;
      if (idx === null) return;

      const target = e.target as SVGCircleElement;
      target.releasePointerCapture(e.pointerId);
      target.style.cursor = CURSORS.mousePointerInverted;

      // Re-enable orbit controls
      if (sceneRefs.controls) sceneRefs.controls.enabled = true;

      const shapeId = sceneState.selectedShapeIds[0];
      const shape = sceneState.shapes.find((s) => s.id === shapeId);
      const startVerts = sceneRefs.editPolyStartVerts;

      if (shape?.vertices && startVerts) {
        // Save final state
        const finalVerts = shape.vertices.map(
          (v) => [...v] as [number, number],
        );
        const finalPos = [...shape.position] as Vec3;
        // Restore start state before commit for undo
        shape.vertices = startVerts;
        if (sceneRefs.editPolyStartPos) {
          shape.position = sceneRefs.editPolyStartPos;
        }
        let maxR = 0;
        for (const [vx, vz] of startVerts)
          maxR = Math.max(maxR, Math.sqrt(vx * vx + vz * vz));
        shape.size = [maxR, shape.size[1], shape.size[2]];
        // Commit final verts (pushes undo with start state)
        editPolyVertices(shapeId, finalVerts);
        // Apply final position after commit
        shape.position = finalPos;
      }

      sceneRefs.editPolyDragIdx = null;
      sceneRefs.editPolyStartVerts = null;
      sceneRefs.editPolyStartPos = null;
    }

    // Attach event listeners to edit hit areas
    for (const hitEl of editHitEls) {
      hitEl.addEventListener("pointerdown", onEditPointerDown);
      hitEl.addEventListener("pointermove", onEditPointerMove);
      hitEl.addEventListener("pointerup", onEditPointerUp);
    }

    function hideAll() {
      for (let i = 0; i < MAX_VERTS; i++) {
        edgeEls[i].style.display = "none";
        vertEls[i].style.display = "none";
        editHitEls[i].style.display = "none";
      }
      closeHitEl!.style.display = "none";
      heightLine.style.display = "none";
      previewLine.style.display = "none";
      closePreviewLine.style.display = "none";
      hideMidpoint();
    }

    function updateEditMode(vpMat: Matrix4, w: number, h: number) {
      const shapeId = sceneState.selectedShapeIds[0];
      const shape = shapeId
        ? sceneState.shapes.find((s) => s.id === shapeId)
        : null;
      if (!shape?.vertices || shape.type !== "polygon") {
        hideAll();
        return;
      }

      const verts = shape.vertices;
      const count = verts.length;
      const m = eulerToMatrix3(
        shape.rotation[0],
        shape.rotation[1],
        shape.rotation[2],
      );
      const s = shape.scale;

      // Project each vertex to screen (vertices sit on the base face: local Y = -size[1])
      const screenPts: { x: number; y: number; vis: boolean }[] = [];
      for (let i = 0; i < count; i++) {
        const worldPos = localToWorld(shape.position, m, s, [
          verts[i][0],
          -shape.size[1],
          verts[i][1],
        ]);
        const [sx, sy, vis] = worldToScreen(worldPos, vpMat, w, h);
        screenPts.push({ x: sx, y: sy, vis });
      }

      // Draw edges (closed loop)
      for (let i = 0; i < MAX_VERTS; i++) {
        if (i < count) {
          const a = screenPts[i];
          const b = screenPts[(i + 1) % count];
          if (a.vis && b.vis) {
            edgeEls[i].setAttribute("x1", String(a.x));
            edgeEls[i].setAttribute("y1", String(a.y));
            edgeEls[i].setAttribute("x2", String(b.x));
            edgeEls[i].setAttribute("y2", String(b.y));
            edgeEls[i].style.display = "";
          } else {
            edgeEls[i].style.display = "none";
          }
        } else {
          edgeEls[i].style.display = "none";
        }
      }

      // Draw vertex circles + position hit areas
      const selectedVerts = sceneRefs.selectedPolyVertIndices;
      for (let i = 0; i < MAX_VERTS; i++) {
        if (i < count && screenPts[i].vis) {
          vertEls[i].setAttribute("cx", String(screenPts[i].x));
          vertEls[i].setAttribute("cy", String(screenPts[i].y));
          vertEls[i].setAttribute("r", String(EDIT_VERTEX_RADIUS));
          const isSel = selectedVerts.has(i);
          vertEls[i].setAttribute("fill", isSel ? MAGENTA : "white");
          vertEls[i].setAttribute("stroke", isSel ? WHITE : MAGENTA);
          vertEls[i].setAttribute("stroke-width", isSel ? "1.0" : "1.5");
          vertEls[i].style.display = "";

          editHitEls[i].setAttribute("cx", String(screenPts[i].x));
          editHitEls[i].setAttribute("cy", String(screenPts[i].y));
          editHitEls[i].style.display = "";
        } else {
          vertEls[i].style.display = "none";
          editHitEls[i].style.display = "none";
        }
      }

      // Edge midpoint indicator
      if (sceneRefs.editPolyDragIdx !== null || count >= MAX_VERTS) {
        hideMidpoint();
        snapEdgeIdx = -1;
      } else {
        // Convert mouse from client to SVG viewport coords
        const rect = svg!.getBoundingClientRect();
        const mx = mouseX - rect.left;
        const my = mouseY - rect.top;

        let bestDist = EDGE_SNAP_DIST;
        let bestIdx = -1;
        let bestT = 0;
        for (let i = 0; i < count; i++) {
          const a = screenPts[i];
          const b = screenPts[(i + 1) % count];
          if (!a.vis || !b.vis) continue;
          const { dist, t } = distToSegment(mx, my, a.x, a.y, b.x, b.y);
          if (dist < bestDist) {
            // Skip if snap point is too close to either endpoint (would interfere with vertex hit areas)
            const px = a.x + t * (b.x - a.x);
            const py = a.y + t * (b.y - a.y);
            const dA = Math.hypot(px - a.x, py - a.y);
            const dB = Math.hypot(px - b.x, py - b.y);
            if (dA < EDIT_HIT_RADIUS || dB < EDIT_HIT_RADIUS) continue;
            bestDist = dist;
            bestIdx = i;
            bestT = t;
          }
        }

        if (bestIdx >= 0) {
          // Lerp in local space and project to screen so dot matches where vertex will be inserted
          const j = (bestIdx + 1) % count;
          const lx = (1 - bestT) * verts[bestIdx][0] + bestT * verts[j][0];
          const lz = (1 - bestT) * verts[bestIdx][1] + bestT * verts[j][1];
          const worldPos = localToWorld(shape.position, m, s, [lx, -shape.size[1], lz]);
          const [sx, sy] = worldToScreen(worldPos, vpMat, w, h);
          showMidpoint(sx, sy);
          snapEdgeIdx = bestIdx;
          snapT = bestT;
        } else {
          hideMidpoint();
          snapEdgeIdx = -1;
        }
      }

      // Hide pen-only elements
      closeHitEl!.style.display = "none";
      heightLine.style.display = "none";
      previewLine.style.display = "none";
      closePreviewLine.style.display = "none";
    }

    function updatePenMode(vpMat: Matrix4, w: number, h: number) {
      // Hide edit hit areas and midpoint
      for (let i = 0; i < MAX_VERTS; i++) {
        editHitEls[i].style.display = "none";
      }
      hideMidpoint();
      snapEdgeIdx = -1;

      const penVerts = sceneState.penVertices;
      const count = penVerts.length;
      const isPolygonTool = sceneState.activeTool === "polygon";
      const isHeightPhase = sceneState.drag.phase === "height" && isPolygonTool;

      if (count === 0 || !isPolygonTool) {
        // Hide everything
        for (let i = 0; i < MAX_VERTS; i++) {
          edgeEls[i].style.display = "none";
          vertEls[i].style.display = "none";
        }
        closeHitEl!.style.display = "none";
        heightLine.style.display = "none";
        previewLine.style.display = "none";
        closePreviewLine.style.display = "none";
        return;
      }

      const floorY = sceneState.penFloorY;

      // Project all vertices to screen
      const screenPts: { x: number; y: number; vis: boolean }[] = [];
      for (let i = 0; i < count; i++) {
        const [sx, sy, vis] = worldToScreen(
          [penVerts[i][0], floorY, penVerts[i][1]],
          vpMat,
          w,
          h,
        );
        screenPts.push({ x: sx, y: sy, vis });
      }

      // Draw edges
      const edgeCount = isHeightPhase ? count : count - 1;
      for (let i = 0; i < MAX_VERTS; i++) {
        if (i < edgeCount) {
          const a = screenPts[i];
          const b = screenPts[(i + 1) % count];
          if (a.vis && b.vis) {
            edgeEls[i].setAttribute("x1", String(a.x));
            edgeEls[i].setAttribute("y1", String(a.y));
            edgeEls[i].setAttribute("x2", String(b.x));
            edgeEls[i].setAttribute("y2", String(b.y));
            edgeEls[i].style.display = "";
          } else {
            edgeEls[i].style.display = "none";
          }
        } else {
          edgeEls[i].style.display = "none";
        }
      }

      // Draw vertices
      for (let i = 0; i < MAX_VERTS; i++) {
        if (i < count && screenPts[i].vis) {
          const r = i === 0 ? FIRST_VERTEX_RADIUS : VERTEX_RADIUS;
          vertEls[i].setAttribute("cx", String(screenPts[i].x));
          vertEls[i].setAttribute("cy", String(screenPts[i].y));
          vertEls[i].setAttribute("r", String(r));
          const isLast = i === count - 1;
          vertEls[i].setAttribute("fill", isLast ? MAGENTA : "white");
          vertEls[i].setAttribute("stroke", isLast ? WHITE : MAGENTA);
          vertEls[i].setAttribute("stroke-width", isLast ? "1.0" : "1.5");
          vertEls[i].style.display = "";
        } else {
          vertEls[i].style.display = "none";
        }
      }

      // Preview edge from last vertex to cursor
      const cursorXZ = sceneRefs.penCursorXZ;
      if (cursorXZ && !isHeightPhase && count >= 1) {
        const lastPt = screenPts[count - 1];
        const [curX, curY, curVis] = worldToScreen(
          [cursorXZ[0], floorY, cursorXZ[1]],
          vpMat,
          w,
          h,
        );
        if (lastPt.vis && curVis) {
          previewLine.setAttribute("x1", String(lastPt.x));
          previewLine.setAttribute("y1", String(lastPt.y));
          previewLine.setAttribute("x2", String(curX));
          previewLine.setAttribute("y2", String(curY));
          previewLine.style.display = "";
        } else {
          previewLine.style.display = "none";
        }
        // Show close preview edge (cursor → first vertex) when 2+ verts
        if (count >= 2 && curVis && screenPts[0].vis) {
          closePreviewLine.setAttribute("x1", String(curX));
          closePreviewLine.setAttribute("y1", String(curY));
          closePreviewLine.setAttribute("x2", String(screenPts[0].x));
          closePreviewLine.setAttribute("y2", String(screenPts[0].y));
          closePreviewLine.style.display = "";
        } else {
          closePreviewLine.style.display = "none";
        }
      } else {
        previewLine.style.display = "none";
        closePreviewLine.style.display = "none";
      }

      // Close hit area on first vertex (only when 3+ vertices and not in height phase)
      if (count >= 3 && !isHeightPhase && screenPts[0].vis) {
        closeHitEl!.setAttribute("cx", String(screenPts[0].x));
        closeHitEl!.setAttribute("cy", String(screenPts[0].y));
        closeHitEl!.style.display = "";
      } else {
        closeHitEl!.style.display = "none";
      }

      // Height indicator
      if (isHeightPhase) {
        const drag = sceneState.drag;
        const topY = drag.previewPosition[1] + drag.previewSize[1];
        // Compute centroid screen position at both floor and top
        let cx = 0,
          cz = 0;
        for (const [vx, vz] of penVerts) {
          cx += vx;
          cz += vz;
        }
        cx /= count;
        cz /= count;
        const [bx, by, bv] = worldToScreen([cx, floorY, cz], vpMat, w, h);
        const [tx, ty, tv] = worldToScreen([cx, topY, cz], vpMat, w, h);
        if (bv && tv) {
          heightLine.setAttribute("x1", String(bx));
          heightLine.setAttribute("y1", String(by));
          heightLine.setAttribute("x2", String(tx));
          heightLine.setAttribute("y2", String(ty));
          heightLine.style.display = "";
        } else {
          heightLine.style.display = "none";
        }
      } else {
        heightLine.style.display = "none";
      }
    }

    function update(vpMat: Matrix4, w: number, h: number) {
      const isEditMode =
        sceneState.editMode === "edit" &&
        sceneState.selectedShapeIds.length === 1;

      if (isEditMode) {
        const shapeId = sceneState.selectedShapeIds[0];
        const shape = sceneState.shapes.find((s) => s.id === shapeId);
        if (
          shape?.type === "polygon" &&
          shape.vertices &&
          shape.vertices.length >= 3
        ) {
          updateEditMode(vpMat, w, h);
          return;
        }
      }

      updatePenMode(vpMat, w, h);
    }

    sceneRefs.updatePenOverlay = update;

    return () => {
      sceneRefs.updatePenOverlay = null;
      for (const hitEl of editHitEls) {
        hitEl.removeEventListener("pointerdown", onEditPointerDown);
        hitEl.removeEventListener("pointermove", onEditPointerMove);
        hitEl.removeEventListener("pointerup", onEditPointerUp);
      }
      document.removeEventListener("pointermove", onDocPointerMove);
      midpointEl.removeEventListener("pointerdown", onMidpointPointerDown);
    };
  }, []);

  return (
    <svg
      ref={svgRef}
      className="absolute inset-0 w-full h-full pointer-events-none z-10"
    />
  );
}
