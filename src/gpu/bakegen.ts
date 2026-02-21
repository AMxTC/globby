import bakeWgsl from "../shaders/bake.wgsl?raw";

export interface FxSlot {
  slot: number;   // 1-based slot index
  code: string;   // WGSL function body
}

// Split bake.wgsl at the marker comment into header (structs, SDF functions)
// and the flat main. The full file is used as-is for the no-fx fast path.
const HEADER_MARKER = '// === MAIN';
const headerEnd = bakeWgsl.indexOf(HEADER_MARKER);
const STATIC_HEADER = headerEnd >= 0 ? bakeWgsl.slice(0, headerEnd) : bakeWgsl;

function generateShapeEval(shapeVar: string): string {
  return `    // Cheap bounding-sphere skip
    let to_shape = world_pos - shapes[${shapeVar}].position;
    let center_dist = length(to_shape);
    let bound_r = length(shapes[${shapeVar}].size) * shapes[${shapeVar}].scale;
    let lower_bound = center_dist - bound_r;
    let is_mask_shape = (shapes[${shapeVar}].transfer_packed & 0x80u) != 0u;
    if (!is_mask_shape && lower_bound > max(abs(d), 0.25)) { continue; }

    let translated_p = to_shape;
    let inv_rot = buildInvRotation(shapes[${shapeVar}].rotation);
    let s = shapes[${shapeVar}].scale;
    let local_p = (inv_rot * translated_p) / s;
    var d_shape: f32;
    switch shapes[${shapeVar}].shape_type {
      case 0u: { d_shape = sdBox(local_p, shapes[${shapeVar}].size); }
      case 1u: { d_shape = sdSphere(local_p, shapes[${shapeVar}].size.x); }
      case 2u: { d_shape = sdCylinder(local_p, shapes[${shapeVar}].size.y, shapes[${shapeVar}].size.x); }
      case 3u: { d_shape = sdPyramid(local_p, shapes[${shapeVar}].size.y, shapes[${shapeVar}].size.x); }
      case 4u: { d_shape = sdCone(local_p, shapes[${shapeVar}].size.y, shapes[${shapeVar}].size.x); }
      case 5u: {
        let base_idx = ${shapeVar} * 16u;
        let count = u32(shapes[${shapeVar}].size.z + 0.5);
        let is_capped = (shapes[${shapeVar}].fx_info >> 16u) & 1u;
        if (is_capped == 1u) {
          d_shape = sdPolygonExtrusion(local_p, shapes[${shapeVar}].size.y, base_idx, count);
        } else {
          let wall_t = f32((shapes[${shapeVar}].fx_info >> 17u) & 0x3FFFu) / 16383.0 * 0.5;
          d_shape = sdPolygonExtrusionUncapped(local_p, shapes[${shapeVar}].size.y, base_idx, count, wall_t / s);
        }
      }
      default: { d_shape = 1e10; }
    }
    d_shape = d_shape * s;`;
}

/**
 * Generate the complete bake shader with fx injection.
 *
 * Fx is dispatched via runtime slot IDs stored in the shape's fx_info field,
 * so the generated shader code only changes when fx code text changes or fx
 * is toggled on/off — NOT when shapes are added/removed.
 *
 * Shape fx: each unique fx body gets a slot (1-based). The shader reads
 * the slot from shapes[i].fx_info bits 0-7 and dispatches via switch.
 *
 * Layer fx: each unique fx body gets a slot (1-based). The shader reads
 * the slot from shapes[i].fx_info bits 8-15. The slot is non-zero only on
 * the last shape of the layer, triggering the layer fx call after that shape.
 */
export function generateBakeShader(shapeFxSlots: FxSlot[], layerFxSlots: FxSlot[]): string {
  // Fast path: no fx active — return the imported bake.wgsl as-is
  if (shapeFxSlots.length === 0 && layerFxSlots.length === 0) {
    return bakeWgsl;
  }

  const parts: string[] = [STATIC_HEADER];

  // Generate shape fx functions
  for (const { slot, code } of shapeFxSlots) {
    parts.push(`fn shape_fx_${slot}(distance: f32, p: vec3<f32>, local_p: vec3<f32>, fx_params: vec3<f32>) -> f32 {
  ${code}
}
`);
  }

  // Generate layer fx functions
  for (const { slot, code } of layerFxSlots) {
    parts.push(`fn layer_fx_${slot}(distance: f32, p: vec3<f32>, fx_params: vec3<f32>) -> f32 {
  ${code}
}
`);
  }

  // Generate main — single loop using params.shape_count, slot dispatch at runtime
  const hasLayerFx = layerFxSlots.length > 0;
  const mainLines: string[] = [];
  mainLines.push(`@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= SLOT_SIZE || gid.y >= SLOT_SIZE || gid.z >= SLOT_SIZE) {
    return;
  }

  let world_pos = params.chunk_origin + (vec3<f32>(gid) - 0.5) * params.voxel_size;

  var d: f32 = 1e10;
  var d_mask: f32 = 1e10;
  var d_layer_start: f32 = 1e10;
  var closest_raw: f32 = 1e10;
  var closest_id: u32 = 0xFFFFFFFFu;`);

  mainLines.push(`  for (var i: u32 = 0u; i < params.shape_count; i = i + 1u) {`);

  // Snapshot d at layer start (bit 15) so mask can't cut into layers below
  mainLines.push(`    let is_layer_start = (shapes[i].fx_info >> 15u) & 1u;`);
  mainLines.push(`    if (is_layer_start == 1u) {`);
  mainLines.push(`      d_layer_start = d;`);
  mainLines.push(`    }`);

  mainLines.push(generateShapeEval('i'));

  // Shape fx dispatch via slot from fx_info bits 0-7
  if (shapeFxSlots.length > 0) {
    mainLines.push(`    let sfx = shapes[i].fx_info & 0xFFu;`);
    mainLines.push(`    switch sfx {`);
    for (const { slot } of shapeFxSlots) {
      mainLines.push(`      case ${slot}u: { d_shape = shape_fx_${slot}(d_shape, world_pos, local_p, unpackShapeFxParams(shapes[i])); }`);
    }
    mainLines.push(`      default: {}`);
    mainLines.push(`    }`);
  }

  // Mask routing: mode >= 128 routes to d_mask, else normal transfer
  mainLines.push(`    let packed = shapes[i].transfer_packed;`);
  mainLines.push(`    let mode = packed & 0xFFu;`);
  mainLines.push(`    if (mode >= 128u) {`);
  mainLines.push(`      d_mask = min(d_mask, d_shape);`);
  mainLines.push(`    } else {`);

  // Transfer: shapes combine with d using their transfer mode (indented inside else block)
  mainLines.push(`    // Track closest shape by raw SDF distance (for selection)
    if (abs(d_shape) < closest_raw) {
      closest_raw = abs(d_shape);
      closest_id = i;
    }

    let opacity = f32((packed >> 8u) & 0xFFFu) / 4095.0;
    let eff_opacity = opacity;
    let param = f32((packed >> 20u) & 0xFFFu) / 4095.0;

    // d_scaled lerps shape toward no-effect at low opacity
    let d_scaled = mix(d, d_shape, eff_opacity);

    switch mode {
      // 0: union (hard min)
      case 0u: { d = min(d, d_scaled); }
      // 1: smooth union — param controls smoothness (0..0.5)
      case 1u: { d = smin(d, d_scaled, param * 0.5); }
      // 2: subtract
      case 2u: { d = max(d, mix(d, -d_shape, eff_opacity)); }
      // 3: intersect
      case 3u: { d = max(d, d_scaled); }
      // 4: addition (plain sum of SDFs)
      case 4u: { d = mix(d, d + d_shape, eff_opacity); }
      // 5: multiply
      case 5u: { d = mix(d, d * d_shape, eff_opacity); }
      // 6: pipe — param controls thickness (0..0.2)
      case 6u: {
        let thickness = param * 0.2;
        let pipe_d = abs(max(d, d_shape)) - thickness;
        d = mix(d, pipe_d, eff_opacity);
      }
      // 7: engrave — param controls depth (0..0.2)
      case 7u: {
        let depth = param * 0.2;
        let engrave_d = max(d, -(abs(d_shape) - depth));
        d = mix(d, engrave_d, eff_opacity);
      }
      // 8: smooth subtract — param controls smoothness (0..0.5)
      case 8u: {
        let k = param * 0.5;
        let neg_d_shape = mix(d, -d_shape, eff_opacity);
        d = -smin(-d, -neg_d_shape, k);
      }
      default: { d = min(d, d_scaled); }
    }`);
  mainLines.push(`    }`); // end else

  // Apply mask at layer boundary (bit 31 of fx_info), then layer fx on combined d
  mainLines.push(`    let apply_mask = (shapes[i].fx_info >> 31u) & 1u;`);
  mainLines.push(`    if (apply_mask == 1u && d_mask < 1e9) {`);
  mainLines.push(`      d = min(max(d, -d_mask), d_layer_start);`);
  mainLines.push(`      d_mask = 1e10;`);
  mainLines.push(`      d_layer_start = 1e10;`);
  mainLines.push(`    }`);

  // Layer fx dispatch: apply to combined d at layer boundary (bits 8-15 of fx_info)
  if (hasLayerFx) {
    mainLines.push(`    let lfx = (shapes[i].fx_info >> 8u) & 0x7Fu;`);
    mainLines.push(`    if (lfx != 0u) {`);
    mainLines.push(`      switch lfx {`);
    for (const { slot } of layerFxSlots) {
      mainLines.push(`        case ${slot}u: { d = layer_fx_${slot}(d, world_pos, unpackLayerFxParams(shapes[i])); }`);
    }
    mainLines.push(`        default: {}`);
    mainLines.push(`      }`);
    mainLines.push(`    }`);
  }

  mainLines.push(`  }

  let texel = params.atlas_offset + gid;
  textureStore(output, texel, vec4<f32>(d, 0.0, 0.0, 0.0));
  textureStore(output_id, texel, vec4<u32>(closest_id, 0u, 0u, 0u));
}`);

  parts.push(mainLines.join('\n'));
  return parts.join('\n');
}
