import type { SDFShape } from "../state/sceneStore";
import { RESOLUTION, BOUNDS, SHAPE_TYPE_GPU } from "../constants";
import type { ShapeType } from "../constants";
import bakeWgsl from "../shaders/bake.wgsl?raw";
import mipWgsl from "../shaders/mip.wgsl?raw";
import raymarchWgsl from "../shaders/raymarch.wgsl?raw";
import linesWgsl from "../shaders/lines.wgsl?raw";

const MAX_SHAPES = 64;

export interface WireframeBox {
  center: [number, number, number];
  halfSize: [number, number, number];
  color: [number, number, number, number]; // RGBA 0-1
}

// 12 edges of a box = 24 vertices (line-list)
function buildBoxWireframeVerts(
  center: [number, number, number],
  half: [number, number, number],
): Float32Array<ArrayBuffer> {
  const [cx, cy, cz] = center;
  const [hx, hy, hz] = half;

  // 8 corners
  const c = [
    [cx - hx, cy - hy, cz - hz],
    [cx + hx, cy - hy, cz - hz],
    [cx + hx, cy + hy, cz - hz],
    [cx - hx, cy + hy, cz - hz],
    [cx - hx, cy - hy, cz + hz],
    [cx + hx, cy - hy, cz + hz],
    [cx + hx, cy + hy, cz + hz],
    [cx - hx, cy + hy, cz + hz],
  ];

  // 12 edges as pairs of corner indices
  const edges = [
    0,
    1,
    1,
    2,
    2,
    3,
    3,
    0, // bottom face
    4,
    5,
    5,
    6,
    6,
    7,
    7,
    4, // top face
    0,
    4,
    1,
    5,
    2,
    6,
    3,
    7, // verticals
  ];

  const verts = new Float32Array(24 * 3);
  for (let i = 0; i < 24; i++) {
    const corner = c[edges[i]];
    verts[i * 3 + 0] = corner[0];
    verts[i * 3 + 1] = corner[1];
    verts[i * 3 + 2] = corner[2];
  }
  return verts;
}
const MIP_LEVELS = [
  { src: RESOLUTION, dst: RESOLUTION / 4 }, // 128 → 32
  { src: RESOLUTION / 4, dst: RESOLUTION / 16 }, // 32 → 8
  { src: RESOLUTION / 16, dst: RESOLUTION / 64 }, // 8 → 2
];

export class GPURenderer {
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private format!: GPUTextureFormat;

  // Textures
  private volumeTexture!: GPUTexture;
  private mipTextures!: GPUTexture[]; // 32³, 8³, 2³

  // Pipelines
  private bakePipeline!: GPUComputePipeline;
  private mipPipeline!: GPUComputePipeline;
  private renderPipeline!: GPURenderPipeline;

  // Bind group layouts
  private bakeBindGroupLayout!: GPUBindGroupLayout;
  private mipBindGroupLayout!: GPUBindGroupLayout;
  private renderBindGroupLayout!: GPUBindGroupLayout;

  // Buffers
  private bakeParamsBuffer!: GPUBuffer;
  private shapeBuffer!: GPUBuffer;
  private mipParamsBuffers!: GPUBuffer[];
  private uniformBuffer!: GPUBuffer;

  // Sampler
  private linearSampler!: GPUSampler;

  // Bind groups (recreated when textures change)
  private renderBindGroup!: GPUBindGroup;

  // World-position render target (for pointer picking)
  private worldPosTexture!: GPUTexture;
  private pickStagingBuffer!: GPUBuffer;

  // Lines rendering
  private linesPipeline!: GPURenderPipeline;
  private linesBindGroupLayout!: GPUBindGroupLayout;
  private linesVertexBuffer!: GPUBuffer;
  private linesUniformBuffer!: GPUBuffer;

  async init(canvas: HTMLCanvasElement): Promise<void> {
    if (!navigator.gpu) {
      throw new Error(
        "WebGPU not supported. Use Chrome 113+ or Edge 113+ with WebGPU enabled.",
      );
    }

    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter) throw new Error("No WebGPU adapter found");

    if (!adapter.features.has("float32-filterable")) {
      throw new Error(
        "GPU adapter does not support float32-filterable. Update your browser or GPU drivers.",
      );
    }

    this.device = await adapter.requestDevice({
      requiredFeatures: ["float32-filterable"],
    });

    const ctx = canvas.getContext("webgpu");
    if (!ctx) {
      throw new Error(
        "Failed to get WebGPU context. If in React dev mode, try refreshing.",
      );
    }
    this.context = ctx;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: "premultiplied",
    });

    this.linearSampler = this.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });

    this.createTextures();
    this.createBuffers();
    this.createWorldPosTexture(canvas.width, canvas.height);
    this.createPipelines();
    this.createRenderBindGroup();
  }

  private createTextures(): void {
    const usage =
      GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;

    this.volumeTexture = this.device.createTexture({
      size: [RESOLUTION, RESOLUTION, RESOLUTION],
      dimension: "3d",
      format: "r32float",
      usage,
    });

    this.mipTextures = MIP_LEVELS.map((level) =>
      this.device.createTexture({
        size: [level.dst, level.dst, level.dst],
        dimension: "3d",
        format: "r32float",
        usage,
      }),
    );
  }

  private createBuffers(): void {
    // Bake params: resolution(u32) + shape_count(u32) + bounds(f32) + pad(f32) = 16 bytes
    this.bakeParamsBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Shape buffer: MAX_SHAPES * 32 bytes
    this.shapeBuffer = this.device.createBuffer({
      size: MAX_SHAPES * 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Mip params: one buffer per mip pass (16 bytes each)
    this.mipParamsBuffers = MIP_LEVELS.map(() =>
      this.device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
    );

    // Write static mip params
    for (let i = 0; i < MIP_LEVELS.length; i++) {
      const data = new Uint32Array([MIP_LEVELS[i].src, 0, 0, 0]);
      this.device.queue.writeBuffer(this.mipParamsBuffers[i], 0, data);
    }

    // Render uniforms: 2 mat4 (128) + vec2 + f32 + f32 + vec3 + i32 = 128 + 8 + 4 + 4 + 12 + 4 = 160
    // Align to 16: round up → 160 is fine
    this.uniformBuffer = this.device.createBuffer({
      size: 160,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Lines vertex buffer: enough for bounds box (24 verts) + preview box (24 verts) = 48 * 12 bytes
    this.linesVertexBuffer = this.device.createBuffer({
      size: 48 * 12,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    // Lines uniform buffer: mat4 (64) + vec4 color (16) = 80 bytes
    this.linesUniformBuffer = this.device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  private createPipelines(): void {
    // === Bake pipeline ===
    this.bakeBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: "write-only",
            format: "r32float",
            viewDimension: "3d",
          },
        },
      ],
    });

    this.bakePipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.bakeBindGroupLayout],
      }),
      compute: {
        module: this.device.createShaderModule({ code: bakeWgsl }),
        entryPoint: "main",
      },
    });

    // === Mip pipeline ===
    this.mipBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: "unfilterable-float", viewDimension: "3d" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: "write-only",
            format: "r32float",
            viewDimension: "3d",
          },
        },
      ],
    });

    this.mipPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.mipBindGroupLayout],
      }),
      compute: {
        module: this.device.createShaderModule({ code: mipWgsl }),
        entryPoint: "main",
      },
    });

    // === Render pipeline ===
    this.renderBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float", viewDimension: "3d" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float", viewDimension: "3d" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float", viewDimension: "3d" },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float", viewDimension: "3d" },
        },
        {
          binding: 5,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
      ],
    });

    const shaderModule = this.device.createShaderModule({ code: raymarchWgsl });

    this.renderPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.renderBindGroupLayout],
      }),
      vertex: {
        module: shaderModule,
        entryPoint: "vs",
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs",
        targets: [
          { format: this.format },
          { format: "rgba32float", writeMask: GPUColorWrite.ALL },
        ],
      },
      primitive: {
        topology: "triangle-strip",
      },
    });

    // === Lines pipeline ===
    this.linesBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });

    const linesModule = this.device.createShaderModule({ code: linesWgsl });

    this.linesPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.linesBindGroupLayout],
      }),
      vertex: {
        module: linesModule,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: 12,
            attributes: [
              {
                shaderLocation: 0,
                offset: 0,
                format: "float32x3" as GPUVertexFormat,
              },
            ],
          },
        ],
      },
      fragment: {
        module: linesModule,
        entryPoint: "fs",
        targets: [
          {
            format: this.format,
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
              },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
            },
          },
        ],
      },
      primitive: {
        topology: "line-list",
      },
    });
  }

  private createRenderBindGroup(): void {
    this.renderBindGroup = this.device.createBindGroup({
      layout: this.renderBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.volumeTexture.createView() },
        { binding: 2, resource: this.mipTextures[0].createView() },
        { binding: 3, resource: this.mipTextures[1].createView() },
        { binding: 4, resource: this.mipTextures[2].createView() },
        { binding: 5, resource: this.linearSampler },
      ],
    });
  }

  private createWorldPosTexture(width: number, height: number): void {
    this.worldPosTexture?.destroy();
    this.pickStagingBuffer?.destroy();
    this.worldPosTexture = this.device.createTexture({
      size: [width, height],
      format: "rgba32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    // Staging buffer for one pixel: 4 x f32 = 16 bytes, rounded up to 256 for alignment
    this.pickStagingBuffer = this.device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  async pickWorldPos(
    pixelX: number,
    pixelY: number,
  ): Promise<[number, number, number] | null> {
    const w = this.worldPosTexture.width;
    const h = this.worldPosTexture.height;
    const x = Math.max(0, Math.min(Math.floor(pixelX), w - 1));
    const y = Math.max(0, Math.min(Math.floor(pixelY), h - 1));

    const encoder = this.device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: this.worldPosTexture, origin: [x, y, 0] },
      { buffer: this.pickStagingBuffer, bytesPerRow: 256 },
      [1, 1, 1],
    );
    this.device.queue.submit([encoder.finish()]);

    await this.pickStagingBuffer.mapAsync(GPUMapMode.READ);
    const data = new Float32Array(this.pickStagingBuffer.getMappedRange(0, 16));
    const result: [number, number, number] | null =
      data[3] > 0.5 ? [data[0], data[1], data[2]] : null;
    this.pickStagingBuffer.unmap();
    return result;
  }

  bake(shapes: readonly SDFShape[]): void {
    const shapeCount = Math.min(shapes.length, MAX_SHAPES);

    // Write bake params
    const params = new ArrayBuffer(16);
    const paramsU32 = new Uint32Array(params);
    const paramsF32 = new Float32Array(params);
    paramsU32[0] = RESOLUTION;
    paramsU32[1] = shapeCount;
    paramsF32[2] = BOUNDS;
    paramsF32[3] = 0; // pad
    this.device.queue.writeBuffer(this.bakeParamsBuffer, 0, params);

    // Write shape data
    if (shapeCount > 0) {
      const buf = new ArrayBuffer(shapeCount * 32);
      const f32 = new Float32Array(buf);
      const u32 = new Uint32Array(buf);
      for (let i = 0; i < shapeCount; i++) {
        const s = shapes[i];
        const off = i * 8;
        f32[off + 0] = s.position[0];
        f32[off + 1] = s.position[1];
        f32[off + 2] = s.position[2];
        u32[off + 3] = SHAPE_TYPE_GPU[s.type as ShapeType];
        f32[off + 4] = s.size[0];
        f32[off + 5] = s.size[1];
        f32[off + 6] = s.size[2];
        f32[off + 7] = 0; // pad
      }
      this.device.queue.writeBuffer(this.shapeBuffer, 0, buf);
    }

    const encoder = this.device.createCommandEncoder();

    // Bake pass
    const bakeBindGroup = this.device.createBindGroup({
      layout: this.bakeBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.bakeParamsBuffer } },
        { binding: 1, resource: { buffer: this.shapeBuffer } },
        { binding: 2, resource: this.volumeTexture.createView() },
      ],
    });

    const bakePass = encoder.beginComputePass();
    bakePass.setPipeline(this.bakePipeline);
    bakePass.setBindGroup(0, bakeBindGroup);
    const wg = RESOLUTION / 4;
    bakePass.dispatchWorkgroups(wg, wg, wg);
    bakePass.end();

    // Mip passes
    const mipSources = [this.volumeTexture, ...this.mipTextures];
    for (let i = 0; i < MIP_LEVELS.length; i++) {
      const mipBindGroup = this.device.createBindGroup({
        layout: this.mipBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.mipParamsBuffers[i] } },
          { binding: 1, resource: mipSources[i].createView() },
          { binding: 2, resource: this.mipTextures[i].createView() },
        ],
      });

      const mipPass = encoder.beginComputePass();
      mipPass.setPipeline(this.mipPipeline);
      mipPass.setBindGroup(0, mipBindGroup);
      const mipWg = Math.max(MIP_LEVELS[i].dst / 4, 1);
      mipPass.dispatchWorkgroups(mipWg, mipWg, mipWg);
      mipPass.end();
    }

    this.device.queue.submit([encoder.finish()]);
  }

  render(
    cameraMatrixWorld: Float32Array,
    cameraProjectionMatrixInverse: Float32Array,
    viewProjectionMatrix: Float32Array,
    width: number,
    height: number,
    wireframes: WireframeBox[],
  ): void {
    // Write raymarcher uniforms
    const data = new ArrayBuffer(160);
    const f32 = new Float32Array(data);
    const i32 = new Int32Array(data);

    f32.set(cameraMatrixWorld, 0);
    f32.set(cameraProjectionMatrixInverse, 16);
    f32[32] = width;
    f32[33] = height;
    f32[34] = BOUNDS;
    f32[35] = RESOLUTION;
    f32[36] = MIP_LEVELS[0].dst;
    f32[37] = MIP_LEVELS[1].dst;
    f32[38] = MIP_LEVELS[2].dst;
    i32[39] = MIP_LEVELS.length;

    this.device.queue.writeBuffer(this.uniformBuffer, 0, data);

    const encoder = this.device.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();

    // Raymarcher pass (color + world position)
    const worldPosView = this.worldPosTexture.createView();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: textureView,
          loadOp: "clear" as GPULoadOp,
          storeOp: "store" as GPUStoreOp,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
        {
          view: worldPosView,
          loadOp: "clear" as GPULoadOp,
          storeOp: "store" as GPUStoreOp,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });

    pass.setPipeline(this.renderPipeline);
    pass.setBindGroup(0, this.renderBindGroup);
    pass.draw(4);
    pass.end();

    // Lines pass (wireframes overlay)
    if (wireframes.length > 0) {
      const linesPass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: textureView,
            loadOp: "load" as GPULoadOp,
            storeOp: "store" as GPUStoreOp,
          },
        ],
      });

      linesPass.setPipeline(this.linesPipeline);

      for (let i = 0; i < wireframes.length; i++) {
        const wf = wireframes[i];
        const verts = buildBoxWireframeVerts(wf.center, wf.halfSize);
        const vertexOffset = i * 24 * 12; // 24 vertices * 12 bytes per vertex
        this.device.queue.writeBuffer(this.linesVertexBuffer, vertexOffset, verts);

        // Write lines uniforms: viewProj (64 bytes) + color (16 bytes)
        const lineUniforms = new Float32Array(20);
        lineUniforms.set(viewProjectionMatrix, 0);
        lineUniforms[16] = wf.color[0];
        lineUniforms[17] = wf.color[1];
        lineUniforms[18] = wf.color[2];
        lineUniforms[19] = wf.color[3];
        this.device.queue.writeBuffer(this.linesUniformBuffer, 0, lineUniforms);

        const bindGroup = this.device.createBindGroup({
          layout: this.linesBindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: this.linesUniformBuffer } },
          ],
        });

        linesPass.setBindGroup(0, bindGroup);
        linesPass.setVertexBuffer(0, this.linesVertexBuffer, vertexOffset);
        linesPass.draw(24); // 12 edges * 2 verts
      }

      linesPass.end();
    }

    this.device.queue.submit([encoder.finish()]);
  }

  resize(width: number, height: number): void {
    const canvas = this.context.canvas as HTMLCanvasElement;
    canvas.width = width;
    canvas.height = height;
    this.createWorldPosTexture(width, height);
  }

  destroy(): void {
    this.context?.unconfigure();
    this.volumeTexture?.destroy();
    this.mipTextures?.forEach((t) => t.destroy());
    this.worldPosTexture?.destroy();
    this.pickStagingBuffer?.destroy();
    this.bakeParamsBuffer?.destroy();
    this.shapeBuffer?.destroy();
    this.mipParamsBuffers?.forEach((b) => b.destroy());
    this.uniformBuffer?.destroy();
    // Don't call device.destroy() — it invalidates the canvas context
    // permanently, breaking React StrictMode's double-invoke in dev.
    // The device will be GC'd when no longer referenced.
  }
}
