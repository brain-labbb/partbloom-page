"""Export a Direct Blender asset.blend to GLB with its colors kept.

The agents color materials through ColorRamp nodes, which the glTF exporter drops, so the
release asset.glb comes out white. This flattens each linked Base Color to the ramp's
mean color before exporting; geometry and objects are unchanged.

Usage: blender -b ASSET.blend --python export_blend_glb.py -- OUT.glb
"""
import sys

import bpy


def ramp_mean(node):
    elements = node.color_ramp.elements
    return [sum(e.color[i] for e in elements) / len(elements) for i in range(4)]


def source_color(socket, depth=0):
    """Follow a Base Color link back to a constant color, or None."""
    if not socket.is_linked or depth > 6:
        return list(socket.default_value) if hasattr(socket.default_value, '__len__') else None
    node = socket.links[0].from_node
    if node.type == 'VALTORGB':
        return ramp_mean(node)
    if node.type == 'RGB':
        return list(node.outputs[0].default_value)
    if node.type == 'MIX' or node.type == 'MIX_RGB':
        colors = [source_color(s, depth + 1) for s in node.inputs if s.type == 'RGBA']
        colors = [c for c in colors if c]
        return [sum(c[i] for c in colors) / len(colors) for i in range(4)] if colors else None
    for sock in node.inputs:
        if sock.type == 'RGBA':
            color = source_color(sock, depth + 1)
            if color:
                return color
    return None


for material in bpy.data.materials:
    if not material.use_nodes:
        continue
    bsdf = next((n for n in material.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not bsdf:
        continue
    base = bsdf.inputs['Base Color']
    if base.is_linked:
        color = source_color(base)
        for link in list(base.links):
            material.node_tree.links.remove(link)
        if color:
            base.default_value = color
    for name in ('Roughness', 'Metallic'):
        for link in list(bsdf.inputs[name].links):
            material.node_tree.links.remove(link)

out = sys.argv[sys.argv.index('--') + 1]
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_apply=True, export_yup=True)
