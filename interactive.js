// interactive.js — reusable interaction helpers for the room scene.
//
//   RoomInteractive.createFocusController(opts)  click-to-focus camera system:
//       hover highlight + pointer cursor, eased camera glides, Esc to exit.
//   RoomInteractive.createDrawableBoard(opts)    turns an existing mesh into a
//       whiteboard you draw on with physical markers and an eraser from a basket,
//       with localStorage persistence.
//   RoomInteractive.createFocusSpot(opts)        makes any object a place to look at
//       up close, with optional up/down stepping between several views (shelf by shelf).
//
// Any object can be made focusable by registering an "item" with the controller:
//   { mesh, getFocusView(camera, hit?) -> { position, target }, owns?(object), isAvailable?(),
//     onHover?(on), onFocus?(), onExit?() }
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
    let active = null, hovered = null, returnView = null, down = null, glideId = 0;

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
      const item = items.find((it) => (it.mesh === hit.object || (it.owns && it.owns(hit.object)))
        && (!it.isAvailable || it.isAvailable()));
      return item ? { item, hit } : null;
    }

    function setHover(item) {
      if (hovered === item) return;
      if (hovered && hovered.onHover) hovered.onHover(false);
      hovered = item;
      if (hovered && hovered.onHover) hovered.onHover(true);
      el.style.cursor = hovered ? 'pointer' : '';
    }

    // Eased camera glide between views; resolves when done. A newer glide takes over.
    function glide(toPos, toTarget, ms = 1000) {
      const fromPos = camera.position.clone(), fromTarget = controls.target.clone();
      const dur = reducedMotion() ? 1 : ms, start = performance.now(), id = ++glideId;
      return new Promise((resolve) => {
        function step(now) {
          if (id !== glideId) { resolve(); return; }
          const t = Math.min(1, (now - start) / dur), k = easeInOutCubic(t);
          camera.position.lerpVectors(fromPos, toPos, k);
          controls.target.lerpVectors(fromTarget, toTarget, k);
          camera.lookAt(controls.target);
          if (t < 1) requestAnimationFrame(step); else resolve();
        }
        requestAnimationFrame(step);
      });
    }

    async function focus(item, hit) {
      if (state !== 'room') return;
      returnView = { position: camera.position.clone(), target: controls.target.clone() };
      active = item;
      setState('moving');
      const v = item.getFocusView(camera, hit);
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
      const p = pick(e);
      setHover(p && p.item);
    });
    el.addEventListener('pointerleave', () => { if (state === 'room') setHover(null); });
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    el.addEventListener('pointerup', (e) => {
      if (state !== 'room' || !down) return;          // ignore clicks while moving or focused
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.t < 500;
      down = null;
      if (moved > 6 || !quick) return;                 // that was an orbit drag, not a click
      const p = pick(e);
      if (p) focus(p.item, p.hit);
    });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') exit(); });

    return {
      register(item) { items.push(item); return item; },
      focus, exit, glide, camera, scene, isSeen,
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
  // Drawing uses physical tools that live in a basket on the board. Each tool is
  // { object, kind: 'marker' | 'eraser', color?, feltIn?: [long, short], onTake?(), onReturn?() }.
  // A tool's object is modeled with its tip (or felt face) at the local origin and its
  // body along local +Y. Click a tool to pick it up, draw on the board, click the
  // basket to put it back, and click away from the board to return to the room.
  function createDrawableBoard({
    THREE, controller, mesh, renderer,
    normal,                                // world-space direction the writing face points
    basket, tools,
    canvasWidth = 1024, canvasHeight = 640,
    background = '#f6f5f1',
    storageKey = 'room.whiteboard.v1',
    message = 'hi, welcome to my room',
    markerSize = 6,
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

    // ---- board geometry in world space ----
    mesh.updateWorldMatrix(true, false);
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, normal).normalize();   // viewer's right
    const surfaceBox = new THREE.Box3().setFromObject(mesh);
    const surfaceSize = surfaceBox.getSize(new THREE.Vector3());
    const across = (size, dir) => Math.abs(dir.x) * size.x + Math.abs(dir.y) * size.y + Math.abs(dir.z) * size.z;
    const widthIn = across(surfaceSize, right), heightIn = across(surfaceSize, up);
    const pxPerIn = { x: canvas.width / widthIn, y: canvas.height / heightIn };
    const faceCenter = surfaceBox.getCenter(new THREE.Vector3())
      .addScaledVector(normal, across(surfaceSize, normal) / 2);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, faceCenter);
    // The focus view frames the writing surface plus the basket hanging below it
    const viewBox = surfaceBox.clone().union(new THREE.Box3().setFromObject(basket));
    const reachBox = viewBox.clone().expandByScalar(2);  // clicks outside this leave the board

    // ---- tools: in the basket, hovered (lifted a little), or held ----
    const HOVER_LIFT = 0.5, HOVER_GAP = 0.35, PRESS_GAP = 0.02;
    const markerQuat = new THREE.Quaternion().setFromUnitVectors(
      up,                                                    // body points back out at the viewer,
      normal.clone().addScaledVector(right, 0.55).addScaledVector(up, -0.5).normalize()  // down and to the right
    );
    const eraserQuat = new THREE.Quaternion().setFromRotationMatrix(       // felt flat on the board, long side level
      new THREE.Matrix4().makeBasis(right, normal, new THREE.Vector3().crossVectors(right, normal))
    );
    for (const t of tools) {
      t.home = { position: t.object.position.clone(), quaternion: t.object.quaternion.clone() };
    }
    let held = null, lifted = null;

    function placeHome(t, lift = 0) {
      t.object.position.copy(t.home.position);
      t.object.quaternion.copy(t.home.quaternion);
      if (lift) {
        const parent = t.object.parent;
        const world = parent.localToWorld(t.home.position.clone()).addScaledVector(up, lift);
        t.object.position.copy(parent.worldToLocal(world));
      }
    }
    function placeHeld(worldPoint, gap) {
      const parent = held.object.parent;
      const parentQuat = parent.getWorldQuaternion(new THREE.Quaternion());
      const q = held.kind === 'eraser' ? eraserQuat : markerQuat;
      held.object.quaternion.copy(parentQuat.invert().multiply(q));
      held.object.position.copy(parent.worldToLocal(worldPoint.clone().addScaledVector(normal, gap)));
    }
    function setLifted(t) {
      if (lifted === t) return;
      if (lifted && lifted !== held) placeHome(lifted);
      lifted = t;
      if (lifted && lifted !== held) placeHome(lifted, HOVER_LIFT);
    }
    function take(t, e) {
      if (held) putBack();
      setLifted(null);
      held = t;
      if (t.onTake) t.onTake();
      const p = planePoint(e);
      if (p) placeHeld(p, HOVER_GAP);
    }
    function putBack() {
      if (!held) return;
      const t = held;
      held = null;
      drawing = null;
      placeHome(t);
      if (t.onReturn) t.onReturn();
    }

    // ---- pointer helpers ----
    const el = renderer.domElement;
    let drawing = null;                                // { id, last: {x,y}, mid: {x,y} }

    function planePoint(e) {
      return controller.setRay(e).ray.intersectPlane(plane, new THREE.Vector3());
    }
    // Which basket tool (or the basket itself) is under the pointer
    function pickBasket(e) {
      const hits = controller.setRay(e).intersectObjects([basket, ...tools.map((t) => t.object)], true);
      const hit = hits.find((h) => !(held && isInside(h.object, held.object)));   // skip the tool in hand
      if (!hit) return null;
      const tool = tools.find((t) => t !== held && isInside(hit.object, t.object));
      return tool || 'basket';
    }
    function isInside(obj, root) {
      for (let p = obj; p; p = p.parent) if (p === root) return true;
      return false;
    }
    // Pointer -> canvas pixel on the board's writing face (or null if off the board)
    function toCanvas(e) {
      const hit = controller.setRay(e).intersectObject(mesh, false)[0];
      if (!hit || !hit.uv) return null;
      const n = hit.face.normal.clone().transformDirection(mesh.matrixWorld);
      if (n.dot(normal) < 0.5) return null;            // only the front face
      return { x: hit.uv.x * canvas.width, y: (1 - hit.uv.y) * canvas.height };
    }

    // ---- marks ----
    function strokeWidth(e) {
      return e.pointerType === 'pen' && e.pressure > 0 ? markerSize * (0.55 + e.pressure * 0.9) : markerSize;
    }
    function segment(from, ctrl, to, width) {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = width;
      ctx.strokeStyle = held.color;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.quadraticCurveTo(ctrl.x, ctrl.y, to.x, to.y);
      ctx.stroke();
      ctx.restore();
    }
    function dot(p, width) {
      ctx.save();
      ctx.fillStyle = held.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, width / 2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    // The eraser wipes its own felt footprint, stamped along the path
    function wipe(from, to) {
      const [long, short] = held.feltIn || [3.5, 1.5];
      const w = long * pxPerIn.x, h = short * pxPerIn.y;
      const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 4));
      ctx.fillStyle = background;
      for (let i = 0; i <= steps; i++) {
        const x = from.x + (to.x - from.x) * (i / steps), y = from.y + (to.y - from.y) * (i / steps);
        ctx.fillRect(x - w / 2, y - h / 2, w, h);
      }
    }
    function mark(from, to, e) {
      if (held.kind === 'eraser') { wipe(from || to, to); return; }
      if (!from) { dot(to, strokeWidth(e)); return; }
      // Smooth curve through midpoints; consecutive segments share endpoints, so no gaps
      const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
      segment(drawing.mid, from, mid, strokeWidth(e));
      drawing.mid = mid;
    }

    // ---- pointer events (only while this board is focused) ----
    const focused = () => controller.state === 'focused' && controller.active === item;

    el.addEventListener('pointerdown', (e) => {
      if (!focused()) return;
      const picked = pickBasket(e);
      if (picked) {
        e.preventDefault();
        if (picked === 'basket') putBack(); else take(picked, e);
        updateCursor(e);
        return;
      }
      const p = toCanvas(e);
      if (p && held) {
        e.preventDefault();
        try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        drawing = { id: e.pointerId, last: p, mid: p };
        mark(null, p, e);
        placeHeld(planePoint(e), PRESS_GAP);
        refresh();
        return;
      }
      // Anywhere away from the board heads back to the room
      const w = planePoint(e);
      if (!w || !reachBox.containsPoint(w)) controller.exit();
    });

    el.addEventListener('pointermove', (e) => {
      if (!focused()) return;
      if (held) {
        const w = planePoint(e);
        if (w) placeHeld(w, drawing ? PRESS_GAP : HOVER_GAP);
      }
      if (!drawing || e.pointerId !== drawing.id) { updateCursor(e); return; }
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of (events.length ? events : [e])) {
        const p = toCanvas(ev);
        if (!p) { drawing.last = null; continue; }     // left the board: lift the tool
        if (!drawing.last) { drawing.last = p; drawing.mid = p; continue; }
        mark(drawing.last, p, ev);
        drawing.last = p;
      }
      refresh();
    });

    const endStroke = (e) => {
      if (!drawing || e.pointerId !== drawing.id) return;
      if (drawing.last && held.kind === 'marker') segment(drawing.mid, drawing.last, drawing.last, strokeWidth(e));
      drawing = null;
      const w = planePoint(e);
      if (w && held) placeHeld(w, HOVER_GAP);
      refresh();
      save();
    };
    el.addEventListener('pointerup', endStroke);
    el.addEventListener('pointercancel', endStroke);

    function updateCursor(e) {
      const picked = pickBasket(e);
      setLifted(picked && picked !== 'basket' ? picked : null);
      if (picked && (picked !== 'basket' || held)) el.style.cursor = 'pointer';
      else el.style.cursor = held ? 'none' : '';      // the held tool is the cursor
    }

    // ---- focus item ----
    const highlight = new THREE.Color(0x4a6c9b);
    const item = {
      mesh,
      owns: (obj) => isInside(obj, basket) || tools.some((t) => isInside(obj, t.object)),
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
        const center = viewBox.getCenter(new THREE.Vector3());
        const size = viewBox.getSize(new THREE.Vector3());
        // Fit the board and basket to ~80% of the limiting screen dimension; the basket juts
        // out toward the camera, so it looks bigger than its box
        const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
        const fill = 0.8;
        const dV = (across(size, up) / fill) / (2 * tanHalf);
        const dH = (across(size, right) / fill) / (2 * tanHalf * cam.aspect);
        const d = Math.max(dV, dH);
        return { position: center.clone().addScaledVector(normal, d), target: center };
      },
      onFocus() {},
      onExit() { putBack(); setLifted(null); el.style.cursor = ''; drawing = null; save(); }
    };
    controller.register(item);
    return { item, canvas, texture };
  }

  // ---------------------------------------------------------------------------
  // Focus spot: a close-up look at an object, optionally stepping through views
  // ---------------------------------------------------------------------------
  const STEPPER_CSS = `
  .ri-stepper {
    position: fixed; right: 16px; top: 50%; transform: translateY(-50%);
    display: flex; flex-direction: column; align-items: center; gap: 8px;
  }
  .ri-stepper[hidden] { display: none; }
  .ri-stepper button { width: 44px; height: 44px; padding: 0; font-size: 16px; line-height: 1; }
  .ri-stepper button:disabled { opacity: 0.35; cursor: default; }
  .ri-stepper .ri-count { font: 600 12px var(--font-ui, system-ui, sans-serif); color: var(--muted, #7a6f63); }
  .ri-note {
    position: fixed; transform: translate(-50%, calc(-100% - 12px)); pointer-events: none;
    max-width: min(260px, calc(100vw - 32px)); padding: 8px 12px; border-radius: 8px;
    background: var(--panel, rgba(250,248,244,.94)); color: var(--fg, #3a332c);
    border: 1px solid var(--line, rgba(0,0,0,.14)); backdrop-filter: blur(6px);
    font: 400 13px/1.4 var(--font-ui, system-ui, sans-serif); text-align: center;
  }
  .ri-note[hidden] { display: none; }
  `;

  // objects: what you click to focus. views: Box3s to frame, listed bottom to top; with more
  // than one, up/down buttons (and the arrow keys) step between them. Clicking away, or Esc, exits.
  // notes: [{ object, text }] captions shown above a thing while you hover it (or tap it).
  // inspect: { objects, face } things you can pull out to look at (books): click one and it
  //   slides out along the normal, turns its local `face` direction toward you and comes
  //   closer; drag to turn it over, click anywhere else (or Esc) to put it back.
  //   The motion (straight out until clear, then turn) follows The Complete Shelf in
  //   Mint Playground (MIT, Copyright (c) 2026 Mint).
  function createFocusSpot({ THREE, controller, renderer, objects, views, normal, notes = [], inspect = null, label = 'shelf', fill = 0.85 }) {
    const el = renderer.domElement;
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, normal).normalize();
    const across = (size, dir) => Math.abs(dir.x) * size.x + Math.abs(dir.y) * size.y + Math.abs(dir.z) * size.z;
    const within = (obj, root) => { for (let p = obj; p; p = p.parent) if (p === root) return true; return false; };
    const isInside = (obj) => objects.some((root) => within(obj, root));
    let index = 0;

    // Something other than this object between the eye and a point in the view?
    const sight = new THREE.Raycaster();
    function blocked(eye, points) {
      return points.some((p) => {
        const dir = eye.clone().sub(p), dist = dir.length();
        sight.set(p, dir.normalize());
        sight.far = dist;
        return sight.intersectObjects(controller.scene.children, true)
          .some((h) => h.distance > 0.01 && controller.isSeen(h.object) && !isInside(h.object));
      });
    }

    function viewFor(cam, i) {
      const box = views[i];
      const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
      const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
      const dV = (across(size, up) / fill) / (2 * tanHalf);
      const dH = (across(size, right) / fill) / (2 * tanHalf * cam.aspect);
      // measure from the front of the box, not its middle
      const d = Math.max(dV, dH) + across(size, normal) / 2;
      // Sample the front of the view; if furniture is in the way (a bed in front of a low
      // shelf), rise on an arc and look down into it instead
      const front = center.clone().addScaledVector(normal, across(size, normal) / 2 - 0.1);
      const hw = across(size, right) * 0.5, hh = across(size, up) * 0.5;
      const points = [center];
      for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1]]) {
        points.push(front.clone().addScaledVector(right, a * hw).addScaledVector(up, b * hh));
      }
      let eye = center.clone().addScaledVector(normal, d);
      for (let deg = 5; deg <= 60 && blocked(eye, points); deg += 5) {
        const t = THREE.MathUtils.degToRad(deg);
        eye = center.clone().addScaledVector(normal, d * Math.cos(t)).addScaledVector(up, d * Math.sin(t));
      }
      return { position: eye, target: center };
    }

    if (!document.getElementById('ri-stepper-css')) {
      const style = document.createElement('style');
      style.id = 'ri-stepper-css';
      style.textContent = STEPPER_CSS;
      document.head.appendChild(style);
    }

    // ---- up / down stepper ----
    let bar = null, upBtn = null, downBtn = null, count = null;
    if (views.length > 1) {
      bar = document.createElement('div');
      bar.className = 'ri-stepper';
      bar.hidden = true;
      const mk = (text, aria, delta) => {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = text; b.setAttribute('aria-label', aria);
        b.addEventListener('click', () => step(delta));
        return b;
      };
      upBtn = mk(String.fromCharCode(0x25B2), `${label} above`, 1);  // char codes, so the file encoding cannot garble them
      downBtn = mk(String.fromCharCode(0x25BC), `${label} below`, -1);
      count = document.createElement('div');
      count.className = 'ri-count';
      count.setAttribute('aria-live', 'polite');
      bar.append(upBtn, count, downBtn);
      document.body.appendChild(bar);
    }
    function sync() {
      if (!bar) return;
      upBtn.disabled = index >= views.length - 1;
      downBtn.disabled = index <= 0;
      count.textContent = `${views.length - index} / ${views.length}`;   // counted from the top
    }
    function step(delta) {
      putBack();
      const next = Math.max(0, Math.min(views.length - 1, index + delta));
      if (next === index || !focused()) return;
      showNote(null);
      index = next;
      sync();
      const v = viewFor(controller.camera, index);
      controller.glide(v.position, v.target, 650);
    }

    const focused = () => controller.state === 'focused' && controller.active === item;
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && focused() && held) { e.stopImmediatePropagation(); putBack(); }
    }, true);   // capture, so Esc puts a book back before it leaves the shelf
    window.addEventListener('keydown', (e) => {
      if (!focused() || !bar) return;
      if (e.key === 'ArrowUp') { e.preventDefault(); step(1); }
      if (e.key === 'ArrowDown') { e.preventDefault(); step(-1); }
    });
    // Clicking anything other than this object heads back to the room; tapping a thing with a
    // note shows it (touch screens have no hover)
    el.addEventListener('pointerdown', (e) => {
      if (!focused()) return;
      const hit = controller.setRay(e).intersectObjects(objects, true)[0];
      const thing = hit && isInside(hit.object) ? hit.object : null;
      const pull = thing && ownerOf(thing);
      if (held && pull === held.obj) { dragging = { x: e.clientX, y: e.clientY }; el.style.cursor = 'grabbing'; return; }
      if (pull) { takeOut(pull); return; }
      if (held) { putBack(); return; }
      if (!thing) { controller.exit(); return; }
      showNote(noteFor(thing));
    });
    el.addEventListener('pointermove', (e) => {
      if (!focused()) return;
      if (dragging) { turn(e.clientX - dragging.x, e.clientY - dragging.y); dragging = { x: e.clientX, y: e.clientY }; return; }
      if (e.pointerType === 'touch') return;
      const hit = controller.setRay(e).intersectObjects(objects, true)[0];
      // the one that's out: its note, and a hand to turn it with
      if (held && hit && within(hit.object, held.obj)) {
        showNote(held.t === 1 ? noteFor(hit.object) : null);
        el.style.cursor = held.t === 1 ? 'grab' : '';
        return;
      }
      showNote(hit ? noteFor(hit.object) : null);
      if (hit && ownerOf(hit.object)) el.style.cursor = 'pointer';
    });
    window.addEventListener('pointerup', () => { if (dragging) { dragging = null; el.style.cursor = 'grab'; } });

    // ---- pulling things out ----
    const pullable = inspect ? inspect.objects : [];
    const ownerOf = (obj) => pullable.find((o) => within(obj, o)) || null;
    const smooth = (t) => t * t * (3 - 2 * t);
    const states = new Map();    // object -> { obj, home, lane, present, t, anim }
    let held = null, dragging = null;

    function poseAt(h, t) {
      const a = 0.4;   // first 40%: straight out without turning, so it never clips the ones beside it
      if (t <= a) {
        h.obj.position.lerpVectors(h.home.pos, h.lane, smooth(t / a));
        h.obj.quaternion.copy(h.home.quat);
        h.obj.scale.setScalar(1);
      } else {
        const k = smooth((t - a) / (1 - a));
        h.obj.position.lerpVectors(h.lane, h.present.pos, k);
        h.obj.quaternion.slerpQuaternions(h.home.quat, h.present.quat, k);
        h.obj.scale.setScalar(1 + (h.present.scale - 1) * k);
      }
    }
    function animate(h, to, ms, done) {
      const from = h.t, start = performance.now();
      const dur = reducedMotion() ? 1 : Math.max(1, ms * Math.abs(to - from));
      const id = ++h.anim;
      (function frame() {
        if (h.anim !== id) return;
        const u = Math.min(1, (performance.now() - start) / dur);
        h.t = from + (to - from) * u;
        poseAt(h, h.t);
        if (u < 1) requestAnimationFrame(frame); else if (done) done();
      })();
    }

    function takeOut(obj) {
      if (held) putBack();
      showNote(null);
      let h = states.get(obj);
      if (!h) {
        h = { obj, home: { pos: obj.position.clone(), quat: obj.quaternion.clone() }, t: 0, anim: 0,
          size: new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3()) };   // measured on the shelf
        states.set(obj, h);
      }
      const cam = controller.camera, parent = obj.parent;
      parent.updateMatrixWorld();
      const parentQ = parent.getWorldQuaternion(new THREE.Quaternion());
      const homeWorld = parent.localToWorld(h.home.pos.clone());
      const homeQ = parentQ.clone().multiply(h.home.quat);
      const size = h.size, radius = size.length() / 2;
      // Lane: straight out until its back clears the front of the shelf by its turning radius
      const view = views[index];
      const front = Math.max(view.min.dot(normal), view.max.dot(normal));
      const back = homeWorld.dot(normal) - across(size, normal) / 2;
      const laneWorld = homeWorld.clone().addScaledVector(normal, Math.max(0, front - back) + radius + 0.5);
      // Presented: in front of the camera, filling about half the view, face toward you
      const dir = cam.getWorldDirection(new THREE.Vector3());
      const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
      const laneDist = laneWorld.clone().sub(cam.position).dot(dir);
      const dist = Math.min(Math.max(size.x, size.y, size.z) / 0.55 / (2 * tanHalf), laneDist - radius);
      const presentWorld = cam.position.clone().addScaledVector(dir, dist);
      const toCam = dir.clone().negate(), flat = toCam.clone().setY(0).normalize();
      const faceWorld = inspect.face.clone().applyQuaternion(homeQ).setY(0).normalize();
      const turnQ = new THREE.Quaternion().setFromUnitVectors(flat, toCam)        // tip back toward the eye
        .multiply(new THREE.Quaternion().setFromUnitVectors(faceWorld, flat));   // swing the face around
      h.lane = parent.worldToLocal(laneWorld);
      h.present = {
        pos: parent.worldToLocal(presentWorld),
        quat: parentQ.clone().invert().multiply(turnQ.multiply(homeQ)),
        scale: 1
      };
      h.parentQ = parentQ;
      held = h;
      animate(h, 1, 950, () => { if (held === h) showNote(noteFor(obj)); });
    }

    function putBack(instant = false) {
      if (!held) return;
      const h = held;
      held = null; dragging = null;
      showNote(null);
      el.style.cursor = '';
      if (instant) { h.anim++; h.t = 0; poseAt(h, 0); } else animate(h, 0, 850);
    }

    // Drag to turn it: left/right spins it, up/down tips it toward or away from you
    function turn(dx, dy) {
      const h = held;
      if (!h || h.t < 1) return;
      const cam = controller.camera;
      const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
      const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
      const spin = new THREE.Quaternion().setFromAxisAngle(camUp, dx * 0.01)
        .premultiply(new THREE.Quaternion().setFromAxisAngle(camRight, dy * 0.01));
      // a turn in world space, expressed in the parent's space
      const local = h.parentQ.clone().invert().multiply(spin).multiply(h.parentQ);
      h.present.quat.premultiply(local);
      h.obj.quaternion.copy(h.present.quat);
      if (shown) showNote(null);
    }

    // ---- highlight: the whole object in the room, one thing while a note is up ----
    const highlight = new THREE.Color(0x4a6c9b);
    function glow(roots, on, strength) {
      const set = new Set();
      for (const root of roots) root.traverse((o) => { if (o.isMesh && o.material) [].concat(o.material).forEach((m) => set.add(m)); });
      for (const m of set) {
        if (!m.emissive) continue;
        m.emissive.copy(on ? highlight : new THREE.Color(0x000000));
        m.emissiveIntensity = on ? strength : 1;
      }
    }

    // ---- notes ----
    const noteEl = document.createElement('div');
    noteEl.className = 'ri-note';
    noteEl.hidden = true;
    noteEl.setAttribute('role', 'status');
    document.body.appendChild(noteEl);
    let shown = null;
    const noteFor = (obj) => notes.find((n) => within(obj, n.object)) || null;
    function showNote(note) {
      if (note === shown) return;
      if (shown) glow([shown.object], false);
      shown = note;
      el.style.cursor = note ? 'help' : '';
      if (!note) { noteEl.hidden = true; return; }
      glow([note.object], true, 0.06);
      noteEl.textContent = note.text;
      // anchor just above the top of the thing, on screen
      const box = new THREE.Box3().setFromObject(note.object);
      const top = box.getCenter(new THREE.Vector3()).setY(box.max.y).project(controller.camera);
      const r = el.getBoundingClientRect();
      noteEl.style.left = `${r.left + (top.x + 1) / 2 * r.width}px`;
      noteEl.style.top = `${r.top + (1 - top.y) / 2 * r.height}px`;
      noteEl.hidden = false;
      // keep it on screen
      const b = noteEl.getBoundingClientRect();
      const shift = Math.max(16 - b.left, 0) + Math.min(window.innerWidth - 16 - b.right, 0);
      if (shift) noteEl.style.left = `${parseFloat(noteEl.style.left) + shift}px`;
    }

    // ---- with several views, hovering in the room lights just the row under the pointer ----
    //  A see-through copy of every mesh, drawn additively and clipped to that row's height,
    //  so shared parts (the sides, the back) only light up within the row.
    const nearestView = (point) => {
      let best = Infinity, at = 0;
      views.forEach((b, i) => { const d = b.distanceToPoint(point); if (d < best) { best = d; at = i; } });
      return at;
    };
    let rowGlow = null, lit = -1;
    if (views.length > 1) {
      renderer.localClippingEnabled = true;
      const planes = [new THREE.Plane(up.clone(), 0), new THREE.Plane(up.clone().negate(), 0)];
      const mat = new THREE.MeshBasicMaterial({
        color: highlight, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending,
        depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
        clippingPlanes: planes, visible: false
      });
      const meshes = [];
      objects.forEach((root) => root.traverse((o) => { if (o.isMesh && !o.isInstancedMesh) meshes.push(o); }));
      for (const o of meshes) {
        const copy = new THREE.Mesh(o.geometry, mat);
        copy.raycast = () => {};
        o.add(copy);
      }
      rowGlow = { mat, planes };
    }
    function lightRow(i) {
      if (i === lit) return;
      lit = i;
      if (i < 0) { rowGlow.mat.visible = false; return; }
      const v = views[i];
      const lo = Math.min(v.min.dot(up), v.max.dot(up)), hi = Math.max(v.min.dot(up), v.max.dot(up));
      rowGlow.planes[0].constant = -lo;   // keep above the bottom
      rowGlow.planes[1].constant = hi;    // and below the top
      rowGlow.mat.visible = true;
    }
    if (rowGlow) {
      el.addEventListener('pointermove', (e) => {
        if (controller.state !== 'room' || e.buttons) { lightRow(-1); return; }
        const hit = controller.setRay(e).intersectObjects(controller.scene.children, true).find((h) => controller.isSeen(h.object));
        lightRow(hit && isInside(hit.object) ? nearestView(hit.point) : -1);
      });
      el.addEventListener('pointerleave', () => lightRow(-1));
    }

    const item = {
      mesh: null,
      owns: isInside,
      onHover(on) { if (rowGlow) { if (!on) lightRow(-1); } else glow(objects, on, 0.22); },
      getFocusView(cam, hit) {
        // Start on the view nearest where you clicked
        index = hit && views.length > 1 ? nearestView(hit.point) : 0;
        sync();
        return viewFor(cam, index);
      },
      onFocus() { if (bar) bar.hidden = false; },
      onExit() { putBack(); if (bar) bar.hidden = true; showNote(null); }
    };
    controller.register(item);
    return { item };
  }

  window.RoomInteractive = { createFocusController, createDrawableBoard, createFocusSpot };
})();
