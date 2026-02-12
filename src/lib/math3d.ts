import { Matrix4, Vector4, Raycaster, Vector2, Vector3, type PerspectiveCamera } from "three";
import type { Vec3 } from "../state/sceneStore";

const _v4 = new Vector4();
const _raycaster = new Raycaster();
const _mouse = new Vector2();

/**
 * Project world position to screen pixels.
 * Returns [screenX, screenY, visible].
 */
export function worldToScreen(
  pos: Vec3,
  vpMat: Matrix4,
  w: number,
  h: number,
): [number, number, boolean] {
  _v4.set(pos[0], pos[1], pos[2], 1.0);
  _v4.applyMatrix4(vpMat);
  if (_v4.w <= 0) return [0, 0, false];
  return [
    (_v4.x / _v4.w * 0.5 + 0.5) * w,
    (1 - (_v4.y / _v4.w * 0.5 + 0.5)) * h,
    true,
  ];
}

/**
 * Project mouse ray onto an axis line through shapePos.
 * Returns the parameter t along the axis.
 */
export function projectRayOnAxis(
  camera: PerspectiveCamera,
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  shapePos: Vec3,
  axis: "x" | "y" | "z",
): number {
  const rect = canvas.getBoundingClientRect();
  _mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  _mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  _raycaster.setFromCamera(_mouse, camera);

  const ro = _raycaster.ray.origin;
  const rd = _raycaster.ray.direction;

  const axisDir = new Vector3(
    axis === "x" ? 1 : 0,
    axis === "y" ? 1 : 0,
    axis === "z" ? 1 : 0,
  );
  const origin = new Vector3(...shapePos);

  const w0 = new Vector3().subVectors(ro, origin);
  const a = rd.dot(rd);
  const b = rd.dot(axisDir);
  const c = axisDir.dot(axisDir);
  const d = rd.dot(w0);
  const e = axisDir.dot(w0);

  const denom = a * c - b * b;
  if (Math.abs(denom) < 1e-8) return 0;

  return (a * e - b * d) / denom;
}

/**
 * Compute a gizmo arm length in world units that appears as a
 * roughly constant screen-pixel size, while still foreshortening
 * properly when viewed down the barrel of an axis.
 *
 * We measure the apparent size of 1 world-unit at `pos` by
 * projecting a small offset perpendicular to the view direction,
 * then scale so the arm is ~targetPx on screen.
 */
export function gizmoWorldLength(
  pos: Vec3,
  vpMat: Matrix4,
  w: number,
  h: number,
  camera: PerspectiveCamera,
  targetPx: number,
): number {
  // Get camera right vector (always perpendicular to view)
  const right = new Vector3();
  right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();

  const probe = 0.1; // small world offset
  const offset: Vec3 = [
    pos[0] + right.x * probe,
    pos[1] + right.y * probe,
    pos[2] + right.z * probe,
  ];
  const [cx, cy] = worldToScreen(pos, vpMat, w, h);
  const [ox, oy] = worldToScreen(offset, vpMat, w, h);
  const screenPer = Math.sqrt((ox - cx) ** 2 + (oy - cy) ** 2);
  if (screenPer < 0.001) return 0.3; // fallback
  // world units per pixel at this depth
  const worldPerPx = probe / screenPer;
  return worldPerPx * targetPx;
}
