import {
  Matrix4,
  Vector4,
  Raycaster,
  Vector2,
  Vector3,
  Plane,
  type PerspectiveCamera,
} from "three";
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
    ((_v4.x / _v4.w) * 0.5 + 0.5) * w,
    (1 - ((_v4.y / _v4.w) * 0.5 + 0.5)) * h,
    true,
  ];
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

/**
 * Build XYZ intrinsic rotation matrix (R = Rz * Ry * Rx).
 * Returns column-major 9 floats: [col0.xyz, col1.xyz, col2.xyz].
 */
export function eulerToMatrix3(rx: number, ry: number, rz: number): number[] {
  const cx = Math.cos(rx),
    sx = Math.sin(rx);
  const cy = Math.cos(ry),
    sy = Math.sin(ry);
  const cz = Math.cos(rz),
    sz = Math.sin(rz);
  return [
    // column 0
    cy * cz,
    cy * sz,
    -sy,
    // column 1
    sx * sy * cz - cx * sz,
    sx * sy * sz + cx * cz,
    sx * cy,
    // column 2
    cx * sy * cz + sx * sz,
    cx * sy * sz - sx * cz,
    cx * cy,
  ];
}

/**
 * Compute world-space AABB half-extents for a rotated+scaled shape.
 * Formula: aabb[i] = sum_j(|R[i][j]| * size[j]) * scale
 */
export function rotatedAABBHalfExtents(
  size: Vec3,
  rotation: Vec3,
  scale: number,
): Vec3 {
  const m = eulerToMatrix3(rotation[0], rotation[1], rotation[2]);
  // m is column-major: m[col*3+row]
  // R row i, col j = m[j*3 + i]
  const hx =
    (Math.abs(m[0]) * size[0] +
      Math.abs(m[3]) * size[1] +
      Math.abs(m[6]) * size[2]) *
    scale;
  const hy =
    (Math.abs(m[1]) * size[0] +
      Math.abs(m[4]) * size[1] +
      Math.abs(m[7]) * size[2]) *
    scale;
  const hz =
    (Math.abs(m[2]) * size[0] +
      Math.abs(m[5]) * size[1] +
      Math.abs(m[8]) * size[2]) *
    scale;
  return [hx, hy, hz];
}

/**
 * Project mouse ray onto an arbitrary axis line through origin.
 * Returns the parameter t along the direction.
 */
export function projectRayOnAxisDir(
  camera: PerspectiveCamera,
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  origin: Vec3,
  direction: Vec3,
): number {
  const rect = canvas.getBoundingClientRect();
  _mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  _mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  _raycaster.setFromCamera(_mouse, camera);

  const ro = _raycaster.ray.origin;
  const rd = _raycaster.ray.direction;

  const axisDir = new Vector3(direction[0], direction[1], direction[2]);
  const o = new Vector3(origin[0], origin[1], origin[2]);

  const w0 = new Vector3().subVectors(ro, o);
  const a = rd.dot(rd);
  const b = rd.dot(axisDir);
  const c = axisDir.dot(axisDir);
  const d = rd.dot(w0);
  const e = axisDir.dot(w0);

  const denom = a * c - b * b;
  if (Math.abs(denom) < 1e-8) return 0;

  return (a * e - b * d) / denom;
}

const _plane = new Plane();
const _intersection = new Vector3();

/**
 * Intersect mouse ray with an arbitrary plane.
 * Returns world-space hit point or null if parallel.
 */
export function projectRayOnPlane(
  camera: PerspectiveCamera,
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  planeOrigin: Vec3,
  planeNormal: Vec3,
): Vec3 | null {
  const rect = canvas.getBoundingClientRect();
  _mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  _mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  _raycaster.setFromCamera(_mouse, camera);

  const normal = new Vector3(planeNormal[0], planeNormal[1], planeNormal[2]);
  const pOrigin = new Vector3(planeOrigin[0], planeOrigin[1], planeOrigin[2]);
  _plane.setFromNormalAndCoplanarPoint(normal, pOrigin);

  const hit = _raycaster.ray.intersectPlane(_plane, _intersection);
  if (!hit) return null;
  return [hit.x, hit.y, hit.z];
}
