# TODO

## Sparse Chunks

Replace single large 3D texture with sparse chunk grid to support larger scenes (512³+).

- Divide volume into e.g. 64³ chunks, only allocate where shapes exist
- Each chunk is a separate 3D texture (well under 256MB WebGPU buffer limit)
- Only bake dirty chunks on shape add/edit
- Ray marcher steps through chunk grid, skips empty chunks
- Mip chain per-chunk or global coarse mip for acceleration
- Enables effectively unbounded scenes with localized geometry
- debug viz for chunk boundaries and memory usage

1. Increase voxel size (lower resolution but covers more space) — e.g. 4× bigger voxels means 4× bigger chunks, 64× fewer chunks needed
2. Increase atlas slots — more texture memory but handles bigger scenes
3. Both — balance resolution vs coverage

## hotkeys

hotkeys in one place, like in blobby (/Users/alasdair/Documents/GitHub/blobby/src/lib/hotkeys.ts)

- delete to delete selected shape(s)
- escape to deselect selected shape(s)
- shift + left click to multi-select shapes
- f to focus camera on selected shape(s)

## Layers + Masks

## Undo/Redo System

## edit shapes (edit base of recangle, push pull top)

## extruded polygon tool

## push pull side faces of shapes
