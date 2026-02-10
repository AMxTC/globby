export const RESOLUTION = 128;
export const BOUNDS = 2.0;

export const SHAPE_TYPES = ["box", "sphere", "cylinder", "pyramid", "cone"] as const;
export type ShapeType = (typeof SHAPE_TYPES)[number];

export const SHAPE_TYPE_GPU: Record<ShapeType, number> = {
  box: 0,
  sphere: 1,
  cylinder: 2,
  pyramid: 3,
  cone: 4,
};
