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

  // Multi-finger tap gestures: 2-finger tap = undo, 3-finger tap = redo
  let maxTouches = 0;
  let touchStartTime = 0;
  let startX = 0;
  let startY = 0;
  let moved = false;

  function onTouchStart(e: TouchEvent) {
    if (e.touches.length === 1) {
      // First finger down — reset tracking
      maxTouches = 1;
      touchStartTime = performance.now();
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      moved = false;
    } else {
      maxTouches = Math.max(maxTouches, e.touches.length);
    }
  }

  function onTouchMove(e: TouchEvent) {
    if (moved) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (dx * dx + dy * dy > 100) moved = true; // 10px threshold
  }

  function onTouchEnd(e: TouchEvent) {
    if (e.touches.length > 0) return; // still fingers down
    const elapsed = performance.now() - touchStartTime;
    if (elapsed < 300 && !moved) {
      if (maxTouches === 2) undo();
      else if (maxTouches === 3) redo();
    }
    maxTouches = 0;
  }

  window.addEventListener("touchstart", onTouchStart, { passive: true });
  window.addEventListener("touchmove", onTouchMove, { passive: true });
  window.addEventListener("touchend", onTouchEnd, { passive: true });

  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("touchstart", onTouchStart);
    window.removeEventListener("touchmove", onTouchMove);
    window.removeEventListener("touchend", onTouchEnd);
  };
}
