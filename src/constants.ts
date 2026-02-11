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
