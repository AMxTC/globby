import { useState, useRef, useCallback, useEffect } from "react";
import Editor from "@monaco-editor/react";
import { useSnapshot } from "valtio";
import { themeState } from "../state/themeStore";

interface FxEditorProps {
  code: string;
  onChange: (code: string) => void;
  error: string | null;
  readOnly?: boolean;
}

export function FxEditor({ code, onChange, error, readOnly }: FxEditorProps) {
  const { theme } = useSnapshot(themeState);
  const [localCode, setLocalCode] = useState(code);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Sync external code changes (e.g. undo/redo, toggle)
  useEffect(() => {
    setLocalCode(code);
  }, [code]);

  const handleChange = useCallback(
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

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <div className="space-y-1">
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
          value={localCode}
          onChange={handleChange}
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
      {error && !readOnly && (
        <pre className="text-[10px] text-destructive bg-destructive/10 rounded-sm px-2 py-1 whitespace-pre-wrap break-words max-h-20 overflow-auto">
          {error}
        </pre>
      )}
    </div>
  );
}
