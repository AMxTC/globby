import { useRef, useEffect, useCallback } from "react";
import { Matrix4 } from "three";
import { useSnapshot } from "valtio";
import { sceneState, sceneRefs, type SDFShape } from "./state/sceneStore";
import { GPURenderer, type WireframeBox } from "./gpu/renderer";
import { rotatedAABBHalfExtents, polyHalfExtents } from "./lib/math3d";
import { CHUNK_WORLD_SIZE } from "./constants";
import { createOrbitCamera } from "./gpu/orbit";
import { setupPointer } from "./gpu/pointer";
import Toolbar from "./components/Toolbar";
import SidePanel from "./components/SidePanel";
import TranslateGumball from "./components/gizmo/TranslateGumball";
import EditGizmo from "./components/gizmo/EditGizmo";
import PenOverlay from "./components/PenOverlay";
import { themeState } from "./state/themeStore";
import { setupHotkeys } from "./lib/hotkeys";
import { bindCursorCanvas } from "./lib/cursors";
import ContextMenu from "./components/ContextMenu";
import AppMenu from "./components/AppMenu";

function MarqueeOverlay({ marquee }: { marquee: { x1: number; y1: number; x2: number; y2: number } }) {
  const isWindow = marquee.x2 >= marquee.x1;
  const left = Math.min(marquee.x1, marquee.x2);
  const top = Math.min(marquee.y1, marquee.y2);
  const width = Math.abs(marquee.x2 - marquee.x1);
  const height = Math.abs(marquee.y2 - marquee.y1);
  return (
    <div
      className="fixed pointer-events-none z-20"
      style={{
        left, top, width, height,
        border: isWindow ? '1px solid rgba(59,130,246,0.8)' : '1px dashed rgba(59,130,246,0.8)',
        backgroundColor: isWindow ? 'rgba(59,130,246,0.08)' : 'rgba(59,130,246,0.05)',
      }}
    />
  );
}

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
      bindCursorCanvas(canvas!);

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
        if (drag.active && sceneState.activeTool !== "polygon") {
          wireframes.push({
            center: [...drag.previewPosition] as [number, number, number],
            halfSize: [...drag.previewSize] as [number, number, number],
            color: wireframeColor,
          });
        }

        // Show selection wireframe
        const selectedIds = sceneState.selectedShapeIds;
        const selColor: [number, number, number, number] =
          themeState.theme === "light"
            ? [0.1, 0.1, 0.1, 0.6]
            : [1, 1, 1, 0.6];

        if (selectedIds.length === 1) {
          const shape = sceneState.shapes.find((s) => s.id === selectedIds[0]);
          if (shape) {
            const hs: [number, number, number] = shape.vertices && shape.vertices.length > 0
              ? polyHalfExtents(shape.size, shape.vertices) as [number, number, number]
              : [...shape.size] as [number, number, number];
            wireframes.push({
              center: [...shape.position] as [number, number, number],
              halfSize: hs,
              color: selColor,
              rotation: [...shape.rotation] as [number, number, number],
              scale: shape.scale,
            });
          }
        } else if (selectedIds.length > 1) {
          // Compute axis-aligned union AABB
          let minX = Infinity, minY = Infinity, minZ = Infinity;
          let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
          const idSet = new Set(selectedIds);
          for (const shape of sceneState.shapes) {
            if (!idSet.has(shape.id)) continue;
            const he = rotatedAABBHalfExtents(shape.size, shape.rotation, shape.scale, shape.vertices);
            minX = Math.min(minX, shape.position[0] - he[0]);
            minY = Math.min(minY, shape.position[1] - he[1]);
            minZ = Math.min(minZ, shape.position[2] - he[2]);
            maxX = Math.max(maxX, shape.position[0] + he[0]);
            maxY = Math.max(maxY, shape.position[1] + he[1]);
            maxZ = Math.max(maxZ, shape.position[2] + he[2]);
          }
          if (minX < Infinity) {
            wireframes.push({
              center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
              halfSize: [(maxX - minX) / 2, (maxY - minY) / 2, (maxZ - minZ) / 2],
              color: selColor,
            });
          }
        }

        // Pen tool wireframe preview
        const extraLines: { verts: Float32Array; color: [number, number, number, number] }[] = [];
        const penVerts = sceneState.penVertices;
        if (penVerts.length >= 2) {
          const floorY = sceneState.penFloorY + 0.001; // slight offset to avoid z-fighting
          // Build line segments between consecutive vertices
          const isHeightPhase = sceneState.drag.phase === "height";
          const segCount = isHeightPhase ? penVerts.length : penVerts.length - 1;
          const verts = new Float32Array(segCount * 2 * 3);
          for (let i = 0; i < segCount; i++) {
            const j = (i + 1) % penVerts.length;
            verts[i * 6 + 0] = penVerts[i][0];
            verts[i * 6 + 1] = floorY;
            verts[i * 6 + 2] = penVerts[i][1];
            verts[i * 6 + 3] = penVerts[j][0];
            verts[i * 6 + 4] = floorY;
            verts[i * 6 + 5] = penVerts[j][1];
          }
          extraLines.push({ verts, color: wireframeColor });
        }

        // Update SVG overlays
        sceneRefs.updateTranslateGumball?.(viewProjMat, canvas!.clientWidth, canvas!.clientHeight);
        sceneRefs.updateEditGizmo?.(viewProjMat, canvas!.clientWidth, canvas!.clientHeight);
        sceneRefs.updatePenOverlay?.(viewProjMat, canvas!.clientWidth, canvas!.clientHeight);

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
          extraLines,
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
      <TranslateGumball />
      <EditGizmo />
      <PenOverlay />
      {snap.showDebugChunks && (
        <pre
          ref={debugHudRef}
          className="fixed top-4 left-4 font-mono text-xs pointer-events-none text-foreground"
        />
      )}
      {snap.marquee && <MarqueeOverlay marquee={snap.marquee} />}
      <AppMenu />
      <Toolbar />
      <SidePanel />
      <ContextMenu />
    </div>
  );
}
