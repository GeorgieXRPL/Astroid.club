/**
 * 3D gradient noise for procedural asteroid shaping.
 *
 * The 2D Perlin in `Starfield.tsx` (cribbed from the public site) gives
 * smooth nebula clouds; here we want the same flowing curves but in 3D
 * so we can displace icosahedron vertices along their normals into
 * organic-looking rocks. Implementing it from scratch (rather than
 * leaning on a library) keeps the asteroid bundle small and lets us
 * pick a quintic fade curve and gradient-vector distribution that
 * matches the look on the rest of the site.
 *
 * Used at mesh-build time only (once per asteroid on mount), so we
 * optimise for code clarity over micro-throughput.
 */

/** Mulberry32 PRNG. Same shape as the one in `Starfield.tsx`. */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit string hash. */
export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Quintic fade — zero first AND second derivative at endpoints. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** A pre-built 3D Perlin sampler bound to a fixed seed. */
export interface Noise3 {
  /** Sample noise in roughly [-0.7, 0.7] at world position (x, y, z). */
  (x: number, y: number, z: number): number;
}

/**
 * Build a 3D gradient-noise sampler.
 *
 * Internally allocates a 3D grid of unit-length random gradient
 * vectors (one per cell corner) and returns a closure that does
 * trilinear interpolation of the dot products with quintic fade.
 *
 * `gridSize` controls the spatial frequency: smaller grids =
 * smoother noise. Stack multiple samplers at different grid sizes
 * to make fbm.
 */
export function makeNoise3(seed: number, gridSize = 8): Noise3 {
  const rng = makeRng(seed);
  const N = gridSize;
  const total = N * N * N;
  const gx = new Float32Array(total);
  const gy = new Float32Array(total);
  const gz = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    // Uniform unit-length random direction (Marsaglia).
    let v0: number;
    let v1: number;
    let s: number;
    do {
      v0 = rng() * 2 - 1;
      v1 = rng() * 2 - 1;
      s = v0 * v0 + v1 * v1;
    } while (s >= 1 || s === 0);
    const factor = 2 * Math.sqrt(1 - s);
    gx[i] = v0 * factor;
    gy[i] = v1 * factor;
    gz[i] = 1 - 2 * s;
  }

  const idx = (xi: number, yi: number, zi: number) => ((zi * N + yi) * N + xi) | 0;

  return (x: number, y: number, z: number): number => {
    // Wrap into [0, N) so the grid tiles forever.
    const xx = ((x % N) + N) % N;
    const yy = ((y % N) + N) % N;
    const zz = ((z % N) + N) % N;
    const x0 = Math.floor(xx);
    const y0 = Math.floor(yy);
    const z0 = Math.floor(zz);
    const x1 = (x0 + 1) % N;
    const y1 = (y0 + 1) % N;
    const z1 = (z0 + 1) % N;
    const fx = xx - x0;
    const fy = yy - y0;
    const fz = zz - z0;

    // Gradients at the eight corners.
    const g000 = idx(x0, y0, z0);
    const g100 = idx(x1, y0, z0);
    const g010 = idx(x0, y1, z0);
    const g110 = idx(x1, y1, z0);
    const g001 = idx(x0, y0, z1);
    const g101 = idx(x1, y0, z1);
    const g011 = idx(x0, y1, z1);
    const g111 = idx(x1, y1, z1);

    // Dot products with offset vectors.
    const d000 = gx[g000]! * fx + gy[g000]! * fy + gz[g000]! * fz;
    const d100 = gx[g100]! * (fx - 1) + gy[g100]! * fy + gz[g100]! * fz;
    const d010 = gx[g010]! * fx + gy[g010]! * (fy - 1) + gz[g010]! * fz;
    const d110 = gx[g110]! * (fx - 1) + gy[g110]! * (fy - 1) + gz[g110]! * fz;
    const d001 = gx[g001]! * fx + gy[g001]! * fy + gz[g001]! * (fz - 1);
    const d101 = gx[g101]! * (fx - 1) + gy[g101]! * fy + gz[g101]! * (fz - 1);
    const d011 = gx[g011]! * fx + gy[g011]! * (fy - 1) + gz[g011]! * (fz - 1);
    const d111 = gx[g111]! * (fx - 1) + gy[g111]! * (fy - 1) + gz[g111]! * (fz - 1);

    const ux = fade(fx);
    const uy = fade(fy);
    const uz = fade(fz);

    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

    const xa00 = lerp(d000, d100, ux);
    const xa10 = lerp(d010, d110, ux);
    const xa01 = lerp(d001, d101, ux);
    const xa11 = lerp(d011, d111, ux);

    const ya0 = lerp(xa00, xa10, uy);
    const ya1 = lerp(xa01, xa11, uy);

    return lerp(ya0, ya1, uz);
  };
}

/**
 * Composite multi-octave noise (fbm). Each octave doubles frequency
 * and halves amplitude. Returned in roughly [-1, 1] before any
 * caller-side scaling.
 */
export function fbm3(samplers: ReadonlyArray<Noise3>, x: number, y: number, z: number): number {
  let total = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (const s of samplers) {
    total += s(x * freq, y * freq, z * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return total / Math.max(norm, 1e-6);
}
