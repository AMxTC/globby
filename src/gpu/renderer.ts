import { sceneState, type SDFShape } from "../state/sceneStore";
import {
  SHAPE_TYPE_GPU,
  TRANSFER_MODE_GPU,
  VOXEL_SIZE,
  CHUNK_SLOT_SIZE,
  CHUNK_WORLD_SIZE,
  CHUNK_WORKGROUPS,
  ATLAS_SLOTS,
  CHUNK_MAP_SIZE,
} from "../constants";
import type { ShapeType, TransferMode } from "../constants";
import { ChunkManager } from "./chunkManager";
import bakeWgsl from "../shaders/bake.wgsl?raw";
import chunkReduceWgsl from "../shaders/chunkReduce.wgsl?raw";
import raymarchWgsl from "../shaders/raymarch.wgsl?raw";
import linesWgsl from "../shaders/lines.wgsl?raw";

const MAX_SHAPES = 64;
const UNIFORM_SIZE = 240; // aligned to 16

export interface WireframeBox {
  center: [number, number, number];
  halfSize: [number, number, number];
  color: [number, number, number, number];
}

// 12 edges of a box = 24 vertices (line-list)
function buildBoxWireframeVerts(
  center: [number, number, number],
  half: [number, number, number],
): Float32Array<ArrayBuffer> {
  const [cx, cy, cz] = center;
  const [hx, hy, hz] = half;

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

  const edges = [
    0, 1, 1, 2, 2, 3, 3, 0,
    4, 5, 5, 6, 6, 7, 7, 4,
    0, 4, 1, 5, 2, 6, 3, 7,
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

export class GPURenderer {
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private format!: GPUTextureFormat;

  // Chunk system
  private chunkManager = new ChunkManager();

  // Textures
  private atlasTexture!: GPUTexture;
  private chunkMapTexture!: GPUTexture;
  private chunkDistTexture!: GPUTexture;

  // Pipelines
  private bakePipeline!: GPUComputePipeline;
  private chunkReducePipeline!: GPUComputePipeline;
  private renderPipeline!: GPURenderPipeline;

  // Bind group layouts
  private bakeBindGroupLayout!: GPUBindGroupLayout;
  private chunkReduceBindGroupLayout!: GPUBindGroupLayout;
  private renderBindGroupLayout!: GPUBindGroupLayout;

  // Buffers
  private bakeParamsBuffer!: GPUBuffer;
  private shapeBuffer!: GPUBuffer;
  private reduceParamsBuffer!: GPUBuffer;
  private uniformBuffer!: GPUBuffer;

  // Sampler
  private linearSampler!: GPUSampler;

  // Bind groups
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
    // Atlas: ATLAS_SLOTS * CHUNK_SLOT_SIZE in each dimension
    this.atlasTexture = this.device.createTexture({
      size: [
        ATLAS_SLOTS[0] * CHUNK_SLOT_SIZE,
        ATLAS_SLOTS[1] * CHUNK_SLOT_SIZE,
        ATLAS_SLOTS[2] * CHUNK_SLOT_SIZE,
      ],
      dimension: "3d",
      format: "r32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });

    // Chunk map: 64³ r32sint
    this.chunkMapTexture = this.device.createTexture({
      size: [CHUNK_MAP_SIZE, CHUNK_MAP_SIZE, CHUNK_MAP_SIZE],
      dimension: "3d",
      format: "r32sint",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    // Chunk distance: 64³ r32float
    this.chunkDistTexture = this.device.createTexture({
      size: [CHUNK_MAP_SIZE, CHUNK_MAP_SIZE, CHUNK_MAP_SIZE],
      dimension: "3d",
      format: "r32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
  }

  private createBuffers(): void {
    // Bake params: 32 bytes per chunk, 256-byte aligned, up to 64 chunks per batch
    this.bakeParamsBuffer = this.device.createBuffer({
      size: 256 * 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Shape buffer: MAX_SHAPES * 32 bytes
    this.shapeBuffer = this.device.createBuffer({
      size: MAX_SHAPES * 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Reduce params: 32 bytes per chunk, 256-byte aligned, up to 64 chunks per batch
    this.reduceParamsBuffer = this.device.createBuffer({
      size: 256 * 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Render uniforms: 240 bytes
    this.uniformBuffer = this.device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Lines vertex buffer (up to 1030 wireframe boxes: 1024 debug chunks + 6 UI)
    this.linesVertexBuffer = this.device.createBuffer({
      size: 24 * 12 * 1030,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    // Lines uniform buffer (color groups, 256-byte stride, up to 16 groups)
    this.linesUniformBuffer = this.device.createBuffer({
      size: 256 * 16,
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
          buffer: { type: "uniform", hasDynamicOffset: true },
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

    // === Chunk reduce pipeline ===
    this.chunkReduceBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform", hasDynamicOffset: true },
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

    this.chunkReducePipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.chunkReduceBindGroupLayout],
      }),
      compute: {
        module: this.device.createShaderModule({ code: chunkReduceWgsl }),
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
          texture: { sampleType: "sint", viewDimension: "3d" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "unfilterable-float", viewDimension: "3d" },
        },
        {
          binding: 4,
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
          buffer: { type: "uniform", hasDynamicOffset: true },
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
        { binding: 1, resource: this.atlasTexture.createView() },
        { binding: 2, resource: this.chunkMapTexture.createView() },
        { binding: 3, resource: this.chunkDistTexture.createView() },
        { binding: 4, resource: this.linearSampler },
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
    // Sort shapes by layer order (bottom layer first)
    const layers = sceneState.layers;
    const layerOrder = new Map<string, number>();
    for (let i = 0; i < layers.length; i++) {
      layerOrder.set(layers[i].id, i);
    }
    const hiddenLayers = new Set<string>();
    const layerInfo = new Map<string, { mode: TransferMode; opacity: number; param: number }>();
    for (const l of layers) {
      layerInfo.set(l.id, { mode: l.transferMode as TransferMode, opacity: l.opacity, param: l.transferParam });
      if (!l.visible) hiddenLayers.add(l.id);
    }

    const sorted = [...shapes].filter((s) => !hiddenLayers.has(s.layerId)).sort((a, b) => {
      return (layerOrder.get(a.layerId) ?? 0) - (layerOrder.get(b.layerId) ?? 0);
    });

    const shapeCount = Math.min(sorted.length, MAX_SHAPES);

    // Sync chunk manager with current shapes
    const { dirtyChunks, chunkMapData } = this.chunkManager.sync(shapes);

    // Upload chunk map
    this.device.queue.writeTexture(
      { texture: this.chunkMapTexture },
      chunkMapData.buffer,
      {
        bytesPerRow: CHUNK_MAP_SIZE * 4,
        rowsPerImage: CHUNK_MAP_SIZE,
      },
      [CHUNK_MAP_SIZE, CHUNK_MAP_SIZE, CHUNK_MAP_SIZE],
    );

    // Write shape data once
    if (shapeCount > 0) {
      const buf = new ArrayBuffer(shapeCount * 32);
      const f32 = new Float32Array(buf);
      const u32 = new Uint32Array(buf);
      for (let i = 0; i < shapeCount; i++) {
        const s = sorted[i];
        const off = i * 8;
        f32[off + 0] = s.position[0];
        f32[off + 1] = s.position[1];
        f32[off + 2] = s.position[2];
        u32[off + 3] = SHAPE_TYPE_GPU[s.type as ShapeType];
        f32[off + 4] = s.size[0];
        f32[off + 5] = s.size[1];
        f32[off + 6] = s.size[2];
        const info = layerInfo.get(s.layerId);
        const mode = info?.mode ?? "union";
        const opacity = info?.opacity ?? 1;
        const param = info?.param ?? 0.5;
        // Pack: bits 0-7 = mode, bits 8-19 = opacity*4095, bits 20-31 = param*4095
        u32[off + 7] =
          (TRANSFER_MODE_GPU[mode] & 0xFF) |
          ((Math.round(opacity * 4095) & 0xFFF) << 8) |
          ((Math.round(param * 4095) & 0xFFF) << 20);
      }
      this.device.queue.writeBuffer(this.shapeBuffer, 0, buf);
    }

    if (dirtyChunks.length === 0) return;

    // Process in batches of 64 (buffer capacity)
    const BATCH_SIZE = 64;
    for (let batchStart = 0; batchStart < dirtyChunks.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, dirtyChunks.length);
      const batchCount = batchEnd - batchStart;

      // Upload all bake + reduce params for this batch upfront (256-byte stride)
      for (let i = 0; i < batchCount; i++) {
        const chunk = dirtyChunks[batchStart + i];
        const origin = ChunkManager.chunkOrigin(chunk.cx, chunk.cy, chunk.cz);
        const atlasOffset = ChunkManager.atlasSlotToOffset(chunk.slotIndex);

        const bakeParams = new ArrayBuffer(32);
        const bpF32 = new Float32Array(bakeParams);
        const bpU32 = new Uint32Array(bakeParams);
        bpF32[0] = origin[0];
        bpF32[1] = origin[1];
        bpF32[2] = origin[2];
        bpU32[3] = shapeCount;
        bpU32[4] = atlasOffset[0];
        bpU32[5] = atlasOffset[1];
        bpU32[6] = atlasOffset[2];
        bpF32[7] = VOXEL_SIZE;
        this.device.queue.writeBuffer(this.bakeParamsBuffer, i * 256, bakeParams);

        const half = CHUNK_MAP_SIZE / 2;
        const reduceParams = new ArrayBuffer(32);
        const rpU32 = new Uint32Array(reduceParams);
        rpU32[0] = atlasOffset[0];
        rpU32[1] = atlasOffset[1];
        rpU32[2] = atlasOffset[2];
        rpU32[3] = 0;
        rpU32[4] = chunk.cx + half;
        rpU32[5] = chunk.cy + half;
        rpU32[6] = chunk.cz + half;
        rpU32[7] = 0;
        this.device.queue.writeBuffer(this.reduceParamsBuffer, i * 256, reduceParams);
      }

      const encoder = this.device.createCommandEncoder();
      const atlasView = this.atlasTexture.createView();
      const chunkDistView = this.chunkDistTexture.createView();

      const bakeBindGroup = this.device.createBindGroup({
        layout: this.bakeBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.bakeParamsBuffer, size: 32 } },
          { binding: 1, resource: { buffer: this.shapeBuffer } },
          { binding: 2, resource: atlasView },
        ],
      });

      const reduceBindGroup = this.device.createBindGroup({
        layout: this.chunkReduceBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.reduceParamsBuffer, size: 32 } },
          { binding: 1, resource: atlasView },
          { binding: 2, resource: chunkDistView },
        ],
      });

      for (let i = 0; i < batchCount; i++) {
        const offset = i * 256;

        const bakePass = encoder.beginComputePass();
        bakePass.setPipeline(this.bakePipeline);
        bakePass.setBindGroup(0, bakeBindGroup, [offset]);
        bakePass.dispatchWorkgroups(CHUNK_WORKGROUPS, CHUNK_WORKGROUPS, CHUNK_WORKGROUPS);
        bakePass.end();

        const reducePass = encoder.beginComputePass();
        reducePass.setPipeline(this.chunkReducePipeline);
        reducePass.setBindGroup(0, reduceBindGroup, [offset]);
        reducePass.dispatchWorkgroups(1, 1, 1);
        reducePass.end();
      }

      this.device.queue.submit([encoder.finish()]);
    }
  }

  render(
    cameraMatrixWorld: Float32Array,
    cameraProjectionMatrixInverse: Float32Array,
    viewProjectionMatrix: Float32Array,
    width: number,
    height: number,
    wireframes: WireframeBox[],
  ): void {
    // Write uniforms (240 bytes)
    const data = new ArrayBuffer(UNIFORM_SIZE);
    const f32 = new Float32Array(data);
    const i32 = new Int32Array(data);
    const u32 = new Uint32Array(data);

    // 0-15: camera_matrix (64 bytes)
    f32.set(cameraMatrixWorld, 0);
    // 16-31: proj_matrix_inverse (64 bytes)
    f32.set(cameraProjectionMatrixInverse, 16);
    // 32-33: resolution (8 bytes)
    f32[32] = width;
    f32[33] = height;
    // 34: voxel_size
    f32[34] = VOXEL_SIZE;
    // 35: chunk_world_size
    f32[35] = CHUNK_WORLD_SIZE;
    // 36-38: chunk_map_offset (vec3<i32>) + pad at 39
    const mapOffset = this.chunkManager.getChunkMapOffset();
    i32[36] = mapOffset[0];
    i32[37] = mapOffset[1];
    i32[38] = mapOffset[2];
    i32[39] = 0; // pad
    // 40-42: chunk_map_size (vec3<u32>) + pad at 43
    u32[40] = CHUNK_MAP_SIZE;
    u32[41] = CHUNK_MAP_SIZE;
    u32[42] = CHUNK_MAP_SIZE;
    u32[43] = 0; // pad
    // 44-46: atlas_slots (vec3<u32>) + pad at 47
    u32[44] = ATLAS_SLOTS[0];
    u32[45] = ATLAS_SLOTS[1];
    u32[46] = ATLAS_SLOTS[2];
    u32[47] = 0; // pad
    // 48: max_distance, show_ground_plane, 2 pad
    f32[48] = 100.0;
    u32[49] = sceneState.showGroundPlane ? 1 : 0;
    f32[50] = 0;
    f32[51] = 0;
    // 52-54: world_bounds_min (vec3<f32>) + pad at 55
    const bmin = this.chunkManager.worldBoundsMin;
    f32[52] = bmin[0];
    f32[53] = bmin[1];
    f32[54] = bmin[2];
    f32[55] = 0;
    // 56-58: world_bounds_max (vec3<f32>) + pad at 59
    const bmax = this.chunkManager.worldBoundsMax;
    f32[56] = bmax[0];
    f32[57] = bmax[1];
    f32[58] = bmax[2];
    f32[59] = 0;

    this.device.queue.writeBuffer(this.uniformBuffer, 0, data);

    const encoder = this.device.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();

    // Raymarcher pass
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

      // Group wireframes by color to batch draw calls
      const colorGroups = new Map<string, { color: [number, number, number, number]; boxes: WireframeBox[] }>();
      for (const wf of wireframes) {
        const key = wf.color.join(",");
        let group = colorGroups.get(key);
        if (!group) {
          group = { color: wf.color, boxes: [] };
          colorGroups.set(key, group);
        }
        group.boxes.push(wf);
      }

      // Write uniforms for each color group (one per 256-byte slot)
      let uniformSlot = 0;
      const draws: { uniformOffset: number; vertexOffset: number; vertexCount: number }[] = [];
      let vertexOffset = 0;

      for (const group of colorGroups.values()) {
        if (uniformSlot >= 256) break;

        const lineUniforms = new Float32Array(20);
        lineUniforms.set(viewProjectionMatrix, 0);
        lineUniforms[16] = group.color[0];
        lineUniforms[17] = group.color[1];
        lineUniforms[18] = group.color[2];
        lineUniforms[19] = group.color[3];
        this.device.queue.writeBuffer(this.linesUniformBuffer, uniformSlot * 256, lineUniforms);

        // Write all box vertices for this group contiguously
        const boxCount = group.boxes.length;
        const totalVerts = boxCount * 24;
        const batchVerts = new Float32Array(totalVerts * 3);
        for (let i = 0; i < boxCount; i++) {
          const wf = group.boxes[i];
          const verts = buildBoxWireframeVerts(wf.center, wf.halfSize);
          batchVerts.set(verts, i * 24 * 3);
        }
        this.device.queue.writeBuffer(this.linesVertexBuffer, vertexOffset, batchVerts);

        draws.push({
          uniformOffset: uniformSlot * 256,
          vertexOffset,
          vertexCount: totalVerts,
        });

        vertexOffset += batchVerts.byteLength;
        uniformSlot++;
      }

      const bindGroup = this.device.createBindGroup({
        layout: this.linesBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.linesUniformBuffer, size: 80 } },
        ],
      });

      for (const draw of draws) {
        linesPass.setBindGroup(0, bindGroup, [draw.uniformOffset]);
        linesPass.setVertexBuffer(0, this.linesVertexBuffer, draw.vertexOffset);
        linesPass.draw(draw.vertexCount);
      }

      linesPass.end();
    }

    this.device.queue.submit([encoder.finish()]);
  }

  getDebugChunkOrigins(): [number, number, number][] {
    return this.chunkManager.getAllocatedChunkOrigins();
  }

  getDebugWorldBounds(): { min: [number, number, number]; max: [number, number, number] } {
    return {
      min: this.chunkManager.worldBoundsMin,
      max: this.chunkManager.worldBoundsMax,
    };
  }

  getDebugChunkStats(): { used: number; max: number } {
    return {
      used: this.chunkManager.getAllocatedChunkCount(),
      max: this.chunkManager.getMaxChunks(),
    };
  }

  resize(width: number, height: number): void {
    const canvas = this.context.canvas as HTMLCanvasElement;
    canvas.width = width;
    canvas.height = height;
    this.createWorldPosTexture(width, height);
  }

  destroy(): void {
    this.context?.unconfigure();
    this.atlasTexture?.destroy();
    this.chunkMapTexture?.destroy();
    this.chunkDistTexture?.destroy();
    this.worldPosTexture?.destroy();
    this.pickStagingBuffer?.destroy();
    this.bakeParamsBuffer?.destroy();
    this.shapeBuffer?.destroy();
    this.reduceParamsBuffer?.destroy();
    this.uniformBuffer?.destroy();
    this.linesVertexBuffer?.destroy();
    this.linesUniformBuffer?.destroy();
  }
}
