// The homepage globe: the extension gate's globe, painted with what an imagined
// learner knows, drawn by the GPU so it can be lit and turned smoothly.
//
// The countries are painted once onto a flat map (equirectangular, so longitude
// and latitude are just x and y), and a fragment shader wraps it round a sphere:
// for each pixel of the disc it works out which longitude and latitude it shows
// and reads the map there. The far side and the horizon need no clipping.
//
// It turns slowly on its own, leans a little towards the cursor, stops turning
// while the cursor is over it (so a country can be read), names the country
// under the cursor, and can be dragged. With reduced motion it holds still
// unless dragged. Without WebGL 2 the plain sphere behind it shows instead.

const RAD = Math.PI / 180;

/** The disc's radius as a share of half the canvas: the rest is the atmosphere. */
export const DISC = 0.86;

const COLORS = {
  sea: '#1a4a75',
  line: '#5d86ab',
  glow: '#6fa8dc',
  border: '#0e2f4f',
  plates: ['#3a6890', '#b3d4a0', '#f2d88a', '#eeb5ab'], // not met, known, learning, tripping up
};

const REST_PITCH = 16; // degrees of latitude at the centre: a little from above, where most land is
const START_YAW = 12; // Europe and Africa facing
const SPIN = 4.2; // degrees a second
const LEAN_YAW = 16; // how far it leans towards the cursor
const LEAN_PITCH = 9;

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform float uRadius;
uniform float uPx;
uniform mat3 uRot;
uniform vec3 uLight;
uniform sampler2D uTex;
uniform sampler2D uMask;
uniform float uHover;
uniform vec3 uSea;
uniform vec3 uLine;
uniform vec3 uGlow;
out vec4 outColor;
const float PI = 3.14159265359;

void main() {
  vec2 p = (gl_FragCoord.xy - uCenter) / uRadius;
  float d = length(p);
  float aa = 1.2 / uRadius;

  // The atmosphere: a soft halo just outside the disc.
  float h = max(d - 1.0, 0.0);
  float halo = (exp(-h * 10.0) * 0.38 + exp(-h * 32.0) * 0.3) * (1.0 - smoothstep(1.0, 1.16, d));
  vec4 outside = vec4(uGlow * halo, halo);
  if (d > 1.0 + aa) { outColor = outside; return; }

  float z = sqrt(max(0.0, 1.0 - d * d));
  vec3 n = vec3(p, z);
  vec3 g = uRot * n;
  float lat = asin(clamp(g.y, -1.0, 1.0));
  float lon = atan(g.x, g.z);
  vec2 uv = vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);

  // Texture gradients that ignore the jump where longitude wraps round.
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  float wrapped = fract(uv.x + 0.5);
  float wx = dFdx(wrapped), wy = dFdy(wrapped);
  if (abs(wx) < abs(dx.x)) dx.x = wx;
  if (abs(wy) < abs(dy.x)) dy.x = wy;
  vec4 tex = textureGrad(uTex, uv, dx, dy);
  float mask = textureGrad(uMask, uv, dx, dy).r;
  float land = tex.a;
  vec3 base = tex.rgb + uSea * (1.0 - land);

  // Graticule every 10 degrees, on the sea only, about one pixel wide.
  vec2 deg = vec2(degrees(lon), degrees(lat)) / 10.0;
  vec2 fw = vec2(min(fwidth(deg.x), fwidth(mod(deg.x + 18.0, 36.0))), fwidth(deg.y)) * uPx;
  vec2 dist = abs(fract(deg + 0.5) - 0.5) / max(fw, vec2(1e-5));
  float meridian = (1.0 - smoothstep(0.0, 1.0, dist.x)) * (1.0 - smoothstep(72.0, 82.0, abs(degrees(lat))));
  float parallel = 1.0 - smoothstep(0.0, 1.0, dist.y);
  base = mix(base, uLine, max(meridian, parallel) * (1.0 - land) * 0.4);

  // The country under the cursor lifts towards white.
  base = mix(base, vec3(1.0), mask * uHover * 0.5);

  vec3 L = normalize(uLight);
  float diffuse = dot(n, L);
  vec3 col = base * (0.5 + 0.56 * smoothstep(-0.45, 1.0, diffuse));
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float nh = max(dot(n, H), 0.0);
  col += (pow(nh, 70.0) * 0.2 + pow(nh, 14.0) * 0.05) * (1.0 - land * 0.8);
  col = mix(col, uGlow, pow(1.0 - z, 2.6) * 0.5);

  float a = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, d);
  outColor = vec4(col, 1.0) * a + outside * (1.0 - a);
}`;

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const easeOut = (t) => 1 - Math.pow(1 - t, 4);
/** Frame-rate independent smoothing: the share of the remaining distance to cover this frame. */
const follow = (rate, dt) => 1 - Math.exp(-rate * dt);

/** TopoJSON arcs and rings to plain [lon, lat, lon, lat…] arrays, with each polygon's bounding box. */
function decode(world) {
  const [sx, sy] = world.transform.scale;
  const [tx, ty] = world.transform.translate;
  const arcs = world.arcs.map((arc) => {
    const out = new Float64Array(arc.length * 2);
    let x = 0;
    let y = 0;
    arc.forEach(([dx, dy], i) => {
      x += dx;
      y += dy;
      out[2 * i] = x * sx + tx;
      out[2 * i + 1] = y * sy + ty;
    });
    return out;
  });
  const ring = (indices) => {
    const pts = [];
    indices.forEach((index, k) => {
      const arc = arcs[index < 0 ? ~index : index];
      const n = arc.length / 2;
      for (let i = k === 0 ? 0 : 1; i < n; i++) {
        const j = index < 0 ? n - 1 - i : i;
        pts.push(arc[2 * j], arc[2 * j + 1]);
      }
    });
    return Float64Array.from(pts);
  };
  return world.countries.map((c) => ({
    name: c.n || null,
    plate: c.c,
    polygons: c.a.map((poly) => {
      const rings = poly.map(ring);
      let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
      const outer = rings[0];
      for (let i = 0; i < outer.length; i += 2) {
        x0 = Math.min(x0, outer[i]); x1 = Math.max(x1, outer[i]);
        y0 = Math.min(y0, outer[i + 1]); y1 = Math.max(y1, outer[i + 1]);
      }
      return { rings, box: [x0, y0, x1, y1] };
    }),
  }));
}

/** Even-odd test over every ring, in plain longitude and latitude (the atlas is cut at ±180°). */
function contains(polygon, lon, lat) {
  const [x0, y0, x1, y1] = polygon.box;
  if (lon < x0 || lon > x1 || lat < y0 || lat > y1) return false;
  let inside = false;
  for (const r of polygon.rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function tracePolygons(ctx, polygons, W, H, skipSeams) {
  const X = (lon) => ((lon + 180) / 360) * W;
  const Y = (lat) => ((90 - lat) / 180) * H;
  for (const { rings } of polygons) {
    for (const r of rings) {
      for (let i = 0; i < r.length; i += 2) {
        const x = X(r[i]);
        const y = Y(r[i + 1]);
        // Borders: no line along the cut at ±180° or along the South Pole, where the atlas closes Antarctica.
        const seam = skipSeams && i > 0 && ((Math.abs(r[i]) > 179.99 && Math.abs(r[i - 2]) > 179.99) || (r[i + 1] < -89.9 && r[i - 1] < -89.9));
        if (i === 0 || seam) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      if (!skipSeams) ctx.closePath();
    }
  }
}

function paintMap(countries, W, H) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  for (const c of countries) {
    ctx.beginPath();
    tracePolygons(ctx, c.polygons, W, H, false);
    ctx.fillStyle = COLORS.plates[c.plate] || COLORS.plates[0];
    ctx.fill('evenodd');
  }
  ctx.beginPath();
  for (const c of countries) tracePolygons(ctx, c.polygons, W, H, true);
  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = Math.max(1.2, W / 2200);
  ctx.lineJoin = 'round';
  ctx.stroke();
  return canvas;
}

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
  return s;
}

/**
 * Start the globe in `root` (holding the canvas and the label). `area` is where
 * the cursor is followed. Resolves once the first frame is drawn; rejects if
 * WebGL 2 isn't available (root then gets `no-gl`).
 */
export async function startGlobe({ root, area, reduced }) {
  const canvas = root.querySelector('canvas');
  const label = root.querySelector('[data-globe-label]');
  const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: true, alpha: true, powerPreference: 'low-power' });
  if (!gl) {
    root.classList.add('no-gl');
    throw new Error('WebGL 2 unavailable');
  }

  const world = await fetch(new URL('../data/world.json', import.meta.url)).then((r) => {
    if (!r.ok) throw new Error(`world.json: ${r.status}`);
    return r.json();
  });
  const countries = decode(world);

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'link');
  gl.useProgram(program);
  const u = {};
  for (const name of ['uCenter', 'uRadius', 'uPx', 'uRot', 'uLight', 'uTex', 'uMask', 'uHover', 'uSea', 'uLine', 'uGlow']) u[name] = gl.getUniformLocation(program, name);

  // One triangle covering the canvas.
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, 'aPos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  // The painted map: 4096 wide where the screen can show it (about one texel per pixel at the centre).
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const bigScreen = Math.max(root.clientWidth, 1) * Math.min(2, window.devicePixelRatio || 1) > 900;
  const W = maxTex >= 4096 && bigScreen ? 4096 : 2048;
  const H = W / 2;
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');

  const texture = (unit, source, internal, format, premultiply) => {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, format, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    return t;
  };
  texture(0, paintMap(countries, W, H), gl.RGBA, gl.RGBA, true);

  // The highlight: one country in white on black, repainted when the cursor moves to another.
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = W / 2;
  maskCanvas.height = H / 2;
  const maskCtx = maskCanvas.getContext('2d');
  const paintMask = (country) => {
    maskCtx.fillStyle = '#000';
    maskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
    if (country) {
      maskCtx.beginPath();
      tracePolygons(maskCtx, country.polygons, maskCanvas.width, maskCanvas.height, false);
      maskCtx.fillStyle = '#fff';
      maskCtx.fill('evenodd');
    }
  };
  paintMask(null);
  const maskTex = texture(1, maskCanvas, gl.R8, gl.RED, false);
  const uploadMask = () => {
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, maskTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, maskCanvas);
    gl.generateMipmap(gl.TEXTURE_2D);
  };

  gl.uniform1i(u.uTex, 0);
  gl.uniform1i(u.uMask, 1);
  gl.uniform3fv(u.uSea, hex(COLORS.sea));
  gl.uniform3fv(u.uLine, hex(COLORS.line));
  gl.uniform3fv(u.uGlow, hex(COLORS.glow));

  // --- State -----------------------------------------------------------------
  let size = 0; // canvas size in CSS pixels (square)
  let dpr = 1;
  let yaw = START_YAW;
  let pitch = REST_PITCH;
  let velYaw = 0;
  let velPitch = 0;
  let spin = reduced ? 0 : 1;
  let intro = reduced ? 1 : 0;
  const lean = { x: 0, y: 0, tx: 0, ty: 0 };
  const light = { x: 0, y: 0 };
  let over = false; // cursor over the disc
  let drag = null;
  let hoverAmount = 0;
  let hoverTarget = 0;
  let hovered = null;
  let pointer = null; // last cursor position over the canvas, CSS px
  let tapTimer = 0;
  let view = { yaw, pitch };

  const rotation = (y, p) => {
    const cl = Math.cos(y * RAD), sl = Math.sin(y * RAD), cp = Math.cos(p * RAD), sp = Math.sin(p * RAD);
    // Ry(yaw) · Rx(-pitch), column-major: screen normal → globe direction.
    return [cl, 0, -sl, -sl * sp, cp, -cl * sp, sl * cp, sp, cl * cp];
  };

  /** The country under a point of the canvas (CSS px), if it has a name. */
  const pick = (x, y) => {
    const r = (size / 2) * DISC;
    const px = (x - size / 2) / r;
    const py = -(y - size / 2) / r;
    const d2 = px * px + py * py;
    if (d2 > 1) return null;
    const m = rotation(view.yaw, view.pitch);
    const nz = Math.sqrt(1 - d2);
    const gx = m[0] * px + m[3] * py + m[6] * nz;
    const gy = m[1] * px + m[4] * py + m[7] * nz;
    const gz = m[2] * px + m[5] * py + m[8] * nz;
    const lat = Math.asin(clamp(gy, -1, 1)) / RAD;
    const lon = Math.atan2(gx, gz) / RAD;
    for (const c of countries) if (c.name && c.polygons.some((p) => contains(p, lon, lat))) return c;
    return null;
  };

  const onDisc = (x, y) => Math.hypot(x - size / 2, y - size / 2) <= (size / 2) * DISC;

  const setHovered = (country) => {
    if (country === hovered) return;
    hovered = country;
    if (country) {
      paintMask(country);
      uploadMask();
      hoverAmount = 0;
      hoverTarget = 1;
      label.textContent = country.name;
      label.classList.add('is-on');
    } else {
      hoverTarget = 0;
      label.classList.remove('is-on');
    }
  };

  const placeLabel = (x, y) => {
    const offset = canvas.offsetLeft;
    const w = label.offsetWidth;
    // Above and right of the cursor, kept inside the globe's box.
    const lx = clamp(x + offset + 16, 0, root.clientWidth - w);
    const ly = Math.max(0, y + canvas.offsetTop - 44);
    label.style.transform = `translate(${lx}px, ${ly}px)`;
  };

  // --- Size ------------------------------------------------------------------
  const resize = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    size = canvas.clientWidth;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
    dirty = true;
  };
  let dirty = true;
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  // --- Input -----------------------------------------------------------------
  const local = (e) => {
    const rect = canvas.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) / rect.width) * size, y: ((e.clientY - rect.top) / rect.height) * size };
  };

  const onAreaMove = (e) => {
    if (e.pointerType !== 'mouse' || reduced) return;
    const rect = area.getBoundingClientRect();
    if (e.clientY < rect.top || e.clientY > rect.bottom) {
      lean.tx = 0;
      lean.ty = 0;
      return;
    }
    lean.tx = clamp(((e.clientX - rect.left) / rect.width) * 2 - 1, -1, 1);
    lean.ty = clamp(((e.clientY - rect.top) / rect.height) * 2 - 1, -1, 1);
  };
  const onAreaLeave = () => {
    lean.tx = 0;
    lean.ty = 0;
  };
  window.addEventListener('pointermove', onAreaMove, { passive: true });
  document.documentElement.addEventListener('pointerleave', onAreaLeave);

  canvas.addEventListener('pointermove', (e) => {
    const p = local(e);
    if (drag) {
      const now = performance.now();
      const dt = Math.max(1, now - drag.t) / 1000;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      const k = 180 / (Math.PI * (size / 2) * DISC); // a drag of one radius turns it about 57 degrees
      yaw -= dx * k;
      pitch = clamp(pitch + dy * k, -50, 70);
      velYaw = (-dx * k) / dt;
      velPitch = (dy * k) / dt;
      drag.x = e.clientX;
      drag.y = e.clientY;
      drag.t = now;
      return;
    }
    if (e.pointerType !== 'mouse') return;
    over = onDisc(p.x, p.y);
    canvas.style.cursor = over ? 'grab' : '';
    pointer = over ? p : null;
    if (!over) setHovered(null);
  });
  canvas.addEventListener('pointerleave', (e) => {
    if (drag || e.pointerType !== 'mouse') return;
    over = false;
    pointer = null;
    canvas.style.cursor = '';
    setHovered(null);
  });
  canvas.addEventListener('pointerdown', (e) => {
    const p = local(e);
    if (!onDisc(p.x, p.y)) return;
    drag = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false, id: e.pointerId };
    velYaw = 0;
    velPitch = 0;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  });
  const endDrag = (e) => {
    if (!drag) return;
    const tapped = !drag.moved;
    // Holding still before letting go means no fling.
    if (performance.now() - drag.t > 70) {
      velYaw = 0;
      velPitch = 0;
    }
    drag = null;
    const p = local(e);
    if (e.pointerType === 'mouse') {
      over = onDisc(p.x, p.y);
      canvas.style.cursor = over ? 'grab' : '';
      pointer = over ? p : null;
    } else if (tapped) {
      // On a touch screen, a tap names the country for a moment.
      pointer = p;
      clearTimeout(tapTimer);
      tapTimer = setTimeout(() => {
        pointer = null;
        setHovered(null);
      }, 1800);
    }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', (e) => {
    drag = null;
    endDrag(e);
  });

  // --- Frames ----------------------------------------------------------------
  let raf = 0;
  let last = performance.now();
  let visible = true;
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  let drawn = false;

  const frame = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    const holding = over || drag || pointer;
    spin += ((holding || reduced ? 0 : 1) - spin) * follow(3.5, dt);
    if (!drag) {
      yaw += velYaw * dt;
      pitch += velPitch * dt;
      velYaw *= Math.exp(-3.2 * dt);
      velPitch *= Math.exp(-3.2 * dt);
      pitch += (REST_PITCH - pitch) * follow(holding ? 0 : 1.1, dt);
      yaw -= SPIN * spin * dt;
    }
    if (!holding) {
      lean.x += (lean.tx - lean.x) * follow(2.6, dt);
      lean.y += (lean.ty - lean.y) * follow(2.6, dt);
    }
    light.x += (lean.tx - light.x) * follow(3, dt);
    light.y += (lean.ty - light.y) * follow(3, dt);
    if (intro < 1) intro = Math.min(1, intro + dt / 2.2);

    const introYaw = (1 - easeOut(intro)) * 40;
    view = { yaw: yaw + introYaw - lean.x * LEAN_YAW, pitch: clamp(pitch + lean.y * LEAN_PITCH, -60, 75) };

    if (pointer && !drag) {
      setHovered(pick(pointer.x, pointer.y));
      placeLabel(pointer.x, pointer.y);
    }
    hoverAmount += (hoverTarget - hoverAmount) * follow(hoverTarget ? 14 : 9, dt);

    const moving = !reduced || drag || Math.abs(velYaw) > 0.01 || Math.abs(velPitch) > 0.01 || Math.abs(hoverAmount - hoverTarget) > 0.002 || intro < 1;
    if (moving || dirty) {
      dirty = false;
      const r = (size / 2) * DISC * dpr;
      gl.uniform2f(u.uCenter, canvas.width / 2, canvas.height / 2);
      gl.uniform1f(u.uRadius, r);
      gl.uniform1f(u.uPx, Math.max(1, dpr * 0.75));
      gl.uniformMatrix3fv(u.uRot, false, rotation(view.yaw, view.pitch));
      gl.uniform3f(u.uLight, -0.55 + light.x * 0.45, 0.6 - light.y * 0.35, 0.85);
      gl.uniform1f(u.uHover, hoverAmount);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!drawn) {
        drawn = true;
        resolveReady();
      }
    }
    raf = visible && !document.hidden ? requestAnimationFrame(frame) : 0;
  };

  const run = () => {
    if (raf || !visible || document.hidden) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  };
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    run();
  }).observe(canvas);
  document.addEventListener('visibilitychange', run);
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    cancelAnimationFrame(raf);
    raf = 0;
    visible = false;
    root.classList.add('no-gl');
  });

  run();
  await ready;
  root.classList.add('is-ready');
}
