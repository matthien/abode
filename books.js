// books.js — procedural books for the room's bookshelf.
//
//   RoomBooks.createBook(THREE, spec) -> THREE.Group
//       A rounded book centered on its own origin: height along +Y, spine facing +Z,
//       front cover facing +X (how a book sits on a shelf, spine out). Front, back and
//       spine are drawn on canvases from the spec, so no images are needed.
//
//   spec: { id, title, author, spineTitle?, spineAuthor?, cover, accent, ink, motif,
//           thickness, height, depth, blurb? }   colors as numbers, sizes in inches
//
// Cover art (motifs, paper grain, typography) is adapted from The Complete Shelf in
// Mint Playground, https://github.com/mintdotgg/mint-playground
//   MIT License, Copyright (c) 2026 Mint
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this
//   software and associated documentation files (the "Software"), to deal in the Software
//   without restriction, including without limitation the rights to use, copy, modify,
//   merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
//   permit persons to whom the Software is furnished to do so, subject to the following
//   conditions: The above copyright notice and this permission notice shall be included
//   in all copies or substantial portions of the Software.
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
//   INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
//   PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
//   HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
//   CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
//   OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
(function () {
  const serif = 'Georgia, "Iowan Old Style", serif';
  const sans = 'system-ui, Arial, sans-serif';
  const hex = (c) => '#' + c.toString(16).padStart(6, '0');

  // Same seed -> same pattern every load
  function seeded(seed) {
    let state = 2166136261;
    for (const ch of seed) { state ^= ch.charCodeAt(0); state = Math.imul(state, 16777619); }
    return () => {
      state += 0x6d2b79f5;
      let v = state;
      v = Math.imul(v ^ (v >>> 15), v | 1);
      v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
      return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
    };
  }

  function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines = 8) {
    const lines = [];
    let line = '';
    for (const word of text.split(/\s+/)) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = word; } else line = test;
    }
    if (line) lines.push(line);
    lines.slice(0, maxLines).forEach((l, i) => ctx.fillText(l, x, y + i * lineHeight));
    return Math.min(lines.length, maxLines);
  }

  function strokeLine(ctx, points, width = 4) {
    if (!points.length) return;
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (const [x, y] of points.slice(1)) ctx.lineTo(x, y);
    ctx.lineWidth = width;
    ctx.stroke();
  }

  // Motifs drawn on a 1024 x 1536 front cover
  function drawMotif(ctx, b, width, height) {
    const random = seeded(b.id);
    const accent = hex(b.accent), ink = hex(b.ink);
    ctx.save();
    ctx.strokeStyle = accent; ctx.fillStyle = accent;
    ctx.globalAlpha = 0.88; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    switch (b.motif) {
      case 'lattice': {
        const nodes = [];
        for (let i = 0; i < 24; i++) nodes.push([110 + random() * (width - 220), 380 + random() * (height - 560)]);
        ctx.globalAlpha = 0.38;
        nodes.forEach((p, i) => nodes.slice(i + 1).forEach((o) => {
          if (Math.hypot(p[0] - o[0], p[1] - o[1]) < 240) strokeLine(ctx, [p, o], 3);
        }));
        ctx.globalAlpha = 0.9;
        nodes.forEach(([x, y], i) => { ctx.beginPath(); ctx.arc(x, y, i % 5 === 0 ? 12 : 6, 0, Math.PI * 2); ctx.fill(); });
        break;
      }
      case 'efficiency': {
        ctx.globalAlpha = 0.72;
        for (let x = 140; x < width - 100; x += 150) {
          ctx.lineWidth = 4;
          ctx.strokeRect(x, 450, 94, height - 690);
          for (let y = 520; y < height - 250; y += 130) {
            ctx.beginPath(); ctx.arc(x + 47, y, 26, 0, Math.PI * 2); ctx.stroke();
            strokeLine(ctx, [[x + 10, y], [x + 84, y]], 3);
          }
        }
        strokeLine(ctx, [[120, height - 315], [width - 120, 420]], 9);
        break;
      }
      case 'network': {
        ctx.globalAlpha = 0.66;
        for (let x = 0; x < 7; x++) for (let y = 0; y < 9; y++) {
          const px = 130 + x * 126 + Math.sin(y) * 18, py = 390 + y * 105;
          if (x < 6) strokeLine(ctx, [[px, py], [px + 126 + Math.sin(y + 1) * 18, py + 105]], 2.5);
          ctx.beginPath(); ctx.arc(px, py, (x + y) % 5 === 0 ? 11 : 4, 0, Math.PI * 2); ctx.fill();
        }
        break;
      }
      case 'boom': {
        ctx.globalAlpha = 0.86;
        for (let i = 0; i < 9; i++) {
          ctx.beginPath(); ctx.arc(width * 0.54, height * 0.63, 48 + i * 68, 0, Math.PI * 2);
          ctx.lineWidth = i % 3 === 0 ? 13 : 4; ctx.stroke();
        }
        break;
      }
      case 'schematic': {
        ctx.globalAlpha = 0.72;
        for (let i = 0; i < 6; i++) {
          const y = 430 + i * 165, k = i % 2 ? -72 : 72;
          strokeLine(ctx, [[110, y], [300, y], [380, y + k], [610, y + k], [700, y], [width - 110, y]], 5);
          [300, 700].forEach((x) => { ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.fill(); });
        }
        break;
      }
      case 'orbit': {
        ctx.globalAlpha = 0.66;
        ctx.save();
        ctx.translate(width * 0.52, height * 0.64);
        for (let i = 0; i < 7; i++) {
          ctx.rotate(0.42);
          ctx.beginPath(); ctx.ellipse(0, 0, 100 + i * 48, 36 + i * 20, 0, 0, Math.PI * 2);
          ctx.lineWidth = i === 3 ? 8 : 3; ctx.stroke();
        }
        ctx.restore();
        ctx.beginPath(); ctx.arc(width * 0.52, height * 0.64, 24, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case 'branches': {
        ctx.globalAlpha = 0.84;
        const root = [width / 2, height - 185];
        for (let level = 0; level < 5; level++) {
          const count = 2 ** level;
          for (let i = 0; i < count; i++) {
            const y = height - 240 - level * 180;
            const span = width * (0.13 + level * 0.1);
            const x = width / 2 + (i / Math.max(1, count - 1) - 0.5) * span * 2;
            const pi = Math.floor(i / 2), pc = 2 ** Math.max(0, level - 1);
            const parentX = level === 0 ? root[0]
              : width / 2 + (pi / Math.max(1, pc - 1) - 0.5) * width * (0.13 + (level - 1) * 0.1) * 2;
            const parentY = level === 0 ? root[1] : y + 180;
            strokeLine(ctx, [[parentX, parentY], [x, y]], 4);
            ctx.beginPath(); ctx.arc(x, y, level === 4 ? 10 : 6, 0, Math.PI * 2); ctx.fill();
          }
        }
        break;
      }
      case 'wave': {
        ctx.globalAlpha = 0.8;
        for (let row = 0; row < 10; row++) {
          ctx.beginPath();
          for (let x = 80; x <= width - 80; x += 12) {
            const y = 430 + row * 92 + Math.sin(x * 0.025 + row * 0.78) * (18 + row * 3);
            if (x === 80) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.lineWidth = row % 3 === 0 ? 7 : 3; ctx.stroke();
        }
        break;
      }
      case 'gather': {
        ctx.globalAlpha = 0.76;
        const colors = [ink, accent, '#2b5f83'];
        for (let i = 0; i < 18; i++) {
          ctx.strokeStyle = colors[i % colors.length]; ctx.lineWidth = 16;
          ctx.beginPath();
          ctx.arc(width * (0.2 + random() * 0.6), height * (0.34 + random() * 0.48), 42 + random() * 110, 0, Math.PI * 2);
          ctx.stroke();
        }
        break;
      }
      case 'maze': {
        ctx.globalAlpha = 0.76;
        const size = 94;
        for (let x = 92; x < width - 92; x += size) for (let y = 400; y < height - 180; y += size) {
          strokeLine(ctx, random() > 0.48 ? [[x, y], [x + size, y]] : [[x, y], [x, y + size]], 7);
        }
        strokeLine(ctx, [[95, height - 215], [310, height - 215], [310, 680], [720, 680], [720, 430], [width - 95, 430]], 14);
        break;
      }
      case 'fracture': {
        ctx.globalAlpha = 0.88;
        for (let i = 0; i < 16; i++) {
          const sx = width * 0.5 + (random() - 0.5) * 160, sy = height * 0.62 + (random() - 0.5) * 140;
          const ex = random() > 0.5 ? width - 50 : 50, ey = 340 + random() * (height - 500);
          strokeLine(ctx, [[sx, sy], [(sx + ex) / 2 + (random() - 0.5) * 90, (sy + ey) / 2], [ex, ey]], i % 4 === 0 ? 12 : 4);
        }
        break;
      }
      case 'continuum': {
        ctx.globalAlpha = 0.88;
        ctx.beginPath(); ctx.moveTo(70, height * 0.72);
        for (let x = 70; x <= width - 70; x += 16) {
          const t = (x - 70) / (width - 140);
          ctx.lineTo(x, height * 0.72 - Math.sin(t * Math.PI * 5) * 90 - Math.pow(t, 2) * 330);
        }
        ctx.lineWidth = 12; ctx.stroke();
        break;
      }
      case 'windows': {
        ctx.globalAlpha = 0.72;
        for (let i = 0; i < 9; i++) {
          const inset = 90 + i * 48;
          ctx.lineWidth = i === 0 ? 11 : 4;
          ctx.strokeRect(inset, 390 + i * 32, width - inset * 2, height - 590 - i * 64);
        }
        ctx.beginPath(); ctx.roundRect(width * 0.49, height * 0.62, 24, 118, 8); ctx.fill();
        break;
      }
      case 'steps': {
        ctx.globalAlpha = 0.86;
        for (let i = 0; i < 8; i++) ctx.fillRect(120 + i * 92, height - 230 - i * 102, 78, 102 + i * 102);
        ctx.globalAlpha = 0.34;
        strokeLine(ctx, [[110, height - 235], [width - 115, 420]], 8);
        break;
      }
    }
    ctx.restore();
  }

  function addPaperGrain(ctx, width, height, seed) {
    const random = seeded(`${seed}-grain`);
    ctx.save();
    for (let i = 0; i < 1600; i++) {
      const a = 0.018 + random() * 0.03;
      ctx.fillStyle = random() > 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
      const s = random() * 2.2 + 0.35;
      ctx.fillRect(random() * width, random() * height, s, s);
    }
    ctx.restore();
  }

  // A canvas drawn at a logical size and stored at half resolution
  function sheet(lw, lh, draw) {
    const cv = document.createElement('canvas');
    cv.width = lw / 2; cv.height = lh / 2;
    const ctx = cv.getContext('2d');
    ctx.scale(0.5, 0.5);
    draw(ctx);
    return cv;
  }

  function frontCover(b) {
    const W = 1024, H = Math.round(1024 * b.height / b.depth);
    return sheet(W, H, (ctx) => {
      ctx.fillStyle = hex(b.cover); ctx.fillRect(0, 0, W, H);
      drawMotif(ctx, b, W, H);
      addPaperGrain(ctx, W, H, b.id);
      ctx.save();
      ctx.globalAlpha = 0.26; ctx.strokeStyle = hex(b.ink); ctx.lineWidth = 4;
      ctx.strokeRect(22, 22, W - 44, H - 44);
      ctx.restore();
      // title and author
      ctx.fillStyle = hex(b.ink); ctx.textBaseline = 'top';
      const size = b.title.length > 38 ? 74 : b.title.length > 24 ? 86 : 112;
      ctx.font = `500 ${size}px ${serif}`;
      const lines = wrapText(ctx, b.title, 78, 120, W - 156, size * 0.91, 5);
      ctx.font = `500 31px ${sans}`;
      ctx.fillText(b.author, 82, Math.max(300, 120 + lines * size * 0.91 + 35));
    });
  }

  function backCover(b) {
    const W = 1024, H = Math.round(1024 * b.height / b.depth);
    return sheet(W, H, (ctx) => {
      ctx.fillStyle = hex(b.cover); ctx.fillRect(0, 0, W, H);
      addPaperGrain(ctx, W, H, `${b.id}-back`);
      ctx.fillStyle = hex(b.ink); ctx.textBaseline = 'top';
      ctx.font = `italic 500 64px ${serif}`;
      const lines = wrapText(ctx, b.title, 108, 180, 808, 74, 4);
      ctx.save();
      ctx.globalAlpha = 0.9; ctx.fillStyle = hex(b.accent);
      ctx.fillRect(108, 180 + lines * 74 + 50, 108, 9);
      ctx.restore();
      ctx.font = `600 26px ${sans}`;
      ctx.fillText(b.author.toUpperCase(), 110, 180 + lines * 74 + 100);
      if (b.blurb) {
        ctx.font = `500 42px ${serif}`;
        wrapText(ctx, b.blurb, 108, 180 + lines * 74 + 180, 808, 56, 10);
      }
      // barcode
      const random = seeded(`${b.id}-barcode`);
      ctx.fillStyle = '#fff'; ctx.fillRect(W - 360, H - 250, 260, 150);
      ctx.fillStyle = '#111';
      for (let x = W - 340; x < W - 120;) { const w = 2 + Math.floor(random() * 5); if (random() > 0.4) ctx.fillRect(x, H - 235, w, 110); x += w + 2; }
    });
  }

  // Title running top to bottom, author at the foot (letters face the front cover, as on US books)
  function spine(b) {
    const W = 256, H = Math.round(256 * b.height / b.thickness);
    return sheet(W, H, (ctx) => {
      ctx.fillStyle = hex(b.cover); ctx.fillRect(0, 0, W, H);
      addPaperGrain(ctx, W, H, `${b.id}-spine`);
      ctx.fillStyle = hex(b.accent);
      ctx.fillRect(0, H * 0.035, W, 10); ctx.fillRect(0, H * 0.965 - 10, W, 10);
      ctx.fillStyle = hex(b.ink);
      ctx.translate(W / 2, 0); ctx.rotate(Math.PI / 2);
      ctx.textBaseline = 'middle';
      const fit = (text, size, maxLen, weight) => {
        ctx.font = `${weight} ${size}px ${serif}`;
        const tw = ctx.measureText(text).width;
        if (tw > maxLen) ctx.font = `${weight} ${size * maxLen / tw}px ${serif}`;
      };
      const title = b.spineTitle || b.title.toUpperCase();
      const author = b.spineAuthor || b.author.split(' ').pop().toUpperCase();
      fit(title, W * 0.42, H * 0.66, 600);
      ctx.textAlign = 'left'; ctx.fillText(title, H * 0.07, 0);
      fit(author, W * 0.32, H * 0.15, 600);
      ctx.textAlign = 'right'; ctx.fillText(author, H * 0.93, 0);
    });
  }

  // Page edges: fine lines along the length of the block
  let pageEdge = null;
  function pages(THREE) {
    if (pageEdge) return pageEdge;
    const cv = document.createElement('canvas');
    cv.width = 64; cv.height = 256;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#efe7d3'; ctx.fillRect(0, 0, 64, 256);
    const random = seeded('pages');
    for (let x = 0; x < 64; x += 2) {
      ctx.fillStyle = `rgba(120,100,70,${0.05 + random() * 0.08})`;
      ctx.fillRect(x, 0, 1, 256);
    }
    pageEdge = new THREE.CanvasTexture(cv);
    pageEdge.encoding = THREE.sRGBEncoding;
    return pageEdge;
  }

  function texture(THREE, canvas) {
    const t = new THREE.CanvasTexture(canvas);
    t.encoding = THREE.sRGBEncoding;
    t.anisotropy = 4;
    return t;
  }

  function createBook(THREE, b) {
    const { thickness: w, height: h, depth: d } = b;
    const group = new THREE.Group();
    group.name = b.id;
    const coverMat = (map) => new THREE.MeshStandardMaterial({ map, roughness: 0.62 });
    const edge = () => new THREE.MeshStandardMaterial({ map: pages(THREE), roughness: 0.9 });
    const board = new THREE.MeshStandardMaterial({ color: b.cover, roughness: 0.62 });

    // Cover: front, back and spine boards with rounded edges (thin boxes so the page
    // block shows between them on the top, bottom and fore edge)
    const c = Math.min(0.09, w * 0.12), r = c * 0.45;
    const front = new THREE.Mesh(new THREE.RoundedBoxGeometry(c, h, d, 2, r),
      [coverMat(texture(THREE, frontCover(b))), board, board, board, board, board]);
    front.position.x = w / 2 - c / 2;
    const back = new THREE.Mesh(new THREE.RoundedBoxGeometry(c, h, d, 2, r),
      [board, coverMat(texture(THREE, backCover(b))), board, board, board, board]);
    back.position.x = -w / 2 + c / 2;
    const spineMesh = new THREE.Mesh(new THREE.RoundedBoxGeometry(w, h, c * 1.4, 2, r),
      [board, board, board, board, coverMat(texture(THREE, spine(b))), board]);
    spineMesh.position.z = d / 2 - c * 0.7;
    // Page block, set in from the boards' edges; runs from the fore edge to inside the spine
    const inset = 0.1, sp = c * 1.4;
    const block = new THREE.Mesh(new THREE.BoxGeometry(w - 2 * c, h - 2 * inset, d - sp - inset), edge());
    block.position.z = (inset - sp) / 2;
    for (const m of [front, back, spineMesh, block]) { m.castShadow = m.receiveShadow = true; group.add(m); }
    return group;
  }

  window.RoomBooks = { createBook };
})();
