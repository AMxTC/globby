import { useRef, useEffect, useCallback } from "react";
import { Matrix4 } from "three";
import { useSnapshot } from "valtio";
import { sceneState, type SDFShape } from "./state/sceneStore";
import { GPURenderer, type WireframeBox } from "./gpu/renderer";
import { createOrbitCamera } from "./gpu/orbit";
import { setupPointer } from "./gpu/pointer";
import { BOUNDS, SHAPE_TYPES } from "./constants";
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

        // Disable orbit when actively drawing (base or height phase)
        const drawing = sceneState.drag.phase !== "idle";
        controls.enableRotate =
          !drawing &&
          !(SHAPE_TYPES as readonly string[]).includes(sceneState.activeTool);
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
