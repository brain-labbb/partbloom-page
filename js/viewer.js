// One WebGL renderer draws every 3D cell through scissor rects, so dozens of cells
// never hit the browser's WebGL context limit.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// First six match the part renders in the PartBloom repo (scripts/render_parts.py).
export const PALETTE = [
  [.30, .55, .90], [.90, .55, .25], [.35, .72, .40], [.80, .35, .55], [.60, .42, .85], [.25, .75, .75],
  [.95, .78, .30], [.85, .32, .30], [.50, .62, .72], [.70, .82, .35], [.95, .62, .75], [.45, .45, .80],
];
// Blender renders: oblique camera at (1.5, -2.5, 1.5) in Z-up, ortho scale 1.35, longest edge 1.
const ORTHO_SCALE = 1.35;
const BASE_ELEV = Math.atan2(1.5, Math.hypot(1.5, 2.5));

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const flat = { metalness: 0 };
const clay = new THREE.MeshStandardMaterial({ color: 0xc4bfb7, roughness: .9, ...flat });
const highlight = new THREE.MeshStandardMaterial({ color: 0xff7a45, roughness: .6, emissive: 0x401000, ...flat });
const partMaterials = PALETTE.map(c => new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(...c, THREE.SRGBColorSpace), roughness: .75, ...flat }));

// Base camera direction for a render yaw/elevation (degrees) from assets/orientation.json.
export function baseAngles(yaw, elev) {
  const t = -yaw * Math.PI / 180;
  const bx = 1.5 * Math.cos(t) + 2.5 * Math.sin(t);
  const by = 1.5 * Math.sin(t) - 2.5 * Math.cos(t);
  return { az: Math.atan2(bx, -by), el: elev == null ? BASE_ELEV : elev * Math.PI / 180 };
}

export class Model {
  constructor(gltf, { metallicZero = false } = {}) {
    this.root = new THREE.Group();
    gltf.scene.updateMatrixWorld(true);
    const meshes = [];
    gltf.scene.traverse(o => { if (o.isMesh) meshes.push(o); });
    // A glTF mesh with several primitives loads as a group of meshes; group them back by node.
    const nodeOf = mesh => {
      for (let o = mesh; o && o !== gltf.scene; o = o.parent) {
        if (gltf.parser.associations.get(o)?.nodes !== undefined) return o;
      }
      return mesh;
    };
    const groups = new Map();
    for (const mesh of meshes) {
      const node = nodeOf(mesh);
      if (!groups.has(node)) groups.set(node, []);
      groups.get(node).push(mesh);
      // TRELLIS GLBs ship without normals.
      if (!mesh.geometry.attributes.normal) mesh.geometry.computeVertexNormals();
    }
    // Flatten so every part can be offset independently for the exploded view.
    for (const mesh of meshes) this.root.attach(mesh);
    const box = new THREE.Box3().setFromObject(this.root);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    this.scale = 1 / Math.max(size.x, size.y, size.z);
    this.root.scale.setScalar(this.scale);
    this.root.position.copy(center).multiplyScalar(-this.scale);

    this.parts = [...groups].map(([node, group], i) => {
      const materials = group.flatMap(m => [m.material].flat());
      if (metallicZero) materials.forEach(m => { m.metalness = 0; });
      const partBox = new THREE.Box3();
      group.forEach(m => partBox.expandByObject(m));
      // PartBloom GLBs number their nodes and carry the part name on the material.
      const label = (node.name || '').replace(/\.\d+$/, '');
      const name = !label || /^\d+$/.test(label) ? materials[0]?.name || label : label;
      return {
        meshes: group, originals: group.map(m => m.material), name: name || `part ${i + 1}`,
        bases: group.map(m => m.position.clone()),
        dir: partBox.getCenter(new THREE.Vector3()).sub(center),
      };
    });
    this.mode = 'textured';
    this.hovered = -1;
  }

  setMode(mode) {
    this.mode = mode;
    this.parts.forEach((p, i) => p.meshes.forEach((mesh, j) => {
      mesh.material = i === this.hovered ? highlight
        : mode === 'clay' ? clay : mode === 'parts' ? partMaterials[i % partMaterials.length] : p.originals[j];
    }));
  }

  setHighlight(i) { this.hovered = i; this.setMode(this.mode); }

  setExplode(k) {
    for (const p of this.parts) p.meshes.forEach((mesh, j) => mesh.position.copy(p.bases[j]).addScaledVector(p.dir, k));
  }

  dispose() {
    this.root.traverse(o => {
      if (!o.isMesh) return;
      o.geometry.dispose();
    });
    for (const p of this.parts) {
      for (const m of p.originals.flat()) {
        for (const value of Object.values(m)) if (value && value.isTexture) value.dispose();
        m.dispose();
      }
    }
  }
}

export function loadModel(url, options) {
  return loader.loadAsync(url).then(gltf => new Model(gltf, options));
}

// Shared camera state for one row: every cell turns by the same amount from its own base view.
export class Rig {
  constructor() { this.reset(); this.listeners = new Set(); }
  reset() { this.dAz = 0; this.dEl = 0; this.zoom = 1; this.changed?.(); }
  changed() { this.listeners?.forEach(f => f()); }
}

export class MultiView {
  constructor(canvas, { fixed = true } = {}) {
    this.canvas = canvas;
    this.fixed = fixed;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Blender renders use the Standard view transform, i.e. no tone mapping.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.setClearColor(0x000000, 0);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environment = pmrem.fromScene(new RoomEnvironment(), .04).texture;
    this.views = new Set();
    this.dirty = true;
    const mark = () => this.request();
    window.addEventListener('scroll', mark, { passive: true });
    window.addEventListener('resize', mark);
    const tick = () => { if (this.dirty) this.render(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }

  request() { this.dirty = true; }

  add({ el, model, rig, yaw = 0, elev = null }) {
    const scene = new THREE.Scene();
    scene.environment = this.environment;
    scene.environmentIntensity = .75;
    const light = new THREE.DirectionalLight(0xffffff, 1.1);
    scene.add(light, light.target, new THREE.HemisphereLight(0xffffff, 0xb8b4ad, .25), model.root);
    const view = { el, model, rig, scene, light, base: baseAngles(yaw, elev), camera: new THREE.OrthographicCamera() };
    this.views.add(view);
    this.request();
    return view;
  }

  remove(view) {
    if (!view) return;
    this.views.delete(view);
    view.scene.clear();
    this.request();
  }

  render() {
    this.dirty = false;
    const canvas = this.canvas;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (canvas.width !== Math.floor(width * this.renderer.getPixelRatio()) || canvas.height !== Math.floor(height * this.renderer.getPixelRatio())) {
      this.renderer.setSize(width, height, false);
    }
    const frame = this.fixed ? { left: 0, top: 0 } : canvas.getBoundingClientRect();
    this.renderer.setScissorTest(false);
    this.renderer.clear();
    this.renderer.setScissorTest(true);
    for (const view of this.views) {
      const r = view.el.getBoundingClientRect();
      const left = r.left - frame.left, top = r.top - frame.top;
      if (r.width === 0 || top + r.height < 0 || top > height || left + r.width < 0 || left > width) continue;
      const bottom = height - (top + r.height);
      this.renderer.setViewport(left, bottom, r.width, r.height);
      this.renderer.setScissor(left, bottom, r.width, r.height);
      this.place(view, r.width / r.height);
      // Flat-colored modes take less environment light so their shading reads like the clay renders.
      const textured = view.model.mode === 'textured';
      view.scene.environmentIntensity = textured ? .75 : .18;
      view.light.intensity = textured ? 1.1 : 2.2;
      this.renderer.render(view.scene, view.camera);
    }
  }

  place(view, aspect) {
    const { camera, rig, base, light } = view;
    const az = base.az + rig.dAz;
    const el = THREE.MathUtils.clamp(base.el + rig.dEl, -1.45, 1.45);
    camera.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(3);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    // Blender's ortho scale spans the longer side of the frame.
    const half = ORTHO_SCALE / 2 / rig.zoom;
    const hw = aspect >= 1 ? half : half * aspect, hh = aspect >= 1 ? half / aspect : half;
    Object.assign(camera, { left: -hw, right: hw, top: hh, bottom: -hh, near: .01, far: 20 });
    camera.updateProjectionMatrix();
    light.position.copy(camera.position).add(new THREE.Vector3(0, 1.5, 0)).applyAxisAngle(new THREE.Vector3(0, 1, 0), .5);
  }
}

// Drag to orbit (touch: horizontal drag orbits, vertical drag scrolls); wheel zooms where allowed.
export function bindOrbit(el, rig, { wheel = false } = {}) {
  let last = null;
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('button')) return;
    last = { x: e.clientX, y: e.clientY, touch: e.pointerType === 'touch' };
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
  });
  el.addEventListener('pointermove', e => {
    if (!last) return;
    rig.dAz -= (e.clientX - last.x) * .01;
    if (!last.touch) rig.dEl = THREE.MathUtils.clamp(rig.dEl + (e.clientY - last.y) * .01, -2.9, 2.9);
    last.x = e.clientX; last.y = e.clientY;
    rig.changed();
  });
  const end = () => { last = null; el.classList.remove('dragging'); };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('dblclick', () => rig.reset());
  if (wheel) {
    el.addEventListener('wheel', e => {
      e.preventDefault();
      rig.zoom = THREE.MathUtils.clamp(rig.zoom * Math.exp(-e.deltaY * .0015), .5, 6);
      rig.changed();
    }, { passive: false });
  }
}
