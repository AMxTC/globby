import { useState, useRef, useCallback, useEffect } from "react";
import { cn } from "@/lib/utils";

export interface FaderProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  onStart?: () => void;
  onCommit?: () => void;
  /** "percent" shows 0–100%, "number" shows the raw value */
  display?: "percent" | "number";
  /** Decimal places for "number" display */
  precision?: number;
  className?: string;
}

export function Fader({
  value,
  min = 0,
  max = 1,
  step = 0.01,
  onChange,
  onStart,
  onCommit,
  display = "percent",
  precision = 2,
  className,
}: FaderProps) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const clamp = useCallback(
    (v: number) => Math.max(min, Math.min(max, v)),
    [min, max],
  );

  const fraction = (value - min) / (max - min);

  // --- drag handling ---
  const valueFromMouse = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track) return value;
      const rect = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const raw = min + ratio * (max - min);
      // snap to step
      return clamp(Math.round(raw / step) * step);
    },
    [min, max, step, clamp, value],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (editing) return;
      e.preventDefault();
      dragging.current = true;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      onStart?.();
      onChange(valueFromMouse(e.clientX));
    },
    [editing, onChange, valueFromMouse, onStart],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      onChange(valueFromMouse(e.clientX));
    },
    [onChange, valueFromMouse],
  );

  const onPointerUp = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    onCommit?.();
  }, [onCommit]);

  // --- inline editing ---
  function startEditing() {
    if (display === "percent") {
      setEditText(String(Math.round(value * 100)));
    } else {
      setEditText(String(parseFloat(value.toFixed(precision))));
    }
    setEditing(true);
  }

  function commitEditing() {
    const parsed = parseFloat(editText);
    if (!isNaN(parsed)) {
      onStart?.();
      if (display === "percent") {
        onChange(clamp(parsed / 100));
      } else {
        onChange(clamp(parsed));
      }
      onCommit?.();
    }
    setEditing(false);
  }

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const displayText =
    display === "percent"
      ? `${Math.round(value * 100)}%`
      : value.toFixed(precision);

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      {/* Track */}
      <div
        ref={trackRef}
        className="relative flex-1 h-4 cursor-ew-resize select-none touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={(e) => {
          e.stopPropagation();
          startEditing();
        }}
      >
        {/* Rail */}
        <div className="absolute top-1/2 -translate-y-1/2 left-0 right-0 h-1 bg-border rounded-full" />
        {/* Fill */}
        <div
          className="absolute top-1/2 -translate-y-1/2 left-0 h-1 bg-primary/60 rounded-full"
          style={{ width: `${fraction * 100}%` }}
        />
        {/* Thumb: horizontal bar */}
        <div
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-1 h-3 bg-foreground rounded-sm"
          style={{ left: `${fraction * 100}%` }}
        />
      </div>

      {/* Value readout / inline edit */}
      {editing ? (
        <input
          ref={inputRef}
          className="w-9 text-[10px] text-foreground bg-background border border-border rounded-sm px-1 py-0.5 text-right outline-none focus:ring-1 focus:ring-ring tabular-nums"
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          onBlur={commitEditing}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitEditing();
            if (e.key === "Escape") setEditing(false);
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span
          className="w-9 text-[10px] text-muted-foreground text-right tabular-nums cursor-text select-none"
          onDoubleClick={(e) => {
            e.stopPropagation();
            startEditing();
          }}
        >
          {displayText}
        </span>
      )}
    </div>
  );
}
