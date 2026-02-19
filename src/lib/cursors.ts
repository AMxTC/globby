/**
 * Centralized cursor management.
 *
 * Each cursor is defined once here. To add a new cursor:
 *   1. Add an entry to CURSOR_SVGS (inline SVG string, 24x24)
 *   2. It will be auto-converted to a data URI in CURSORS
 *   3. Call setCursor() with the new name
 *
 * For built-in CSS cursors, add directly to CURSORS instead.
 */

import { subscribe } from "valtio";
import { sceneState, isShapeTool } from "../state/sceneStore";
import crosshairSvg from "../assets/cursors/crosshair.svg?raw";
import orbitSvg from "../assets/cursors/orbit.svg?raw";
import pushPull from "../assets/cursors/pushpull.svg?raw";
import mousePointer from "../assets/cursors/mousePointer.svg?raw";

function svgToDataUri(svg: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

const mousePointerInverted = mousePointer
  .replace(/fill:white/g, "fill:__BLACK__")
  .replace(/stroke:black/g, "stroke:white")
  .replace(/fill:__BLACK__/g, "fill:black");

export type CursorName = keyof typeof CURSORS;

function scaledCursor(
  svg: string,
  size: number,
  hotspot: [number, number],
  fallback = "default",
  shadow?: {
    dx?: number;
    dy?: number;
    blur?: number;
    color?: string;
    opacity?: number;
  },
): string {
  let scaled = svg
    .replace(/\bwidth="[\d.]+"/, `width="${size}"`)
    .replace(/\bheight="[\d.]+"/, `height="${size}"`);
  if (shadow) {
    const { dx = 1, dy = 1, blur = 2, color = "black", opacity = 0.4 } = shadow;
    const filter = `<defs><filter id="ds" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="${dx}" dy="${dy}" stdDeviation="${blur}" flood-color="${color}" flood-opacity="${opacity}"/></filter></defs>`;
    const groupWrap = (inner: string) =>
      inner
        .replace(/(<svg[^>]*>)/, `$1${filter}<g filter="url(#ds)">`)
        .replace(/<\/svg>/, "</g></svg>");
    scaled = groupWrap(scaled);
  }
  return `${svgToDataUri(scaled)} ${hotspot[0]} ${hotspot[1]}, ${fallback}`;
}

const SHADOW = { dx: 1, dy: 1, blur: 2, color: "black", opacity: 0.4 };

const ARROW_SVG = (angleDeg: number, outer: string, inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><defs><filter id="ds" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="${SHADOW.dx}" dy="${SHADOW.dy}" stdDeviation="${SHADOW.blur}" flood-color="${SHADOW.color}" flood-opacity="${SHADOW.opacity}"/></filter></defs><g filter="url(#ds)" transform="rotate(${angleDeg}, 12, 12)"><line x1="12" y1="20" x2="12" y2="5" stroke="${outer}" stroke-width="3" stroke-linecap="round"/><polyline points="7,10 12,4 17,10" fill="none" stroke="${outer}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="20" x2="12" y2="5" stroke="${inner}" stroke-width="1.5" stroke-linecap="round"/><polyline points="7,10 12,4 17,10" fill="none" stroke="${inner}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`;

/** Rotated arrow cursor for active push/pull drag (white on black). */
export function makePushPullArrowCursor(angleDeg: number): string {
  return `${svgToDataUri(ARROW_SVG(angleDeg, "white", "black"))} 12 12, default`;
}

/** Rotated arrow cursor for push/pull hover preview (black on white). */
export function makeHoverArrowCursor(angleDeg: number): string {
  return `${svgToDataUri(ARROW_SVG(angleDeg, "black", "white"))} 12 12, default`;
}

const PUSHPULL_DOT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><defs><filter id="ds" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="${SHADOW.dx}" dy="${SHADOW.dy}" stdDeviation="${SHADOW.blur}" flood-color="${SHADOW.color}" flood-opacity="${SHADOW.opacity}"/></filter></defs><circle cx="12" cy="12" r="2.5" fill="white" stroke="black" stroke-width="1.0" filter="url(#ds)"/></svg>`;

export const CURSORS = {
  default: "default",
  crosshair: `${svgToDataUri(crosshairSvg)} 12 12, crosshair`,
  grab: "grab",
  grabbing: "grabbing",
  orbit: scaledCursor(orbitSvg, 22, [12, 12], "grab", SHADOW),
  pushpullDot: `${svgToDataUri(PUSHPULL_DOT_SVG)} 12 12, default`,
  mousePointer: scaledCursor(mousePointer, 24, [1, 1], "crosshair", SHADOW),
  mousePointerInverted: scaledCursor(
    mousePointerInverted,
    24,
    [1, 1],
    "crosshair",
    SHADOW,
  ),
} as const;

let currentCanvas: HTMLCanvasElement | null = null;
let override: CursorName | null = null;
let rawOverride: string | null = null;

/** Bind the canvas element (call once on setup). */
export function bindCursorCanvas(canvas: HTMLCanvasElement) {
  currentCanvas = canvas;
  applyToolCursor();
}

/** Override the cursor with an arbitrary CSS cursor string. Takes priority over everything. */
export function setRawCursor(css: string | null) {
  rawOverride = css;
  if (currentCanvas) {
    currentCanvas.style.cursor =
      rawOverride ?? (override ? CURSORS[override] : toolCursor());
  }
}

/** Temporarily override the cursor (e.g. during orbit/pan). Call with null to clear. */
export function setCursor(name: CursorName | null) {
  override = name;
  if (rawOverride || !currentCanvas) return;
  currentCanvas.style.cursor = override ? CURSORS[override] : toolCursor();
}

function toolCursor(): string {
  if (sceneState.activeTool === "pushpull") return CURSORS.pushpullDot;
  if (sceneState.editMode === "edit") return CURSORS.mousePointer;

  return isShapeTool(sceneState.activeTool)
    ? CURSORS.crosshair
    : CURSORS.default;
}

let prevTool = sceneState.activeTool;
let prevEditMode = sceneState.editMode;

function applyToolCursor() {
  if (!currentCanvas) return;
  const toolChanged =
    sceneState.activeTool !== prevTool || sceneState.editMode !== prevEditMode;
  prevTool = sceneState.activeTool;
  prevEditMode = sceneState.editMode;
  if (toolChanged) rawOverride = null;
  if (rawOverride || override) return;
  currentCanvas.style.cursor = toolCursor();
}

// React to tool changes
subscribe(sceneState, applyToolCursor);
