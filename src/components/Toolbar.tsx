import { useSnapshot } from "valtio";
import {
  Box,
  Circle,
  Cone,
  Cylinder,
  MousePointer,
  Pyramid,
} from "lucide-react";
import { sceneState, setTool } from "../state/sceneStore";
import type { ShapeType } from "../constants";
import { Toggle } from "./ui/toggle";

function PushPullIcon({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      strokeWidth="1.8"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      stroke="currentColor"
    >
      <g transform="scale(1.1)" transform-origin="center">
        <path
          d="M21 12.353L21 16.647C21 16.8649 20.8819 17.0656 20.6914 17.1715L12.2914 21.8381C12.1102 21.9388 11.8898 21.9388 11.7086 21.8381L3.30861 17.1715C3.11814 17.0656 3 16.8649 3 16.647L2.99998 12.353C2.99998 12.1351 3.11812 11.9344 3.3086 11.8285L11.7086 7.16188C11.8898 7.06121 12.1102 7.06121 12.2914 7.16188L20.6914 11.8285C20.8818 11.9344 21 12.1351 21 12.353Z"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M3.52844 12.2936L11.7086 16.8382C11.8898 16.9388 12.1102 16.9388 12.2914 16.8382L20.5 12.2778"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M12 21.5V17" strokeLinecap="round" strokeLinejoin="round" />
        <path
          d="M12 12V2M12 2L14.5 4.5M12 2L9.5 4.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}

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
      <Toggle
        pressed={snap.activeTool === "pushpull"}
        onPressedChange={() =>
          setTool(snap.activeTool === "pushpull" ? "select" : "pushpull")
        }
        size="icon"
        title="Push/Pull"
      >
        <PushPullIcon size={20} />
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
    </div>
  );
}
