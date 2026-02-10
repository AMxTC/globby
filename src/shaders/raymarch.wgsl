struct Uniforms {
  camera_matrix: mat4x4<f32>,
  camera_projection_matrix_inverse: mat4x4<f32>,
  resolution: vec2<f32>,
  bounds: f32,
  base_resolution: f32,
  mip_res: vec3<f32>,
  mip_count: i32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var volume: texture_3d<f32>;
@group(0) @binding(2) var mip1: texture_3d<f32>;
@group(0) @binding(3) var mip2: texture_3d<f32>;
@group(0) @binding(4) var mip3: texture_3d<f32>;
@group(0) @binding(5) var vol_sampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VertexOutput {
  // Fullscreen triangle
  let x = f32(i32(i & 1u)) * 4.0 - 1.0;
  let y = f32(i32((i >> 1u) & 1u)) * 4.0 - 1.0;
  var out: VertexOutput;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(x, y);
  return out;
}

// Ray-AABB intersection
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

fn worldToUVW(p: vec3<f32>) -> vec3<f32> {
  return (p + uniforms.bounds) / (2.0 * uniforms.bounds);
}

fn sampleSDF(p: vec3<f32>) -> f32 {
  let uvw = worldToUVW(p);
  return textureSampleLevel(volume, vol_sampler, uvw, 0.0).r;
}

fn sampleMip(p: vec3<f32>, level: i32) -> f32 {
  let uvw = worldToUVW(p);
  if (level == 1) { return textureSampleLevel(mip1, vol_sampler, uvw, 0.0).r; }
  if (level == 2) { return textureSampleLevel(mip2, vol_sampler, uvw, 0.0).r; }
  return textureSampleLevel(mip3, vol_sampler, uvw, 0.0).r;
}

fn cellSizeForLevel(level: i32) -> f32 {
  if (level == 0) { return uniforms.bounds * 2.0 / uniforms.base_resolution; }
  if (level == 1) { return uniforms.bounds * 2.0 / uniforms.mip_res.x; }
  if (level == 2) { return uniforms.bounds * 2.0 / uniforms.mip_res.y; }
  return uniforms.bounds * 2.0 / uniforms.mip_res.z;
}

fn calcNormal(p: vec3<f32>) -> vec3<f32> {
  let eps = uniforms.bounds * 2.0 / uniforms.base_resolution;
  let dx = sampleSDF(p + vec3<f32>(eps, 0.0, 0.0)) - sampleSDF(p - vec3<f32>(eps, 0.0, 0.0));
  let dy = sampleSDF(p + vec3<f32>(0.0, eps, 0.0)) - sampleSDF(p - vec3<f32>(0.0, eps, 0.0));
  let dz = sampleSDF(p + vec3<f32>(0.0, 0.0, eps)) - sampleSDF(p - vec3<f32>(0.0, 0.0, eps));
  return normalize(vec3<f32>(dx, dy, dz));
}

struct FragOutput {
  @location(0) color: vec4<f32>,
  @location(1) world_pos: vec4<f32>,
}

@fragment
fn fs(@builtin(position) frag_coord: vec4<f32>) -> FragOutput {
  // WebGPU frag_coord has Y=0 at top, but NDC needs Y-up. Flip Y.
  let pixel = vec2<f32>(frag_coord.x, uniforms.resolution.y - frag_coord.y);
  let screen_pos = (pixel * 2.0 - uniforms.resolution) / uniforms.resolution;

  // Unproject a clip-space point to world space with proper perspective divide
  let clip = vec4<f32>(screen_pos, 1.0, 1.0);
  let world_h = uniforms.camera_matrix * uniforms.camera_projection_matrix_inverse * clip;
  let world_point = world_h.xyz / world_h.w;
  let ro = (uniforms.camera_matrix * vec4<f32>(0.0, 0.0, 0.0, 1.0)).xyz;
  var rd = normalize(world_point - ro);

  let bmin = vec3<f32>(-uniforms.bounds);
  let bmax = vec3<f32>(uniforms.bounds);
  let t_hit = intersectAABB(ro, rd, bmin, bmax);

  let bg_color = vec3<f32>(0.0);
  let no_hit = vec4<f32>(0.0, 0.0, 0.0, 0.0); // w=0 means no surface

  if (t_hit.x > t_hit.y || t_hit.y < 0.0) {
    return FragOutput(vec4<f32>(bg_color, 0.0), no_hit);
  }

  let t_near = max(t_hit.x, 0.0);
  let t_far = t_hit.y;
  let voxel_size = cellSizeForLevel(0);

  // Hierarchical sphere tracing
  var level: i32 = uniforms.mip_count;
  var t: f32 = t_near;
  var prev_d: f32 = sampleSDF(ro + t_near * rd);

  for (var i: i32 = 0; i < 512; i = i + 1) {
    if (t > t_far) { break; }

    let p = ro + t * rd;

    if (level > 0) {
      let d = sampleMip(p, level);
      let cell_size = cellSizeForLevel(level);

      if (d > cell_size * 0.5) {
        t = t + d;
      } else {
        level = level - 1;
        if (level == 0) {
          prev_d = sampleSDF(p);
        }
      }
    } else {
      // Level 0: fine-grained fixed-step march with zero-crossing detection
      let step_size = voxel_size * 0.5;
      t = t + step_size;
      if (t > t_far) { break; }

      let p2 = ro + t * rd;
      let d = sampleSDF(p2);

      if (d < 0.0 && prev_d >= 0.0) {
        // Bisection refinement
        var t_lo = t - step_size;
        var t_hi = t;
        for (var j: i32 = 0; j < 8; j = j + 1) {
          let t_mid = (t_lo + t_hi) * 0.5;
          let d_mid = sampleSDF(ro + t_mid * rd);
          if (d_mid < 0.0) {
            t_hi = t_mid;
          } else {
            t_lo = t_mid;
          }
        }

        let hit_pos = ro + t_lo * rd;
        let nor = calcNormal(hit_pos);

        // Lighting
        let lig = normalize(vec3<f32>(1.0, 0.8, -0.2));
        let dif = clamp(dot(nor, lig), 0.0, 1.0);
        let amb = 0.5 + 0.5 * nor.y;
        var col = vec3<f32>(0.05, 0.1, 0.15) * amb + vec3<f32>(1.0, 0.9, 0.8) * dif;
        col = sqrt(col); // gamma

        return FragOutput(vec4<f32>(col, 1.0), vec4<f32>(hit_pos, 1.0));
      }

      // If far from surface at level 0, go back up to mip 1
      if (d > voxel_size * 4.0 && uniforms.mip_count >= 1) {
        level = 1;
      }

      prev_d = d;
    }
  }

  return FragOutput(vec4<f32>(bg_color, 0.0), no_hit);
}
