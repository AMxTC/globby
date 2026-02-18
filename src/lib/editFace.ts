import type { Vec3, SDFShape } from "../state/sceneStore";
import { eulerToMatrix3 } from "./math3d";

export const MIN_SIZE = 0.02;

export interface FaceDragParams {
  axisIdx: number;
  negative: boolean;
  axisDir: Vec3;
  startPos: Vec3;
  startSize: Vec3;
  startScale: number;
}

/**
 * Compute new size and position for a face-drag operation.
 * Moves the dragged face by `delta` (world-space) along axisDir,
 * keeping the opposite face pinned.
 *
 * @param params  - drag parameters (axis, direction, start state)
 * @param delta   - world-space displacement along +axisDir
 * @param shapeType - shape type for special-case handling
 * @param axis    - "x"|"y"|"z", only needed for cylinder/cone/pyramid radius branch
 */
export function computeFaceDrag(
  params: FaceDragParams,
  delta: number,
  shapeType: string,
  axis?: "x" | "y" | "z",
): { newSize: Vec3; newPos: Vec3 } {
  const { axisIdx, negative, startPos, startSize, startScale, axisDir } = params;
  const newSize: Vec3 = [...startSize];
  const newPos: Vec3 = [...startPos];

  if (shapeType === "sphere") {
    // Uniform resize
    const newR = Math.max(startSize[0] + delta, MIN_SIZE);
    newSize[0] = newR;
    newSize[1] = newR;
    newSize[2] = newR;
    return { newSize, newPos };
  }

  if (
    (shapeType === "cylinder" ||
      shapeType === "cone" ||
      shapeType === "pyramid") &&
    axis !== "y"
  ) {
    // Radius handles: uniform XZ resize
    const newR = Math.max(startSize[axisIdx] + delta, MIN_SIZE);
    newSize[0] = newR;
    newSize[2] = newR;
    return { newSize, newPos };
  }

  // Default: move one face, keep opposite fixed.
  const sign = negative ? -1 : 1;
  const newHalf = Math.max(startSize[axisIdx] + sign * delta / (2 * startScale), MIN_SIZE);
  newSize[axisIdx] = newHalf;
  const worldShift = sign * (newHalf - startSize[axisIdx]) * startScale;
  newPos[0] = startPos[0] + axisDir[0] * worldShift;
  newPos[1] = startPos[1] + axisDir[1] * worldShift;
  newPos[2] = startPos[2] + axisDir[2] * worldShift;

  return { newSize, newPos };
}

/** Transform a world-space position to local shape space. */
function worldToLocal(worldPos: Vec3, shape: SDFShape): Vec3 {
  const m = eulerToMatrix3(shape.rotation[0], shape.rotation[1], shape.rotation[2]);
  const dx = worldPos[0] - shape.position[0];
  const dy = worldPos[1] - shape.position[1];
  const dz = worldPos[2] - shape.position[2];
  // m is column-major orthonormal, so transpose = inverse
  return [
    (m[0] * dx + m[1] * dy + m[2] * dz) / shape.scale,
    (m[3] * dx + m[4] * dy + m[5] * dz) / shape.scale,
    (m[6] * dx + m[7] * dy + m[8] * dz) / shape.scale,
  ];
}

/** Squared distance from point (px,pz) to line segment (v0→v1) in 2D. */
function pointToEdgeDist2D(
  px: number, pz: number,
  v0: [number, number], v1: [number, number],
): number {
  const ex = v1[0] - v0[0];
  const ez = v1[1] - v0[1];
  const wx = px - v0[0];
  const wz = pz - v0[1];
  const t = Math.max(0, Math.min(1, (wx * ex + wz * ez) / (ex * ex + ez * ez + 1e-12)));
  const dx = wx - t * ex;
  const dz = wz - t * ez;
  return dx * dx + dz * dz;
}

export type FaceResult = {
  axisIdx: number;
  negative: boolean;
  axis?: "x" | "y" | "z";
  edgeIdx?: number;
};

/**
 * Detect which face of a shape was clicked.
 * Returns the axis index, whether it's the negative face, and an optional
 * axis hint needed by computeFaceDrag for cylinder/cone/pyramid radius branches.
 * For polygon side faces, also returns edgeIdx.
 * Returns null for unsupported shape types.
 */
export function detectFace(
  worldPos: Vec3,
  shape: SDFShape,
): FaceResult | null {
  switch (shape.type) {
    case "box": {
      const local = worldToLocal(worldPos, shape);
      // Find which face: largest |local[i] / size[i]|
      let bestAxis = 0;
      let bestRatio = -1;
      for (let i = 0; i < 3; i++) {
        const ratio = Math.abs(local[i]) / shape.size[i];
        if (ratio > bestRatio) {
          bestRatio = ratio;
          bestAxis = i;
        }
      }
      return { axisIdx: bestAxis, negative: local[bestAxis] < 0 };
    }
    case "sphere": {
      // Any surface click drags the radius uniformly
      return { axisIdx: 0, negative: false, axis: "x" };
    }
    case "cylinder": {
      const local = worldToLocal(worldPos, shape);
      const radial = Math.sqrt(local[0] * local[0] + local[2] * local[2]);
      const yRatio = shape.size[1] > 1e-6 ? Math.abs(local[1]) / shape.size[1] : 0;
      const rRatio = shape.size[0] > 1e-6 ? radial / shape.size[0] : 0;
      if (yRatio > rRatio) {
        // Cap face — height drag, opposite cap pinned
        return { axisIdx: 1, negative: local[1] < 0, axis: "y" };
      }
      // Side — radius drag, uniform XZ resize
      return { axisIdx: 0, negative: false, axis: "x" };
    }
    case "cone":
    case "pyramid": {
      const local = worldToLocal(worldPos, shape);
      if (local[1] > 0) {
        // Upper half (near apex) — height/apex drag
        return { axisIdx: 1, negative: false, axis: "y" };
      }
      // Lower half: compare proximity to base plane vs proximity to side
      const baseDist = shape.size[1] > 1e-6 ? Math.abs(local[1] + shape.size[1]) / shape.size[1] : 0;
      const radial = Math.sqrt(local[0] * local[0] + local[2] * local[2]);
      const sideDist = shape.size[0] > 1e-6 ? radial / shape.size[0] : 0;
      if (baseDist < sideDist) {
        // Bottom face drag
        return { axisIdx: 1, negative: true, axis: "y" };
      }
      // Side/radius drag
      return { axisIdx: 0, negative: false, axis: "x" };
    }
    case "polygon": {
      // Top/bottom faces → height drag (same as cylinder caps)
      const local = worldToLocal(worldPos, shape);
      const yRatio = shape.size[1] > 1e-6 ? Math.abs(local[1]) / shape.size[1] : 0;
      if (yRatio > 0.5) {
        return { axisIdx: 1, negative: local[1] < 0, axis: "y" };
      }
      // Side face: find closest edge
      const verts = shape.vertices;
      if (verts && verts.length >= 3) {
        let bestEdge = 0;
        let bestDist = Infinity;
        for (let i = 0; i < verts.length; i++) {
          const j = (i + 1) % verts.length;
          const d = pointToEdgeDist2D(local[0], local[2], verts[i], verts[j]);
          if (d < bestDist) {
            bestDist = d;
            bestEdge = i;
          }
        }
        return { axisIdx: 0, negative: false, axis: "x", edgeIdx: bestEdge };
      }
      return { axisIdx: 1, negative: false, axis: "y" };
    }
    default:
      return null;
  }
}
