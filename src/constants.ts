// Sparse chunk system
export const VOXEL_SIZE = 0.015625;
export const CHUNK_VOXELS = 32;
export const CHUNK_SLOT_SIZE = 34; // CHUNK_VOXELS + 2 (1 padding on each side)
export const CHUNK_WORLD_SIZE = 0.5; // CHUNK_VOXELS * VOXEL_SIZE
export const CHUNK_WORKGROUPS = 9; // ceil(CHUNK_SLOT_SIZE / 4)
export const ATLAS_SLOTS: [number, number, number] = [16, 8, 8]; // 1024 max chunks
export const CHUNK_MAP_SIZE = 64;

export const SHAPE_TYPES = [
  "box",
  "sphere",
  "cylinder",
  "pyramid",
  "cone",
] as const;
export type ShapeType = (typeof SHAPE_TYPES)[number];

export const SHAPE_TYPE_GPU: Record<ShapeType, number> = {
  box: 0,
  sphere: 1,
  cylinder: 2,
  pyramid: 3,
  cone: 4,
};

export const TRANSFER_MODES = [
  "union",
  "smooth_union",
  "subtract",
  "intersect",
  "addition",
  "multiply",
  "pipe",
  "engrave",
] as const;
export type TransferMode = (typeof TRANSFER_MODES)[number];

export const TRANSFER_MODE_GPU: Record<TransferMode, number> = {
  union: 0,
  smooth_union: 1,
  subtract: 2,
  intersect: 3,
  addition: 4,
  multiply: 5,
  pipe: 6,
  engrave: 7,
};
