import {
  Copy,
  Scissors,
  ClipboardPaste,
  CopyPlus,
  Trash2,
  AlignHorizontalSpaceAround,
  FlipHorizontal2,
} from "lucide-react";
import {
  duplicateSelectedShapes,
  deleteSelectedShapes,
  flipShapes,
  distributeShapes,
} from "../../state/sceneStore";
import { copyShapes, cutShapes, pasteShapes, hasClipboard } from "../../lib/clipboard";
import type { ContextMenuItem } from "../ContextMenu";

export function buildObjectMenu(ids: string[]): ContextMenuItem[] {
  const selCount = ids.length;
  return [
    { label: "Copy", icon: Copy, shortcut: "\u2318C", action: copyShapes },
    { label: "Cut", icon: Scissors, shortcut: "\u2318X", action: cutShapes },
    {
      label: "Paste",
      icon: ClipboardPaste,
      shortcut: "\u2318V",
      action: pasteShapes,
      disabled: !hasClipboard(),
    },
    { separator: true },
    {
      label: "Duplicate",
      icon: CopyPlus,
      shortcut: "\u2318J",
      action: () => duplicateSelectedShapes(),
    },
    {
      label: "Delete",
      icon: Trash2,
      shortcut: "\u232B",
      action: () => deleteSelectedShapes(),
    },
    { separator: true },
    {
      label: "Flip",
      icon: FlipHorizontal2,
      children: [
        { label: "Flip X", action: () => flipShapes([...ids], 0) },
        { label: "Flip Y", action: () => flipShapes([...ids], 1) },
        { label: "Flip Z", action: () => flipShapes([...ids], 2) },
      ],
    },
    {
      label: "Distribute",
      icon: AlignHorizontalSpaceAround,
      disabled: selCount < 3,
      children: [
        { label: "Distribute X", action: () => distributeShapes([...ids], 0) },
        { label: "Distribute Y", action: () => distributeShapes([...ids], 1) },
        { label: "Distribute Z", action: () => distributeShapes([...ids], 2) },
      ],
    },
  ];
}
