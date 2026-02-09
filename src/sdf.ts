export type Vec3 = [number, number, number];

export function sdSphere(p: Vec3, radius: number): number {
  return Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]) - radius;
}

export function sdBox(p: Vec3, size: Vec3): number {
  const dx = Math.abs(p[0]) - size[0];
  const dy = Math.abs(p[1]) - size[1];
  const dz = Math.abs(p[2]) - size[2];
  const outside = Math.sqrt(
    Math.max(dx, 0) ** 2 + Math.max(dy, 0) ** 2 + Math.max(dz, 0) ** 2
  );
  const inside = Math.min(Math.max(dx, dy, dz), 0);
  return outside + inside;
}

export function opSmoothUnion(d1: number, d2: number, k: number): number {
  const h = Math.max(Math.min(0.5 + (0.5 * (d2 - d1)) / k, 1), 0);
  return d2 * (1 - h) + d1 * h - k * h * (1 - h);
}

export function bakeVoxels(
  evalFn: (p: Vec3) => number,
  resolution: number,
  bounds: number
): Float32Array {
  const data = new Float32Array(resolution * resolution * resolution);
  const step = (2 * bounds) / (resolution - 1);
  let idx = 0;
  for (let z = 0; z < resolution; z++) {
    for (let y = 0; y < resolution; y++) {
      for (let x = 0; x < resolution; x++) {
        const px = -bounds + x * step;
        const py = -bounds + y * step;
        const pz = -bounds + z * step;
        data[idx++] = evalFn([px, py, pz]);
      }
    }
  }
  return data;
}

export interface MipLevel {
  data: Float32Array;
  resolution: number;
}

/**
 * Build a mipmap chain of 3D distance fields.
 * Each level downsamples by 4×4×4 and stores min(|sdf|) of each block.
 * Returns array of mip levels (excluding level 0, which is the input).
 * e.g. 128→32→8→2, or 256→64→16→4, or 64→16→4
 */
export function buildMipChain(
  data: Float32Array,
  resolution: number,
): MipLevel[] {
  const mips: MipLevel[] = [];
  let src = data;
  let srcRes = resolution;

  while (srcRes >= 8) {
    const dstRes = srcRes / 4;
    const dst = new Float32Array(dstRes * dstRes * dstRes);

    for (let dz = 0; dz < dstRes; dz++) {
      for (let dy = 0; dy < dstRes; dy++) {
        for (let dx = 0; dx < dstRes; dx++) {
          let minAbs = Infinity;
          for (let lz = 0; lz < 4; lz++) {
            for (let ly = 0; ly < 4; ly++) {
              for (let lx = 0; lx < 4; lx++) {
                const sx = dx * 4 + lx;
                const sy = dy * 4 + ly;
                const sz = dz * 4 + lz;
                const val = Math.abs(src[sz * srcRes * srcRes + sy * srcRes + sx]);
                if (val < minAbs) minAbs = val;
              }
            }
          }
          dst[dz * dstRes * dstRes + dy * dstRes + dx] = minAbs;
        }
      }
    }

    mips.push({ data: dst, resolution: dstRes });
    src = dst;
    srcRes = dstRes;
  }

  return mips;
}
