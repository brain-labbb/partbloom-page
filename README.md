# PartBloom project page

Source of the PartBloom project page. Code lives at [brain-labbb/PartBloom](https://github.com/brain-labbb/PartBloom).

Static site, no build step: `index.html`, `css/`, `js/` (three.js from jsDelivr) and `assets/`.

```bash
python -m http.server 8000   # preview at http://localhost:8000
```

## Rebuilding the 3D assets

`scripts/build_assets.py` reads the comparison selection and views from a sibling `PartBloom/` checkout
and the results in `compare_release/outputs`, then writes compressed GLBs (meshopt + WebP textures,
part nodes kept), previews and `assets/results.json`. Direct Blender assets are re-exported from their
`asset.blend` with `scripts/export_blend_glb.py` so their material colors survive.

```bash
GLTF_TRANSFORM=/path/to/gltf-transform BLENDER=/path/to/blender python scripts/build_assets.py
```
