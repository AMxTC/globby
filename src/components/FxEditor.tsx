import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import Editor from "@monaco-editor/react";
import { useSnapshot } from "valtio";
import { themeState } from "../state/themeStore";
import { Fader } from "./ui/fader";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Vec3 } from "../state/sceneStore";

// --- Preset definitions ---
// Presets now emit static WGSL referencing fx_params.x/y/z.
// Slider changes only update the runtime buffer (no recompile).

interface PresetParam {
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number; // user-facing value in [min, max]
  display: "number" | "percent";
  precision?: number;
}

interface Preset {
  id: string;
  label: string;
  params: PresetParam[]; // up to 3 params mapped to fx_params.x/y/z
  code: string;          // static WGSL string using fx_params
}

/** Convert a user-facing value to normalized [0, 1] for GPU buffer. */
function normalizeParam(value: number, param: PresetParam): number {
  if (param.max === param.min) return 0;
  return (value - param.min) / (param.max - param.min);
}

/** Convert a normalized [0, 1] GPU value back to user-facing range. */
function denormalizeParam(norm: number, param: PresetParam): number {
  return param.min + norm * (param.max - param.min);
}

const PRESETS: Preset[] = [
  {
    id: "onion",
    label: "Onion",
    params: [
      { label: "Thickness", min: 0.01, max: 0.5, step: 0.005, defaultValue: 0.05, display: "number", precision: 3 },
    ],
    code: `return abs(distance) - fx_params.x * 0.5;`,
  },
  {
    id: "inflate",
    label: "Inflate (Round)",
    params: [
      { label: "Radius", min: 0.0, max: 0.5, step: 0.005, defaultValue: 0.05, display: "number", precision: 3 },
    ],
    code: `return distance - fx_params.x * 0.5;`,
  },
  {
    id: "sin_displace",
    label: "Sin Displacement",
    params: [
      { label: "Amplitude", min: 0.0, max: 0.3, step: 0.005, defaultValue: 0.04, display: "number", precision: 3 },
      { label: "Frequency", min: 1.0, max: 80.0, step: 0.5, defaultValue: 20.0, display: "number", precision: 1 },
    ],
    code: `let freq = fx_params.y * 80.0;
let disp = sin(p.x * freq) * sin(p.y * freq) * sin(p.z * freq) * fx_params.x * 0.3;
return distance + disp;`,
  },
  {
    id: "perlin_displace",
    label: "Perlin Displacement",
    params: [
      { label: "Amplitude", min: 0.0, max: 0.5, step: 0.005, defaultValue: 0.08, display: "number", precision: 3 },
      { label: "Scale", min: 1.0, max: 40.0, step: 0.5, defaultValue: 8.0, display: "number", precision: 1 },
    ],
    code: `return distance + perlin(p * fx_params.y * 40.0) * fx_params.x * 0.5;`,
  },
  {
    id: "perlin_diff",
    label: "Perlin Carve",
    params: [
      { label: "Depth", min: 0.0, max: 0.5, step: 0.005, defaultValue: 0.1, display: "number", precision: 3 },
      { label: "Scale", min: 1.0, max: 40.0, step: 0.5, defaultValue: 6.0, display: "number", precision: 1 },
      { label: "Smoothness", min: 0.0, max: 0.2, step: 0.005, defaultValue: 0.02, display: "number", precision: 3 },
    ],
    code: `let carve = perlin(p * fx_params.y * 40.0) * fx_params.x * 0.5;
let sm = fx_params.z * 0.2;
let h = clamp(0.5 - 0.5 * (distance + carve) / max(sm, 0.0001), 0.0, 1.0);
return mix(distance, -carve, h) + sm * h * (1.0 - h);`,
  },
  {
    id: "perlin_subtract",
    label: "Perlin Subtract",
    params: [
      { label: "Depth", min: 0.0, max: 0.5, step: 0.005, defaultValue: 0.1, display: "number", precision: 3 },
      { label: "Scale", min: 1.0, max: 40.0, step: 0.5, defaultValue: 6.0, display: "number", precision: 1 },
      { label: "Smoothness", min: 0.0, max: 0.2, step: 0.005, defaultValue: 0.02, display: "number", precision: 3 },
    ],
    code: `let n = perlin(p * fx_params.y * 40.0) * fx_params.x * 0.5;
let sm = fx_params.z * 0.2;
let h = clamp(0.5 + 0.5 * (distance + n) / max(sm, 0.0001), 0.0, 1.0);
return mix(-n, distance, h) - sm * h * (1.0 - h);`,
  },
];

/** Try to detect which preset a code string matches. */
function detectPreset(code: string): string | null {
  const trimmed = code.trim();
  for (const preset of PRESETS) {
    if (preset.code.trim() === trimmed) return preset.id;
  }
  return null;
}

// --- Component ---

interface FxEditorProps {
  code: string;
  onChange: (code: string) => void;
  fxParams: Vec3;
  onFxParamsChange: (params: Vec3) => void;
  error: string | null;
  readOnly?: boolean;
}

export function FxEditor({ code, onChange, fxParams, onFxParamsChange, error, readOnly }: FxEditorProps) {
  const { theme } = useSnapshot(themeState);
  const [localCode, setLocalCode] = useState(code);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Detect initial preset from code
  const detectedId = useMemo(() => detectPreset(code), [code]);
  const [selectedPreset, setSelectedPreset] = useState<string>(
    detectedId ?? "custom",
  );
  const [showCode, setShowCode] = useState(false);

  // Sync when external code changes (undo/redo, toggle)
  useEffect(() => {
    setLocalCode(code);
    const det = detectPreset(code);
    if (det) {
      setSelectedPreset(det);
    } else {
      setSelectedPreset("custom");
    }
  }, [code]);

  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      if (readOnly) return;
      const v = value ?? "";
      setLocalCode(v);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        onChangeRef.current(v);
      }, 500);
    },
    [readOnly],
  );

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const activePreset = PRESETS.find((p) => p.id === selectedPreset);

  // Convert normalized fxParams to user-facing values for sliders
  const paramDisplayValues = useMemo(() => {
    if (!activePreset) return [];
    return activePreset.params.map((param, idx) =>
      denormalizeParam(fxParams[idx] ?? 0, param),
    );
  }, [activePreset, fxParams]);

  function handlePresetChange(presetId: string) {
    setSelectedPreset(presetId);
    setShowCode(false);
    if (presetId === "custom") return;
    const preset = PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    // Set the static code (triggers one-time recompile if code changed)
    onChange(preset.code);
    // Set default param values (normalized to 0-1)
    const defaults: Vec3 = [0, 0, 0];
    for (let i = 0; i < preset.params.length; i++) {
      defaults[i] = normalizeParam(preset.params[i].defaultValue, preset.params[i]);
    }
    onFxParamsChange(defaults);
  }

  function handleParamChange(idx: number, userValue: number) {
    if (!activePreset) return;
    const norm = normalizeParam(userValue, activePreset.params[idx]);
    const next: Vec3 = [...fxParams];
    next[idx] = Math.max(0, Math.min(1, norm));
    onFxParamsChange(next);
  }

  return (
    <div className="space-y-1.5">
      {/* Preset dropdown */}
      {!readOnly && (
        <select
          className="w-full text-xs bg-background text-foreground rounded-sm border border-border px-1.5 py-1 outline-none focus:ring-1 focus:ring-ring cursor-pointer"
          value={selectedPreset}
          onChange={(e) => handlePresetChange(e.target.value)}
        >
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          <option value="custom">Custom</option>
        </select>
      )}

      {/* Preset sliders */}
      {activePreset && !readOnly && (
        <div className="space-y-1.5">
          {activePreset.params.map((param, idx) => (
            <div key={param.label} className="flex items-center gap-2">
              <label className="text-[11px] text-muted-foreground w-16 shrink-0 truncate" title={param.label}>
                {param.label}
              </label>
              <Fader
                value={paramDisplayValues[idx] ?? param.defaultValue}
                min={param.min}
                max={param.max}
                step={param.step}
                onChange={(v) => handleParamChange(idx, v)}
                display={param.display}
                precision={param.precision}
                className="flex-1"
              />
            </div>
          ))}

          {/* Show code toggle */}
          <button
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setShowCode(!showCode)}
          >
            <ChevronRight
              size={10}
              className={cn("transition-transform", showCode && "rotate-90")}
            />
            <span>View code</span>
          </button>
          {showCode && activePreset.code && (
            <pre className="text-[10px] text-muted-foreground bg-muted/50 rounded-sm px-2 py-1.5 whitespace-pre-wrap break-words max-h-32 overflow-auto font-mono">
              {activePreset.code}
            </pre>
          )}
        </div>
      )}

      {/* Custom code editor */}
      {(selectedPreset === "custom" || readOnly) && (
        <div
          className={
            readOnly
              ? "rounded-sm overflow-hidden opacity-70"
              : "outline outline-border rounded-sm overflow-hidden"
          }
        >
          <Editor
            height="120px"
            defaultLanguage="wgsl"
            value={readOnly ? code : localCode}
            onChange={handleEditorChange}
            theme={theme === "dark" ? "vs-dark" : "vs"}
            options={{
              minimap: { enabled: false },
              lineNumbers: "off",
              scrollbar: { vertical: "hidden", horizontal: "auto" },
              overviewRulerLanes: 0,
              hideCursorInOverviewRuler: true,
              overviewRulerBorder: false,
              scrollBeyondLastLine: false,
              wordWrap: "on",
              fontSize: 12,
              tabSize: 2,
              renderLineHighlight: "none",
              glyphMargin: false,
              folding: false,
              lineDecorationsWidth: 4,
              lineNumbersMinChars: 0,
              padding: { top: 4, bottom: 4 },
              readOnly: readOnly ?? false,
              domReadOnly: readOnly ?? false,
            }}
          />
        </div>
      )}

      {error && !readOnly && (
        <pre className="text-[10px] text-destructive bg-destructive/10 rounded-sm px-2 py-1 whitespace-pre-wrap break-words max-h-20 overflow-auto">
          {error}
        </pre>
      )}
    </div>
  );
}
