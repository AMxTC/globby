import { useEffect, useRef } from "react";
import type { Matrix4 } from "three";
import {
  sceneState,
  sceneRefs,
  moveShape,
  scaleShape,
  rotateShape,
  duplicateShape,
  type Vec3,
  type SDFShape,
} from "../state/sceneStore";
import {
  worldToScreen,
  projectRayOnAxisDir,
  projectRayOnPlane,
  gizmoWorldLength,
  eulerToMatrix3,
} from "../lib/math3d";

const AXIS_COLORS = { x: "#ef4444", y: "#22c55e", z: "#3b82f6" } as const;
const AXES: Array<"x" | "y" | "z"> = ["x", "y", "z"];
const ARROW_TARGET_PX = 80; // desired screen size at typical viewing angle
const ARROW_HEAD_PX = 10;
const SCALE_HANDLE_SIZE = 8;
const CP_RADIUS = 5;
const MIN_SIZE = 0.02;
const ARC_SAMPLES = 48;
const ROTATION_SNAP = Math.PI / 2; // 90 degrees

interface DragInfo {
  kind: "translate" | "scale" | "editFace" | "rotate";
  axis: "x" | "y" | "z";
  axisIdx: number;
  shapeId: string;
  startT: number;
  startPos: Vec3;
  startSize: Vec3;
  axisDir: Vec3;         // world-space direction of the dragged local axis
  startRotation: Vec3;   // for rotation undo
  startScale: number;    // for scale undo
  negative?: boolean;    // for scale: negative-side handle
  duplicatedFrom?: string; // set when alt+drag created a duplicate
  startAngle?: number;   // for rotation drag
}

/** Compute local axes from shape rotation */
function getLocalAxes(rotation: Vec3): Vec3[] {
  const m = eulerToMatrix3(rotation[0], rotation[1], rotation[2]);
  return [
    [m[0], m[1], m[2]],  // local X
    [m[3], m[4], m[5]],  // local Y
    [m[6], m[7], m[8]],  // local Z
  ];
}

/** Transform a local-space offset to world-space position */
function localToWorld(pos: Vec3, m: number[], s: number, localOffset: Vec3): Vec3 {
  const lx = localOffset[0] * s, ly = localOffset[1] * s, lz = localOffset[2] * s;
  return [
    pos[0] + m[0] * lx + m[3] * ly + m[6] * lz,
    pos[1] + m[1] * lx + m[4] * ly + m[7] * lz,
    pos[2] + m[2] * lx + m[5] * ly + m[8] * lz,
  ];
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

    // --- Object mode: rotation arcs (1 per axis) ---
    const rotateEls: Record<
      string,
      { path: SVGPathElement; hit: SVGPathElement }
    > = {};
    for (const axis of AXES) {
      const path = createSvgEl("path", {
        stroke: AXIS_COLORS[axis],
        "stroke-width": "1.5",
        fill: "none",
        opacity: "0.7",
        "pointer-events": "none",
      });
      const hit = createSvgEl("path", {
        stroke: AXIS_COLORS[axis],
        "stroke-width": "12",
        fill: "none",
        opacity: "0",
        "pointer-events": "stroke",
      });
      hit.dataset.role = "rotate";
      hit.dataset.axis = axis;
      addHoverBrightness(hit, [path]);
      g.appendChild(path);
      g.appendChild(hit);
      rotateEls[axis] = { path, hit };
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

      // Compute local axes from shape rotation
      const localAxes = getLocalAxes(shape.rotation);

      // --- Object mode elements ---
      const showObj = !isEdit;
      for (const axis of AXES) {
        const { line, hit, head } = translateEls[axis];
        const { rect: scaleRect, dash: scaleDash } = scaleEls[axis];
        const { path: arcPath, hit: arcHit } = rotateEls[axis];

        if (!showObj) {
          line.style.display = "none";
          hit.style.display = "none";
          head.style.display = "none";
          scaleRect.style.display = "none";
          scaleDash.style.display = "none";
          arcPath.style.display = "none";
          arcHit.style.display = "none";
          continue;
        }

        // Compute 3D endpoint of the arrow along local axis
        const axisIdx = axis === "x" ? 0 : axis === "y" ? 1 : 2;
        const armLen = gizmoWorldLength(
          pos,
          vpMat,
          w,
          h,
          camera,
          ARROW_TARGET_PX,
        );
        const dir = localAxes[axisIdx];
        const endWorld: Vec3 = [
          pos[0] + dir[0] * armLen,
          pos[1] + dir[1] * armLen,
          pos[2] + dir[2] * armLen,
        ];
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

        // Scale handle: opposite side of translate arrow (negative local axis)
        const negWorld: Vec3 = [
          pos[0] - dir[0] * armLen,
          pos[1] - dir[1] * armLen,
          pos[2] - dir[2] * armLen,
        ];
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

        // Rotation arc: circle in the plane perpendicular to this local axis
        const arcRadius = armLen * 1.15;
        // Basis vectors for the arc plane: use the other two local axes
        const basis0 = localAxes[(axisIdx + 1) % 3];
        const basis1 = localAxes[(axisIdx + 2) % 3];

        let arcD = "M";
        let allVisible = true;
        for (let j = 0; j <= ARC_SAMPLES; j++) {
          const angle = (j / ARC_SAMPLES) * Math.PI * 2;
          const cs = Math.cos(angle);
          const sn = Math.sin(angle);
          const wp: Vec3 = [
            pos[0] + (basis0[0] * cs + basis1[0] * sn) * arcRadius,
            pos[1] + (basis0[1] * cs + basis1[1] * sn) * arcRadius,
            pos[2] + (basis0[2] * cs + basis1[2] * sn) * arcRadius,
          ];
          const [apx, apy, apv] = worldToScreen(wp, vpMat, w, h);
          if (!apv) { allVisible = false; break; }
          arcD += `${j > 0 ? " L" : ""} ${apx},${apy}`;
        }
        arcD += " Z";

        if (allVisible) {
          arcPath.style.display = "";
          arcHit.style.display = "";
          arcPath.setAttribute("d", arcD);
          arcHit.setAttribute("d", arcD);
        } else {
          arcPath.style.display = "none";
          arcHit.style.display = "none";
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
      const localAxes = getLocalAxes(shape.rotation);
      const axisDir = localAxes[axisIdx];

      if (role === "translate") {
        const startT = projectRayOnAxisDir(
          camera, canvas, e.clientX, e.clientY, shape.position, axisDir,
        );

        if (e.altKey) {
          const newId = duplicateShape(selectedId);
          if (newId) {
            const clonedShape = sceneState.shapes.find((s) => s.id === newId);
            dragRef.current = {
              kind: "translate",
              axis,
              axisIdx,
              shapeId: newId,
              startT,
              startPos: [...clonedShape!.position] as Vec3,
              startSize: [...clonedShape!.size] as Vec3,
              axisDir,
              startRotation: [...clonedShape!.rotation] as Vec3,
              startScale: clonedShape!.scale,
              duplicatedFrom: selectedId,
            };
          }
        } else {
          dragRef.current = {
            kind: "translate",
            axis,
            axisIdx,
            shapeId: selectedId,
            startT,
            startPos: [...shape.position] as Vec3,
            startSize: [...shape.size] as Vec3,
            axisDir,
            startRotation: [...shape.rotation] as Vec3,
            startScale: shape.scale,
          };
        }
      } else if (role === "scale") {
        const startT = projectRayOnAxisDir(
          camera, canvas, e.clientX, e.clientY, shape.position, axisDir,
        );
        const negative = target.dataset.negative === "1";
        dragRef.current = {
          kind: "scale",
          axis,
          axisIdx,
          shapeId: selectedId,
          startT,
          startPos: [...shape.position] as Vec3,
          startSize: [...shape.size] as Vec3,
          axisDir,
          startRotation: [...shape.rotation] as Vec3,
          startScale: shape.scale,
          negative,
        };
      } else if (role === "rotate") {
        // Compute initial angle by intersecting mouse ray with the rotation plane
        const planeNormal = axisDir;
        const hitPoint = projectRayOnPlane(
          camera, canvas, e.clientX, e.clientY, shape.position, planeNormal,
        );
        let startAngle = 0;
        if (hitPoint) {
          const basis0 = localAxes[(axisIdx + 1) % 3];
          const basis1 = localAxes[(axisIdx + 2) % 3];
          const dx = hitPoint[0] - shape.position[0];
          const dy = hitPoint[1] - shape.position[1];
          const dz = hitPoint[2] - shape.position[2];
          const proj0 = dx * basis0[0] + dy * basis0[1] + dz * basis0[2];
          const proj1 = dx * basis1[0] + dy * basis1[1] + dz * basis1[2];
          startAngle = Math.atan2(proj1, proj0);
        }
        dragRef.current = {
          kind: "rotate",
          axis,
          axisIdx,
          shapeId: selectedId,
          startT: 0,
          startPos: [...shape.position] as Vec3,
          startSize: [...shape.size] as Vec3,
          axisDir,
          startRotation: [...shape.rotation] as Vec3,
          startScale: shape.scale,
          startAngle,
        };
      } else if (role === "editCp") {
        const startT = projectRayOnAxisDir(
          camera, canvas, e.clientX, e.clientY, shape.position, axisDir,
        );
        const negative = target.dataset.negative === "1";
        dragRef.current = {
          kind: "editFace",
          axis,
          axisIdx,
          shapeId: selectedId,
          startT,
          startPos: [...shape.position] as Vec3,
          startSize: [...shape.size] as Vec3,
          axisDir,
          startRotation: [...shape.rotation] as Vec3,
          startScale: shape.scale,
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

      const shape = sceneState.shapes.find((s) => s.id === drag.shapeId);
      if (!shape) return;

      if (drag.kind === "rotate") {
        // Rotation drag: intersect with rotation plane
        const hitPoint = projectRayOnPlane(
          camera, canvas, e.clientX, e.clientY, drag.startPos, drag.axisDir,
        );
        if (!hitPoint) return;
        const localAxes = getLocalAxes(drag.startRotation);
        const basis0 = localAxes[(drag.axisIdx + 1) % 3];
        const basis1 = localAxes[(drag.axisIdx + 2) % 3];
        const dx = hitPoint[0] - drag.startPos[0];
        const dy = hitPoint[1] - drag.startPos[1];
        const dz = hitPoint[2] - drag.startPos[2];
        const proj0 = dx * basis0[0] + dy * basis0[1] + dz * basis0[2];
        const proj1 = dx * basis1[0] + dy * basis1[1] + dz * basis1[2];
        const currentAngle = Math.atan2(proj1, proj0);
        let deltaAngle = currentAngle - (drag.startAngle ?? 0);
        deltaAngle = Math.atan2(Math.sin(deltaAngle), Math.cos(deltaAngle));

        const newRotation: Vec3 = [...drag.startRotation];
        newRotation[drag.axisIdx] += deltaAngle;
        if (e.shiftKey) {
          newRotation[drag.axisIdx] = Math.round(newRotation[drag.axisIdx] / ROTATION_SNAP) * ROTATION_SNAP;
        }
        shape.rotation = newRotation;
        sceneState.version++;
        return;
      }

      const currentT = projectRayOnAxisDir(
        camera, canvas, e.clientX, e.clientY, drag.startPos, drag.axisDir,
      );
      const delta = currentT - drag.startT;

      if (drag.kind === "translate") {
        const newPos: Vec3 = [
          drag.startPos[0] + drag.axisDir[0] * delta,
          drag.startPos[1] + drag.axisDir[1] * delta,
          drag.startPos[2] + drag.axisDir[2] * delta,
        ];
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

      if (drag.kind === "rotate") {
        // Compute final rotation
        const hitPoint = projectRayOnPlane(
          camera, canvas, e.clientX, e.clientY, drag.startPos, drag.axisDir,
        );
        const localAxes = getLocalAxes(drag.startRotation);
        const basis0 = localAxes[(drag.axisIdx + 1) % 3];
        const basis1 = localAxes[(drag.axisIdx + 2) % 3];
        let deltaAngle = 0;
        if (hitPoint) {
          const dx = hitPoint[0] - drag.startPos[0];
          const dy = hitPoint[1] - drag.startPos[1];
          const dz = hitPoint[2] - drag.startPos[2];
          const proj0 = dx * basis0[0] + dy * basis0[1] + dz * basis0[2];
          const proj1 = dx * basis1[0] + dy * basis1[1] + dz * basis1[2];
          deltaAngle = Math.atan2(proj1, proj0) - (drag.startAngle ?? 0);
          deltaAngle = Math.atan2(Math.sin(deltaAngle), Math.cos(deltaAngle));
        }
        // Restore startRotation, then commit via rotateShape (which pushes undo)
        const shape = sceneState.shapes.find((s) => s.id === drag.shapeId);
        if (shape) {
          shape.rotation = [...drag.startRotation] as Vec3;
          sceneState.version++;
        }
        const newRotation: Vec3 = [...drag.startRotation];
        newRotation[drag.axisIdx] += deltaAngle;
        if (e.shiftKey) {
          newRotation[drag.axisIdx] = Math.round(newRotation[drag.axisIdx] / ROTATION_SNAP) * ROTATION_SNAP;
        }
        rotateShape(drag.shapeId, newRotation);
        dragRef.current = null;
        return;
      }

      const currentT = projectRayOnAxisDir(
        camera, canvas, e.clientX, e.clientY, drag.startPos, drag.axisDir,
      );
      const delta = currentT - drag.startT;

      if (drag.kind === "translate") {
        const newPos: Vec3 = [
          drag.startPos[0] + drag.axisDir[0] * delta,
          drag.startPos[1] + drag.axisDir[1] * delta,
          drag.startPos[2] + drag.axisDir[2] * delta,
        ];
        if (drag.duplicatedFrom) {
          // Duplicate drag: undo was already pushed by duplicateShape(), just set final position
          const shape = sceneState.shapes.find((s) => s.id === drag.shapeId);
          if (shape) {
            shape.position = newPos;
            sceneState.version++;
          }
        } else {
          // Normal drag: restore original position, then use moveShape (which pushes undo)
          const shape = sceneState.shapes.find((s) => s.id === drag.shapeId);
          if (shape) {
            shape.position = [...drag.startPos] as Vec3;
            sceneState.version++;
          }
          moveShape(drag.shapeId, newPos);
        }
      } else if (drag.kind === "scale") {
        // Restore original, then commit via scaleShape
        const shape = sceneState.shapes.find((s) => s.id === drag.shapeId);
        if (shape) {
          const origPos: Vec3 = [...drag.startPos];
          const origSize: Vec3 = [...drag.startSize];
          shape.position = origPos;
          shape.size = origSize;
          shape.scale = drag.startScale;
          sceneState.version++;

          // Recompute final values
          const newScale = computeUniformScale(drag, delta);
          scaleShape(drag.shapeId, origSize, origPos, newScale);
        }
      } else if (drag.kind === "editFace") {
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
          computeEditFace(drag, delta, newPos, newSize, shape);
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
  const { position: pos, size, type, rotation, scale: s } = shape;
  const m = eulerToMatrix3(rotation[0], rotation[1], rotation[2]);
  const cps: ControlPointDef[] = [];

  function toWorld(localOffset: Vec3): Vec3 {
    return localToWorld(pos, m, s, localOffset);
  }

  switch (type) {
    case "box":
      // 6 face centers
      for (const axis of AXES) {
        const idx = axis === "x" ? 0 : axis === "y" ? 1 : 2;
        const posOff: Vec3 = [0, 0, 0];
        posOff[idx] = size[idx];
        cps.push({ worldPos: toWorld(posOff), axis, negative: false });
        const negOff: Vec3 = [0, 0, 0];
        negOff[idx] = -size[idx];
        cps.push({ worldPos: toWorld(negOff), axis, negative: true });
      }
      break;
    case "sphere":
      // 1 radius handle on +X
      cps.push({
        worldPos: toWorld([size[0], 0, 0]),
        axis: "x",
        negative: false,
      });
      break;
    case "cylinder":
      // Top/bottom caps (Y axis), 2 radius handles on X and Z
      cps.push({
        worldPos: toWorld([0, size[1], 0]),
        axis: "y",
        negative: false,
      });
      cps.push({
        worldPos: toWorld([0, -size[1], 0]),
        axis: "y",
        negative: true,
      });
      cps.push({
        worldPos: toWorld([size[0], 0, 0]),
        axis: "x",
        negative: false,
      });
      cps.push({
        worldPos: toWorld([0, 0, size[2]]),
        axis: "z",
        negative: false,
      });
      break;
    case "cone":
      // Apex (top of Y), base radius on X
      cps.push({
        worldPos: toWorld([0, size[1], 0]),
        axis: "y",
        negative: false,
      });
      cps.push({
        worldPos: toWorld([size[0], -size[1], 0]),
        axis: "x",
        negative: false,
      });
      break;
    case "pyramid":
      // Apex (top of Y), base size on X
      cps.push({
        worldPos: toWorld([0, size[1], 0]),
        axis: "y",
        negative: false,
      });
      cps.push({
        worldPos: toWorld([size[0], -size[1], 0]),
        axis: "x",
        negative: false,
      });
      break;
  }

  return cps;
}

/** Compute new uniform scale from drag delta */
function computeUniformScale(drag: DragInfo, delta: number): number {
  const d = drag.negative ? -delta : delta;
  // Use armLen-like reference: scale relative to startScale
  return Math.max(drag.startScale + d, 0.01);
}

function applyScale(drag: DragInfo, delta: number, shape: SDFShape) {
  const newScale = computeUniformScale(drag, delta);
  shape.scale = newScale;
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
  // Position shift is along the local axis direction
  if (negative) {
    const newHalf = Math.max(drag.startSize[axisIdx] - delta, MIN_SIZE);
    const shift = (drag.startSize[axisIdx] - newHalf) / 2;
    newSize[axisIdx] = newHalf;
    newPos[0] = drag.startPos[0] + drag.axisDir[0] * shift * drag.startScale;
    newPos[1] = drag.startPos[1] + drag.axisDir[1] * shift * drag.startScale;
    newPos[2] = drag.startPos[2] + drag.axisDir[2] * shift * drag.startScale;
  } else {
    const newHalf = Math.max(drag.startSize[axisIdx] + delta, MIN_SIZE);
    const shift = (newHalf - drag.startSize[axisIdx]) / 2;
    newSize[axisIdx] = newHalf;
    newPos[0] = drag.startPos[0] + drag.axisDir[0] * shift * drag.startScale;
    newPos[1] = drag.startPos[1] + drag.axisDir[1] * shift * drag.startScale;
    newPos[2] = drag.startPos[2] + drag.axisDir[2] * shift * drag.startScale;
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
