/**
 * Centralized hotkey definitions and handler.
 * All global keyboard shortcuts are defined here.
 */

import {
  sceneState,
  sceneRefs,
  selectShape,
  deleteSelectedShape,
  cancelDrag,
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
  const tag = (e.target as HTMLElement)?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA";
}

let clipboard: Omit<SDFShape, "id" | "layerId"> | null = null;

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
    name: "Delete",
    description: "Delete selected shape",
    combo: { key: "Backspace" },
    action: deleteSelectedShape,
  },
  {
    name: "Delete",
    description: "Delete selected shape",
    combo: { key: "Delete" },
    action: deleteSelectedShape,
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
      if (!sceneState.selectedShapeId) return;
      if (sceneState.editMode === "edit") {
        exitEditMode();
      } else {
        enterEditMode();
      }
    },
  },
  {
    name: "Copy",
    description: "Copy selected shape",
    combo: { key: "c", meta: true },
    action: () => {
      const id = sceneState.selectedShapeId;
      if (!id) return;
      const shape = sceneState.shapes.find((s) => s.id === id);
      if (!shape) return;
      clipboard = {
        type: shape.type,
        position: [...shape.position] as Vec3,
        rotation: [...shape.rotation] as Vec3,
        size: [...shape.size] as Vec3,
        scale: shape.scale,
      };
    },
  },
  {
    name: "Paste",
    description: "Paste shape to active layer",
    combo: { key: "v", meta: true },
    action: () => {
      if (!clipboard) return;
      addShape({
        ...clipboard,
        position: [...clipboard.position] as Vec3,
        rotation: [...clipboard.rotation] as Vec3,
        size: [...clipboard.size] as Vec3,
      });
      // Select the newly pasted shape (it's the last one)
      const last = sceneState.shapes[sceneState.shapes.length - 1];
      if (last) sceneState.selectedShapeId = last.id;
    },
  },
  {
    name: "Cut",
    description: "Cut selected shape",
    combo: { key: "x", meta: true },
    action: () => {
      const id = sceneState.selectedShapeId;
      if (!id) return;
      const shape = sceneState.shapes.find((s) => s.id === id);
      if (!shape) return;
      clipboard = {
        type: shape.type,
        position: [...shape.position] as Vec3,
        rotation: [...shape.rotation] as Vec3,
        size: [...shape.size] as Vec3,
        scale: shape.scale,
      };
      deleteSelectedShape();
    },
  },
  {
    name: "Focus",
    description: "Focus camera on selected shape",
    combo: { key: "f" },
    action: () => {
      const id = sceneState.selectedShapeId;
      if (!id) return;

      const shape = sceneState.shapes.find((s) => s.id === id);
      if (!shape) return;

      const controls = sceneRefs.controls;
      if (!controls) return;

      const camera = controls.object;
      const [x, y, z] = shape.position;
      const delta = new THREE.Vector3(x, y, z).sub(controls.target);

      camera.position.add(delta);
      controls.target.set(x, y, z);
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
