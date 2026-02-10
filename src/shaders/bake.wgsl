struct BakeParams {
  resolution: u32,
  shape_count: u32,
  bounds: f32,
  _pad: f32,
}

struct Shape {
  position: vec3<f32>,
  shape_type: u32,
  size: vec3<f32>,
  _pad1: f32,
}

@group(0) @binding(0) var<uniform> params: BakeParams;
@group(0) @binding(1) var<storage, read> shapes: array<Shape>;
@group(0) @binding(2) var output: texture_storage_3d<r32float, write>;

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
  // Scale to reference pyramid (base half-width 0.5)
  var pp = p;
  pp.x = pp.x / (2.0 * r);
  pp.z = pp.z / (2.0 * r);
  
  let m2 = h * h + 0.25;
  
  pp.x = abs(pp.x);
  pp.z = abs(pp.z);
  
  // Swap if z > x
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

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let res = params.resolution;
  if (gid.x >= res || gid.y >= res || gid.z >= res) {
    return;
  }

  let bounds = params.bounds;
  // Map voxel centers to world: voxel i → -bounds + (i + 0.5) * (2*bounds/res)
  // This matches the ray marcher's textureSampleLevel UVW convention
  let step = (2.0 * bounds) / f32(res);
  let world_pos = vec3<f32>(
    -bounds + (f32(gid.x) + 0.5) * step,
    -bounds + (f32(gid.y) + 0.5) * step,
    -bounds + (f32(gid.z) + 0.5) * step,
  );

  var d: f32 = 1e10;
  for (var i: u32 = 0u; i < params.shape_count; i = i + 1u) {
    let local_p = world_pos - shapes[i].position;
    var d_shape: f32;
    switch shapes[i].shape_type {
      case 0u: { d_shape = sdBox(local_p, shapes[i].size); }
      case 1u: { d_shape = sdSphere(local_p, shapes[i].size.x); }
      case 2u: { d_shape = sdCylinder(local_p, shapes[i].size.y, shapes[i].size.x); }
      case 3u: { d_shape = sdPyramid(local_p, shapes[i].size.y, shapes[i].size.x); }
      case 4u: { d_shape = sdCone(local_p, shapes[i].size.y, shapes[i].size.x); }
      default: { d_shape = 1e10; }
    }
    d = min(d, d_shape);
  }

  textureStore(output, gid, vec4<f32>(d, 0.0, 0.0, 0.0));
}
