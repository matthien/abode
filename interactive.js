// interactive.js — reusable interaction helpers for the room scene.
//
//   RoomInteractive.createFocusController(opts)  click-to-focus camera system:
//       hover highlight + pointer cursor, eased camera glides, Esc to exit.
//   RoomInteractive.createDrawableBoard(opts)    turns an existing mesh into a
//       whiteboard you can draw on, with an HTML toolbar and localStorage persistence.
//
// Any object can be made focusable by registering an "item" with the controller:
//   { mesh, getFocusView(camera) -> { position, target }, isAvailable?(), onHover?(on),
//     onFocus?(), onExit?() }
(function () {
  const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const reducedMotion = () => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  };

  // ---------------------------------------------------------------------------
  // Focus controller
  // ---------------------------------------------------------------------------
  function createFocusController({ THREE, camera, controls, renderer, scene, onStateChange }) {
    const el = renderer.domElement;
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const items = [];
    let state = 'room';            // 'room' | 'moving' | 'focused'
    let active = null, hovered = null, returnView = null, down = null;

    function setState(s) {
      state = s;
      controls.enabled = s === 'room';
      if (s !== 'room') setHover(null);
      if (onStateChange) onStateChange(s, active);
    }

    function setRay(e) {
      const r = el.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      return raycaster;
    }

    // Skip things the viewer can't see: hidden objects, faded walls, shadow-only meshes, glass
    function isSeen(obj) {
      for (let p = obj; p; p = p.parent) if (!p.visible) return false;
      const m = obj.material;
      if (!m || Array.isArray(m)) return !!m;
      if (m.colorWrite === false) return false;
      if (m.transparent && m.opacity < 0.2) return false;
      return true;
    }

    // First visible thing under the pointer, and the focusable item it belongs to (if any)
    function pick(e) {
      const hits = setRay(e).intersectObjects(scene.children, true);
      const hit = hits.find((h) => isSeen(h.object));
      if (!hit) return null;
      const item = items.find((it) => it.mesh === hit.object && (!it.isAvailable || it.isAvailable()));
      return item || null;
    }

    function setHover(item) {
      if (hovered === item) return;
      if (hovered && hovered.onHover) hovered.onHover(false);
      hovered = item;
      if (hovered && hovered.onHover) hovered.onHover(true);
      el.style.cursor = hovered ? 'pointer' : '';
    }

    // Eased camera glide between views; resolves when done
    function glide(toPos, toTarget, ms = 1000) {
      const fromPos = camera.position.clone(), fromTarget = controls.target.clone();
      const dur = reducedMotion() ? 1 : ms, start = performance.now();
      return new Promise((resolve) => {
        function step(now) {
          const t = Math.min(1, (now - start) / dur), k = easeInOutCubic(t);
          camera.position.lerpVectors(fromPos, toPos, k);
          controls.target.lerpVectors(fromTarget, toTarget, k);
          camera.lookAt(controls.target);
          if (t < 1) requestAnimationFrame(step); else resolve();
        }
        requestAnimationFrame(step);
      });
    }

    async function focus(item) {
      if (state !== 'room') return;
      returnView = { position: camera.position.clone(), target: controls.target.clone() };
      active = item;
      setState('moving');
      const v = item.getFocusView(camera);
      await glide(v.position, v.target);
      setState('focused');
      if (item.onFocus) item.onFocus();
    }

    async function exit() {
      if (state !== 'focused') return;
      const item = active;
      if (item.onExit) item.onExit();
      setState('moving');
      await glide(returnView.position, returnView.target);
      active = null;
      setState('room');
    }

    el.addEventListener('pointermove', (e) => {
      if (state !== 'room' || e.buttons) { if (state === 'room') setHover(null); return; }
      setHover(pick(e));
    });
    el.addEventListener('pointerleave', () => { if (state === 'room') setHover(null); });
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    el.addEventListener('pointerup', (e) => {
      if (state !== 'room' || !down) return;          // ignore clicks while moving or focused
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.t < 500;
      down = null;
      if (moved > 6 || !quick) return;                 // that was an orbit drag, not a click
      const item = pick(e);
      if (item) focus(item);
    });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') exit(); });

    return {
      register(item) { items.push(item); return item; },
      focus, exit, glide,
      get state() { return state; },
      get busy() { return state !== 'room'; },
      get active() { return active; },
      raycaster: () => raycaster,
      setRay
    };
  }

  // ---------------------------------------------------------------------------
  // Drawable board
  // ---------------------------------------------------------------------------
  const TOOLBAR_CSS = `
  .ri-toolbar {
    position: fixed; left: 50%; transform: translateX(-50%);
    bottom: calc(16px + env(safe-area-inset-bottom, 0px));
    display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 8px;
    max-width: calc(100% - 32px); padding: 8px 10px;
    background: var(--panel, rgba(250,248,244,.9)); color: var(--fg, #3a332c);
    border: 1px solid var(--line, rgba(0,0,0,.14)); border-radius: 10px;
    backdrop-filter: blur(6px); font: 600 13px var(--font-ui, system-ui, sans-serif);
  }
  .ri-group { display: flex; gap: 6px; align-items: center; }
  .ri-sep { width: 1px; align-self: stretch; background: var(--line, rgba(0,0,0,.14)); }
  .ri-toolbar button {
    font: inherit; color: inherit; background: transparent; cursor: pointer;
    border: 1px solid var(--line, rgba(0,0,0,.14)); border-radius: 6px; padding: 7px 10px;
  }
  .ri-toolbar button[aria-pressed="true"] { background: var(--fg, #3a332c); color: var(--bg, #fff); border-color: var(--fg, #3a332c); }
  .ri-toolbar button:focus-visible { outline: 2px solid var(--muted, #7a6f63); outline-offset: 2px; }
  .ri-toolbar .ri-swatch { width: 28px; height: 28px; padding: 0; border-radius: 50%; border: 2px solid transparent; }
  .ri-toolbar .ri-swatch[aria-pressed="true"] { border-color: var(--fg, #3a332c); box-shadow: 0 0 0 2px var(--bg, #fff) inset; background: var(--swatch); }
  .ri-toolbar .ri-back { background: var(--fg, #3a332c); color: var(--bg, #fff); border-color: var(--fg, #3a332c); }
  `;

  function createDrawableBoard({
    THREE, controller, mesh, renderer,
    widthIn, heightIn,                     // size of the writing face, in inches
    normal,                                // world-space direction the writing face points
    canvasWidth = 1024, canvasHeight = 640,
    background = '#f6f5f1',
    storageKey = 'room.whiteboard.v1',
    message = 'hi, welcome to my room',
    colors = [['Black', '#1d1d1f'], ['Blue', '#1f4fbf'], ['Red', '#c62828'], ['Green', '#2e7d32']],
    sizes = { thin: 5, thick: 13 }, eraserSize = 40,
    font = '"Permanent Marker", "Comic Sans MS", cursive'
  }) {
    // Hidden 2D canvas that becomes the board's texture
    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth; canvas.height = canvasHeight;
    const ctx = canvas.getContext('2d');
    const texture = new THREE.CanvasTexture(canvas);
    texture.encoding = THREE.sRGBEncoding;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

    // Swap only the surface material's look: off-white canvas map, very slight gloss
    const mat = mesh.material;
    mat.map = texture;
    mat.color.set(0xffffff);
    mat.roughness = 0.3;
    mat.metalness = 0;
    mat.emissive = mat.emissive || new THREE.Color(0x000000);
    mat.needsUpdate = true;

    const paintBackground = () => { ctx.fillStyle = background; ctx.fillRect(0, 0, canvas.width, canvas.height); };
    const refresh = () => { texture.needsUpdate = true; };

    function save() {
      try { localStorage.setItem(storageKey, canvas.toDataURL('image/png')); } catch { /* storage unavailable */ }
    }
    function drawMessage() {
      ctx.save();
      ctx.fillStyle = '#1f3f8f';
      ctx.font = `64px ${font}`;
      ctx.translate(70, 120);
      ctx.rotate(-0.035);
      ctx.fillText(message, 0, 0);
      ctx.restore();
    }
    function prefill() {
      paintBackground();
      const ready = document.fonts && document.fonts.load
        ? Promise.race([document.fonts.load(`64px ${font}`), new Promise((r) => setTimeout(r, 2500))])
        : Promise.resolve();
      ready.then(() => { drawMessage(); refresh(); });
    }

    // Restore a saved drawing, or start with the welcome message
    paintBackground();
    refresh();
    let saved = null;
    try { saved = localStorage.getItem(storageKey); } catch { saved = null; }
    if (saved) {
      const img = new Image();
      img.onload = () => { ctx.drawImage(img, 0, 0, canvas.width, canvas.height); refresh(); };
      img.onerror = prefill;
      img.src = saved;
    } else {
      prefill();
    }

    // ---- tool state ----
    const tool = { color: colors[0][1], size: 'thin', eraser: false };

    // ---- toolbar ----
    if (!document.getElementById('ri-toolbar-css')) {
      const style = document.createElement('style');
      style.id = 'ri-toolbar-css';
      style.textContent = TOOLBAR_CSS;
      document.head.appendChild(style);
    }
    const bar = document.createElement('div');
    bar.className = 'ri-toolbar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Whiteboard tools');
    bar.hidden = true;
    const btn = (label, cls, onClick, extra = {}) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls || '';
      b.textContent = extra.text === undefined ? label : extra.text;
      b.setAttribute('aria-label', label);
      if (extra.pressed !== undefined) b.setAttribute('aria-pressed', String(extra.pressed));
      b.addEventListener('click', onClick);
      return b;
    };
    const group = (...kids) => { const g = document.createElement('div'); g.className = 'ri-group'; kids.forEach((k) => g.appendChild(k)); return g; };
    const sep = () => { const s = document.createElement('div'); s.className = 'ri-sep'; return s; };

    const swatches = colors.map(([name, hex]) => {
      const b = btn(`${name} marker`, 'ri-swatch', () => { tool.color = hex; tool.eraser = false; sync(); }, { text: '', pressed: false });
      b.style.background = hex;
      b.style.setProperty('--swatch', hex);
      b.dataset.color = hex;
      return b;
    });
    const thinBtn = btn('Thin', '', () => { tool.size = 'thin'; sync(); }, { pressed: true });
    const thickBtn = btn('Thick', '', () => { tool.size = 'thick'; sync(); }, { pressed: false });
    const eraserBtn = btn('Eraser', '', () => { tool.eraser = !tool.eraser; sync(); }, { pressed: false });
    let clearArmed = null;
    const clearBtn = btn('Clear', '', () => {
      if (!clearArmed) {                               // two taps, so one stray tap can't wipe the board
        clearBtn.textContent = 'Tap again to clear';
        clearArmed = setTimeout(() => { clearArmed = null; clearBtn.textContent = 'Clear'; }, 2000);
        return;
      }
      clearTimeout(clearArmed); clearArmed = null; clearBtn.textContent = 'Clear';
      paintBackground(); refresh(); save();
    });
    const backBtn = btn('Back to room', 'ri-back', () => controller.exit());

    bar.append(group(...swatches), sep(), group(thinBtn, thickBtn), sep(), group(eraserBtn, clearBtn), sep(), backBtn);
    document.body.appendChild(bar);

    function sync() {
      swatches.forEach((s) => s.setAttribute('aria-pressed', String(!tool.eraser && s.dataset.color === tool.color)));
      thinBtn.setAttribute('aria-pressed', String(tool.size === 'thin'));
      thickBtn.setAttribute('aria-pressed', String(tool.size === 'thick'));
      eraserBtn.setAttribute('aria-pressed', String(tool.eraser));
    }
    sync();

    // ---- drawing ----
    const el = renderer.domElement;
    let drawing = null;                                // { id, last: {x,y}, mid: {x,y} }

    // Pointer -> canvas pixel on the board's writing face (or null if off the board)
    function toCanvas(e) {
      const hit = controller.setRay(e).intersectObject(mesh, false)[0];
      if (!hit || !hit.uv) return null;
      const n = hit.face.normal.clone().transformDirection(mesh.matrixWorld);
      if (n.dot(normal) < 0.5) return null;            // only the front face
      return { x: hit.uv.x * canvas.width, y: (1 - hit.uv.y) * canvas.height };
    }
    function strokeWidth(e) {
      if (tool.eraser) return eraserSize;
      const base = sizes[tool.size];
      return e.pointerType === 'pen' && e.pressure > 0 ? base * (0.55 + e.pressure * 0.9) : base;
    }
    function segment(from, ctrl, to, width) {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = width;
      ctx.strokeStyle = tool.eraser ? background : tool.color;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.quadraticCurveTo(ctrl.x, ctrl.y, to.x, to.y);
      ctx.stroke();
      ctx.restore();
    }
    function dot(p, width) {
      ctx.save();
      ctx.fillStyle = tool.eraser ? background : tool.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, width / 2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    el.addEventListener('pointerdown', (e) => {
      if (controller.state !== 'focused' || controller.active !== item) return;
      const p = toCanvas(e);
      if (!p) return;
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      drawing = { id: e.pointerId, last: p, mid: p };
      dot(p, strokeWidth(e));
      refresh();
    });
    el.addEventListener('pointermove', (e) => {
      if (!drawing || e.pointerId !== drawing.id) return;
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of (events.length ? events : [e])) {
        const p = toCanvas(ev);
        if (!p) { drawing.last = null; continue; }     // left the board: lift the marker
        if (!drawing.last) { drawing.last = p; drawing.mid = p; continue; }
        // Smooth curve through midpoints; consecutive segments share endpoints, so no gaps
        const mid = { x: (drawing.last.x + p.x) / 2, y: (drawing.last.y + p.y) / 2 };
        segment(drawing.mid, drawing.last, mid, strokeWidth(ev));
        drawing.last = p; drawing.mid = mid;
      }
      refresh();
    });
    const endStroke = (e) => {
      if (!drawing || e.pointerId !== drawing.id) return;
      if (drawing.last) segment(drawing.mid, drawing.last, drawing.last, strokeWidth(e));
      drawing = null;
      refresh();
      save();
    };
    el.addEventListener('pointerup', endStroke);
    el.addEventListener('pointercancel', endStroke);

    // ---- focus item ----
    const highlight = new THREE.Color(0x4a6c9b);
    const item = {
      mesh,
      isAvailable: () => {
        const m = mesh.material;                        // hidden while its wall is faded out
        return !(m.transparent && m.opacity < 0.5);
      },
      onHover(on) {
        const m = mesh.material;
        m.emissive.copy(on ? highlight : new THREE.Color(0x000000));
        m.emissiveIntensity = on ? 0.22 : 1;
      },
      getFocusView(cam) {
        const center = new THREE.Vector3();
        mesh.getWorldPosition(center);
        // Fit the board to ~85% of the limiting screen dimension
        const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
        const fill = 0.85;
        const dV = (heightIn / fill) / (2 * tanHalf);
        const dH = (widthIn / fill) / (2 * tanHalf * cam.aspect);
        const d = Math.max(dV, dH);
        return { position: center.clone().addScaledVector(normal, d), target: center };
      },
      onFocus() { bar.hidden = false; el.style.cursor = 'crosshair'; },
      onExit() { bar.hidden = true; el.style.cursor = ''; drawing = null; save(); }
    };
    controller.register(item);
    return { item, canvas, texture, toolbar: bar };
  }

  window.RoomInteractive = { createFocusController, createDrawableBoard };
})();
