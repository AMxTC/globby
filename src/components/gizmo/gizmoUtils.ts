import type { Vec3 } from "../../state/sceneStore";
import { eulerToMatrix3 } from "../../lib/math3d";

export const AXIS_COLORS = { x: "#ef4444", y: "#22c55e", z: "#3b82f6" } as const;
export const AXES: Array<"x" | "y" | "z"> = ["x", "y", "z"];

/** Compute local axes from shape rotation */
export function getLocalAxes(rotation: Vec3): Vec3[] {
  const m = eulerToMatrix3(rotation[0], rotation[1], rotation[2]);
  return [
    [m[0], m[1], m[2]], // local X
    [m[3], m[4], m[5]], // local Y
    [m[6], m[7], m[8]], // local Z
  ];
}

export function addHoverBrightness(trigger: SVGElement, targets: SVGElement[]) {
  trigger.addEventListener("pointerenter", () => {
    for (const t of targets) t.style.filter = "brightness(1.6)";
  });
  trigger.addEventListener("pointerleave", () => {
    for (const t of targets) t.style.filter = "";
  });
}

export function createSvgEl<K extends keyof SVGElementTagNameMap>(
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

export function setLineAttrs(
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
