// Shared rasteriser of gc::FaceAnimator frames for the browser. Used by BOTH tools/preview/preview.html
// (desktop preview of dumped frames) and tools/webdevice (live frames from the firmware core compiled
// to wasm), so there is exactly one JS drawing implementation. It mirrors M5Face::draw() in
// src/platform/pf_display.h (polygon fans, ellipses, rings, subtitle box). Plain script (no modules).
(function (root) {
function hex(c) { return '#' + (c >>> 0).toString(16).padStart(6, '0'); }

// --- rasteriser: mirrors M5Face::draw() in pf_display.h -------------------------------------
function drawFrame(ctx, f, s) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = hex(f.bg);
  ctx.fillRect(0, 0, 320 * s, 240 * s);
  ctx.lineJoin = 'round';
  for (const p of f.p) {
    const [type, color, x, y, rx, ry, thick, pts] = p;
    const col = hex(color);
    if (type === 0) {               // Poly: triangle fan from the centroid
      const n = pts.length / 2;
      if (n < 3) continue;
      let cx = 0, cy = 0;
      for (let k = 0; k < n; k++) { cx += pts[2 * k]; cy += pts[2 * k + 1]; }
      cx = cx / n * s; cy = cy / n * s;
      ctx.fillStyle = col;
      ctx.beginPath();                // whole fan in one path: no anti-aliasing seams between triangles
      for (let k = 0; k < n; k++) {
        const a = k, b = (k + 1) % n;
        ctx.moveTo(cx, cy);
        ctx.lineTo(pts[2 * a] * s, pts[2 * a + 1] * s);
        ctx.lineTo(pts[2 * b] * s, pts[2 * b + 1] * s);
        ctx.closePath();
      }
      ctx.fill();
    } else if (type === 1) {        // Ellipse
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.ellipse(x * s, y * s, Math.max(rx * s, 0.01), Math.max(ry * s, 0.01), 0, 0, Math.PI * 2); ctx.fill();
    } else {                        // Ring: concentric 1px outlines, drawn inwards
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      const th = Math.max(1, Math.round(thick * s));
      for (let k = 0; k < th; k++) {
        const a = rx * s - k, b = ry * s - k;
        if (a <= 0 || b <= 0) break;
        ctx.beginPath(); ctx.ellipse(x * s, y * s, a, b, 0, 0, Math.PI * 2); ctx.stroke();
      }
    }
  }
}

function drawBox(ctx, L, s) {     // subtitle box like drawText(): round rect 0x2104 with grey border
  const [bx, by, bw, bh] = L.box;
  ctx.fillStyle = '#212421'; ctx.strokeStyle = '#7b7d7b'; ctx.lineWidth = 1;
  const r = 8 * s, x = bx * s, y = by * s, w = bw * s, h = bh * s;
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); ctx.fill(); ctx.stroke();
  const fpx = L.fontPx || 16, lh = L.lh || 18;   // efontCN_12/16/24 -> small/medium/large (line height = font height + 2)
  ctx.fillStyle = '#fff'; ctx.font = (fpx * s) + 'px "Noto Sans CJK SC", "Microsoft YaHei", sans-serif'; ctx.textBaseline = 'top';
  L.text.forEach((t, i) => ctx.fillText(t, 8 * s, (by + 6 + i * lh) * s));
}

// Mirrors M5Face::layoutText()/drawText(): wrap by character with a CJK-width model (efont: ASCII = half
// em, everything else = full em), then place the box. pos: bubble|center|bottom, size: small|medium|large.
function layoutText(text, pos, size) {
  const fpx = size === 'small' ? 12 : size === 'large' ? 24 : 16, lh = fpx + 2, maxW = 320 - 16 - 8;
  const w = (str) => { let n = 0; for (const ch of str) n += ch.codePointAt(0) < 0x80 ? fpx / 2 : fpx; return n; };
  let lines = [], cur = '';
  for (const ch of text) {
    if (ch === '\n') { lines.push(cur); cur = ''; continue; }
    if (w(cur + ch) > maxW && cur) { lines.push(cur); cur = ''; }
    cur += ch;
  }
  if (cur) lines.push(cur);
  const maxLines = Math.floor((pos === 'center' ? 240 - 40 : 80) / lh);
  if (lines.length > maxLines && maxLines > 0) lines = lines.slice(0, maxLines);
  const bh = lines.length * lh + 12;
  const y0 = pos === 'bottom' ? 240 - bh - 4 : pos === 'center' ? Math.floor((240 - bh) / 2) : 4;
  return { box: [4, y0, 312, bh], text: lines, fontPx: fpx, lh };
}

root.GCFaceDraw = { hex, drawFrame, drawBox, layoutText };
})(typeof globalThis !== 'undefined' ? globalThis : window);
