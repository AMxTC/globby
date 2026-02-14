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

## Edit tools

- swap from the 3d rendered gizmo to svg overlays (use same 3D math to position them)
- the 3d gizmo should also allow for rotation and scaling
- single click to show the gizmo ('object mode')
- double click to enter edit shape ('edit mode') (e.g. show control points for rectangle's base, and a height control for the extrusion amount)

## Proper transforms

we should be able to rotate/scale, translate each shape. this affects the way we draw, and edit shapes. instead of storing a position in the shape defs we'll need to store a matrix. we'll want to add rotation handles (drawn as perpective arcs) to the gizmo.

e.g.

```glsl
float opTranslate_{id}(vec3 pos, vec3 world, vec3 id) {
  mat4 xform = mat4(
    1.0, 0.0, 0.0, 0.0,
    0.0, 1.0, 0.0, 0.0,
    0.0, 0.0, 1.0, 0.0,
    -(\${1}).x, -(\${1}).y, -(\${1}).z, 1.0
  );
  vec4 transformedPos = xform * vec4(pos, 1.0);
  pos = transformedPos.xyz;
  return \${0};
}
```

howwer i think scaling is a bit harder - from https://iquilezles.org/articles/distfunctions/

```md
Rotation/Translation - exact

Since rotations and translation don't compress nor dilate space, all we need to do is simply to transform the point being sampled with the inverse of the transformation used to place an object in the scene. This code below assumes that transform encodes only a rotation and a translation (as a 3x4 matrix for example, or as a quaternion and a vector), and that it does not contain any scaling factors in it.

vec3 opTx( in vec3 p, in transform t, in sdf3d primitive )
{
return primitive( invert(t)\*p );
}

Scale - exact

Scaling an obect is slightly more tricky since that compresses/dilates spaces, so we have to take that into account on the resulting distance estimation. Still, it's not difficult to perform, although it only works with uniform scaling. Non uniform scaling is not possible (while still getting a correct SDF):

float opScale( in vec3 p, in float s, in sdf3d primitive )
{
return primitive(p/s)\*s;
}
```

Im not sure but we might need two matrices for each shape. one for the world position, and another for the 'edit' mode transform.

## Shape selection

- [x] right now we have dual defs (js + wgsl). either put them in one place (so we can maintain more easily) OR ditch the js and use a clown pass for selection.
- [ ] select multiple shapes (draw bbox around all of them)

## Layer filters

- should be able to add some code to a layer. e.g add an `onion` effect or a `grow`. applied to everything in that layer after unioning.
  isc

- multi select! ctrl+a
