struct Uniforms {
  camera_matrix: mat4x4<f32>,
  camera_projection_matrix_inverse: mat4x4<f32>,
  resolution: vec2<f32>,
  voxel_size: f32,
  chunk_world_size: f32,
  chunk_map_offset: vec3<i32>,
  _pad0: i32,
  chunk_map_size: vec3<u32>,
  _pad1: u32,
  atlas_slots: vec3<u32>,
  _pad2: u32,
  max_distance: f32,
  show_ground_plane: u32,
  _pad4: f32,
  _pad5: f32,
  world_bounds_min: vec3<f32>,
  _pad6: f32,
  world_bounds_max: vec3<f32>,
  _pad7: f32,
}

const SLOT_SIZE: u32 = 34u;

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var atlas: texture_3d<f32>;
@group(0) @binding(2) var chunk_map: texture_3d<i32>;
@group(0) @binding(3) var chunk_dist: texture_3d<f32>;
@group(0) @binding(4) var vol_sampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VertexOutput {
  let x = f32(i32(i & 1u)) * 4.0 - 1.0;
  let y = f32(i32((i >> 1u) & 1u)) * 4.0 - 1.0;
  var out: VertexOutput;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(x, y);
  return out;
}

fn intersectAABB(ro: vec3<f32>, rd: vec3<f32>, bmin: vec3<f32>, bmax: vec3<f32>) -> vec2<f32> {
  let inv_rd = 1.0 / rd;
  let t0 = (bmin - ro) * inv_rd;
  let t1 = (bmax - ro) * inv_rd;
  let tmin = min(t0, t1);
  let tmax = max(t0, t1);
  let t_near = max(max(tmin.x, tmin.y), tmin.z);
  let t_far = min(min(tmax.x, tmax.y), tmax.z);
  return vec2<f32>(t_near, t_far);
}

// Convert world position to chunk coordinate (integer)
fn worldToChunkCoord(p: vec3<f32>) -> vec3<i32> {
  return vec3<i32>(floor(p / uniforms.chunk_world_size));
}

// Look up chunk map: returns atlas slot index, or -1 if empty
fn lookupChunkMap(cc: vec3<i32>) -> i32 {
  let mc = cc - uniforms.chunk_map_offset;
  if (any(mc < vec3<i32>(0)) || any(mc >= vec3<i32>(uniforms.chunk_map_size))) {
    return -1;
  }
  return textureLoad(chunk_map, vec3<u32>(mc), 0).r;
}

// Convert atlas slot index to texel offset
fn slotToOffset(slot: i32) -> vec3<u32> {
  let s = u32(slot);
  let sx = s % uniforms.atlas_slots.x;
  let sy = (s / uniforms.atlas_slots.x) % uniforms.atlas_slots.y;
  let sz = s / (uniforms.atlas_slots.x * uniforms.atlas_slots.y);
  return vec3<u32>(sx, sy, sz) * SLOT_SIZE;
}

// Sample SDF from atlas using hardware trilinear, clamped within the chunk
fn sampleChunkSDF(p: vec3<f32>) -> f32 {
  let cc = worldToChunkCoord(p);
  let slot = lookupChunkMap(cc);
  if (slot < 0) {
    return 1e10;
  }

  let atlas_offset = vec3<f32>(slotToOffset(slot));
  let chunk_origin = vec3<f32>(cc) * uniforms.chunk_world_size;
  let local_pos = (p - chunk_origin) / uniforms.voxel_size;

  // Data starts at texel 1 (padding offset); clamp to [0.5, 33.5] for safety
  let clamped = clamp(atlas_offset + 1.0 + local_pos, atlas_offset + vec3<f32>(0.5), atlas_offset + vec3<f32>(33.5));

  let atlas_size = vec3<f32>(uniforms.atlas_slots * SLOT_SIZE);
  let atlas_uvw = clamped / atlas_size;

  return textureSampleLevel(atlas, vol_sampler, atlas_uvw, 0.0).r;
}

// Get chunk distance (min |d|) for a chunk coordinate
fn getChunkDist(cc: vec3<i32>) -> f32 {
  let mc = cc - uniforms.chunk_map_offset;
  if (any(mc < vec3<i32>(0)) || any(mc >= vec3<i32>(uniforms.chunk_map_size))) {
    return 1e10;
  }
  return textureLoad(chunk_dist, vec3<u32>(mc), 0).r;
}

// Step to next chunk boundary along ray, landing just inside the next chunk
fn stepToNextChunkBoundary(p: vec3<f32>, rd: vec3<f32>) -> f32 {
  let cws = uniforms.chunk_world_size;
  let nudge = uniforms.voxel_size * 0.25;
  var t_min: f32 = cws; // fallback: step one full chunk

  for (var axis: i32 = 0; axis < 3; axis = axis + 1) {
    let d = rd[axis];
    if (abs(d) < 1e-10) { continue; }

    var boundary: f32;
    if (d > 0.0) {
      boundary = floor(p[axis] / cws + 1.0) * cws;
    } else {
      boundary = ceil(p[axis] / cws - 1.0) * cws;
    }

    let t = (boundary - p[axis]) / d + nudge;
    if (t > nudge) {
      t_min = min(t_min, t);
    }
  }

  return t_min;
}

fn calcNormal(p: vec3<f32>) -> vec3<f32> {
  let eps = uniforms.voxel_size;
  let dx = sampleChunkSDF(p + vec3<f32>(eps, 0.0, 0.0)) - sampleChunkSDF(p - vec3<f32>(eps, 0.0, 0.0));
  let dy = sampleChunkSDF(p + vec3<f32>(0.0, eps, 0.0)) - sampleChunkSDF(p - vec3<f32>(0.0, eps, 0.0));
  let dz = sampleChunkSDF(p + vec3<f32>(0.0, 0.0, eps)) - sampleChunkSDF(p - vec3<f32>(0.0, 0.0, eps));
  return normalize(vec3<f32>(dx, dy, dz));
}

fn shadowMarch(p: vec3<f32>, light_dir: vec3<f32>) -> f32 {
  let eps = uniforms.voxel_size * 2.0;
  var t: f32 = eps;
  for (var i: i32 = 0; i < 32; i = i + 1) {
    let sp = p + t * light_dir;
    let d = sampleChunkSDF(sp);
    if (d < 0.0) {
      return 0.0; // in shadow
    }
    if (t > 50.0) {
      return 1.0; // escaped — lit
    }
    t = t + max(abs(d), uniforms.voxel_size * 0.5);
  }
  return 1.0; // lit
}

struct FragOutput {
  @location(0) color: vec4<f32>,
  @location(1) world_pos: vec4<f32>,
}

@fragment
fn fs(@builtin(position) frag_coord: vec4<f32>) -> FragOutput {
  let pixel = vec2<f32>(frag_coord.x, uniforms.resolution.y - frag_coord.y);
  let screen_pos = (pixel * 2.0 - uniforms.resolution) / uniforms.resolution;

  let clip = vec4<f32>(screen_pos, 1.0, 1.0);
  let world_h = uniforms.camera_matrix * uniforms.camera_projection_matrix_inverse * clip;
  let world_point = world_h.xyz / world_h.w;
  let ro = (uniforms.camera_matrix * vec4<f32>(0.0, 0.0, 0.0, 1.0)).xyz;
  var rd = normalize(world_point - ro);

  let bg_color = vec3<f32>(0.0);
  let no_hit = vec4<f32>(0.0, 0.0, 0.0, 0.0);

  // Early-out: intersect with world bounds AABB of all allocated chunks
  let bmin = uniforms.world_bounds_min;
  let bmax = uniforms.world_bounds_max;

  // Check if bounds are valid (non-degenerate)
  if (all(bmin >= bmax)) {
    return FragOutput(vec4<f32>(bg_color, 0.0), no_hit);
  }

  let t_hit = intersectAABB(ro, rd, bmin, bmax);

  if (t_hit.x > t_hit.y || t_hit.y < 0.0) {
    return FragOutput(vec4<f32>(bg_color, 0.0), no_hit);
  }

  let t_near = max(t_hit.x, 0.0);
  let t_far = t_hit.y;

  let voxel_size = uniforms.voxel_size;
  let step_size = voxel_size * 0.5;
  var t: f32 = t_near;
  var d: f32 = sampleChunkSDF(ro + t_near * rd);

  for (var i: i32 = 0; i < 512; i = i + 1) {
    if (t > t_far) { break; }

    let p = ro + t * rd;
    let cc = worldToChunkCoord(p);
    let slot = lookupChunkMap(cc);

    if (slot < 0) {
      // Empty chunk — skip to next chunk boundary
      t = t + stepToNextChunkBoundary(p, rd);
      d = sampleChunkSDF(ro + t * rd);
      continue;
    }

    // Sphere trace when far from surface
    if (abs(d) > voxel_size * 4.0) {
      t = t + abs(d) * 0.9;
      d = sampleChunkSDF(ro + t * rd);
      continue;
    }

    // Fine step and check for zero-crossing
    let t_next = t + step_size;
    if (t_next > t_far) { break; }

    let d_next = sampleChunkSDF(ro + t_next * rd);

    if (d >= 0.0 && d_next < 0.0) {
      // Bisection refinement between t and t_next
      var t_lo = t;
      var t_hi = t_next;
      for (var j: i32 = 0; j < 8; j = j + 1) {
        let t_mid = (t_lo + t_hi) * 0.5;
        let d_mid = sampleChunkSDF(ro + t_mid * rd);
        if (d_mid < 0.0) {
          t_hi = t_mid;
        } else {
          t_lo = t_mid;
        }
      }

      let hit_pos = ro + t_lo * rd;
      let nor = calcNormal(hit_pos);

      let lig = normalize(vec3<f32>(1.0, 0.8, -0.2));
      let dif = clamp(dot(nor, lig), 0.0, 1.0);
      let amb = 0.5 + 0.5 * nor.y;
      var col = vec3<f32>(0.05, 0.1, 0.15) * amb + vec3<f32>(1.0, 0.9, 0.8) * dif;
      col = sqrt(col);

      return FragOutput(vec4<f32>(col, 1.0), vec4<f32>(hit_pos, 1.0));
    }

    // Accelerate when clearly outside
    if (d_next > voxel_size * 4.0) {
      t = t_next + abs(d_next) * 0.9;
      d = sampleChunkSDF(ro + t * rd);
    } else {
      t = t_next;
      d = d_next;
    }
  }

  // Ground plane shadow
  if (uniforms.show_ground_plane != 0u && rd.y < 0.0) {
    let t_ground = -ro.y / rd.y;
    if (t_ground > 0.0) {
      let ground_pos = ro + t_ground * rd;
      let lig = normalize(vec3<f32>(1.0, 0.8, -0.2));
      let shadow = shadowMarch(ground_pos, lig);
      if (shadow < 0.5) {
        return FragOutput(vec4<f32>(0.0, 0.0, 0.0, 0.35), vec4<f32>(ground_pos, 1.0));
      }
    }
  }

  return FragOutput(vec4<f32>(bg_color, 0.0), no_hit);
}
