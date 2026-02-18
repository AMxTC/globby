import { sceneState, type SDFShape } from "../state/sceneStore";
import { eulerToMatrix3 } from "../lib/math3d";
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
import { generateBakeShader, type FxSlot } from "./bakegen";
import chunkReduceWgsl from "../shaders/chunkReduce.wgsl?raw";
import raymarchWgsl from "../shaders/raymarch.wgsl?raw";
import linesWgsl from "../shaders/lines.wgsl?raw";

const MAX_SHAPES = 64;
const UNIFORM_SIZE = 240; // aligned to 16

export interface WireframeBox {
  center: [number, number, number];
  halfSize: [number, number, number];
  color: [number, number, number, number];
  rotation?: [number, number, number];
  scale?: number;
}

// 12 edges of a box = 24 vertices (line-list)
function buildBoxWireframeVerts(
  center: [number, number, number],
  half: [number, number, number],
  rotation?: [number, number, number],
  scale?: number,
): Float32Array<ArrayBuffer> {
  const [cx, cy, cz] = center;
  const [hx, hy, hz] = half;

  // Local-space corners (centered at origin)
  const localCorners = [
    [-hx, -hy, -hz],
    [+hx, -hy, -hz],
    [+hx, +hy, -hz],
    [-hx, +hy, -hz],
    [-hx, -hy, +hz],
    [+hx, -hy, +hz],
    [+hx, +hy, +hz],
    [-hx, +hy, +hz],
  ];

  const hasRotation = rotation && (rotation[0] !== 0 || rotation[1] !== 0 || rotation[2] !== 0);
  const s = scale ?? 1;

  let c: number[][];
  if (hasRotation || s !== 1) {
    const m = eulerToMatrix3(rotation?.[0] ?? 0, rotation?.[1] ?? 0, rotation?.[2] ?? 0);
    c = localCorners.map(([lx, ly, lz]) => {
      const sx = lx * s, sy = ly * s, sz = lz * s;
      return [
        cx + m[0] * sx + m[3] * sy + m[6] * sz,
        cy + m[1] * sx + m[4] * sy + m[7] * sz,
        cz + m[2] * sx + m[5] * sy + m[8] * sz,
      ];
    });
  } else {
    c = localCorners.map(([lx, ly, lz]) => [cx + lx, cy + ly, cz + lz]);
  }

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
  private shapeIdAtlasTexture!: GPUTexture;
  private chunkMapTexture!: GPUTexture;
  private chunkDistTexture!: GPUTexture;

  // Shape index → shape ID mapping from last bake
  private lastBakeShapeIds: string[] = [];

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
  private polygonVertexBuffer!: GPUBuffer;
  private reduceParamsBuffer!: GPUBuffer;
  private uniformBuffer!: GPUBuffer;

  // Sampler
  private linearSampler!: GPUSampler;

  // Bind groups
  private renderBindGroup!: GPUBindGroup;

  // World-position render target (for pointer picking)
  private worldPosTexture!: GPUTexture;
  private pickStagingBuffer!: GPUBuffer;
  private regionStagingBuffer: GPUBuffer | null = null;
  private regionStagingBusy = false;

  // Lines rendering
  private linesPipeline!: GPURenderPipeline;
  private linesBindGroupLayout!: GPUBindGroupLayout;
  private linesVertexBuffer!: GPUBuffer;
  private linesUniformBuffer!: GPUBuffer;

  // Fx pipeline management
  private lastBakeShaderCode = '';
  private pipelineGeneration = 0;
  private fallbackPipeline!: GPUComputePipeline; // flat NO_FX pipeline, always valid

  // Pre-allocated typed arrays to avoid per-frame allocations
  private readonly uniformData = new ArrayBuffer(UNIFORM_SIZE);
  private readonly uniformF32 = new Float32Array(this.uniformData);
  private readonly uniformI32 = new Int32Array(this.uniformData);
  private readonly uniformU32 = new Uint32Array(this.uniformData);
  private readonly bakeParamsBuf = new ArrayBuffer(32);
  private readonly bakeParamsF32 = new Float32Array(this.bakeParamsBuf);
  private readonly bakeParamsU32 = new Uint32Array(this.bakeParamsBuf);
  private readonly reduceParamsBuf = new ArrayBuffer(32);
  private readonly reduceParamsU32 = new Uint32Array(this.reduceParamsBuf);

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

    // Shape ID atlas: same dimensions, r32uint
    this.shapeIdAtlasTexture = this.device.createTexture({
      size: [
        ATLAS_SLOTS[0] * CHUNK_SLOT_SIZE,
        ATLAS_SLOTS[1] * CHUNK_SLOT_SIZE,
        ATLAS_SLOTS[2] * CHUNK_SLOT_SIZE,
      ],
      dimension: "3d",
      format: "r32uint",
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

    // Shape buffer: MAX_SHAPES * 64 bytes (48 + fx_info + 3 pad)
    this.shapeBuffer = this.device.createBuffer({
      size: MAX_SHAPES * 64,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Polygon vertex buffer: MAX_SHAPES * 16 vec2s * 8 bytes = MAX_SHAPES * 128 bytes
    this.polygonVertexBuffer = this.device.createBuffer({
      size: MAX_SHAPES * 16 * 2 * 4,
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
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: {
            access: "write-only",
            format: "r32uint",
            viewDimension: "3d",
          },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" },
        },
      ],
    });

    const initialBakeCode = generateBakeShader([], []);
    this.lastBakeShaderCode = initialBakeCode;
    this.bakePipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.bakeBindGroupLayout],
      }),
      compute: {
        module: this.device.createShaderModule({ code: initialBakeCode }),
        entryPoint: "main",
      },
    });
    this.fallbackPipeline = this.bakePipeline;

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
        {
          binding: 5,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "uint", viewDimension: "3d" },
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
        { binding: 5, resource: this.shapeIdAtlasTexture.createView() },
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
  ): Promise<{ worldPos: [number, number, number]; shapeId: string | null } | null> {
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
    const alpha = data[3];
    const worldPos: [number, number, number] = [data[0], data[1], data[2]];
    this.pickStagingBuffer.unmap();

    if (alpha < 0.5) return null;

    const shapeIdx = Math.round(alpha) - 1;
    const shapeId = shapeIdx >= 0 && shapeIdx < this.lastBakeShapeIds.length
      ? this.lastBakeShapeIds[shapeIdx]
      : null;
    return { worldPos, shapeId };
  }

  async pickRegionShapeIds(
    x: number, y: number, w: number, h: number,
  ): Promise<Set<string>> {
    const texW = this.worldPosTexture.width;
    const texH = this.worldPosTexture.height;

    // Clamp rect to texture bounds
    const x0 = Math.max(0, Math.min(Math.floor(x), texW - 1));
    const y0 = Math.max(0, Math.min(Math.floor(y), texH - 1));
    const x1 = Math.max(0, Math.min(Math.floor(x + w), texW));
    const y1 = Math.max(0, Math.min(Math.floor(y + h), texH));
    const rw = x1 - x0;
    const rh = y1 - y0;
    if (rw <= 0 || rh <= 0) return new Set();

    // bytesPerRow must be multiple of 256 for WebGPU
    const bytesPerPixel = 16; // rgba32float
    const bytesPerRow = Math.ceil((rw * bytesPerPixel) / 256) * 256;
    const bufferSize = bytesPerRow * rh;

    // Reuse or create staging buffer (create fresh if previous is still mapped)
    if (!this.regionStagingBuffer || this.regionStagingBuffer.size < bufferSize || this.regionStagingBusy) {
      if (!this.regionStagingBusy) this.regionStagingBuffer?.destroy();
      this.regionStagingBuffer = this.device.createBuffer({
        size: bufferSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
    }

    const buf = this.regionStagingBuffer;
    this.regionStagingBusy = true;

    const encoder = this.device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: this.worldPosTexture, origin: [x0, y0, 0] },
      { buffer: buf, bytesPerRow, rowsPerImage: rh },
      [rw, rh, 1],
    );
    this.device.queue.submit([encoder.finish()]);

    await buf.mapAsync(GPUMapMode.READ);
    const data = new Float32Array(buf.getMappedRange());

    const ids = new Set<string>();
    const floatsPerRow = bytesPerRow / 4;
    for (let row = 0; row < rh; row++) {
      const rowOffset = row * floatsPerRow;
      for (let col = 0; col < rw; col++) {
        const alpha = data[rowOffset + col * 4 + 3];
        if (alpha < 0.5) continue;
        const shapeIdx = Math.round(alpha) - 1;
        if (shapeIdx >= 0 && shapeIdx < this.lastBakeShapeIds.length) {
          ids.add(this.lastBakeShapeIds[shapeIdx]);
        }
      }
    }

    buf.unmap();
    this.regionStagingBusy = false;
    return ids;
  }

  private async tryRebuildBakePipeline(code: string): Promise<void> {
    const gen = ++this.pipelineGeneration;
    sceneState.fxCompiling = true;
    try {
      const module = this.device.createShaderModule({ code });
      const info = await module.getCompilationInfo();
      if (gen !== this.pipelineGeneration) return; // superseded by newer compilation
      const errors = info.messages.filter(m => m.type === 'error');
      if (errors.length > 0) {
        sceneState.fxError = errors.map(e => `Line ${e.lineNum}: ${e.message}`).join('\n');
        return;
      }
      sceneState.fxError = null;
      this.bakePipeline = this.device.createComputePipeline({
        layout: this.device.createPipelineLayout({
          bindGroupLayouts: [this.bakeBindGroupLayout],
        }),
        compute: { module, entryPoint: 'main' },
      });
      // Force full rebake with the new fx pipeline
      this.chunkManager.markAllDirty();
      this.bake(sceneState.shapes as SDFShape[]);
    } finally {
      if (gen === this.pipelineGeneration) {
        sceneState.fxCompiling = false;
      }
    }
  }

  bake(shapes: readonly SDFShape[]): void {
    // Sort shapes by layer order (bottom layer first)
    const layers = sceneState.layers;
    const layerOrder = new Map<string, number>();
    for (let i = 0; i < layers.length; i++) {
      layerOrder.set(layers[i].id, i);
    }
    const hiddenLayers = new Set<string>();
    const layerInfo = new Map<string, { mode: TransferMode; opacity: number; param: number; fxParams: [number, number, number] }>();
    for (const l of layers) {
      layerInfo.set(l.id, { mode: l.transferMode as TransferMode, opacity: l.opacity, param: l.transferParam, fxParams: l.fxParams ?? [0, 0, 0] });
      if (!l.visible) hiddenLayers.add(l.id);
    }

    const sorted = [...shapes].filter((s) => !hiddenLayers.has(s.layerId)).sort((a, b) => {
      return (layerOrder.get(a.layerId) ?? 0) - (layerOrder.get(b.layerId) ?? 0);
    });

    const shapeCount = Math.min(sorted.length, MAX_SHAPES);

    // Store shape index → ID mapping for pick readback
    if (this.lastBakeShapeIds.length !== shapeCount) {
      this.lastBakeShapeIds.length = shapeCount;
    }
    for (let i = 0; i < shapeCount; i++) {
      this.lastBakeShapeIds[i] = sorted[i].id;
    }

    // Build fx slots: deduplicate identical fx code into numbered slots.
    // Slots are stable across shape add/remove — only change when fx text changes
    // or fx is toggled on/off.
    const shapeFxSlots: FxSlot[] = [];
    const shapeFxCodeToSlot = new Map<string, number>();
    // Map shape ID → shape fx slot for GPU data writing
    const shapeIdToFxSlot = new Map<string, number>();
    for (let i = 0; i < shapeCount; i++) {
      const s = sorted[i];
      if (!s.fx) continue;
      let slot = shapeFxCodeToSlot.get(s.fx);
      if (slot === undefined) {
        slot = shapeFxSlots.length + 1; // 1-based
        shapeFxCodeToSlot.set(s.fx, slot);
        shapeFxSlots.push({ slot, code: s.fx });
      }
      shapeIdToFxSlot.set(s.id, slot);
    }

    const layerFxSlots: FxSlot[] = [];
    const layerFxCodeToSlot = new Map<string, number>();
    // Map layer ID → layer fx slot
    const layerIdToFxSlot = new Map<string, number>();
    for (const l of layers) {
      if (hiddenLayers.has(l.id) || !l.fx) continue;
      let slot = layerFxCodeToSlot.get(l.fx);
      if (slot === undefined) {
        slot = layerFxSlots.length + 1; // 1-based
        layerFxCodeToSlot.set(l.fx, slot);
        layerFxSlots.push({ slot, code: l.fx });
      }
      layerIdToFxSlot.set(l.id, slot);
    }

    const code = generateBakeShader(shapeFxSlots, layerFxSlots);
    if (code !== this.lastBakeShaderCode) {
      this.lastBakeShaderCode = code;
      // Use fallback pipeline for immediate bake while the fx pipeline compiles
      this.bakePipeline = this.fallbackPipeline;
      this.chunkManager.markAllDirty();
      this.tryRebuildBakePipeline(code);
      // Fall through to bake with fallback pipeline (no return)
    }

    // Find first/last shape index per layer (for layer fx boundary markers)
    const layerFirstShapeIdx = new Map<string, number>();
    const layerLastShapeIdx = new Map<string, number>();
    for (let i = 0; i < shapeCount; i++) {
      if (!layerFirstShapeIdx.has(sorted[i].layerId)) {
        layerFirstShapeIdx.set(sorted[i].layerId, i);
      }
      layerLastShapeIdx.set(sorted[i].layerId, i);
    }

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

    // Write shape data (64 bytes per shape)
    if (shapeCount > 0) {
      const buf = new ArrayBuffer(shapeCount * 64);
      const f32 = new Float32Array(buf);
      const u32 = new Uint32Array(buf);
      for (let i = 0; i < shapeCount; i++) {
        const s = sorted[i];
        const off = i * 16; // 64 bytes / 4 = 16 u32s per shape
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
        f32[off + 8] = s.rotation[0];
        f32[off + 9] = s.rotation[1];
        f32[off + 10] = s.rotation[2];
        f32[off + 11] = s.scale;
        // fx_info: bits 0-7 = shape fx slot, bits 8-15 = layer fx slot (applied to all shapes in layer)
        const sfxSlot = shapeIdToFxSlot.get(s.id) ?? 0;
        const lfxSlot = layerIdToFxSlot.get(s.layerId) ?? 0;
        const cappedBit = (s.capped !== false ? 1 : 0) << 16;
        const wallThick = Math.round(Math.max(0, Math.min(1, (s.wallThickness ?? 0.03) / 0.5)) * 32767) & 0x7FFF;
        u32[off + 12] = (sfxSlot & 0xFF) | ((lfxSlot & 0xFF) << 8) | cappedBit | (wallThick << 17);
        // Pack shape fx params (16-bit each)
        const sfp = s.fxParams ?? [0, 0, 0];
        const sp0 = Math.round(Math.max(0, Math.min(1, sfp[0])) * 65535);
        const sp1 = Math.round(Math.max(0, Math.min(1, sfp[1])) * 65535);
        const sp2 = Math.round(Math.max(0, Math.min(1, sfp[2])) * 65535);
        // Pack layer fx params (on all shapes in layer)
        const lfp = info?.fxParams ?? [0, 0, 0];
        const lp0 = Math.round(Math.max(0, Math.min(1, lfp[0])) * 65535);
        const lp1 = Math.round(Math.max(0, Math.min(1, lfp[1])) * 65535);
        const lp2 = Math.round(Math.max(0, Math.min(1, lfp[2])) * 65535);
        u32[off + 13] = (sp0 & 0xFFFF) | ((sp1 & 0xFFFF) << 16);
        u32[off + 14] = (sp2 & 0xFFFF) | ((lp0 & 0xFFFF) << 16);
        u32[off + 15] = (lp1 & 0xFFFF) | ((lp2 & 0xFFFF) << 16);
      }
      this.device.queue.writeBuffer(this.shapeBuffer, 0, buf);

      // Write polygon vertex data (16 vec2s per shape slot)
      const polyBuf = new Float32Array(shapeCount * 16 * 2);
      for (let i = 0; i < shapeCount; i++) {
        const s = sorted[i];
        if (s.type === "polygon" && s.vertices) {
          const baseOff = i * 16 * 2; // 16 vec2s = 32 floats per shape
          const count = Math.min(s.vertices.length, 16);
          for (let v = 0; v < count; v++) {
            polyBuf[baseOff + v * 2 + 0] = s.vertices[v][0];
            polyBuf[baseOff + v * 2 + 1] = s.vertices[v][1];
          }
        }
      }
      this.device.queue.writeBuffer(this.polygonVertexBuffer, 0, polyBuf);
    }

    if (dirtyChunks.length === 0) return;

    // Process in batches of 64 (buffer capacity)
    const BATCH_SIZE = 64;
    for (let batchStart = 0; batchStart < dirtyChunks.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, dirtyChunks.length);
      const batchCount = batchEnd - batchStart;

      // Upload all bake + reduce params for this batch upfront (256-byte stride)
      // Reuse pre-allocated typed arrays to avoid per-chunk allocations
      const bpF32 = this.bakeParamsF32;
      const bpU32 = this.bakeParamsU32;
      const rpU32 = this.reduceParamsU32;
      const half = CHUNK_MAP_SIZE / 2;

      for (let i = 0; i < batchCount; i++) {
        const chunk = dirtyChunks[batchStart + i];
        const origin = ChunkManager.chunkOrigin(chunk.cx, chunk.cy, chunk.cz);
        const atlasOffset = ChunkManager.atlasSlotToOffset(chunk.slotIndex);

        bpF32[0] = origin[0];
        bpF32[1] = origin[1];
        bpF32[2] = origin[2];
        bpU32[3] = shapeCount;
        bpU32[4] = atlasOffset[0];
        bpU32[5] = atlasOffset[1];
        bpU32[6] = atlasOffset[2];
        bpF32[7] = VOXEL_SIZE;
        this.device.queue.writeBuffer(this.bakeParamsBuffer, i * 256, this.bakeParamsBuf);

        rpU32[0] = atlasOffset[0];
        rpU32[1] = atlasOffset[1];
        rpU32[2] = atlasOffset[2];
        rpU32[3] = 0;
        rpU32[4] = chunk.cx + half;
        rpU32[5] = chunk.cy + half;
        rpU32[6] = chunk.cz + half;
        rpU32[7] = 0;
        this.device.queue.writeBuffer(this.reduceParamsBuffer, i * 256, this.reduceParamsBuf);
      }

      const encoder = this.device.createCommandEncoder();
      const atlasView = this.atlasTexture.createView();
      const shapeIdAtlasView = this.shapeIdAtlasTexture.createView();
      const chunkDistView = this.chunkDistTexture.createView();

      const bakeBindGroup = this.device.createBindGroup({
        layout: this.bakeBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.bakeParamsBuffer, size: 32 } },
          { binding: 1, resource: { buffer: this.shapeBuffer } },
          { binding: 2, resource: atlasView },
          { binding: 3, resource: shapeIdAtlasView },
          { binding: 4, resource: { buffer: this.polygonVertexBuffer } },
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
    extraLines?: { verts: Float32Array; color: [number, number, number, number] }[],
  ): void {
    // Write uniforms (240 bytes) — reuse pre-allocated buffer
    const f32 = this.uniformF32;
    const i32 = this.uniformI32;
    const u32 = this.uniformU32;

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
    u32[50] = sceneState.renderMode;
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

    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

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
    const hasExtraLines = extraLines && extraLines.length > 0;
    if (wireframes.length > 0 || hasExtraLines) {
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
          const verts = buildBoxWireframeVerts(wf.center, wf.halfSize, wf.rotation, wf.scale);
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

      // Draw extra line segments (e.g., pen tool preview)
      if (hasExtraLines) {
        for (const lineGroup of extraLines!) {
          if (lineGroup.verts.length < 6) continue; // need at least 2 vertices (6 floats)
          const lineUniforms = new Float32Array(20);
          lineUniforms.set(viewProjectionMatrix, 0);
          lineUniforms[16] = lineGroup.color[0];
          lineUniforms[17] = lineGroup.color[1];
          lineUniforms[18] = lineGroup.color[2];
          lineUniforms[19] = lineGroup.color[3];
          this.device.queue.writeBuffer(this.linesUniformBuffer, uniformSlot * 256, lineUniforms);
          this.device.queue.writeBuffer(this.linesVertexBuffer, vertexOffset, lineGroup.verts);

          linesPass.setBindGroup(0, bindGroup, [uniformSlot * 256]);
          linesPass.setVertexBuffer(0, this.linesVertexBuffer, vertexOffset);
          linesPass.draw(lineGroup.verts.length / 3);

          vertexOffset += lineGroup.verts.byteLength;
          uniformSlot++;
        }
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
    this.shapeIdAtlasTexture?.destroy();
    this.chunkMapTexture?.destroy();
    this.chunkDistTexture?.destroy();
    this.worldPosTexture?.destroy();
    this.pickStagingBuffer?.destroy();
    this.regionStagingBuffer?.destroy();
    this.bakeParamsBuffer?.destroy();
    this.shapeBuffer?.destroy();
    this.polygonVertexBuffer?.destroy();
    this.reduceParamsBuffer?.destroy();
    this.uniformBuffer?.destroy();
    this.linesVertexBuffer?.destroy();
    this.linesUniformBuffer?.destroy();
  }
}
