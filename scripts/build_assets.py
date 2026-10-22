"""Build web assets from the PartBloom comparison release.

Reads the comparison selection and views from the PartBloom repo, compresses every
selected GLB (meshopt + WebP textures, part nodes kept), writes small preview and input
images, and records everything the page needs in assets/results.json.

Usage: python scripts/build_assets.py [--only ASSET_PREFIX ...] [--workers 16]
Needs the gltf-transform CLI (GLTF_TRANSFORM env var or on PATH) and Blender 4.5 (BLENDER env
var), which re-exports Direct Blender assets with their colors (see export_blend_glb.py).
"""
import argparse
import json
import os
import shutil
import struct
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

SITE = Path(__file__).resolve().parents[1]
PROJECT = SITE.parent
PARTBLOOM = PROJECT / 'PartBloom'
OUTPUTS = PROJECT / 'compare_release' / 'outputs'
INPUTS = PROJECT / 'compare_release' / 'input'
OUT = SITE / 'assets'

METHODS = [
    ('agentvoxel_opus55_high', 'partbloom', 'Claude Opus 5.5'),
    ('agentvoxel_astra_medium', 'partbloom', 'GPT-6-Astra'),
    ('agentvoxel_argon_medium', 'partbloom', 'Gemini-4-Argon'),
    ('physx_omni', 'physx_omni', 'PhysX-Omni'),
    ('direct_blender_opus55', 'direct_blender', 'Claude Opus 5.5'),
    ('direct_blender_astra', 'direct_blender', 'GPT-6-Astra'),
    ('direct_blender_antigravity', 'direct_blender', 'Gemini-4-Argon'),
]
# Same exceptions as PartBloom/scripts/render_final.py.
METALLIC_ZERO = {'physx_omni'}
GLB_OVERRIDES = {('agentvoxel_argon_medium', '74fe541e'): PARTBLOOM / 'renders' / 'overrides' / 'argon_bottle_glass.glb'}
PREVIEW_SIZE = 640
BUILD = SITE / 'build'
BLENDER = os.environ.get('BLENDER', '/opt/blender-4.5.3-linux-x64/blender')


def gltf_transform():
    return os.environ.get('GLTF_TRANSFORM') or shutil.which('gltf-transform') or 'gltf-transform'


def glb_json(path):
    data = path.read_bytes()
    length = struct.unpack('<I', data[12:16])[0]
    return json.loads(data[20:20 + length])


def source_glb(method, asset, preview):
    if (method, asset) in GLB_OVERRIDES:
        return GLB_OVERRIDES[method, asset]
    if method.startswith('direct_blender'):
        return BUILD / 'blend_glb' / method / f'{asset}.glb'
    return preview.parent / 'assembly_textured.glb'


def export_blend(blend, dst):
    dst.parent.mkdir(parents=True, exist_ok=True)
    cmd = [BLENDER, '-b', str(blend), '--threads', '4', '--python', str(SITE / 'scripts' / 'export_blend_glb.py'), '--', str(dst)]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0 or not dst.is_file():
        raise RuntimeError(f'{blend}: {result.stdout[-2000:]}{result.stderr[-2000:]}')


def compress(src, dst):
    dst.parent.mkdir(parents=True, exist_ok=True)
    cmd = [gltf_transform(), 'optimize', str(src), str(dst), '--compress', 'meshopt',
           '--texture-compress', 'webp', '--texture-size', '1024',
           '--join', 'false', '--flatten', 'false', '--instance', 'false',
           '--palette', 'false', '--simplify', 'false']
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f'{src}: {result.stderr[-2000:]}')


def save_image(src, dst, size=PREVIEW_SIZE):
    dst.parent.mkdir(parents=True, exist_ok=True)
    image = Image.open(src)
    if image.mode in ('RGBA', 'LA', 'P'):
        image = image.convert('RGBA')
        white = Image.new('RGBA', image.size, (255, 255, 255, 255))
        image = Image.alpha_composite(white, image)
    image = image.convert('RGB')
    image.thumbnail((size, size), Image.LANCZOS)
    image.save(dst, 'WEBP', quality=86, method=6)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--only', nargs='*', help='asset id prefixes to build')
    parser.add_argument('--workers', type=int, default=16)
    parser.add_argument('--force', action='store_true', help='recompress existing GLBs')
    args = parser.parse_args()

    selection = json.loads((PARTBLOOM / 'assets' / 'selection.json').read_text())
    views = json.loads((PARTBLOOM / 'assets' / 'orientation.json').read_text())
    if args.only:
        selection = [row for row in selection if any(row['asset'].startswith(p) for p in args.only)]

    rows, jobs, exports = [], [], []
    for row in selection:
        asset = row['asset']
        save_image(INPUTS / row['input'], OUT / 'inputs' / f'{asset}.webp')
        cells = []
        for method, family, model in METHODS:
            preview = OUTPUTS / row['methods'][method]
            glb = source_glb(method, asset, preview)
            web_glb = OUT / 'models' / method / f'{asset}.glb'
            save_image(preview, OUT / 'previews' / method / f'{asset}.webp')
            if family == 'direct_blender' and (args.force or not glb.is_file()):
                exports.append((preview.parent / 'asset.blend', glb))
            if args.force or not web_glb.is_file():
                jobs.append((glb, web_glb))
            cells.append((method, family, model, glb, web_glb))
        rows.append({'asset': asset, 'category': row['category'],
                     'input': f'assets/inputs/{asset}.webp', 'cells': cells})

    # Blender is heavy; a few at a time avoids exhausting process threads.
    with ThreadPoolExecutor(min(args.workers, 4)) as pool:
        list(pool.map(lambda job: export_blend(*job), exports))
    with ThreadPoolExecutor(args.workers) as pool:
        list(pool.map(lambda job: compress(*job), jobs))

    for row in rows:
        asset = row['asset']
        cells = []
        for method, family, model, glb, web_glb in row['cells']:
            meta = glb_json(glb)
            view = views.get(method, {}).get(asset, {'yaw': 0, 'elev': None})
            cells.append({
                'method': method, 'family': family, 'model': model,
                'glb': f'assets/models/{method}/{asset}.glb',
                'preview': f'assets/previews/{method}/{asset}.webp',
                'meshes': len(meta.get('meshes', [])),
                'yaw': view['yaw'], 'elev': view['elev'],
                'metallicZero': method in METALLIC_ZERO,
            })
        row['cells'] = cells

    manifest = OUT / 'results.json'
    if args.only and manifest.is_file():
        built = {r['asset']: r for r in json.loads(manifest.read_text())}
        built.update({r['asset']: r for r in rows})
        order = [r['asset'] for r in json.loads((PARTBLOOM / 'assets' / 'selection.json').read_text())]
        rows = [built[a] for a in order if a in built]
    manifest.write_text(json.dumps(rows, indent=1))
    total = sum(f.stat().st_size for f in (OUT / 'models').rglob('*.glb'))
    print(f'{len(rows)} rows, exported {len(exports)} blends, compressed {len(jobs)} GLBs, models total {total / 1e6:.1f} MB')


if __name__ == '__main__':
    main()
