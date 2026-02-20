import { useEffect, useRef } from "react";
import type { Matrix4 } from "three";
import {
  sceneState,
  sceneRefs,
  pushUndo,
  moveShape,
  scaleShape,
  rotateShape,
  duplicateShape,
  duplicateSelectedShapes,
  moveShapes,
  rotateShapesAroundPivot,
  scaleShapesAroundPivot,
  type Vec3,
  type SDFShape,
} from "../../state/sceneStore";
import {
  worldToScreen,
  projectRayOnAxisDir,
  projectRayOnPlane,
  gizmoWorldLength,
  rotateVecAroundAxis,
  composeWorldRotation,
} from "../../lib/math3d";
import {
  AXIS_COLORS,
  AXES,
  getLocalAxes,
  addHoverBrightness,
  createSvgEl,
  setLineAttrs,
} from "./gizmoUtils";

const ARROW_TARGET_PX = 80;
const ARROW_HEAD_PX = 10;
const SCALE_HANDLE_SIZE = 8;
const ARC_SAMPLES = 16;
const ARC_RADIUS_FRACTION = 0.85;
const ROTATION_SNAP = Math.PI / 2;

interface GumballDragInfo {
  kind: "translate" | "scale" | "rotate";
  axis: "x" | "y" | "z";
  axisIdx: number;
  shapeId: string;
  startT: number;
  startPos: Vec3;
  startSize: Vec3;
  axisDir: Vec3;
  startRotation: Vec3;
  startScale: number;
  negative?: boolean;
  duplicatedFrom?: string;
  startAngle?: number;
  pivotPos: Vec3;
  multiShapeIds?: string[];
  multiStartPositions?: Vec3[];
  multiStartRotations?: Vec3[];
  multiStartScales?: number[];
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

function computeUniformScale(drag: GumballDragInfo, delta: number): number {
  const d = drag.negative ? -delta : delta;
  return Math.max(drag.startScale + d, 0.01);
}

function applyScale(drag: GumballDragInfo, delta: number, shape: SDFShape) {
  const newScale = computeUniformScale(drag, delta);
  shape.scale = newScale;
  sceneState.version++;
}

export default function TranslateGumball() {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<GumballDragInfo | null>(null);
  const groupRef = useRef<SVGGElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const g = groupRef.current!;

    // --- Translate arrows ---
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
      addHoverBrightness(hit, [line, head]);

      g.appendChild(line);
      g.appendChild(head);
      g.appendChild(hit);
      translateEls[axis] = { line, hit, head };
    }

    // --- Scale handles ---
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

    // --- Rotation arcs ---
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

    // --- Frame update ---
    function update(vpMat: Matrix4, w: number, h: number) {
      const camera = sceneRefs.camera;
      const selectedIds = sceneState.selectedShapeIds;
      if (selectedIds.length === 0 || !camera) {
        g.style.display = "none";
        return;
      }

      const isSingle = selectedIds.length === 1;
      const shape = isSingle
        ? sceneState.shapes.find((s) => s.id === selectedIds[0])
        : null;

      if (isSingle && !shape) {
        g.style.display = "none";
        return;
      }

      // Compute gizmo position
      let pos: Vec3;
      let localAxes: Vec3[];
      if (isSingle && shape) {
        pos = shape.position;
        localAxes = getLocalAxes(shape.rotation);
      } else {
        let cx2 = 0, cy2 = 0, cz2 = 0, count = 0;
        for (const id of selectedIds) {
          const s = sceneState.shapes.find((sh) => sh.id === id);
          if (!s) continue;
          cx2 += s.position[0];
          cy2 += s.position[1];
          cz2 += s.position[2];
          count++;
        }
        if (count === 0) {
          g.style.display = "none";
          return;
        }
        pos = [cx2 / count, cy2 / count, cz2 / count];
        localAxes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      }

      const isEdit = isSingle && sceneState.editMode === "edit";
      if (isEdit) {
        g.style.display = "none";
        return;
      }

      g.style.display = "";

      const [cx, cy, vis] = worldToScreen(pos, vpMat, w, h);
      if (!vis) {
        g.style.display = "none";
        return;
      }

      for (const axis of AXES) {
        const { line, hit, head } = translateEls[axis];
        const { rect: scaleRect, dash: scaleDash } = scaleEls[axis];
        const { path: arcPath, hit: arcHit } = rotateEls[axis];

        const axisIdx = axis === "x" ? 0 : axis === "y" ? 1 : 2;
        const armLen = gizmoWorldLength(pos, vpMat, w, h, camera, ARROW_TARGET_PX);
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
          scaleRect.style.display = "none";
          scaleDash.style.display = "none";
          arcPath.style.display = "none";
          arcHit.style.display = "none";
          continue;
        }

        line.style.display = "";
        hit.style.display = "";
        head.style.display = "";

        setLineAttrs(line, cx, cy, ex, ey);
        setLineAttrs(hit, cx, cy, ex, ey);

        // Arrowhead
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

        // Scale handle (negative side)
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

        // Rotation arc
        const arcRadius = armLen * ARC_RADIUS_FRACTION;
        const b0 = localAxes[(axisIdx + 1) % 3];
        const b1 = localAxes[(axisIdx + 2) % 3];
        const negBasis0: Vec3 = [-b0[0], -b0[1], -b0[2]];
        const negBasis1: Vec3 = [-b1[0], -b1[1], -b1[2]];

        let arcD = "M";
        let allVisible = true;
        for (let j = 0; j <= ARC_SAMPLES; j++) {
          const t = j / ARC_SAMPLES;
          const angle = t * (Math.PI / 2);
          const cs = Math.cos(angle);
          const sn = Math.sin(angle);
          const wp: Vec3 = [
            pos[0] + (negBasis0[0] * cs + negBasis1[0] * sn) * arcRadius,
            pos[1] + (negBasis0[1] * cs + negBasis1[1] * sn) * arcRadius,
            pos[2] + (negBasis0[2] * cs + negBasis1[2] * sn) * arcRadius,
          ];
          const [apx, apy, apv] = worldToScreen(wp, vpMat, w, h);
          if (!apv) {
            allVisible = false;
            break;
          }
          arcD += `${j > 0 ? " L" : ""} ${apx},${apy}`;
        }

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
    }

    sceneRefs.updateTranslateGumball = update;

    // --- Pointer handling ---
    function onPointerDown(e: PointerEvent) {
      if (e.button !== 0) return;
      const target = e.target as SVGElement;
      const role = target.dataset?.role;
      if (!role || (role !== "translate" && role !== "scale" && role !== "rotate")) return;
      const camera = sceneRefs.camera;
      const canvas = sceneRefs.canvas;
      if (!camera || !canvas) return;

      const selectedIds = sceneState.selectedShapeIds;
      if (selectedIds.length === 0) return;

      const isSingle = selectedIds.length === 1;
      const primaryId = selectedIds[0];
      const primaryShape = sceneState.shapes.find((s) => s.id === primaryId);
      if (!primaryShape) return;

      e.preventDefault();
      e.stopPropagation();
      target.setPointerCapture(e.pointerId);

      const axis = target.dataset.axis as "x" | "y" | "z";
      const axisIdx = axis === "x" ? 0 : axis === "y" ? 1 : 2;

      let axisDir: Vec3;
      let currentLocalAxes: Vec3[];
      if (isSingle) {
        currentLocalAxes = getLocalAxes(primaryShape.rotation);
        axisDir = currentLocalAxes[axisIdx];
      } else {
        currentLocalAxes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        axisDir = currentLocalAxes[axisIdx];
      }

      // Compute pivot
      let pivotPos: Vec3;
      if (isSingle) {
        pivotPos = [...primaryShape.position] as Vec3;
      } else {
        let px = 0, py = 0, pz = 0, cnt = 0;
        for (const id of selectedIds) {
          const s = sceneState.shapes.find((sh) => sh.id === id);
          if (!s) continue;
          px += s.position[0];
          py += s.position[1];
          pz += s.position[2];
          cnt++;
        }
        pivotPos = [px / cnt, py / cnt, pz / cnt];
      }

      // Snapshot multi-shape state
      let multiShapeIds: string[] | undefined;
      let multiStartPositions: Vec3[] | undefined;
      let multiStartRotations: Vec3[] | undefined;
      let multiStartScales: number[] | undefined;
      if (!isSingle) {
        multiShapeIds = [...selectedIds];
        multiStartPositions = [];
        multiStartRotations = [];
        multiStartScales = [];
        for (const id of selectedIds) {
          const s = sceneState.shapes.find((sh) => sh.id === id);
          if (!s) continue;
          multiStartPositions.push([...s.position] as Vec3);
          multiStartRotations.push([...s.rotation] as Vec3);
          multiStartScales.push(s.scale);
        }
      }

      if (role === "translate") {
        const startT = projectRayOnAxisDir(
          camera, canvas, e.clientX, e.clientY, pivotPos, axisDir,
        );

        if (e.altKey) {
          if (isSingle) {
            const newId = duplicateShape(primaryId);
            if (newId) {
              const clonedShape = sceneState.shapes.find((s) => s.id === newId);
              dragRef.current = {
                kind: "translate",
                axis, axisIdx,
                shapeId: newId,
                startT,
                startPos: [...clonedShape!.position] as Vec3,
                startSize: [...clonedShape!.size] as Vec3,
                axisDir,
                startRotation: [...clonedShape!.rotation] as Vec3,
                startScale: clonedShape!.scale,
                duplicatedFrom: primaryId,
                pivotPos: [...clonedShape!.position] as Vec3,
              };
            }
          } else {
            const newIds = duplicateSelectedShapes();
            if (newIds.length > 0) {
              const newMultiPositions: Vec3[] = [];
              const newMultiRotations: Vec3[] = [];
              const newMultiScales: number[] = [];
              for (const nid of newIds) {
                const s = sceneState.shapes.find((sh) => sh.id === nid);
                if (!s) continue;
                newMultiPositions.push([...s.position] as Vec3);
                newMultiRotations.push([...s.rotation] as Vec3);
                newMultiScales.push(s.scale);
              }
              dragRef.current = {
                kind: "translate",
                axis, axisIdx,
                shapeId: newIds[0],
                startT,
                startPos: [...pivotPos] as Vec3,
                startSize: [0, 0, 0],
                axisDir,
                startRotation: [0, 0, 0],
                startScale: 1,
                duplicatedFrom: primaryId,
                pivotPos: [...pivotPos] as Vec3,
                multiShapeIds: newIds,
                multiStartPositions: newMultiPositions,
                multiStartRotations: newMultiRotations,
                multiStartScales: newMultiScales,
              };
            }
          }
        } else {
          dragRef.current = {
            kind: "translate",
            axis, axisIdx,
            shapeId: primaryId,
            startT,
            startPos: [...primaryShape.position] as Vec3,
            startSize: [...primaryShape.size] as Vec3,
            axisDir,
            startRotation: [...primaryShape.rotation] as Vec3,
            startScale: primaryShape.scale,
            pivotPos,
            multiShapeIds,
            multiStartPositions,
            multiStartRotations,
            multiStartScales,
          };
        }
      } else if (role === "scale") {
        const startT = projectRayOnAxisDir(
          camera, canvas, e.clientX, e.clientY, pivotPos, axisDir,
        );
        const negative = target.dataset.negative === "1";
        dragRef.current = {
          kind: "scale",
          axis, axisIdx,
          shapeId: primaryId,
          startT,
          startPos: [...primaryShape.position] as Vec3,
          startSize: [...primaryShape.size] as Vec3,
          axisDir,
          startRotation: [...primaryShape.rotation] as Vec3,
          startScale: primaryShape.scale,
          negative,
          pivotPos,
          multiShapeIds,
          multiStartPositions,
          multiStartRotations,
          multiStartScales,
        };
      } else if (role === "rotate") {
        const planeNormal = axisDir;
        const hitPoint = projectRayOnPlane(
          camera, canvas, e.clientX, e.clientY, pivotPos, planeNormal,
        );
        let startAngle = 0;
        if (hitPoint) {
          const basis0 = currentLocalAxes[(axisIdx + 1) % 3];
          const basis1 = currentLocalAxes[(axisIdx + 2) % 3];
          const dx = hitPoint[0] - pivotPos[0];
          const dy = hitPoint[1] - pivotPos[1];
          const dz = hitPoint[2] - pivotPos[2];
          const proj0 = dx * basis0[0] + dy * basis0[1] + dz * basis0[2];
          const proj1 = dx * basis1[0] + dy * basis1[1] + dz * basis1[2];
          startAngle = Math.atan2(proj1, proj0);
        }
        dragRef.current = {
          kind: "rotate",
          axis, axisIdx,
          shapeId: primaryId,
          startT: 0,
          startPos: [...primaryShape.position] as Vec3,
          startSize: [...primaryShape.size] as Vec3,
          axisDir,
          startRotation: [...primaryShape.rotation] as Vec3,
          startScale: primaryShape.scale,
          startAngle,
          pivotPos,
          multiShapeIds,
          multiStartPositions,
          multiStartRotations,
          multiStartScales,
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

      const isMulti = drag.multiShapeIds != null && drag.multiShapeIds.length > 0;

      if (drag.kind === "rotate") {
        const hitPoint = projectRayOnPlane(
          camera, canvas, e.clientX, e.clientY, drag.pivotPos, drag.axisDir,
        );
        if (!hitPoint) return;

        let basis0: Vec3, basis1: Vec3;
        if (isMulti) {
          const worldAxes: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
          basis0 = worldAxes[(drag.axisIdx + 1) % 3];
          basis1 = worldAxes[(drag.axisIdx + 2) % 3];
        } else {
          const la = getLocalAxes(drag.startRotation);
          basis0 = la[(drag.axisIdx + 1) % 3];
          basis1 = la[(drag.axisIdx + 2) % 3];
        }

        const dx = hitPoint[0] - drag.pivotPos[0];
        const dy = hitPoint[1] - drag.pivotPos[1];
        const dz = hitPoint[2] - drag.pivotPos[2];
        const proj0 = dx * basis0[0] + dy * basis0[1] + dz * basis0[2];
        const proj1 = dx * basis1[0] + dy * basis1[1] + dz * basis1[2];
        const currentAngle = Math.atan2(proj1, proj0);
        let deltaAngle = currentAngle - (drag.startAngle ?? 0);
        deltaAngle = Math.atan2(Math.sin(deltaAngle), Math.cos(deltaAngle));
        if (e.shiftKey) {
          deltaAngle = Math.round(deltaAngle / ROTATION_SNAP) * ROTATION_SNAP;
        }

        if (isMulti) {
          const { multiShapeIds, multiStartPositions, multiStartRotations } = drag;
          for (let i = 0; i < multiShapeIds!.length; i++) {
            const s = sceneState.shapes.find((sh) => sh.id === multiShapeIds![i]);
            if (!s) continue;
            const startP = multiStartPositions![i];
            const startR = multiStartRotations![i];
            const rel: Vec3 = [
              startP[0] - drag.pivotPos[0],
              startP[1] - drag.pivotPos[1],
              startP[2] - drag.pivotPos[2],
            ];
            const rotated = rotateVecAroundAxis(rel, drag.axisDir, deltaAngle);
            s.position = [
              drag.pivotPos[0] + rotated[0],
              drag.pivotPos[1] + rotated[1],
              drag.pivotPos[2] + rotated[2],
            ];
            s.rotation = composeWorldRotation(startR, drag.axisDir, deltaAngle);
          }
          sceneState.version++;
        } else {
          const shape = sceneState.shapes.find((s) => s.id === drag.shapeId);
          if (!shape) return;
          shape.rotation = composeWorldRotation(drag.startRotation, drag.axisDir, deltaAngle);
          sceneState.version++;
        }
        return;
      }

      const currentT = projectRayOnAxisDir(
        camera, canvas, e.clientX, e.clientY, drag.pivotPos, drag.axisDir,
      );
      const delta = currentT - drag.startT;

      if (drag.kind === "translate") {
        if (isMulti) {
          const { multiShapeIds, multiStartPositions } = drag;
          for (let i = 0; i < multiShapeIds!.length; i++) {
            const s = sceneState.shapes.find((sh) => sh.id === multiShapeIds![i]);
            if (!s) continue;
            const sp = multiStartPositions![i];
            s.position = [
              sp[0] + drag.axisDir[0] * delta,
              sp[1] + drag.axisDir[1] * delta,
              sp[2] + drag.axisDir[2] * delta,
            ];
          }
          sceneState.version++;
        } else {
          const shape = sceneState.shapes.find((s) => s.id === drag.shapeId);
          if (!shape) return;
          shape.position = [
            drag.startPos[0] + drag.axisDir[0] * delta,
            drag.startPos[1] + drag.axisDir[1] * delta,
            drag.startPos[2] + drag.axisDir[2] * delta,
          ];
          sceneState.version++;
        }
      } else if (drag.kind === "scale") {
        if (isMulti) {
          const d = drag.negative ? -delta : delta;
          const scaleFactor = Math.max(0.01, 1 + d);
          const { multiShapeIds, multiStartPositions, multiStartScales } = drag;
          for (let i = 0; i < multiShapeIds!.length; i++) {
            const s = sceneState.shapes.find((sh) => sh.id === multiShapeIds![i]);
            if (!s) continue;
            const sp = multiStartPositions![i];
            s.position = [
              drag.pivotPos[0] + (sp[0] - drag.pivotPos[0]) * scaleFactor,
              drag.pivotPos[1] + (sp[1] - drag.pivotPos[1]) * scaleFactor,
              drag.pivotPos[2] + (sp[2] - drag.pivotPos[2]) * scaleFactor,
            ];
            s.scale = multiStartScales![i] * scaleFactor;
          }
          sceneState.version++;
        } else {
          const shape = sceneState.shapes.find((s) => s.id === drag.shapeId);
          if (!shape) return;
          applyScale(drag, delta, shape);
        }
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

      const isMulti = drag.multiShapeIds != null && drag.multiShapeIds.length > 0;

      if (drag.kind === "rotate") {
        const hitPoint = projectRayOnPlane(
          camera, canvas, e.clientX, e.clientY, drag.pivotPos, drag.axisDir,
        );
        let basis0: Vec3, basis1: Vec3;
        if (isMulti) {
          const worldAxes: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
          basis0 = worldAxes[(drag.axisIdx + 1) % 3];
          basis1 = worldAxes[(drag.axisIdx + 2) % 3];
        } else {
          const la = getLocalAxes(drag.startRotation);
          basis0 = la[(drag.axisIdx + 1) % 3];
          basis1 = la[(drag.axisIdx + 2) % 3];
        }
        let deltaAngle = 0;
        if (hitPoint) {
          const dx = hitPoint[0] - drag.pivotPos[0];
          const dy = hitPoint[1] - drag.pivotPos[1];
          const dz = hitPoint[2] - drag.pivotPos[2];
          const proj0 = dx * basis0[0] + dy * basis0[1] + dz * basis0[2];
          const proj1 = dx * basis1[0] + dy * basis1[1] + dz * basis1[2];
          deltaAngle = Math.atan2(proj1, proj0) - (drag.startAngle ?? 0);
          deltaAngle = Math.atan2(Math.sin(deltaAngle), Math.cos(deltaAngle));
        }
        if (e.shiftKey) {
          deltaAngle = Math.round(deltaAngle / ROTATION_SNAP) * ROTATION_SNAP;
        }

        if (isMulti) {
          const { multiShapeIds, multiStartPositions, multiStartRotations } = drag;
          for (let i = 0; i < multiShapeIds!.length; i++) {
            const s = sceneState.shapes.find((sh) => sh.id === multiShapeIds![i]);
            if (!s) continue;
            s.position = [...multiStartPositions![i]] as Vec3;
            s.rotation = [...multiStartRotations![i]] as Vec3;
          }
          sceneState.version++;
          rotateShapesAroundPivot(multiShapeIds!, drag.pivotPos, drag.axisDir, deltaAngle);
        } else {
          const shape = sceneState.shapes.find((s) => s.id === drag.shapeId);
          if (shape) {
            shape.rotation = [...drag.startRotation] as Vec3;
            sceneState.version++;
          }
          pushUndo();
          rotateShape(drag.shapeId, composeWorldRotation(drag.startRotation, drag.axisDir, deltaAngle));
        }
        dragRef.current = null;
        return;
      }

      const currentT = projectRayOnAxisDir(
        camera, canvas, e.clientX, e.clientY, drag.pivotPos, drag.axisDir,
      );
      const delta = currentT - drag.startT;

      if (drag.kind === "translate") {
        if (isMulti) {
          if (drag.duplicatedFrom) {
            // Alt+drag duplicate: undo was already pushed by duplicateSelectedShapes
          } else {
            const { multiShapeIds, multiStartPositions } = drag;
            for (let i = 0; i < multiShapeIds!.length; i++) {
              const s = sceneState.shapes.find((sh) => sh.id === multiShapeIds![i]);
              if (!s) continue;
              s.position = [...multiStartPositions![i]] as Vec3;
            }
            sceneState.version++;
            const moveDelta: Vec3 = [
              drag.axisDir[0] * delta,
              drag.axisDir[1] * delta,
              drag.axisDir[2] * delta,
            ];
            moveShapes(multiShapeIds!, moveDelta);
          }
        } else {
          const newPos: Vec3 = [
            drag.startPos[0] + drag.axisDir[0] * delta,
            drag.startPos[1] + drag.axisDir[1] * delta,
            drag.startPos[2] + drag.axisDir[2] * delta,
          ];
          if (drag.duplicatedFrom) {
            const shape = sceneState.shapes.find((s) => s.id === drag.shapeId);
            if (shape) {
              shape.position = newPos;
              sceneState.version++;
            }
          } else {
            const shape = sceneState.shapes.find((s) => s.id === drag.shapeId);
            if (shape) {
              shape.position = [...drag.startPos] as Vec3;
              sceneState.version++;
            }
            pushUndo();
            moveShape(drag.shapeId, newPos);
          }
        }
      } else if (drag.kind === "scale") {
        if (isMulti) {
          const { multiShapeIds, multiStartPositions, multiStartScales } = drag;
          for (let i = 0; i < multiShapeIds!.length; i++) {
            const s = sceneState.shapes.find((sh) => sh.id === multiShapeIds![i]);
            if (!s) continue;
            s.position = [...multiStartPositions![i]] as Vec3;
            s.scale = multiStartScales![i];
          }
          sceneState.version++;
          const d = drag.negative ? -delta : delta;
          const scaleFactor = Math.max(0.01, 1 + d);
          scaleShapesAroundPivot(multiShapeIds!, drag.pivotPos, scaleFactor);
        } else {
          const shape = sceneState.shapes.find((s) => s.id === drag.shapeId);
          if (shape) {
            const origPos: Vec3 = [...drag.startPos];
            const origSize: Vec3 = [...drag.startSize];
            shape.position = origPos;
            shape.size = origSize;
            shape.scale = drag.startScale;
            sceneState.version++;
            const newScale = computeUniformScale(drag, delta);
            pushUndo();
            scaleShape(drag.shapeId, origSize, origPos, newScale);
          }
        }
      }

      dragRef.current = null;
    }

    function onContextMenu(e: Event) {
      e.preventDefault();
      e.stopPropagation();
    }

    svg.addEventListener("pointerdown", onPointerDown);
    svg.addEventListener("pointermove", onPointerMove);
    svg.addEventListener("pointerup", onPointerUp);
    svg.addEventListener("contextmenu", onContextMenu);

    return () => {
      sceneRefs.updateTranslateGumball = null;
      svg.removeEventListener("pointerdown", onPointerDown);
      svg.removeEventListener("pointermove", onPointerMove);
      svg.removeEventListener("pointerup", onPointerUp);
      svg.removeEventListener("contextmenu", onContextMenu);
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
