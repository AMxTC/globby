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
import { sdSphere, sdBox, opSmoothUnion, bakeVoxels } from "./sdf";
import { vertexShader, fragmentShader } from "./shaders";

const RESOLUTION = 128;
const BOUNDS = 2.0;

function createVolumeTexture(): Data3DTexture {
  const data = bakeVoxels(
    (p) => {
      const sphere = sdSphere([p[0] - 0.5, p[1], p[2]], 0.8);
      const box = sdBox(p, [0.5, 0.5, 0.5]);
      return opSmoothUnion(sphere, box, 0.1);
    },
    RESOLUTION,
    BOUNDS,
  );

  const texture = new Data3DTexture(data, RESOLUTION, RESOLUTION, RESOLUTION);
  texture.format = RedFormat;
  texture.type = FloatType;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

function VolumeRenderer() {
  const size = useThree((s) => s.size);
  const shaderRef = useRef<ShaderMaterial>(null!);
  const cameraRef = useRef<ThreePerspectiveCamera>(null!);

  const volumeTexture = useMemo(() => createVolumeTexture(), []);

  const uniforms = useMemo(
    () => ({
      u_resolution: { value: new Vector2(size.width, size.height) },
      u_volume: { value: volumeTexture },
      u_camera_matrix: { value: cameraRef.current?.matrixWorld },
      u_camera_projection_matrix_inverse: {
        value: cameraRef.current?.projectionMatrixInverse,
      },
      u_bounds: { value: BOUNDS },
    }),
    [volumeTexture, size.width, size.height],
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
