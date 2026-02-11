struct ReduceParams {
  atlas_offset: vec3<u32>,
  _pad0: u32,
  chunk_map_coord: vec3<u32>,
  _pad1: u32,
}

@group(0) @binding(0) var<uniform> params: ReduceParams;
@group(0) @binding(1) var atlas: texture_3d<f32>;
@group(0) @binding(2) var chunk_dist: texture_storage_3d<r32float, write>;

var<workgroup> shared_min: array<f32, 64>;

@compute @workgroup_size(4, 4, 4)
fn main(
  @builtin(local_invocation_id) lid: vec3<u32>,
  @builtin(local_invocation_index) idx: u32,
) {
  // Each thread reads an 8x8x8 sub-block
  let base = params.atlas_offset + 1u + lid * 8u;
  var local_min: f32 = 1e10;

  for (var z: u32 = 0u; z < 8u; z = z + 1u) {
    for (var y: u32 = 0u; y < 8u; y = y + 1u) {
      for (var x: u32 = 0u; x < 8u; x = x + 1u) {
        let coord = base + vec3<u32>(x, y, z);
        let val = abs(textureLoad(atlas, coord, 0).r);
        local_min = min(local_min, val);
      }
    }
  }

  shared_min[idx] = local_min;
  workgroupBarrier();

  // Parallel reduction
  if (idx < 32u) { shared_min[idx] = min(shared_min[idx], shared_min[idx + 32u]); }
  workgroupBarrier();
  if (idx < 16u) { shared_min[idx] = min(shared_min[idx], shared_min[idx + 16u]); }
  workgroupBarrier();
  if (idx < 8u) { shared_min[idx] = min(shared_min[idx], shared_min[idx + 8u]); }
  workgroupBarrier();
  if (idx < 4u) { shared_min[idx] = min(shared_min[idx], shared_min[idx + 4u]); }
  workgroupBarrier();
  if (idx < 2u) { shared_min[idx] = min(shared_min[idx], shared_min[idx + 2u]); }
  workgroupBarrier();
  if (idx == 0u) {
    let result = min(shared_min[0], shared_min[1]);
    textureStore(chunk_dist, params.chunk_map_coord, vec4<f32>(result, 0.0, 0.0, 0.0));
  }
}
