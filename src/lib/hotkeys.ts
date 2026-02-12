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
  cancelGizmoDrag,
  undo,
  redo,
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
      if (sceneState.gizmoDrag.active) {
        cancelGizmoDrag();
      } else if (sceneState.drag.phase !== "idle") {
        cancelDrag();
      } else {
        selectShape(null);
      }
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
