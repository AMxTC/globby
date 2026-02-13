import type { SDFShape } from "../state/sceneStore";
import {
  CHUNK_SLOT_SIZE,
  CHUNK_WORLD_SIZE,
  VOXEL_SIZE,
  ATLAS_SLOTS,
  CHUNK_MAP_SIZE,
} from "../constants";
import { rotatedAABBHalfExtents } from "../lib/math3d";

export interface ChunkSlot {
  cx: number;
  cy: number;
  cz: number;
  slotIndex: number;
}

const TOTAL_SLOTS = ATLAS_SLOTS[0] * ATLAS_SLOTS[1] * ATLAS_SLOTS[2];
const MARGIN = 2 * VOXEL_SIZE; // 2-voxel margin for SDF bleed

export class ChunkManager {
  private chunks = new Map<string, ChunkSlot>();
  private freeSlots: number[] = [];
  private chunkMapData: Int32Array;
  private dirtyChunks: ChunkSlot[] = [];

  // Cached world bounds of all allocated chunks
  worldBoundsMin: [number, number, number] = [0, 0, 0];
  worldBoundsMax: [number, number, number] = [0, 0, 0];

  constructor() {
    // Initialize free slot stack (all slots available)
    for (let i = TOTAL_SLOTS - 1; i >= 0; i--) {
      this.freeSlots.push(i);
    }
    // Initialize chunk map to -1 (empty)
    this.chunkMapData = new Int32Array(CHUNK_MAP_SIZE ** 3).fill(-1);
  }

  static worldToChunk(x: number, y: number, z: number): [number, number, number] {
    return [
      Math.floor(x / CHUNK_WORLD_SIZE),
      Math.floor(y / CHUNK_WORLD_SIZE),
      Math.floor(z / CHUNK_WORLD_SIZE),
    ];
  }

  static atlasSlotToOffset(index: number): [number, number, number] {
    const sx = index % ATLAS_SLOTS[0];
    const sy = Math.floor(index / ATLAS_SLOTS[0]) % ATLAS_SLOTS[1];
    const sz = Math.floor(index / (ATLAS_SLOTS[0] * ATLAS_SLOTS[1]));
    return [
      sx * CHUNK_SLOT_SIZE,
      sy * CHUNK_SLOT_SIZE,
      sz * CHUNK_SLOT_SIZE,
    ];
  }

  static chunkOrigin(cx: number, cy: number, cz: number): [number, number, number] {
    return [
      cx * CHUNK_WORLD_SIZE,
      cy * CHUNK_WORLD_SIZE,
      cz * CHUNK_WORLD_SIZE,
    ];
  }

  private chunkMapIndex(cx: number, cy: number, cz: number): number {
    const half = CHUNK_MAP_SIZE / 2;
    const mx = cx + half;
    const my = cy + half;
    const mz = cz + half;
    if (mx < 0 || mx >= CHUNK_MAP_SIZE ||
        my < 0 || my >= CHUNK_MAP_SIZE ||
        mz < 0 || mz >= CHUNK_MAP_SIZE) {
      return -1;
    }
    return mx + my * CHUNK_MAP_SIZE + mz * CHUNK_MAP_SIZE * CHUNK_MAP_SIZE;
  }

  private allocate(cx: number, cy: number, cz: number): ChunkSlot | undefined {
    const key = `${cx},${cy},${cz}`;
    const existing = this.chunks.get(key);
    if (existing) return existing;

    if (this.freeSlots.length === 0) return undefined;

    const slotIndex = this.freeSlots.pop()!;
    const slot: ChunkSlot = { cx, cy, cz, slotIndex };
    this.chunks.set(key, slot);

    const mapIdx = this.chunkMapIndex(cx, cy, cz);
    if (mapIdx >= 0) {
      this.chunkMapData[mapIdx] = slotIndex;
    }

    return slot;
  }

  private deallocate(key: string): void {
    const slot = this.chunks.get(key);
    if (!slot) return;

    this.freeSlots.push(slot.slotIndex);
    this.chunks.delete(key);

    const mapIdx = this.chunkMapIndex(slot.cx, slot.cy, slot.cz);
    if (mapIdx >= 0) {
      this.chunkMapData[mapIdx] = -1;
    }
  }

  /** Returns chunks that overlap a shape's AABB (with margin) */
  private shapeChunks(shape: SDFShape): Set<string> {
    const keys = new Set<string>();
    const [px, py, pz] = shape.position;
    const [hx, hy, hz] = rotatedAABBHalfExtents(shape.size, shape.rotation, shape.scale);

    const minX = Math.floor((px - hx - MARGIN) / CHUNK_WORLD_SIZE);
    const minY = Math.floor((py - hy - MARGIN) / CHUNK_WORLD_SIZE);
    const minZ = Math.floor((pz - hz - MARGIN) / CHUNK_WORLD_SIZE);
    const maxX = Math.floor((px + hx + MARGIN) / CHUNK_WORLD_SIZE);
    const maxY = Math.floor((py + hy + MARGIN) / CHUNK_WORLD_SIZE);
    const maxZ = Math.floor((pz + hz + MARGIN) / CHUNK_WORLD_SIZE);

    for (let cz = minZ; cz <= maxZ; cz++) {
      for (let cy = minY; cy <= maxY; cy++) {
        for (let cx = minX; cx <= maxX; cx++) {
          keys.add(`${cx},${cy},${cz}`);
        }
      }
    }
    return keys;
  }

  /**
   * Sync chunks with current shapes.
   * Returns dirty chunks that need rebaking and the chunk map data.
   */
  sync(shapes: readonly SDFShape[]): {
    dirtyChunks: ChunkSlot[];
    chunkMapData: Int32Array;
  } {
    // Compute needed chunks from all shape AABBs
    const needed = new Set<string>();
    for (const shape of shapes) {
      for (const key of this.shapeChunks(shape)) {
        needed.add(key);
      }
    }

    // Deallocate chunks no longer needed
    for (const key of this.chunks.keys()) {
      if (!needed.has(key)) {
        this.deallocate(key);
      }
    }

    // Allocate new chunks and mark all needed as dirty
    // (We rebake all chunks since shapes may have changed globally)
    this.dirtyChunks = [];
    for (const key of needed) {
      let slot = this.chunks.get(key);
      if (!slot) {
        const [cx, cy, cz] = key.split(",").map(Number);
        slot = this.allocate(cx, cy, cz);
        if (!slot) continue; // out of slots
      }
      this.dirtyChunks.push(slot);
    }

    // Update world bounds
    this.updateWorldBounds();

    return {
      dirtyChunks: this.dirtyChunks,
      chunkMapData: this.chunkMapData,
    };
  }

  private updateWorldBounds(): void {
    if (this.chunks.size === 0) {
      this.worldBoundsMin = [0, 0, 0];
      this.worldBoundsMax = [0, 0, 0];
      return;
    }

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (const slot of this.chunks.values()) {
      const ox = slot.cx * CHUNK_WORLD_SIZE;
      const oy = slot.cy * CHUNK_WORLD_SIZE;
      const oz = slot.cz * CHUNK_WORLD_SIZE;
      minX = Math.min(minX, ox);
      minY = Math.min(minY, oy);
      minZ = Math.min(minZ, oz);
      maxX = Math.max(maxX, ox + CHUNK_WORLD_SIZE);
      maxY = Math.max(maxY, oy + CHUNK_WORLD_SIZE);
      maxZ = Math.max(maxZ, oz + CHUNK_WORLD_SIZE);
    }

    this.worldBoundsMin = [minX, minY, minZ];
    this.worldBoundsMax = [maxX, maxY, maxZ];
  }

  getChunkMapOffset(): [number, number, number] {
    const half = CHUNK_MAP_SIZE / 2;
    return [-half, -half, -half];
  }

  /** Returns origins of all allocated chunks (for debug visualization) */
  getAllocatedChunkOrigins(): [number, number, number][] {
    const origins: [number, number, number][] = [];
    for (const slot of this.chunks.values()) {
      origins.push(ChunkManager.chunkOrigin(slot.cx, slot.cy, slot.cz));
    }
    return origins;
  }

  getAllocatedChunkCount(): number {
    return this.chunks.size;
  }

  getMaxChunks(): number {
    return TOTAL_SLOTS;
  }
}
