import { useEffect, useRef } from "react";
import type { Matrix4 } from "three";
import {
  sceneState,
  sceneRefs,
  pushUndo,
  scaleShape,
  type Vec3,
  type SDFShape,
} from "../../state/sceneStore";
import {
  worldToScreen,
  projectRayOnAxisDir,
  eulerToMatrix3,
} from "../../lib/math3d";
import { computeFaceDrag } from "../../lib/editFace";
import { CURSORS } from "../../lib/cursors";
import {
  AXIS_COLORS,
  AXES,
  getLocalAxes,
  addHoverBrightness,
  createSvgEl,
  setLineAttrs,
} from "./gizmoUtils";

const CP_RADIUS = 5;

interface EditDragInfo {
  kind: "editFace";
  axis: "x" | "y" | "z";
  axisIdx: number;
  shapeId: string;
  startT: number;
  startPos: Vec3;
  startSize: Vec3;
  axisDir: Vec3;
  startRotation: Vec3;
  startScale: number;
  negative: boolean;
  pivotPos: Vec3;
}

interface ControlPointDef {
  worldPos: Vec3;
  axis: "x" | "y" | "z";
  negative: boolean;
}

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

function getControlPoints(shape: SDFShape): ControlPointDef[] {
  const { position: pos, size, type, rotation, scale: s } = shape;
  const m = eulerToMatrix3(rotation[0], rotation[1], rotation[2]);
  const cps: ControlPointDef[] = [];

  function toWorld(localOffset: Vec3): Vec3 {
    return localToWorld(pos, m, s, localOffset);
  }

  switch (type) {
    case "box":
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
      cps.push({
        worldPos: toWorld([size[0], 0, 0]),
        axis: "x",
        negative: false,
      });
      break;
    case "cylinder":
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

export default function EditGizmo() {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<EditDragInfo | null>(null);
  const groupRef = useRef<SVGGElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const g = groupRef.current!;

    // Pre-allocate max CPs (6 for box) and hide extras
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
      circle.style.cursor = CURSORS.mousePointerInverted;
      addHoverBrightness(circle, [circle]);
      g.appendChild(dashLine);
      g.appendChild(circle);
      cpEls.push({ circle, dashLine });
    }

    // --- Frame update ---
    function update(vpMat: Matrix4, w: number, h: number) {
      const selectedIds = sceneState.selectedShapeIds;
      const isSingle = selectedIds.length === 1;
      const shape = isSingle
        ? sceneState.shapes.find((s) => s.id === selectedIds[0])
        : null;
      const isEdit = isSingle && shape && sceneState.editMode === "edit";

      if (!isEdit || !shape) {
        g.style.display = "none";
        return;
      }

      g.style.display = "";

      const [cx, cy, vis] = worldToScreen(shape.position, vpMat, w, h);
      if (!vis) {
        g.style.display = "none";
        return;
      }

      const cpDefs = getControlPoints(shape);
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

    sceneRefs.updateEditGizmo = update;

    // --- Pointer handling ---
    function onPointerDown(e: PointerEvent) {
      if (e.button !== 0) return;
      const target = e.target as SVGElement;
      const role = target.dataset?.role;
      if (role !== "editCp") return;
      const camera = sceneRefs.camera;
      const canvas = sceneRefs.canvas;
      if (!camera || !canvas) return;

      const selectedIds = sceneState.selectedShapeIds;
      if (selectedIds.length !== 1) return;

      const primaryId = selectedIds[0];
      const primaryShape = sceneState.shapes.find((s) => s.id === primaryId);
      if (!primaryShape) return;

      e.preventDefault();
      e.stopPropagation();
      target.setPointerCapture(e.pointerId);

      const axis = target.dataset.axis as "x" | "y" | "z";
      const axisIdx = axis === "x" ? 0 : axis === "y" ? 1 : 2;
      const localAxes = getLocalAxes(primaryShape.rotation);
      const axisDir = localAxes[axisIdx];

      const startT = projectRayOnAxisDir(
        camera, canvas, e.clientX, e.clientY, primaryShape.position, axisDir,
      );
      const negative = target.dataset.negative === "1";
      dragRef.current = {
        kind: "editFace",
        axis, axisIdx,
        shapeId: primaryId,
        startT,
        startPos: [...primaryShape.position] as Vec3,
        startSize: [...primaryShape.size] as Vec3,
        axisDir,
        startRotation: [...primaryShape.rotation] as Vec3,
        startScale: primaryShape.scale,
        negative,
        pivotPos: [...primaryShape.position] as Vec3,
      };
    }

    function onPointerMove(e: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const camera = sceneRefs.camera;
      const canvas = sceneRefs.canvas;
      if (!camera || !canvas) return;

      e.preventDefault();
      e.stopPropagation();

      const currentT = projectRayOnAxisDir(
        camera, canvas, e.clientX, e.clientY, drag.pivotPos, drag.axisDir,
      );
      const delta = currentT - drag.startT;

      const shape = sceneState.shapes.find((s) => s.id === drag.shapeId);
      if (!shape) return;
      const { newSize, newPos } = computeFaceDrag(
        { ...drag, negative: drag.negative }, delta, shape.type, drag.axis,
      );
      shape.position = newPos;
      shape.size = newSize;
      sceneState.version++;
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

      const currentT = projectRayOnAxisDir(
        camera, canvas, e.clientX, e.clientY, drag.pivotPos, drag.axisDir,
      );
      const delta = currentT - drag.startT;

      const shape = sceneState.shapes.find((s) => s.id === drag.shapeId);
      if (shape) {
        shape.position = [...drag.startPos] as Vec3;
        shape.size = [...drag.startSize] as Vec3;
        sceneState.version++;
        const { newSize, newPos } = computeFaceDrag(
          { ...drag, negative: drag.negative }, delta, shape.type, drag.axis,
        );
        pushUndo();
        scaleShape(drag.shapeId, newSize, newPos);
      }

      dragRef.current = null;
    }

    function onContextMenu(e: Event) {
      e.preventDefault();
    }

    svg.addEventListener("pointerdown", onPointerDown);
    svg.addEventListener("pointermove", onPointerMove);
    svg.addEventListener("pointerup", onPointerUp);
    svg.addEventListener("contextmenu", onContextMenu);

    return () => {
      sceneRefs.updateEditGizmo = null;
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
