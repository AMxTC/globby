import { useState, useRef, useCallback, useEffect } from "react";
import { cn } from "@/lib/utils";

export interface NumberInputProps {
  value: number;
  onChange: (value: number) => void;
  step?: number;
  precision?: number;
  min?: number;
  max?: number;
  className?: string;
}

export function NumberInput({
  value,
  onChange,
  step = 0.01,
  precision = 2,
  min,
  max,
  className,
}: NumberInputProps) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const elRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const dragAccum = useRef(0);
  const dragStartValue = useRef(0);
  const totalMovement = useRef(0);

  const clamp = useCallback(
    (v: number) => {
      let r = v;
      if (min !== undefined) r = Math.max(min, r);
      if (max !== undefined) r = Math.min(max, r);
      return r;
    },
    [min, max],
  );

  // --- drag-to-scrub ---
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (editing) return;
      e.preventDefault();
      dragging.current = true;
      dragAccum.current = 0;
      dragStartValue.current = value;
      totalMovement.current = 0;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [editing, value],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      totalMovement.current += Math.abs(e.movementX);
      dragAccum.current += e.movementX;
      const steps = dragAccum.current;
      const newValue = clamp(dragStartValue.current + steps * step);
      onChange(parseFloat(newValue.toFixed(precision)));
    },
    [onChange, step, precision, clamp],
  );

  const onPointerUp = useCallback(() => {
    if (!dragging.current) return;
    const wasDrag = totalMovement.current >= 3;
    dragging.current = false;
    if (!wasDrag) {
      // Click-to-type: open edit mode
      setEditText(value.toFixed(precision));
      setEditing(true);
    }
  }, [value, precision]);

  // --- click-to-type ---
  useEffect(() => {
    if (editing) {
      // Wait a tick for the input to mount
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing]);

  function commitEditing() {
    const parsed = parseFloat(editText);
    if (!isNaN(parsed)) {
      onChange(clamp(parsed));
    }
    setEditing(false);
  }

  function cancelEditing() {
    setEditing(false);
  }

  const displayText = value.toFixed(precision);

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={cn(
          "h-6 w-14 text-xs tabular-nums bg-background text-foreground border border-border rounded-sm px-1.5 py-0.5 text-right outline-none focus:ring-1 focus:ring-ring",
          className,
        )}
        value={editText}
        onChange={(e) => setEditText(e.target.value)}
        onBlur={commitEditing}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commitEditing();
          } else if (e.key === "Escape") {
            cancelEditing();
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            const parsed = parseFloat(editText);
            if (!isNaN(parsed)) {
              const newVal = clamp(parsed + step);
              const text = newVal.toFixed(precision);
              setEditText(text);
              onChange(parseFloat(text));
            }
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            const parsed = parseFloat(editText);
            if (!isNaN(parsed)) {
              const newVal = clamp(parsed - step);
              const text = newVal.toFixed(precision);
              setEditText(text);
              onChange(parseFloat(text));
            }
          }
        }}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }

  return (
    <div
      ref={elRef}
      className={cn(
        "h-6 w-14 text-xs tabular-nums bg-background text-muted-foreground border border-border rounded-sm px-1.5 py-0.5 text-right select-none cursor-ew-resize flex items-center justify-end touch-none",
        className,
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {displayText}
    </div>
  );
}
