import { useSnapshot } from "valtio";
import {
  Box,
  Circle,
  Cone,
  Cylinder,
  Eye,
  Grid3x3,
  Layers,
  MousePointer,
  Pyramid,
} from "lucide-react";
import { sceneState, setTool } from "../state/sceneStore";
import type { ShapeType } from "../constants";
import { Toggle } from "./ui/toggle";
import ThemeToggle from "./ThemeToggle";

const PRIMITIVES: { type: ShapeType; icon: typeof Box; title: string }[] = [
  { type: "box", icon: Box, title: "Box" },
  { type: "sphere", icon: Circle, title: "Sphere" },
  { type: "cylinder", icon: Cylinder, title: "Cylinder" },
  { type: "pyramid", icon: Pyramid, title: "Pyramid" },
  { type: "cone", icon: Cone, title: "Cone" },
];

export default function Toolbar() {
  const snap = useSnapshot(sceneState);

  return (
    <div className="bg-accent fixed bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-1 p-1.5 z-100">
      <Toggle
        pressed={snap.activeTool === "select"}
        onPressedChange={() =>
          setTool(snap.activeTool === "select" ? "select" : "select")
        }
        size="icon"
        title="Select/Move"
      >
        <MousePointer size={20} />
      </Toggle>
      <div className="w-px h-6 bg-border mx-1" />
      {PRIMITIVES.map((t) => (
        <Toggle
          key={t.type}
          pressed={snap.activeTool === t.type}
          onPressedChange={() =>
            setTool(snap.activeTool === t.type ? "select" : t.type)
          }
          size="icon"
          title={t.title}
        >
          <t.icon size={20} />
        </Toggle>
      ))}

      <div className="w-px h-6 bg-border mx-1" />

      <Toggle
        pressed={snap.showDebugChunks}
        onPressedChange={() => {
          sceneState.showDebugChunks = !sceneState.showDebugChunks;
        }}
        size="icon"
        title="Debug Chunks"
      >
        <Grid3x3 size={20} />
      </Toggle>

      <Toggle
        pressed={snap.showGroundPlane}
        onPressedChange={() => {
          sceneState.showGroundPlane = !sceneState.showGroundPlane;
        }}
        size="icon"
        title="Ground Shadows"
      >
        <Layers size={20} />
      </Toggle>

      <Toggle
        pressed={snap.renderMode !== 0}
        onPressedChange={() => {
          sceneState.renderMode = ((snap.renderMode + 1) % 5) as 0 | 1 | 2 | 3 | 4;
        }}
        size="icon"
        title={["Render: Lit", "Render: Depth", "Render: Normals", "Render: Shape ID", "Render: Iterations"][snap.renderMode]}
      >
        <div className="relative">
          <Eye size={20} />
          {snap.renderMode !== 0 && (
            <span className="absolute -top-1 -right-1.5 text-[8px] font-bold leading-none">
              {["", "Z", "N", "ID", "It"][snap.renderMode]}
            </span>
          )}
        </div>
      </Toggle>

      <div className="w-px h-6 bg-border mx-1" />

      <ThemeToggle />
    </div>
  );
}
