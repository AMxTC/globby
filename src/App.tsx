import { useRef, useEffect, useCallback } from "react";
import { Matrix4 } from "three";
import { useSnapshot } from "valtio";
import { sceneState, sceneRefs, type SDFShape } from "./state/sceneStore";
import { GPURenderer, type WireframeBox } from "./gpu/renderer";
import { CHUNK_WORLD_SIZE } from "./constants";
import { createOrbitCamera } from "./gpu/orbit";
import { setupPointer } from "./gpu/pointer";
import Toolbar from "./components/Toolbar";
import SidePanel from "./components/SidePanel";
import GizmoOverlay from "./components/GizmoOverlay";
import { themeState } from "./state/themeStore";
import { setupHotkeys } from "./lib/hotkeys";

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GPURenderer | null>(null);
  const debugHudRef = useRef<HTMLPreElement>(null);
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

      sceneRefs.camera = camera;
      sceneRefs.controls = controls;
      sceneRefs.canvas = canvas!;

      const cleanupHotkeys = setupHotkeys();

      await renderer.init(canvas!);

      if (destroyed) {
        renderer.destroy();
        return;
      }

      rendererRef.current = renderer;

      // Bake initial shapes (the version-based effect may have already fired before init completed)
      renderer.bake(sceneState.shapes as SDFShape[]);

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
      let lastFrameTime = performance.now();
      let fps = 0;
      let frameCount = 0;
      let fpsAccum = 0;

      function frame() {
        if (destroyed) return;

        const now = performance.now();
        const dt = now - lastFrameTime;
        lastFrameTime = now;
        frameCount++;
        fpsAccum += dt;
        if (fpsAccum >= 500) {
          fps = Math.round((frameCount / fpsAccum) * 1000);
          frameCount = 0;
          fpsAccum = 0;
        }

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

        // Show drag preview
        const drag = sceneState.drag;
        if (drag.active) {
          wireframes.push({
            center: [...drag.previewPosition] as [number, number, number],
            halfSize: [...drag.previewSize] as [number, number, number],
            color: wireframeColor,
          });
        }

        // Show selection wireframe
        const selectedId = sceneState.selectedShapeId;
        if (selectedId) {
          const shape = sceneState.shapes.find((s) => s.id === selectedId);
          if (shape) {
            const showPos: [number, number, number] = [
              ...shape.position,
            ] as [number, number, number];
            const showSize: [number, number, number] = [...shape.size] as [
              number,
              number,
              number,
            ];

            // Selection box (white)
            wireframes.push({
              center: showPos,
              halfSize: showSize,
              // white if dark mode, black if light mode
              color:
                themeState.theme === "dark"
                  ? [1, 1, 1, 0.6]
                  : [0.1, 0.1, 0.1, 0.6],
              rotation: [...shape.rotation] as [number, number, number],
              scale: shape.scale,
            });
          }
        }

        // Update SVG gizmo overlay
        sceneRefs.updateGizmoOverlay?.(viewProjMat, canvas!.clientWidth, canvas!.clientHeight);

        // Debug: world bounds (first so it's never dropped) + chunk boundaries
        if (sceneState.showDebugChunks) {
          const bounds = renderer.getDebugWorldBounds();
          const stats = renderer.getDebugChunkStats();
          const bSize = [
            bounds.max[0] - bounds.min[0],
            bounds.max[1] - bounds.min[1],
            bounds.max[2] - bounds.min[2],
          ];
          const bHalf: [number, number, number] = [
            bSize[0] / 2,
            bSize[1] / 2,
            bSize[2] / 2,
          ];

          if (bHalf[0] > 0) {
            wireframes.push({
              center: [
                (bounds.min[0] + bounds.max[0]) / 2,
                (bounds.min[1] + bounds.max[1]) / 2,
                (bounds.min[2] + bounds.max[2]) / 2,
              ],
              halfSize: bHalf,
              color: [1, 0.8, 0, 0.5],
            });
          }

          const half = CHUNK_WORLD_SIZE / 2;
          for (const origin of renderer.getDebugChunkOrigins()) {
            wireframes.push({
              center: [origin[0] + half, origin[1] + half, origin[2] + half],
              halfSize: [half, half, half],
              color: [0.3, 0.6, 1, 0.25],
            });
          }

          // Update debug HUD
          const hud = debugHudRef.current;
          if (hud) {
            const atLimit = stats.used >= stats.max;
            hud.textContent =
              `FPS: ${fps}\n` +
              `Chunks: ${stats.used} / ${stats.max}${atLimit ? " (LIMIT)" : ""}\n` +
              `Bounds: ${bSize[0].toFixed(1)} x ${bSize[1].toFixed(1)} x ${bSize[2].toFixed(1)}`;
            if (atLimit) hud.style.color = "#ff4444";
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
        cleanupHotkeys();
        sceneRefs.camera = null;
        sceneRefs.controls = null;
        sceneRefs.canvas = null;
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
    <div className="w-screen h-screen relative">
      <canvas ref={canvasRef} className="w-full h-full block bg-muted" />
      <GizmoOverlay />
      {snap.showDebugChunks && (
        <pre
          ref={debugHudRef}
          className="fixed top-4 left-4 font-mono text-xs pointer-events-none text-foreground"
        />
      )}
      <Toolbar />
      <SidePanel />
    </div>
  );
}
