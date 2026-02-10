# TODO

## Sparse Chunks

Replace single large 3D texture with sparse chunk grid to support larger scenes (512³+).

- Divide volume into e.g. 64³ chunks, only allocate where shapes exist
- Each chunk is a separate 3D texture (well under 256MB WebGPU buffer limit)
- Only bake dirty chunks on shape add/edit
- Ray marcher steps through chunk grid, skips empty chunks
- Mip chain per-chunk or global coarse mip for acceleration
- Enables effectively unbounded scenes with localized geometry

## Layers + Masks

## Undo/Redo System

## Click on shapes and move them around (select + transform tools)
