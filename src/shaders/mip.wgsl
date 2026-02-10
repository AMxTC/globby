struct MipParams {
  src_resolution: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
}

@group(0) @binding(0) var<uniform> params: MipParams;
@group(0) @binding(1) var src: texture_3d<f32>;
@group(0) @binding(2) var dst: texture_storage_3d<r32float, write>;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dst_res = params.src_resolution / 4u;
  if (gid.x >= dst_res || gid.y >= dst_res || gid.z >= dst_res) {
    return;
  }

  var min_abs: f32 = 1e10;
  let base = gid * 4u;

  for (var lz: u32 = 0u; lz < 4u; lz = lz + 1u) {
    for (var ly: u32 = 0u; ly < 4u; ly = ly + 1u) {
      for (var lx: u32 = 0u; lx < 4u; lx = lx + 1u) {
        let coord = base + vec3<u32>(lx, ly, lz);
        let val = abs(textureLoad(src, coord, 0).r);
        min_abs = min(min_abs, val);
      }
    }
  }

  textureStore(dst, gid, vec4<f32>(min_abs, 0.0, 0.0, 0.0));
}
