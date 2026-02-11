import { useRef, useEffect, useCallback } from "react";
import { Matrix4 } from "three";
import { useSnapshot } from "valtio";
import { sceneState, type SDFShape } from "./state/sceneStore";
import { GPURenderer, type WireframeBox } from "./gpu/renderer";
import { createOrbitCamera } from "./gpu/orbit";
import { setupPointer } from "./gpu/pointer";
import { BOUNDS } from "./constants";
import Toolbar from "./components/Toolbar";

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GPURenderer | null>(null);
  const snap = useSnapshot(sceneState);

  // Init WebGPU renderer + camera + controls
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let animId = 0;
    let destroyed = false;

    async function setup() {
      // Size canvas before creating camera/controls (they read dimensions)
      const dpr = window.devicePixelRatio;
      canvas!.width = canvas!.clientWidth * dpr;
      canvas!.height = canvas!.clientHeight * dpr;

      const renderer = new GPURenderer();
      const { camera, controls } = createOrbitCamera(canvas!);
      const cleanupPointer = setupPointer(
        canvas!,
        camera,
        () => rendererRef.current,
      );

      await renderer.init(canvas!);

      if (destroyed) {
        renderer.destroy();
        return;
      }

      rendererRef.current = renderer;

      function onResize() {
        const d = window.devicePixelRatio;
        const w = canvas!.clientWidth * d;
        const h = canvas!.clientHeight * d;
        renderer.resize(w, h);
        camera.aspect = canvas!.clientWidth / canvas!.clientHeight;
        camera.updateProjectionMatrix();
      }
      window.addEventListener("resize", onResize);

      const viewProjMat = new Matrix4();

      function frame() {
        if (destroyed) return;

        controls.update();

        // Get camera matrices
        camera.updateMatrixWorld();
        const matWorld = camera.matrixWorld.elements;
        const matProjInv = camera.projectionMatrixInverse.elements;

        // viewProj = projectionMatrix * matrixWorldInverse
        viewProjMat.multiplyMatrices(
          camera.projectionMatrix,
          camera.matrixWorldInverse,
        );

        // Build wireframe list
        const wireframes: WireframeBox[] = [];

        const wireframeColor: [number, number, number, number] = [
          1, 0.03, 0.54, 0.8,
        ];

        // Always show bounds box
        wireframes.push({
          center: [0, 0, 0],
          halfSize: [BOUNDS, BOUNDS, BOUNDS],
          color: wireframeColor,
        });

        // Show drag preview
        const drag = sceneState.drag;
        if (drag.active) {
          wireframes.push({
            center: [...drag.previewPosition] as [number, number, number],
            halfSize: [...drag.previewSize] as [number, number, number],
            color: wireframeColor,
          });
        }

        // Show selection wireframe + gizmo axes
        const selectedId = sceneState.selectedShapeId;
        if (selectedId) {
          const shape = sceneState.shapes.find((s) => s.id === selectedId);
          if (shape) {
            const gizmo = sceneState.gizmoDrag;
            const showPos: [number, number, number] = gizmo.active && gizmo.shapeId === selectedId
              ? [...gizmo.previewPos] as [number, number, number]
              : [...shape.position] as [number, number, number];
            const showSize: [number, number, number] = [...shape.size] as [number, number, number];

            // Selection box (white)
            wireframes.push({
              center: showPos,
              halfSize: showSize,
              color: [1, 1, 1, 0.6],
            });

            // Gizmo axes: thin elongated boxes
            const gizmoLen = 0.3;
            const gizmoThick = 0.005;

            // X axis (red)
            wireframes.push({
              center: [showPos[0] + gizmoLen / 2, showPos[1], showPos[2]],
              halfSize: [gizmoLen / 2, gizmoThick, gizmoThick],
              color: [1, 0.2, 0.2, 1],
            });

            // Y axis (green)
            wireframes.push({
              center: [showPos[0], showPos[1] + gizmoLen / 2, showPos[2]],
              halfSize: [gizmoThick, gizmoLen / 2, gizmoThick],
              color: [0.2, 1, 0.2, 1],
            });

            // Z axis (blue)
            wireframes.push({
              center: [showPos[0], showPos[1], showPos[2] + gizmoLen / 2],
              halfSize: [gizmoThick, gizmoThick, gizmoLen / 2],
              color: [0.3, 0.3, 1, 1],
            });
          }
        }

        renderer.render(
          new Float32Array(matWorld),
          new Float32Array(matProjInv),
          new Float32Array(viewProjMat.elements),
          canvas!.width,
          canvas!.height,
          wireframes,
        );

        animId = requestAnimationFrame(frame);
      }
      animId = requestAnimationFrame(frame);

      return () => {
        destroyed = true;
        cancelAnimationFrame(animId);
        window.removeEventListener("resize", onResize);
        cleanupPointer();
        controls.dispose();
        renderer.destroy();
      };
    }

    let cleanup: (() => void) | undefined;
    setup().then((c) => {
      cleanup = c;
    });

    return () => {
      destroyed = true;
      cancelAnimationFrame(animId);
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rebake when shapes change
  const version = snap.version;
  const shapes = snap.shapes;
  const bake = useCallback(() => {
    rendererRef.current?.bake(shapes as SDFShape[]);
  }, [shapes]);

  useEffect(() => {
    bake();
  }, [version, bake]);

  return (
    <div className="w-screen h-screen">
      <canvas ref={canvasRef} className="w-full h-full block bg-muted" />
      <Toolbar />
    </div>
  );
}
