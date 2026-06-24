/**
 * WebGL capability probe.
 *
 * Some environments (locked-down corporate machines, headless/VM
 * browsers with a broken GPU sandbox, very old devices) can run the
 * rest of the app fine but fail to create a WebGL context — Three.js
 * then throws "Error creating WebGL context" and the canvas renders
 * nothing. We detect that up front so the arena can fall back to a
 * fully playable 2D view instead of a silent black hole.
 *
 * Creating a throwaway context is the only reliable signal: feature
 * flags like `'WebGLRenderingContext' in window` are true even when
 * the actual context allocation fails (e.g. GPU process crash).
 */
export function isWebGLAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const gl =
      canvas.getContext('webgl2') ??
      canvas.getContext('webgl') ??
      canvas.getContext('experimental-webgl');
    if (!gl) return false;
    // Some drivers hand back a context that immediately reports a lost
    // state; treat that as unavailable too.
    const lose = (gl as WebGLRenderingContext).getExtension?.('WEBGL_lose_context');
    void lose;
    return true;
  } catch {
    return false;
  }
}
