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
import pushPull from "../assets/cursors/pushPull.svg?raw";
import mousePointer from "../assets/cursors/mousePointer.svg?raw";

function svgToDataUri(svg: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

const mousePointerInverted = mousePointer
  .replace(/fill:white/g, "fill:__BLACK__")
  .replace(/stroke:black/g, "stroke:white")
  .replace(/fill:__BLACK__/g, "fill:black");

export type CursorName = keyof typeof CURSORS;

export const CURSORS = {
  default: "default",
  crosshair: `${svgToDataUri(crosshairSvg)} 12 12, crosshair`,
  grab: "grab",
  grabbing: "grabbing",
  orbit: `${svgToDataUri(orbitSvg)} 12 12, default`,
  pushpull: `${svgToDataUri(pushPull)} 12 12, default`,
  mousePointer: `${svgToDataUri(mousePointer)} 1 1, default`,
  mousePointerInverted: `${svgToDataUri(mousePointerInverted)} 1 1, default`,
} as const;

let currentCanvas: HTMLCanvasElement | null = null;
let override: CursorName | null = null;

/** Bind the canvas element (call once on setup). */
export function bindCursorCanvas(canvas: HTMLCanvasElement) {
  currentCanvas = canvas;
  applyToolCursor();
}

/** Temporarily override the cursor (e.g. during orbit/pan). Call with null to clear. */
export function setCursor(name: CursorName | null) {
  override = name;
  if (currentCanvas) {
    currentCanvas.style.cursor = override ? CURSORS[override] : toolCursor();
  }
}

function toolCursor(): string {
  if (sceneState.activeTool === "pushpull") return CURSORS.pushpull;
  if (sceneState.editMode === "edit") return CURSORS.mousePointer;

  return isShapeTool(sceneState.activeTool)
    ? CURSORS.crosshair
    : CURSORS.default;
}

function applyToolCursor() {
  if (!currentCanvas || override) return;
  currentCanvas.style.cursor = toolCursor();
}

// React to tool changes
subscribe(sceneState, applyToolCursor);
