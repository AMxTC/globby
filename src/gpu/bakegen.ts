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
  return `    let translated_p = world_pos - shapes[${shapeVar}].position;
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
      default: { d_shape = 1e10; }
    }
    d_shape = d_shape * s;`;
}

function generateTransferBlock(shapeVar: string): string {
  return `
    // Track closest shape by raw SDF distance (for selection)
    if (abs(d_shape) < closest_raw) {
      closest_raw = abs(d_shape);
      closest_id = ${shapeVar};
    }

    // Unpack: bits 0-7 = mode, bits 8-19 = opacity*4095, bits 20-31 = param*4095
    let packed = shapes[${shapeVar}].transfer_packed;
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
    }`;
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
    parts.push(`fn shape_fx_${slot}(distance: f32, p: vec3<f32>, local_p: vec3<f32>) -> f32 {
  ${code}
}
`);
  }

  // Generate layer fx functions
  for (const { slot, code } of layerFxSlots) {
    parts.push(`fn layer_fx_${slot}(distance: f32, p: vec3<f32>) -> f32 {
  ${code}
}
`);
  }

  // Generate main — single loop using params.shape_count, slot dispatch at runtime
  const mainLines: string[] = [];
  mainLines.push(`@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= SLOT_SIZE || gid.y >= SLOT_SIZE || gid.z >= SLOT_SIZE) {
    return;
  }

  let world_pos = params.chunk_origin + (vec3<f32>(gid) - 0.5) * params.voxel_size;

  var d: f32 = 1e10;
  var closest_raw: f32 = 1e10;
  var closest_id: u32 = 0xFFFFFFFFu;
  for (var i: u32 = 0u; i < params.shape_count; i = i + 1u) {`);

  mainLines.push(generateShapeEval('i'));

  // Shape fx dispatch via slot from fx_info bits 0-7
  if (shapeFxSlots.length > 0) {
    mainLines.push(`    let sfx = shapes[i].fx_info & 0xFFu;`);
    mainLines.push(`    switch sfx {`);
    for (const { slot } of shapeFxSlots) {
      mainLines.push(`      case ${slot}u: { d_shape = shape_fx_${slot}(d_shape, world_pos, local_p); }`);
    }
    mainLines.push(`      default: {}`);
    mainLines.push(`    }`);
  }

  mainLines.push(generateTransferBlock('i'));

  // Layer fx dispatch via slot from fx_info bits 8-15 (non-zero on last shape of layer)
  if (layerFxSlots.length > 0) {
    mainLines.push(`    let lfx = (shapes[i].fx_info >> 8u) & 0xFFu;`);
    mainLines.push(`    switch lfx {`);
    for (const { slot } of layerFxSlots) {
      mainLines.push(`      case ${slot}u: { d = layer_fx_${slot}(d, world_pos); }`);
    }
    mainLines.push(`      default: {}`);
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
