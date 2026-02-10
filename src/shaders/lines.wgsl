struct LineUniforms {
  view_proj: mat4x4<f32>,
  color: vec4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: LineUniforms;

@vertex
fn vs(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
  return uniforms.view_proj * vec4<f32>(position, 1.0);
}

@fragment
fn fs() -> @location(0) vec4<f32> {
  return uniforms.color;
}
