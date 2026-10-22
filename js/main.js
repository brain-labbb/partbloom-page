import { MultiView, Rig, bindOrbit, loadModel, PALETTE } from './viewer.js';

const LLMS = [
  { key: 'opus', label: 'Claude Opus 5.5', short: 'Opus 5.5' },
  { key: 'astra', label: 'GPT-6-Astra', short: 'Astra' },
  { key: 'argon', label: 'Gemini-4-Argon', short: 'Argon' },
];
const SHORT_LLMS = LLMS.map(o => ({ ...o, label: o.short, title: o.label }));
const COLUMNS = [
  { key: 'partbloom', title: 'PartBloom', ours: true,
    methods: { opus: 'agentvoxel_opus55_high', astra: 'agentvoxel_astra_medium', argon: 'agentvoxel_argon_medium' } },
  { key: 'physx_omni', title: 'PhysX-Omni', methods: { all: 'physx_omni' } },
  { key: 'direct_blender', title: 'Direct Blender',
    methods: { opus: 'direct_blender_opus55', astra: 'direct_blender_astra', argon: 'direct_blender_antigravity' } },
];
const MODES = [
  { key: 'textured', label: 'Textured' },
  { key: 'parts', label: 'Parts' },
  { key: 'clay', label: 'Clay' },
];

const state = { mode: 'textured', llm: 'opus', auto: false };
const stage = new MultiView(document.getElementById('stage'));
const rows = [];

const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat().filter(c => c != null));
  return el;
};

function segmented(options, current, onPick, cls = '') {
  const group = h('div', { class: `seg ${cls}`, role: 'group' });
  const buttons = options.map(o => h('button', {
    type: 'button', 'aria-pressed': String(o.key === current), title: o.title,
    onclick: () => { buttons.forEach(b => b.setAttribute('aria-pressed', String(b === buttons[options.indexOf(o)]))); onPick(o.key); },
  }, o.label));
  group.append(...buttons);
  group.set = key => buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i].key === key)));
  return group;
}

const partLabel = cell => `${cell.meshes} ${cell.family === 'direct_blender' ? 'objects' : 'parts'}`;

class Row {
  constructor(data) {
    this.data = data;
    this.byMethod = Object.fromEntries(data.cells.map(c => [c.method, c]));
    this.rig = new Rig();
    this.rig.listeners.add(() => stage.request());
    this.llm = { partbloom: state.llm, direct_blender: state.llm };
    this.cells = {};
    this.wanted = false;
    this.el = this.build();
  }

  cellFor(col) {
    const key = col.methods.all ? 'all' : this.llm[col.key];
    return this.byMethod[col.methods[key]];
  }

  build() {
    const load = h('button', { type: 'button', class: 'btn small load', onclick: () => this.toggle() }, 'Load 3D');
    this.loadButton = load;
    const head = h('div', { class: 'row-head' },
      h('h3', {}, this.data.category),
      h('div', { class: 'row-actions' },
        h('button', { type: 'button', class: 'btn small ghost', title: 'Reset view (or double-click a cell)', onclick: () => this.rig.reset() }, 'Reset view'),
        load));
    const grid = h('div', { class: 'row-grid' },
      h('figure', { class: 'cell input' },
        h('figcaption', {}, h('span', { class: 'cell-title' }, 'Input')),
        h('div', { class: 'view' }, h('img', { src: this.data.input, alt: `${this.data.category} input image`, loading: 'lazy' }))));
    for (const col of COLUMNS) grid.append(this.buildCell(col));
    return h('article', { class: 'row', id: `row-${this.data.asset}` }, head, grid);
  }

  buildCell(col) {
    const title = h('figcaption', {}, h('span', { class: 'cell-title' }, col.title), col.ours ? h('span', { class: 'tag' }, 'Ours') : null);
    const view = h('div', { class: 'view', tabindex: '0' });
    const img = h('img', { class: 'preview', loading: 'lazy', alt: '' });
    const badge = h('span', { class: 'badge' });
    const expand = h('button', { type: 'button', class: 'expand', title: 'Open large viewer', 'aria-label': 'Open large viewer', onclick: () => openModal(this, col) }, '⤢');
    const spinner = h('span', { class: 'spinner', 'aria-hidden': 'true' });
    view.append(img, badge, expand, spinner);
    bindOrbit(view, this.rig);
    const fig = h('figure', { class: `cell${col.ours ? ' ours' : ''}` }, title);
    let tabs = null;
    if (!col.methods.all) {
      tabs = segmented(SHORT_LLMS, this.llm[col.key], key => { this.llm[col.key] = key; this.refresh(col); }, 'tiny');
      fig.append(tabs);
    } else {
      fig.append(h('div', { class: 'seg tiny placeholder' }, h('span', {}, 'Official VLM')));
    }
    fig.append(view);
    this.cells[col.key] = { col, fig, view, img, badge, tabs, model: null, handle: null, token: 0 };
    this.refresh(col, false);
    return fig;
  }

  refresh(col, reload = true) {
    const slot = this.cells[col.key];
    const cell = this.cellFor(col);
    slot.img.src = cell.preview;
    slot.img.alt = `${this.data.category}, ${col.title}${col.methods.all ? '' : ` + ${cell.model}`}`;
    slot.badge.textContent = partLabel(cell);
    slot.tabs?.set(this.llm[col.key]);
    if (reload && this.wanted) this.loadCell(col);
  }

  setLLM(key) {
    for (const col of COLUMNS) {
      if (col.methods.all) continue;
      this.llm[col.key] = key;
      this.refresh(col);
    }
  }

  async loadCell(col) {
    const slot = this.cells[col.key];
    const cell = this.cellFor(col);
    const token = ++slot.token;
    this.unloadCell(slot);
    slot.view.classList.add('loading');
    try {
      const model = await loadModel(cell.glb, { metallicZero: cell.metallicZero });
      if (token !== slot.token || !this.wanted) { model.dispose(); return; }
      model.setMode(state.mode);
      slot.model = model;
      slot.handle = stage.add({ el: slot.view, model, rig: this.rig, yaw: cell.yaw, elev: cell.elev });
      slot.view.classList.add('live');
    } catch (err) {
      console.error(err);
      slot.view.classList.add('failed');
    } finally {
      if (token === slot.token) slot.view.classList.remove('loading');
    }
  }

  unloadCell(slot) {
    if (slot.handle) stage.remove(slot.handle);
    slot.model?.dispose();
    slot.model = slot.handle = null;
    slot.view.classList.remove('live', 'failed');
  }

  load() {
    if (this.loaded) return;
    this.loaded = true;
    COLUMNS.forEach(col => this.loadCell(col));
  }

  unload() {
    this.loaded = false;
    for (const slot of Object.values(this.cells)) { slot.token++; this.unloadCell(slot); slot.view.classList.remove('loading'); }
  }

  toggle() {
    this.wanted = !this.wanted;
    this.loadButton.textContent = this.wanted ? 'Unload 3D' : 'Load 3D';
    this.el.classList.toggle('active', this.wanted);
    this.wanted ? this.load() : this.unload();
  }

  setMode(mode) {
    for (const slot of Object.values(this.cells)) slot.model?.setMode(mode);
  }
}

// Rows far off-screen release their GPU memory and come back when scrolled near again.
const keepAlive = new IntersectionObserver(entries => {
  for (const entry of entries) {
    const row = entry.target.row;
    if (entry.isIntersecting && (row.wanted || state.auto)) {
      if (!row.wanted) row.toggle(); else row.load();
    } else if (!entry.isIntersecting && row.loaded) {
      row.unload();
    }
  }
}, { rootMargin: '120% 0px' });

const autoLoad = new IntersectionObserver(entries => {
  if (!state.auto) return;
  for (const entry of entries) if (entry.isIntersecting && !entry.target.row.wanted) entry.target.row.toggle();
}, { rootMargin: '10% 0px' });

function buildToolbar() {
  const bar = document.getElementById('results-toolbar');
  bar.append(
    h('div', { class: 'control' }, h('span', { class: 'control-label' }, 'Display'),
      segmented(MODES, state.mode, mode => { state.mode = mode; rows.forEach(r => r.setMode(mode)); stage.request(); })),
    h('div', { class: 'control' }, h('span', { class: 'control-label' }, 'Agent LLM'),
      segmented(LLMS, state.llm, llm => { state.llm = llm; rows.forEach(r => r.setLLM(llm)); })),
    h('label', { class: 'control check' },
      h('input', { type: 'checkbox', onchange: e => {
        state.auto = e.target.checked;
        try { localStorage.setItem('pb-autoload', state.auto ? '1' : '0'); } catch {}
        if (state.auto) rows.forEach(r => { autoLoad.unobserve(r.el); autoLoad.observe(r.el); });
      } }),
      h('span', {}, 'Load 3D while scrolling')));
}

// ---------- large viewer ----------
const modal = document.getElementById('viewer-modal');
const modalStage = new MultiView(document.getElementById('modal-stage'), { fixed: false });
const modalRig = new Rig();
modalRig.listeners.add(() => modalStage.request());
const modalView = document.getElementById('modal-view');
bindOrbit(modalView, modalRig, { wheel: true });
let modalState = null;

const modalMode = segmented(MODES, 'textured', mode => {
  if (!modalState) return;
  modalState.mode = mode;
  modalState.model?.setMode(mode);
  renderPartList();
  modalStage.request();
});
document.getElementById('modal-mode').append(modalMode);
const explode = document.getElementById('modal-explode');
explode.addEventListener('input', () => { modalState?.model?.setExplode(+explode.value); modalStage.request(); });

function renderPartList() {
  const list = document.getElementById('modal-parts');
  list.replaceChildren();
  const model = modalState?.model;
  if (!model) return;
  const showColor = modalState.mode === 'parts';
  model.parts.forEach((p, i) => {
    const c = PALETTE[i % PALETTE.length].map(v => Math.round(v * 255)).join(',');
    list.append(h('li', {
      onpointerenter: () => { model.setHighlight(i); modalStage.request(); },
      onpointerleave: () => { model.setHighlight(-1); modalStage.request(); },
    }, h('span', { class: 'swatch', style: showColor ? `background: rgb(${c})` : '' }), p.name.replace(/_/g, ' ')));
  });
  document.getElementById('modal-count').textContent = `${model.parts.length} ${modalState.cell.family === 'direct_blender' ? 'objects' : 'parts'}`;
}

async function openModal(row, col) {
  const cell = row.cellFor(col);
  closeModal(false);
  const token = Symbol();
  modalState = { token, cell, mode: state.mode, model: null, handle: null };
  document.getElementById('modal-title').textContent = row.data.category;
  document.getElementById('modal-method').textContent = col.methods.all ? col.title : `${col.title} + ${cell.model}`;
  modalMode.set(state.mode);
  explode.value = 0;
  modalRig.dAz = row.rig.dAz; modalRig.dEl = row.rig.dEl; modalRig.zoom = 1;
  document.getElementById('modal-parts').replaceChildren();
  document.getElementById('modal-count').textContent = '';
  modal.showModal();
  modalView.classList.add('loading');
  try {
    const model = await loadModel(cell.glb, { metallicZero: cell.metallicZero });
    if (modalState?.token !== token) { model.dispose(); return; }
    model.setMode(modalState.mode);
    modalState.model = model;
    modalState.handle = modalStage.add({ el: modalView, model, rig: modalRig, yaw: cell.yaw, elev: cell.elev });
    renderPartList();
  } finally {
    modalView.classList.remove('loading');
  }
}

function closeModal(close = true) {
  if (modalState) {
    modalStage.remove(modalState.handle);
    modalState.model?.dispose();
    modalState = null;
  }
  if (close && modal.open) modal.close();
}
modal.addEventListener('close', () => closeModal(false));
document.getElementById('modal-close').addEventListener('click', () => closeModal());
modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
new ResizeObserver(() => modalStage.request()).observe(modalView);

// ---------- boot ----------
async function boot() {
  buildToolbar();
  const data = await (await fetch('assets/results.json')).json();
  const list = document.getElementById('results-rows');
  for (const item of data) {
    const row = new Row(item);
    row.el.row = row;
    rows.push(row);
    list.append(row.el);
    keepAlive.observe(row.el);
  }
  try {
    if (localStorage.getItem('pb-autoload') === '1') document.querySelector('#results-toolbar input[type=checkbox]').click();
  } catch {}
  new ResizeObserver(() => stage.request()).observe(list);
  // Rows are inserted after the browser's initial anchor jump, so redo it.
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
}
boot();

// ---------- copy buttons ----------
document.querySelectorAll('[data-copy]').forEach(btn => btn.addEventListener('click', async () => {
  const text = document.getElementById(btn.dataset.copy).innerText;
  try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; } catch { btn.textContent = 'Copy failed'; }
  setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
}));
