import { PerspectiveCamera, MOUSE } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { setCursor } from "../lib/cursors";

export function createOrbitCamera(canvas: HTMLCanvasElement) {
  const camera = new PerspectiveCamera(
    50,
    canvas.clientWidth / canvas.clientHeight,
    0.1,
    100,
  );
  camera.position.set(3, 2, -3);
  camera.lookAt(0, 0, 0);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  // Right-click = orbit, Shift+right-click = pan, left-click reserved for tools
  controls.mouseButtons = {
    LEFT: null as unknown as MOUSE,
    MIDDLE: MOUSE.DOLLY,
    RIGHT: MOUSE.ROTATE,
  };

  // Defer orbit/pan cursor until actual mouse movement after right-click
  let pendingRightCursor: "orbit" | "grabbing" | null = null;

  function onMouseDown(e: MouseEvent) {
    if (e.button === 2 && e.shiftKey) {
      controls.mouseButtons.RIGHT = MOUSE.PAN;
      pendingRightCursor = "grabbing";
    } else if (e.button === 2) {
      pendingRightCursor = "orbit";
    }
  }
  function onMouseMove() {
    if (pendingRightCursor) {
      setCursor(pendingRightCursor);
      pendingRightCursor = null;
    }
  }
  function onMouseUp(e: MouseEvent) {
    if (e.button === 2) {
      pendingRightCursor = null;
      controls.mouseButtons.RIGHT = MOUSE.ROTATE;
      setCursor(null);
    }
  }
  canvas.addEventListener("mousedown", onMouseDown);
  canvas.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("mouseup", onMouseUp);

  const origDispose = controls.dispose.bind(controls);
  controls.dispose = () => {
    canvas.removeEventListener("mousedown", onMouseDown);
    canvas.removeEventListener("mousemove", onMouseMove);
    canvas.removeEventListener("mouseup", onMouseUp);
    origDispose();
  };

  return { camera, controls };
}
