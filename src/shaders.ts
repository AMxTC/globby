export const vertexShader = `
void main() {
  gl_Position = vec4(position, 1.0);
}
`;

export const fragmentShader = `
precision highp float;
precision highp sampler3D;

uniform vec2 u_resolution;
uniform sampler3D u_volume;
uniform mat4 u_camera_matrix;
uniform mat4 u_camera_projection_matrix_inverse;
uniform float u_bounds;

out vec4 outColor;

// Ray-AABB intersection: returns (tNear, tFar), negative tFar means no hit
vec2 intersectAABB(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax) {
  vec3 invRd = 1.0 / rd;
  vec3 t0 = (bmin - ro) * invRd;
  vec3 t1 = (bmax - ro) * invRd;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  float tNear = max(max(tmin.x, tmin.y), tmin.z);
  float tFar = min(min(tmax.x, tmax.y), tmax.z);
  return vec2(tNear, tFar);
}

// Convert world position to UVW texture coordinates
vec3 worldToUVW(vec3 p) {
  return (p + u_bounds) / (2.0 * u_bounds);
}

// Sample the SDF volume
float sampleSDF(vec3 p) {
  vec3 uvw = worldToUVW(p);
  return texture(u_volume, uvw).r;
}

// Normal via central differences
vec3 calcNormal(vec3 p) {
  float eps = u_bounds * 2.0 / 128.0; // ~1 voxel
  float dx = sampleSDF(p + vec3(eps,0,0)) - sampleSDF(p - vec3(eps,0,0));
  float dy = sampleSDF(p + vec3(0,eps,0)) - sampleSDF(p - vec3(0,eps,0));
  float dz = sampleSDF(p + vec3(0,0,eps)) - sampleSDF(p - vec3(0,0,eps));
  return normalize(vec3(dx, dy, dz));
}

void main() {
  vec2 screenPos = (gl_FragCoord.xy * 2.0 - u_resolution) / u_resolution;
  vec4 ndcRay = vec4(screenPos, 1.0, 1.0);
  vec3 rd = (u_camera_matrix * u_camera_projection_matrix_inverse * ndcRay).xyz;
  rd = normalize(rd);
  vec3 ro = (u_camera_matrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

  vec3 bmin = vec3(-u_bounds);
  vec3 bmax = vec3( u_bounds);
  vec2 tHit = intersectAABB(ro, rd, bmin, bmax);

  vec3 bgColor = vec3(0.0);

  if (tHit.x > tHit.y || tHit.y < 0.0) {
    outColor = vec4(bgColor, 1.0);
    return;
  }

  float tNear = max(tHit.x, 0.0);
  float tFar = tHit.y;

  // Raymarch through volume
  float stepSize = u_bounds * 2.0 / 256.0;
  float t = tNear;
  float prevD = sampleSDF(ro + t * rd);

  for (int i = 0; i < 512; i++) {
    t += stepSize;
    if (t > tFar) break;

    vec3 p = ro + t * rd;
    float d = sampleSDF(p);

    // Zero crossing: sign change
    if (d < 0.0 && prevD >= 0.0) {
      // Bisection refinement
      float tLo = t - stepSize;
      float tHi = t;
      for (int j = 0; j < 8; j++) {
        float tMid = (tLo + tHi) * 0.5;
        float dMid = sampleSDF(ro + tMid * rd);
        if (dMid < 0.0) {
          tHi = tMid;
        } else {
          tLo = tMid;
        }
      }

      vec3 hitPos = ro + tLo * rd;
      vec3 nor = calcNormal(hitPos);

      // Lighting
      vec3 lig = normalize(vec3(1.0, 0.8, -0.2));
      float dif = clamp(dot(nor, lig), 0.0, 1.0);
      float amb = 0.5 + 0.5 * nor.y;
      vec3 col = vec3(0.05, 0.1, 0.15) * amb + vec3(1.0, 0.9, 0.8) * dif;
      col = sqrt(col); // gamma

      outColor = vec4(col, 1.0);
      return;
    }

    prevD = d;
  }

  outColor = vec4(bgColor, 1.0);
}
`;
