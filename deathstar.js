// Death Star renderer. Procedural surface, ray-marched into a bitmap canvas.
//
// renderFrame() and surfaceOffset() are pure (no DOM) so they can be tested
// in Node. mount() is the only part that touches the page.

export const CONFIG = {
  tilt: 0.45,          // radians; tips the superlaser dish toward the viewer
  spinSpeed: 0.4,      // radians per second
  fill: 0.42,          // sphere radius as a fraction of the canvas size
  bound: 1.25,         // bounding sphere radius, in units of the sphere radius
  maxSteps: 90,        // ray-march iterations per pixel
  hitEps: 0.0015,      // surface hit threshold
  dishDepth: 0.13,     // superlaser crater depth (fraction of radius)
  dishRadius: 0.42,    // crater angular radius (radians)
  rimHeight: 0.025,    // raised rim around the crater
  trenchDepth: 0.06,   // equatorial trench depth
  trenchWidth: 0.09,   // trench half-width (≈ radians of latitude)
};

const LIGHT = normalize(-0.5, 0.6, 0.8);
const HALF = normalize(LIGHT.x, LIGHT.y, LIGHT.z + 1);

function normalize(x, y, z) {
  const l = Math.hypot(x, y, z);
  return { x: x / l, y: y / l, z: z / l };
}

// Radial displacement of the surface in object space.
// ny is the y component of the unit direction (+y is the dish pole).
export function surfaceOffset(ny) {
  const { dishRadius: rc, dishDepth, rimHeight, trenchDepth, trenchWidth } = CONFIG;
  const th2 = 2 * (1 - ny); // theta^2, accurate for small theta
  let h = 0;

  // Superlaser crater: smooth bowl, deepest at the pole, zero slope at the rim.
  if (th2 < rc * rc) {
    const q = th2 / (rc * rc);
    h -= dishDepth * (1 - q) * (1 - q);
  }

  // Raised rim just outside the crater.
  if (th2 < (rc + 0.3) * (rc + 0.3)) {
    const d = (Math.sqrt(th2) - rc) / 0.05;
    h += rimHeight * Math.exp(-d * d);
  }

  // Equatorial trench: flat-bottomed groove around the middle.
  const g = ny / trenchWidth;
  const g2 = g * g;
  h -= trenchDepth * Math.exp(-(g2 * g2));

  return h;
}

// Signed distance-like value: positive outside the displaced surface.
// World -> object transform is Ry(-spin) * Rx(-tilt).
function sdf(x, y, z, c, s, cs, ss) {
  const y1 = y * c + z * s;
  const z1 = -y * s + z * c;
  const xo = x * cs - z1 * ss;
  const zo = x * ss + z1 * cs;
  const r = Math.sqrt(xo * xo + y1 * y1 + zo * zo);
  return r - (1 + surfaceOffset(y1 / r));
}

// Render one frame into `out` (RGBA bytes, N x N). Background pixels get
// alpha 0 so the page background shows through. Returns the number of hit pixels.
export function renderFrame(out, N, spin, rgb) {
  const { tilt, fill, bound, maxSteps, hitEps } = CONFIG;
  const c = Math.cos(tilt), s = Math.sin(tilt);
  const cs = Math.cos(spin), ss = Math.sin(spin);
  const scale = N * fill;
  const half = N / 2;
  const B2 = bound * bound;
  const e = 0.002;
  let hits = 0;

  for (let j = 0; j < N; j++) {
    const y = (half - j - 0.5) / scale;
    for (let i = 0; i < N; i++) {
      const x = (i + 0.5 - half) / scale;
      const p = (j * N + i) * 4;
      const r2 = x * x + y * y;
      if (r2 > B2) { out[p + 3] = 0; continue; }

      // Orthographic ray, travelling along -z, starting on the bounding sphere.
      let z = Math.sqrt(B2 - r2);
      let hit = false;
      for (let k = 0; k < maxSteps; k++) {
        const f = sdf(x, y, z, c, s, cs, ss);
        if (f < hitEps) { hit = true; break; }
        z -= f * 0.9;
        if (z < -bound) break;
      }
      if (!hit) { out[p + 3] = 0; continue; }
      hits++;

      // Surface normal from the tetrahedron gradient.
      const n1 = sdf(x + e, y - e, z - e, c, s, cs, ss);
      const n2 = sdf(x - e, y - e, z + e, c, s, cs, ss);
      const n3 = sdf(x - e, y + e, z - e, c, s, cs, ss);
      const n4 = sdf(x + e, y + e, z + e, c, s, cs, ss);
      const n = normalize(n1 - n2 - n3 + n4, -n1 - n2 + n3 + n4, -n1 + n2 - n3 + n4);

      const diffuse = Math.max(0, n.x * LIGHT.x + n.y * LIGHT.y + n.z * LIGHT.z);
      const spec = Math.pow(Math.max(0, n.x * HALF.x + n.y * HALF.y + n.z * HALF.z), 28) * 0.4;
      let intensity = 0.1 + 0.85 * diffuse + spec;

      // Faint panel seams so the spin is visible on smooth shading.
      intensity *= panelShade(x, y, z, c, s, cs, ss);

      intensity = Math.min(1, Math.max(0, intensity));
      out[p] = rgb[0] * intensity;
      out[p + 1] = rgb[1] * intensity;
      out[p + 2] = rgb[2] * intensity;
      out[p + 3] = 255;
    }
  }
  return hits;
}

// Object-space longitude of a world point on the surface, darkened on panel seams.
function panelShade(x, y, z, c, s, cs, ss) {
  const y1 = y * c + z * s;
  const z1 = -y * s + z * c;
  const xo = x * cs - z1 * ss;
  const zo = x * ss + z1 * cs;
  const lon = Math.atan2(zo, xo);
  return Math.abs(Math.sin(lon * 14)) < 0.06 ? 0.8 : 1;
}

function parseColor(str) {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(str || "");
  return m ? [+m[1], +m[2], +m[3]] : [232, 232, 236];
}

// Browser-only: draws the animation into a canvas.
export function mount(canvas, { fps = 30, reducedMotion, maxSize = 420 } = {}) {
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssSize = canvas.clientWidth || 360;
  const N = Math.round(Math.min(cssSize * dpr, maxSize));
  canvas.width = N;
  canvas.height = N;
  const img = ctx.createImageData(N, N);

  const reduced = reducedMotion ?? matchMedia("(prefers-reduced-motion: reduce)").matches;
  let rgb = parseColor(getComputedStyle(canvas).color);
  let spin = 0;
  let last = 0;
  let frame = 0;
  let raf = 0;
  let userPaused = false;
  let onScreen = true;

  function paint(now) {
    if (frame++ % 30 === 0) rgb = parseColor(getComputedStyle(canvas).color);
    const dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
    last = now;
    spin += dt * CONFIG.spinSpeed;
    renderFrame(img.data, N, spin, rgb);
    ctx.putImageData(img, 0, 0);
  }

  function loop(now) {
    raf = 0;
    if (!running()) return;
    raf = requestAnimationFrame(loop);
    if (last && now - last < 1000 / fps) return;
    paint(now);
  }

  function running() {
    return !reduced && !userPaused && onScreen && !document.hidden;
  }

  function sync() {
    if (running() && !raf) {
      last = 0;
      raf = requestAnimationFrame(loop);
    }
  }

  if (reduced) paint(performance.now()); // one static frame
  else sync();

  const io = new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting;
    sync();
  });
  io.observe(canvas);
  document.addEventListener("visibilitychange", sync);

  return {
    setPaused(p) { userPaused = p; sync(); },
    get paused() { return userPaused; },
  };
}
