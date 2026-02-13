struct BakeParams {
  chunk_origin: vec3<f32>,
  shape_count: u32,
  atlas_offset: vec3<u32>,
  voxel_size: f32,
}

struct Shape {
  position: vec3<f32>,
  shape_type: u32,
  size: vec3<f32>,
  transfer_packed: u32, // low 16 = mode, high 16 = opacity*1000
  rotation: vec3<f32>,   // euler angles
  scale: f32,            // uniform scale
}

@group(0) @binding(0) var<uniform> params: BakeParams;
@group(0) @binding(1) var<storage, read> shapes: array<Shape>;
@group(0) @binding(2) var output: texture_storage_3d<r32float, write>;
@group(0) @binding(3) var output_id: texture_storage_3d<r32uint, write>;

fn sdBox(p: vec3<f32>, size: vec3<f32>) -> f32 {
  let q = abs(p) - size;
  return length(max(q, vec3<f32>(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}

fn sdSphere(p: vec3<f32>, radius: f32) -> f32 {
  return length(p) - radius;
}

fn sdTorus(p: vec3<f32>, t: vec2<f32>) -> f32 {
  let q = vec2<f32>(length(p.xz) - t.x, p.y);
  return length(q) - t.y;
}

fn sdCylinder(p: vec3<f32>, h: f32, r: f32) -> f32 {
  let d = abs(vec2<f32>(length(p.xz), p.y)) - vec2<f32>(r, h);
  return min(max(d.x, d.y), 0.0) + length(max(d, vec2<f32>(0.0)));
}

fn sdCone(p: vec3<f32>, h: f32, r: f32) -> f32 {
  let q = vec2<f32>(r, -h);
  let w = vec2<f32>(length(p.xz), p.y);
  let a = w - q * clamp(dot(w, q) / dot(q, q), 0.0, 1.0);
  let b = w - q * vec2<f32>(clamp(w.x / q.x, 0.0, 1.0), 1.0);
  let k = sign(q.y);
  let d = min(dot(a, a), dot(b, b));
  let s = max(k * (w.x * q.y - w.y * q.x), k * (w.y - q.y));
  return sqrt(d) * sign(s);
}

fn sdPyramid(p: vec3<f32>, h: f32, r: f32) -> f32 {
  var pp = p;
  pp.x = pp.x / (2.0 * r);
  pp.z = pp.z / (2.0 * r);

  let m2 = h * h + 0.25;

  pp.x = abs(pp.x);
  pp.z = abs(pp.z);

  if (pp.z > pp.x) {
    let temp = pp.x;
    pp.x = pp.z;
    pp.z = temp;
  }

  pp.x = pp.x - 0.5;
  pp.z = pp.z - 0.5;

  let q = vec3<f32>(pp.z, h * pp.y - 0.5 * pp.x, h * pp.x + 0.5 * pp.y);

  let s = max(-q.x, 0.0);
  let t = clamp((q.y - 0.5 * pp.z) / (m2 + 0.25), 0.0, 1.0);

  let a = m2 * (q.x + s) * (q.x + s) + q.y * q.y;
  let b = m2 * (q.x + 0.5 * t) * (q.x + 0.5 * t) + (q.y - m2 * t) * (q.y - m2 * t);

  let d2 = select(min(a, b), 0.0, min(q.y, -q.x * m2 - q.y * 0.5) > 0.0);

  return sqrt((d2 + q.z * q.z) / m2) * sign(max(q.z, -pp.y)) * 2.0 * r;
}

fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

fn buildInvRotation(euler: vec3<f32>) -> mat3x3<f32> {
  let cx = cos(euler.x); let sx = sin(euler.x);
  let cy = cos(euler.y); let sy = sin(euler.y);
  let cz = cos(euler.z); let sz = sin(euler.z);
  // R = Rz * Ry * Rx; columns below are the ROWS of R, giving R^T
  return mat3x3<f32>(
    vec3<f32>(cy*cz,            sx*sy*cz - cx*sz,   cx*sy*cz + sx*sz),
    vec3<f32>(cy*sz,            sx*sy*sz + cx*cz,    cx*sy*sz - sx*cz),
    vec3<f32>(-sy,              sx*cy,               cx*cy),
  );
}

const SLOT_SIZE: u32 = 34u;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= SLOT_SIZE || gid.y >= SLOT_SIZE || gid.z >= SLOT_SIZE) {
    return;
  }

  let world_pos = params.chunk_origin + (vec3<f32>(gid) - 0.5) * params.voxel_size;

  var d: f32 = 1e10;
  var closest_raw: f32 = 1e10;
  var closest_id: u32 = 0xFFFFFFFFu;
  for (var i: u32 = 0u; i < params.shape_count; i = i + 1u) {
    let translated_p = world_pos - shapes[i].position;
    let inv_rot = buildInvRotation(shapes[i].rotation);
    let s = shapes[i].scale;
    let local_p = (inv_rot * translated_p) / s;
    var d_shape: f32;
    switch shapes[i].shape_type {
      case 0u: { d_shape = sdBox(local_p, shapes[i].size); }
      case 1u: { d_shape = sdSphere(local_p, shapes[i].size.x); }
      case 2u: { d_shape = sdCylinder(local_p, shapes[i].size.y, shapes[i].size.x); }
      case 3u: { d_shape = sdPyramid(local_p, shapes[i].size.y, shapes[i].size.x); }
      case 4u: { d_shape = sdCone(local_p, shapes[i].size.y, shapes[i].size.x); }
      default: { d_shape = 1e10; }
    }
    d_shape = d_shape * s;

    // Track closest shape by raw SDF distance (for selection)
    if (abs(d_shape) < closest_raw) {
      closest_raw = abs(d_shape);
      closest_id = i;
    }

    // Unpack: bits 0-7 = mode, bits 8-19 = opacity*4095, bits 20-31 = param*4095
    let packed = shapes[i].transfer_packed;
    let mode = packed & 0xFFu;
    let opacity = f32((packed >> 8u) & 0xFFFu) / 4095.0;
    let param = f32((packed >> 20u) & 0xFFFu) / 4095.0;

    // d_scaled lerps shape toward no-effect at low opacity
    let d_scaled = mix(d, d_shape, opacity);

    switch mode {
      // 0: union (hard min)
      case 0u: { d = min(d, d_scaled); }
      // 1: smooth union — param controls smoothness (0..0.5)
      case 1u: { d = smin(d, d_scaled, param * 0.5); }
      // 2: subtract
      case 2u: { d = max(d, mix(d, -d_shape, opacity)); }
      // 3: intersect
      case 3u: { d = max(d, d_scaled); }
      // 4: addition (plain sum of SDFs)
      case 4u: { d = mix(d, d + d_shape, opacity); }
      // 5: multiply
      case 5u: { d = mix(d, d * d_shape, opacity); }
      // 6: pipe — param controls thickness (0..0.2)
      case 6u: {
        let thickness = param * 0.2;
        let pipe_d = abs(max(d, d_shape)) - thickness;
        d = mix(d, pipe_d, opacity);
      }
      // 7: engrave — param controls depth (0..0.2)
      case 7u: {
        let depth = param * 0.2;
        let engrave_d = max(d, -(abs(d_shape) - depth));
        d = mix(d, engrave_d, opacity);
      }
      default: { d = min(d, d_scaled); }
    }
  }

  let texel = params.atlas_offset + gid;
  textureStore(output, texel, vec4<f32>(d, 0.0, 0.0, 0.0));
  textureStore(output_id, texel, vec4<u32>(closest_id, 0u, 0u, 0u));
}
