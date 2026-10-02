import { useEffect, useRef } from "react";

/**
 * The desktop: Longhorn's aurora light-ribbons as one fragment shader. Raw
 * WebGL (no library), GLSL ES 1.00 so it runs on webgl1 too, rendered at a
 * fraction of the screen's resolution (it is soft light, nothing is sharp)
 * and capped at 30fps. `pulse` bumps whenever money moves on the board and
 * flares the ribbons for a moment. Reduced motion gets one still frame; no
 * WebGL leaves the CSS gradient on <body> showing.
 */

const VERT = `attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `
precision mediump float;
uniform vec2 uRes;
uniform float uTime;
uniform float uPulse;
uniform vec2 uMouse;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 m = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = m * p * 2.03; a *= 0.5; }
  return v;
}

// One ribbon: a wandering curve with a bright core, a wide haze, and faint
// vertical rays hanging below it like a curtain.
float ribbon(vec2 uv, float off, float freq, float amp, float speed, float width, float seed) {
  float t = uTime * speed;
  float y = off + amp * sin(uv.x * freq + t + seed)
                + 0.35 * amp * sin(uv.x * freq * 2.3 - t * 1.3 + seed * 2.0)
                + 0.22 * (fbm(vec2(uv.x * 1.4 + t * 0.25, seed)) - 0.5);
  float d = uv.y - y;
  float core = exp(-(d * d) / (width * width));
  float haze = exp(-abs(d) / (width * 7.0)) * 0.22;
  float rays = smoothstep(0.0, -0.5, d) * exp(d * 3.0) * (0.35 + 0.65 * noise(vec2(uv.x * 38.0 + seed * 9.0, t * 0.6)));
  return core + haze + rays * 0.35;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  uv += (uMouse - 0.5) * 0.03;
  float c = cos(-0.32), s = sin(-0.32);
  vec2 r = mat2(c, s, -s, c) * uv;

  // Plex night: near-black navy, a little lighter toward the upper left.
  vec3 col = mix(vec3(0.012, 0.02, 0.05), vec3(0.04, 0.08, 0.19), smoothstep(-0.7, 0.9, uv.y - uv.x * 0.35));

  float glow = 1.0 + uPulse * 0.9;
  col += vec3(0.30, 0.86, 0.58) * ribbon(r, 0.05, 1.7, 0.16, 0.11, 0.030, 1.0) * 0.55 * glow;   // jade
  col += vec3(0.33, 0.47, 0.86) * ribbon(r, -0.12, 1.2, 0.22, 0.08, 0.045, 4.0) * 0.50 * glow;  // plex blue
  col += vec3(0.70, 0.92, 1.00) * ribbon(r, 0.22, 2.3, 0.10, 0.14, 0.018, 7.0) * 0.28 * glow;   // ice

  // Vignette pulls the corners back to the dark so the window reads first.
  col *= 1.0 - 0.45 * dot(uv * 0.75, uv * 0.75);
  col = 1.0 - exp(-col * 1.25);
  col += (hash(gl_FragCoord.xy + uTime) - 0.5) / 255.0; // dither: no banding in the gradients
  gl_FragColor = vec4(col, 1.0);
}`;

const SCALE = 0.6; // render resolution relative to CSS pixels
const FRAME_MS = 1000 / 30;

export function Wallpaper({ pulse }: { pulse: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const flare = useRef(0);

  useEffect(() => { if (pulse > 0) flare.current = 1; }, [pulse]);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const gl = cv.getContext("webgl", { antialias: false, alpha: false, powerPreference: "low-power", preserveDrawingBuffer: false });
    if (!gl) return;

    const shader = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? "shader");
      return sh;
    };
    let prog: WebGLProgram;
    try {
      prog = gl.createProgram()!;
      gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");
    } catch (e) {
      console.warn("wallpaper shader unavailable", e);
      return;
    }
    gl.useProgram(prog);
    // One triangle covering the screen.
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uRes = gl.getUniformLocation(prog, "uRes");
    const uTime = gl.getUniformLocation(prog, "uTime");
    const uPulse = gl.getUniformLocation(prog, "uPulse");
    const uMouse = gl.getUniformLocation(prog, "uMouse");

    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const mouse = [0.5, 0.5];
    const target = [0.5, 0.5];
    const t0 = performance.now() - 40_000; // start mid-drift, not at the symmetric t=0 pose
    let raf = 0, last = 0, lost = false;

    const resize = () => {
      const w = Math.max(1, Math.round(cv.clientWidth * Math.min(window.devicePixelRatio, 1.5) * SCALE));
      const h = Math.max(1, Math.round(cv.clientHeight * Math.min(window.devicePixelRatio, 1.5) * SCALE));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; gl.viewport(0, 0, w, h); }
    };
    const draw = (now: number) => {
      resize();
      mouse[0] += (target[0] - mouse[0]) * 0.04;
      mouse[1] += (target[1] - mouse[1]) * 0.04;
      flare.current *= 0.97;
      gl.uniform2f(uRes, cv.width, cv.height);
      gl.uniform1f(uTime, (now - t0) / 1000);
      gl.uniform1f(uPulse, flare.current);
      gl.uniform2f(uMouse, mouse[0], mouse[1]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < FRAME_MS) return;
      last = now;
      draw(now);
    };
    const start = () => { if (!raf && !lost && !document.hidden) raf = requestAnimationFrame(loop); };
    const stop = () => { cancelAnimationFrame(raf); raf = 0; };

    const onMove = (e: PointerEvent) => { target[0] = e.clientX / window.innerWidth; target[1] = 1 - e.clientY / window.innerHeight; };
    const onVis = () => (document.hidden ? stop() : start());
    const onLost = (e: Event) => { e.preventDefault(); lost = true; stop(); cv.classList.remove("is-on"); };
    const onResize = () => { if (still) draw(performance.now()); };

    cv.addEventListener("webglcontextlost", onLost);
    window.addEventListener("resize", onResize);
    if (still) {
      draw(performance.now());
    } else {
      window.addEventListener("pointermove", onMove, { passive: true });
      document.addEventListener("visibilitychange", onVis);
      start();
    }
    cv.classList.add("is-on");

    return () => {
      stop();
      cv.removeEventListener("webglcontextlost", onLost);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("visibilitychange", onVis);
      // No loseContext() here: StrictMode remounts reuse this same canvas and
      // context, and a deliberately lost context never comes back.
      gl.deleteProgram(prog);
    };
  }, []);

  return <canvas ref={canvas} className="lh-wallpaper" aria-hidden="true" />;
}
