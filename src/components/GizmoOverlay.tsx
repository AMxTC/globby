import { useEffect, useRef } from "react";
import type { Matrix4 } from "three";
import {
  sceneState,
  sceneRefs,
  moveShape,
  scaleShape,
  type Vec3,
  type SDFShape,
} from "../state/sceneStore";
import {
  worldToScreen,
  projectRayOnAxis,
  gizmoWorldLength,
} from "../lib/math3d";

const AXIS_COLORS = { x: "#ef4444", y: "#22c55e", z: "#3b82f6" } as const;
const AXES: Array<"x" | "y" | "z"> = ["x", "y", "z"];
const ARROW_TARGET_PX = 80; // desired screen size at typical viewing angle
const ARROW_HEAD_PX = 10;
const SCALE_HANDLE_SIZE = 8;
const CP_RADIUS = 5;
const MIN_SIZE = 0.02;

interface DragInfo {
  kind: "translate" | "scale" | "editFace";
  axis: "x" | "y" | "z";
  axisIdx: number;
  shapeId: string;
  startT: number;
  startPos: Vec3;
  startSize: Vec3;
  negative?: boolean; // for scale: negative-side handle
}

export default function GizmoOverlay() {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<DragInfo | null>(null);

  // Refs for all SVG elements — we update them imperatively each frame
  const groupRef = useRef<SVGGElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    // Build SVG elements imperatively for zero-allocation frame updates.
    const g = groupRef.current!;

    // --- Object mode: translate arrows ---
    const translateEls: Record<
      string,
      { line: SVGLineElement; hit: SVGLineElement; head: SVGPolygonElement }
    > = {};
    for (const axis of AXES) {
      const line = createSvgEl("line", {
        stroke: AXIS_COLORS[axis],
        "stroke-width": "2",
        "stroke-linecap": "round",
      });
      const hit = createSvgEl("line", {
        stroke: AXIS_COLORS[axis],
        "stroke-width": "14",
        opacity: "0",
        "stroke-linecap": "round",
        "pointer-events": "stroke",
      });
      const head = createSvgEl("polygon", {
        fill: AXIS_COLORS[axis],
        "pointer-events": "none",
      });

      hit.dataset.role = "translate";
      hit.dataset.axis = axis;

      // Hover: brighten the visible line + arrowhead
      addHoverBrightness(hit, [line, head]);

      g.appendChild(line);
      g.appendChild(head);
      g.appendChild(hit);
      translateEls[axis] = { line, hit, head };
    }

    // --- Object mode: scale handles (1 per axis, opposite translate arrow) ---
    const scaleEls: Record<
      string,
      { rect: SVGRectElement; dash: SVGLineElement }
    > = {};
    for (const axis of AXES) {
      const dash = createSvgEl("line", {
        stroke: AXIS_COLORS[axis],
        "stroke-width": "1",
        "stroke-dasharray": "4 3",
        opacity: "0.6",
        "pointer-events": "none",
      });
      const rect = createScaleRect(axis, true);
      addHoverBrightness(rect, [rect]);
      g.appendChild(dash);
      g.appendChild(rect);
      scaleEls[axis] = { rect, dash };
    }

    // --- Edit mode: control points (created dynamically per shape type) ---
    // We pre-allocate max needed (6 for box) and hide extras
    const MAX_CPS = 6;
    const cpEls: { circle: SVGCircleElement; dashLine: SVGLineElement }[] = [];
    for (let i = 0; i < MAX_CPS; i++) {
      const dashLine = createSvgEl("line", {
        stroke: "#9ca3af",
        "stroke-width": "1",
        "stroke-dasharray": "4 3",
        "pointer-events": "none",
      });
      const circle = createSvgEl("circle", {
        r: String(CP_RADIUS),
        fill: "white",
        "stroke-width": "2",
        "pointer-events": "auto",
      });
      circle.dataset.role = "editCp";
      circle.dataset.cpIdx = String(i);
      addHoverBrightness(circle, [circle]);
      g.appendChild(dashLine);
      g.appendChild(circle);
      cpEls.push({ circle, dashLine });
    }

    // --- Frame update function ---
    function update(vpMat: Matrix4, w: number, h: number) {
      const camera = sceneRefs.camera;
      const selectedId = sceneState.selectedShapeId;
      if (!selectedId || !camera) {
        g.style.display = "none";
        return;
      }
      const shape = sceneState.shapes.find((s) => s.id === selectedId);
      if (!shape) {
        g.style.display = "none";
        return;
      }
      g.style.display = "";

      const pos = shape.position;
      const [cx, cy, vis] = worldToScreen(pos, vpMat, w, h);

      if (!vis) {
        g.style.display = "none";
        return;
      }

      const isEdit = sceneState.editMode === "edit";

      // --- Object mode elements ---
      const showObj = !isEdit;
      for (const axis of AXES) {
        const { line, hit, head } = translateEls[axis];
        const { rect: scaleRect, dash: scaleDash } = scaleEls[axis];

        if (!showObj) {
          line.style.display = "none";
          hit.style.display = "none";
          head.style.display = "none";
          scaleRect.style.display = "none";
          scaleDash.style.display = "none";
          continue;
        }

        // Compute 3D endpoint of the arrow along this axis
        const axisIdx = axis === "x" ? 0 : axis === "y" ? 1 : 2;
        const armLen = gizmoWorldLength(
          pos,
          vpMat,
          w,
          h,
          camera,
          ARROW_TARGET_PX,
        );
        const endWorld: Vec3 = [...pos];
        endWorld[axisIdx] += armLen;
        const [ex, ey, ev] = worldToScreen(endWorld, vpMat, w, h);

        if (!ev) {
          line.style.display = "none";
          hit.style.display = "none";
          head.style.display = "none";
          continue;
        }

        line.style.display = "";
        hit.style.display = "";
        head.style.display = "";

        setLineAttrs(line, cx, cy, ex, ey);
        setLineAttrs(hit, cx, cy, ex, ey);

        // Arrowhead: compute screen direction from the projected line
        const adx = ex - cx;
        const ady = ey - cy;
        const alen = Math.sqrt(adx * adx + ady * ady);
        const udx = alen > 0.001 ? adx / alen : 0;
        const udy = alen > 0.001 ? ady / alen : 0;
        const nx = -udy;
        const ny = udx;
        const tipX = ex + udx * ARROW_HEAD_PX;
        const tipY = ey + udy * ARROW_HEAD_PX;
        const baseX1 = ex + nx * 4;
        const baseY1 = ey + ny * 4;
        const baseX2 = ex - nx * 4;
        const baseY2 = ey - ny * 4;
        head.setAttribute(
          "points",
          `${tipX},${tipY} ${baseX1},${baseY1} ${baseX2},${baseY2}`,
        );

        // Scale handle: opposite side of translate arrow (negative axis)
        const negWorld: Vec3 = [...pos];
        negWorld[axisIdx] -= armLen;
        const [sx, sy, sv] = worldToScreen(negWorld, vpMat, w, h);

        if (sv) {
          scaleRect.style.display = "";
          scaleDash.style.display = "";
          scaleRect.setAttribute("x", String(sx - SCALE_HANDLE_SIZE / 2));
          scaleRect.setAttribute("y", String(sy - SCALE_HANDLE_SIZE / 2));
          setLineAttrs(scaleDash, cx, cy, sx, sy);
        } else {
          scaleRect.style.display = "none";
          scaleDash.style.display = "none";
        }
      }

      // --- Edit mode control points ---
      const cpDefs = isEdit ? getControlPoints(shape) : [];
      for (let i = 0; i < MAX_CPS; i++) {
        const { circle, dashLine } = cpEls[i];
        if (i >= cpDefs.length) {
          circle.style.display = "none";
          dashLine.style.display = "none";
          continue;
        }
        const cp = cpDefs[i];
        const [cpx, cpy, cpv] = worldToScreen(cp.worldPos, vpMat, w, h);
        if (!cpv) {
          circle.style.display = "none";
          dashLine.style.display = "none";
          continue;
        }
        circle.style.display = "";
        dashLine.style.display = "";
        circle.setAttribute("cx", String(cpx));
        circle.setAttribute("cy", String(cpy));
        circle.setAttribute("stroke", AXIS_COLORS[cp.axis]);
        circle.dataset.axis = cp.axis;
        circle.dataset.negative = cp.negative ? "1" : "0";
        setLineAttrs(dashLine, cx, cy, cpx, cpy);
      }
    }

    sceneRefs.updateGizmoOverlay = update;

    // --- Pointer handling ---
    function onPointerDown(e: PointerEvent) {
      const target = e.target as SVGElement;
      const role = target.dataset?.role;
      if (!role) return;
      const camera = sceneRefs.camera;
      const canvas = sceneRefs.canvas;
      if (!camera || !canvas) return;

      const selectedId = sceneState.selectedShapeId;
      if (!selectedId) return;
      const shape = sceneState.shapes.find((s) => s.id === selectedId);
      if (!shape) return;

      e.preventDefault();
      e.stopPropagation();
      target.setPointerCapture(e.pointerId);

      const axis = target.dataset.axis as "x" | "y" | "z";
      const axisIdx = axis === "x" ? 0 : axis === "y" ? 1 : 2;
      const startT = projectRayOnAxis(
        camera,
        canvas,
        e.clientX,
        e.clientY,
        shape.position,
        axis,
      );

      if (role === "translate") {
        dragRef.current = {
          kind: "translate",
          axis,
          axisIdx,
          shapeId: selectedId,
          startT,
          startPos: [...shape.position] as Vec3,
          startSize: [...shape.size] as Vec3,
        };
      } else if (role === "scale") {
        const negative = target.dataset.negative === "1";
        dragRef.current = {
          kind: "scale",
          axis,
          axisIdx,
          shapeId: selectedId,
          startT,
          startPos: [...shape.position] as Vec3,
          startSize: [...shape.size] as Vec3,
          negative,
        };
      } else if (role === "editCp") {
        const negative = target.dataset.negative === "1";
        dragRef.current = {
          kind: "editFace",
          axis,
          axisIdx,
          shapeId: selectedId,
          startT,
          startPos: [...shape.position] as Vec3,
          startSize: [...shape.size] as Vec3,
          negative,
        };
      }
    }

    function onPointerMove(e: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const camera = sceneRefs.camera;
      const canvas = sceneRefs.canvas;
      if (!camera || !canvas) return;

      e.preventDefault();
      e.stopPropagation();

      const currentT = projectRayOnAxis(
        camera,
        canvas,
        e.clientX,
        e.clientY,
        drag.startPos,
        drag.axis,
      );
      const delta = currentT - drag.startT;

      const shape = sceneState.shapes.find((s) => s.id === drag.shapeId);
      if (!shape) return;

      if (drag.kind === "translate") {
        const newPos: Vec3 = [...drag.startPos];
        newPos[drag.axisIdx] += delta;
        shape.position = newPos;
        sceneState.version++;
      } else if (drag.kind === "scale") {
        applyScale(drag, delta, shape);
      } else if (drag.kind === "editFace") {
        applyEditFace(drag, delta, shape);
      }
    }

    function onPointerUp(e: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation();
      (e.target as SVGElement).releasePointerCapture(e.pointerId);

      const camera = sceneRefs.camera;
      const canvas = sceneRefs.canvas;
      if (!camera || !canvas) return;

      const currentT = projectRayOnAxis(
        camera,
        canvas,
        e.clientX,
        e.clientY,
        drag.startPos,
        drag.axis,
      );
      const delta = currentT - drag.startT;

      if (drag.kind === "translate") {
        const newPos: Vec3 = [...drag.startPos];
        newPos[drag.axisIdx] += delta;
        // Restore original position first, then use moveShape (which pushes undo)
        const shape = sceneState.shapes.find((s) => s.id === drag.shapeId);
        if (shape) {
          shape.position = [...drag.startPos] as Vec3;
          sceneState.version++;
        }
        moveShape(drag.shapeId, newPos);
      } else if (drag.kind === "scale" || drag.kind === "editFace") {
        // Restore original, then commit via scaleShape
        const shape = sceneState.shapes.find((s) => s.id === drag.shapeId);
        if (shape) {
          const origPos: Vec3 = [...drag.startPos];
          const origSize: Vec3 = [...drag.startSize];
          shape.position = origPos;
          shape.size = origSize;
          sceneState.version++;

          // Recompute final values
          const newPos: Vec3 = [...drag.startPos];
          const newSize: Vec3 = [...drag.startSize];
          if (drag.kind === "scale") {
            computeScale(drag, delta, newPos, newSize);
          } else {
            computeEditFace(drag, delta, newPos, newSize, shape);
          }
          scaleShape(drag.shapeId, newSize, newPos);
        }
      }

      dragRef.current = null;
    }

    svg.addEventListener("pointerdown", onPointerDown);
    svg.addEventListener("pointermove", onPointerMove);
    svg.addEventListener("pointerup", onPointerUp);

    return () => {
      sceneRefs.updateGizmoOverlay = null;
      svg.removeEventListener("pointerdown", onPointerDown);
      svg.removeEventListener("pointermove", onPointerMove);
      svg.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  return (
    <svg
      ref={svgRef}
      className="absolute inset-0 w-full h-full pointer-events-none z-10"
    >
      <g ref={groupRef} style={{ display: "none" }} />
    </svg>
  );
}

// --- Helpers ---

function addHoverBrightness(
  trigger: SVGElement,
  targets: SVGElement[],
) {
  trigger.addEventListener("pointerenter", () => {
    for (const t of targets) t.style.filter = "brightness(1.6)";
  });
  trigger.addEventListener("pointerleave", () => {
    for (const t of targets) t.style.filter = "";
  });
}

function createSvgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(
    "http://www.w3.org/2000/svg",
    tag,
  ) as SVGElementTagNameMap[K];
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}

function createScaleRect(
  axis: "x" | "y" | "z",
  negative: boolean,
): SVGRectElement {
  const rect = createSvgEl("rect", {
    width: String(SCALE_HANDLE_SIZE),
    height: String(SCALE_HANDLE_SIZE),
    fill: AXIS_COLORS[axis],
    stroke: "white",
    "stroke-width": "1",
    rx: "1",
    "pointer-events": "auto",
  });
  rect.dataset.role = "scale";
  rect.dataset.axis = axis;
  rect.dataset.negative = negative ? "1" : "0";
  return rect;
}

function setLineAttrs(
  el: SVGLineElement,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
) {
  el.setAttribute("x1", String(x1));
  el.setAttribute("y1", String(y1));
  el.setAttribute("x2", String(x2));
  el.setAttribute("y2", String(y2));
}

interface ControlPointDef {
  worldPos: Vec3;
  axis: "x" | "y" | "z";
  negative: boolean;
}

function getControlPoints(shape: SDFShape): ControlPointDef[] {
  const { position: pos, size, type } = shape;
  const cps: ControlPointDef[] = [];

  switch (type) {
    case "box":
      // 6 face centers
      for (const axis of AXES) {
        const idx = axis === "x" ? 0 : axis === "y" ? 1 : 2;
        const posW: Vec3 = [...pos];
        posW[idx] += size[idx];
        cps.push({ worldPos: posW, axis, negative: false });
        const negW: Vec3 = [...pos];
        negW[idx] -= size[idx];
        cps.push({ worldPos: negW, axis, negative: true });
      }
      break;
    case "sphere":
      // 1 radius handle on +X
      cps.push({
        worldPos: [pos[0] + size[0], pos[1], pos[2]],
        axis: "x",
        negative: false,
      });
      break;
    case "cylinder":
      // Top/bottom caps (Y axis), 2 radius handles on X and Z
      cps.push({
        worldPos: [pos[0], pos[1] + size[1], pos[2]],
        axis: "y",
        negative: false,
      });
      cps.push({
        worldPos: [pos[0], pos[1] - size[1], pos[2]],
        axis: "y",
        negative: true,
      });
      cps.push({
        worldPos: [pos[0] + size[0], pos[1], pos[2]],
        axis: "x",
        negative: false,
      });
      cps.push({
        worldPos: [pos[0], pos[1], pos[2] + size[2]],
        axis: "z",
        negative: false,
      });
      break;
    case "cone":
      // Apex (top of Y), base radius on X
      cps.push({
        worldPos: [pos[0], pos[1] + size[1], pos[2]],
        axis: "y",
        negative: false,
      });
      cps.push({
        worldPos: [pos[0] + size[0], pos[1] - size[1], pos[2]],
        axis: "x",
        negative: false,
      });
      break;
    case "pyramid":
      // Apex (top of Y), base size on X
      cps.push({
        worldPos: [pos[0], pos[1] + size[1], pos[2]],
        axis: "y",
        negative: false,
      });
      cps.push({
        worldPos: [pos[0] + size[0], pos[1] - size[1], pos[2]],
        axis: "x",
        negative: false,
      });
      break;
  }

  return cps;
}

function computeScale(
  drag: DragInfo,
  delta: number,
  _newPos: Vec3,
  newSize: Vec3,
) {
  const { axisIdx, negative } = drag;
  // Scale symmetrically about shape center — position stays the same
  const d = negative ? -delta : delta;
  newSize[axisIdx] = Math.max(drag.startSize[axisIdx] + d, MIN_SIZE);
}

function applyScale(drag: DragInfo, delta: number, shape: SDFShape) {
  const newPos: Vec3 = [...drag.startPos];
  const newSize: Vec3 = [...drag.startSize];
  computeScale(drag, delta, newPos, newSize);
  shape.position = newPos;
  shape.size = newSize;
  sceneState.version++;
}

function computeEditFace(
  drag: DragInfo,
  delta: number,
  newPos: Vec3,
  newSize: Vec3,
  shape: SDFShape,
) {
  const { axisIdx, negative } = drag;

  if (shape.type === "sphere") {
    // Uniform resize
    const newR = Math.max(drag.startSize[0] + delta, MIN_SIZE);
    newSize[0] = newR;
    newSize[1] = newR;
    newSize[2] = newR;
    return;
  }

  if (
    (shape.type === "cylinder" ||
      shape.type === "cone" ||
      shape.type === "pyramid") &&
    drag.axis !== "y"
  ) {
    // Radius handles: uniform XZ resize
    const newR = Math.max(drag.startSize[axisIdx] + delta, MIN_SIZE);
    newSize[0] = newR;
    newSize[2] = newR;
    return;
  }

  // Default: move one face, keep opposite fixed (same as box face drag)
  if (negative) {
    const newHalf = Math.max(drag.startSize[axisIdx] - delta, MIN_SIZE);
    const positiveFace = drag.startPos[axisIdx] + drag.startSize[axisIdx];
    newSize[axisIdx] = newHalf;
    newPos[axisIdx] = positiveFace - newHalf;
  } else {
    const newHalf = Math.max(drag.startSize[axisIdx] + delta, MIN_SIZE);
    const negativeFace = drag.startPos[axisIdx] - drag.startSize[axisIdx];
    newSize[axisIdx] = newHalf;
    newPos[axisIdx] = negativeFace + newHalf;
  }
}

function applyEditFace(drag: DragInfo, delta: number, shape: SDFShape) {
  const newPos: Vec3 = [...drag.startPos];
  const newSize: Vec3 = [...drag.startSize];
  computeEditFace(drag, delta, newPos, newSize, shape);
  shape.position = newPos;
  shape.size = newSize;
  sceneState.version++;
}
