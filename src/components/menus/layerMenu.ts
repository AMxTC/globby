import { CopyPlus, Pencil, Trash2 } from "lucide-react";
import {
  sceneState,
  removeLayer,
  selectShapesOnLayer,
  moveSelectedToLayer,
  duplicateLayer,
} from "../../state/sceneStore";
import type { ContextMenuItem } from "../ContextMenu";
import type { Layer } from "../../state/sceneStore";

export function buildLayerMenu(
  layer: Layer,
  layerCount: number,
  startEditing: (layer: Layer) => void,
): ContextMenuItem[] {
  return [
    {
      label: "Select Items",
      action: () => selectShapesOnLayer(layer.id),
    },
    {
      label: "Move Selected Here",
      action: () => moveSelectedToLayer(layer.id),
      disabled: sceneState.selectedShapeIds.length === 0,
    },
    { separator: true },
    {
      label: "Rename Layer",
      icon: Pencil,
      action: () => startEditing(layer),
    },
    {
      label: "Delete Layer",
      icon: Trash2,
      action: () => removeLayer(layer.id),
      disabled: layerCount <= 1,
    },
    {
      label: "Duplicate Layer",
      icon: CopyPlus,
      action: () => duplicateLayer(layer.id),
    },
  ];
}
