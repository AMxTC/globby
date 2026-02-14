/**
 * Centralized hotkey definitions and handler.
 * All global keyboard shortcuts are defined here.
 */

import {
  sceneState,
  sceneRefs,
  selectShape,
  selectAll,
  deleteSelectedShapes,
  cancelDrag,
  setTool,
  isShapeTool,
  enterEditMode,
  exitEditMode,
  undo,
  redo,
  addShape,
  type Vec3,
  type SDFShape,
} from "../state/sceneStore";
import * as THREE from "three";

interface KeyCombo {
  key: string;
  meta?: boolean;
  shift?: boolean;
}

interface HotkeyDef {
  name: string;
  description: string;
  combo: KeyCombo;
  action: () => void;
}

function matchesCombo(e: KeyboardEvent, c: KeyCombo): boolean {
  if (e.key !== c.key && e.key.toLowerCase() !== c.key) return false;
  const mod = e.metaKey || e.ctrlKey;
  if (!!c.meta !== mod) return false;
  if (!!c.shift !== e.shiftKey) return false;
  return true;
}

function isInputFocused(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  // Monaco editor uses contentEditable divs and nested textareas
  if (el.closest('.monaco-editor')) return true;
  return false;
}

let clipboard: Omit<SDFShape, "id" | "layerId">[] = [];

const HOTKEYS: HotkeyDef[] = [
  {
    name: "Undo",
    description: "Undo last action",
    combo: { key: "z", meta: true },
    action: undo,
  },
  {
    name: "Redo",
    description: "Redo last undone action",
    combo: { key: "z", meta: true, shift: true },
    action: redo,
  },
  {
    name: "Select All",
    description: "Select all shapes",
    combo: { key: "a", meta: true },
    action: selectAll,
  },
  {
    name: "Delete",
    description: "Delete selected shapes",
    combo: { key: "Backspace" },
    action: deleteSelectedShapes,
  },
  {
    name: "Delete",
    description: "Delete selected shapes",
    combo: { key: "Delete" },
    action: deleteSelectedShapes,
  },
  {
    name: "Escape",
    description: "Deselect / cancel current action",
    combo: { key: "Escape" },
    action: () => {
      if (sceneState.editMode === "edit") {
        exitEditMode();
      } else if (sceneState.drag.phase !== "idle") {
        cancelDrag();
      } else if (isShapeTool(sceneState.activeTool)) {
        setTool("select");
      } else {
        selectShape(null);
      }
    },
  },
  {
    name: "Tab",
    description: "Toggle object/edit mode",
    combo: { key: "Tab" },
    action: () => {
      if (sceneState.selectedShapeIds.length !== 1) return;
      if (sceneState.editMode === "edit") {
        exitEditMode();
      } else {
        enterEditMode();
      }
    },
  },
  {
    name: "Copy",
    description: "Copy selected shapes",
    combo: { key: "c", meta: true },
    action: () => {
      const ids = sceneState.selectedShapeIds;
      if (ids.length === 0) return;
      clipboard = [];
      for (const id of ids) {
        const shape = sceneState.shapes.find((s) => s.id === id);
        if (!shape) continue;
        clipboard.push({
          type: shape.type,
          position: [...shape.position] as Vec3,
          rotation: [...shape.rotation] as Vec3,
          size: [...shape.size] as Vec3,
          scale: shape.scale,
        });
      }
    },
  },
  {
    name: "Paste",
    description: "Paste shapes to active layer",
    combo: { key: "v", meta: true },
    action: () => {
      if (clipboard.length === 0) return;
      const newIds: string[] = [];
      for (const item of clipboard) {
        addShape({
          ...item,
          position: [item.position[0] + 0.2, item.position[1], item.position[2] + 0.2] as Vec3,
          rotation: [...item.rotation] as Vec3,
          size: [...item.size] as Vec3,
        });
        const last = sceneState.shapes[sceneState.shapes.length - 1];
        if (last) newIds.push(last.id);
      }
      sceneState.selectedShapeIds = newIds;
    },
  },
  {
    name: "Cut",
    description: "Cut selected shapes",
    combo: { key: "x", meta: true },
    action: () => {
      const ids = sceneState.selectedShapeIds;
      if (ids.length === 0) return;
      clipboard = [];
      for (const id of ids) {
        const shape = sceneState.shapes.find((s) => s.id === id);
        if (!shape) continue;
        clipboard.push({
          type: shape.type,
          position: [...shape.position] as Vec3,
          rotation: [...shape.rotation] as Vec3,
          size: [...shape.size] as Vec3,
          scale: shape.scale,
        });
      }
      deleteSelectedShapes();
    },
  },
  {
    name: "Focus",
    description: "Focus camera on selected shapes",
    combo: { key: "f" },
    action: () => {
      const ids = sceneState.selectedShapeIds;
      if (ids.length === 0) return;

      const controls = sceneRefs.controls;
      if (!controls) return;

      // Compute centroid of all selected shapes
      let cx = 0, cy = 0, cz = 0;
      let count = 0;
      for (const id of ids) {
        const shape = sceneState.shapes.find((s) => s.id === id);
        if (!shape) continue;
        cx += shape.position[0];
        cy += shape.position[1];
        cz += shape.position[2];
        count++;
      }
      if (count === 0) return;
      cx /= count; cy /= count; cz /= count;

      const camera = controls.object;
      const delta = new THREE.Vector3(cx, cy, cz).sub(controls.target);

      camera.position.add(delta);
      controls.target.set(cx, cy, cz);
      controls.update();
    },
  },
];

function onKeyDown(e: KeyboardEvent) {
  if (isInputFocused(e)) return;

  for (const hotkey of HOTKEYS) {
    if (matchesCombo(e, hotkey.combo)) {
      e.preventDefault();
      hotkey.action();
      return;
    }
  }
}

export function setupHotkeys(): () => void {
  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}
