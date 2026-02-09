import { Canvas, useThree, useFrame } from "@react-three/fiber";
import {
  Box,
  OrbitControls,
  PerspectiveCamera,
  ScreenQuad,
} from "@react-three/drei";
import { useRef, useMemo } from "react";
import {
  GLSL3,
  ShaderMaterial,
  Data3DTexture,
  RedFormat,
  FloatType,
  LinearFilter,
  Vector2,
  PerspectiveCamera as ThreePerspectiveCamera,
  MOUSE,
} from "three";
import {
  sdSphere,
  sdBox,
  opSmoothUnion,
  bakeVoxels,
  buildMipChain,
  type MipLevel,
} from "./sdf";
import { vertexShader, fragmentShader } from "./shaders";

const RESOLUTION = 128;
const BOUNDS = 2.0;

function makeMipTex(mipData: Float32Array, res: number): Data3DTexture {
  const tex = new Data3DTexture(mipData, res, res, res);
  tex.format = RedFormat;
  tex.type = FloatType;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

// 1×1×1 dummy texture (large distance so it never triggers refinement)
function makeDummyMipTex(): Data3DTexture {
  return makeMipTex(new Float32Array([1e10]), 1);
}

interface VolumeTextures {
  volume: Data3DTexture;
  mips: Data3DTexture[]; // up to 3 mip textures
  mipResolutions: number[]; // resolution of each mip (float for the shader)
  mipCount: number;
}

function createVolumeTextures(): VolumeTextures {
  const data = bakeVoxels(
    (p) => {
      const sphere = sdSphere([p[0] - 0.5, p[1], p[2]], 0.8);
      const box = sdBox(p, [0.5, 0.5, 0.5]);
      const displacment =
        Math.sin(p[0] * 30) + Math.sin(p[1] * 30) + Math.sin(p[2] * 30);
      return opSmoothUnion(sphere, box, 0.1) + displacment * 0.01;
    },
    RESOLUTION,
    BOUNDS,
  );

  const volume = new Data3DTexture(data, RESOLUTION, RESOLUTION, RESOLUTION);
  volume.format = RedFormat;
  volume.type = FloatType;
  volume.minFilter = LinearFilter;
  volume.magFilter = LinearFilter;
  volume.unpackAlignment = 1;
  volume.needsUpdate = true;

  const mipLevels = buildMipChain(data, RESOLUTION);
  const mipCount = Math.min(mipLevels.length, 3);

  // Always provide exactly 3 sampler slots; pad with dummies
  const mips: Data3DTexture[] = [];
  const mipResolutions: number[] = [];
  for (let i = 0; i < 3; i++) {
    if (i < mipLevels.length) {
      mips.push(makeMipTex(mipLevels[i].data, mipLevels[i].resolution));
      mipResolutions.push(mipLevels[i].resolution);
    } else {
      mips.push(makeDummyMipTex());
      mipResolutions.push(1.0);
    }
  }

  return { volume, mips, mipResolutions, mipCount };
}

function VolumeRenderer() {
  const size = useThree((s) => s.size);
  const shaderRef = useRef<ShaderMaterial>(null!);
  const cameraRef = useRef<ThreePerspectiveCamera>(null!);

  const textures = useMemo(() => createVolumeTextures(), []);

  const uniforms = useMemo(
    () => ({
      u_resolution: { value: new Vector2(size.width, size.height) },
      u_volume: { value: textures.volume },
      u_mip1: { value: textures.mips[0] },
      u_mip2: { value: textures.mips[1] },
      u_mip3: { value: textures.mips[2] },
      u_mip_res: { value: new Float32Array(textures.mipResolutions) },
      u_mip_count: { value: textures.mipCount },
      u_base_resolution: { value: RESOLUTION },
      u_camera_matrix: { value: cameraRef.current?.matrixWorld },
      u_camera_projection_matrix_inverse: {
        value: cameraRef.current?.projectionMatrixInverse,
      },
      u_bounds: { value: BOUNDS },
    }),
    [textures, size.width, size.height],
  );

  useFrame((state) => {
    if (!shaderRef.current || !cameraRef.current) return;
    const canvas = state.gl.domElement;
    shaderRef.current.uniforms.u_resolution.value.set(
      canvas.width,
      canvas.height,
    );
    shaderRef.current.uniforms.u_camera_matrix.value =
      cameraRef.current.matrixWorld;
    shaderRef.current.uniforms.u_camera_projection_matrix_inverse.value =
      cameraRef.current.projectionMatrixInverse;
  });

  return (
    <>
      <PerspectiveCamera position={[3, 2, -3]} makeDefault ref={cameraRef} />
      <OrbitControls
        enableDamping={false}
        mouseButtons={{
          LEFT: MOUSE.ROTATE,
          MIDDLE: MOUSE.DOLLY,
          RIGHT: MOUSE.PAN,
        }}
      />
      <ScreenQuad>
        <shaderMaterial
          ref={shaderRef}
          glslVersion={GLSL3}
          uniforms={uniforms}
          vertexShader={vertexShader}
          fragmentShader={fragmentShader}
        />
      </ScreenQuad>
      <mesh>
        <boxGeometry args={[BOUNDS * 2, BOUNDS * 2, BOUNDS * 2]} />
        <meshBasicMaterial wireframe depthTest={false} color={"red"} />
      </mesh>
    </>
  );
}

export default function App() {
  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <Canvas>
        <VolumeRenderer />
      </Canvas>
    </div>
  );
}
