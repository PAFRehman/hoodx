(() => {
  "use strict";

  const TAU = Math.PI * 2;
  const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = window.matchMedia("(pointer: fine)");
  const cipher = document.getElementById("cipher");
  const fragments = document.querySelectorAll("[data-binary]");
  const name = document.getElementById("project-name");
  const nameFace = document.getElementById("name-face");
  const modestDevice = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;
  const compact = window.innerWidth < 700;
  let canvas = document.getElementById("galaxy-field");
  let width = window.innerWidth, height = window.innerHeight;
  let renderer = null, frame = null, resizeTimer = null;
  let paused = motionPreference.matches;
  let time = 0, lastTime = 0, lastDraw = 0, textAt = -1, fragmentAt = -1;
  let scrambleAt = -10, scrambleTick = -1;
  let frameStep = 1000 / (modestDevice ? 30 : 60);
  let slowFrames = 0, observedFrames = 0, reducedQuality = false;
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  const burst = { x: 0, y: 0, at: -10 };

  // Immutable star positions are uploaded once. Galaxy rotation, depth, and
  // the interaction wave run on the GPU in a single draw call per frame.
  const VERTEX_SHADER = `
    precision highp float;
    attribute vec4 a_star;
    attribute vec4 a_meta;
    uniform vec2 u_resolution;
    uniform vec2 u_pointer;
    uniform vec3 u_burst;
    uniform float u_time;
    uniform float u_ratio;
    uniform float u_maxPoint;
    varying float v_alpha;
    varying float v_kind;
    void main() {
      float group = a_meta.x;
      float portrait = step(u_resolution.x, u_resolution.y * 0.85);
      float extent = max(u_resolution.x, u_resolution.y);
      vec2 position;
      float alpha = a_meta.y;
      float size = a_star.w;
      if (group > 2.5) {
        position = vec2(fract(a_star.x + u_time * 0.00022 * a_star.z), a_star.y) * u_resolution;
        position += u_pointer * (8.0 + a_star.z * 23.0);
        alpha *= 0.78 + 0.22 * sin(u_time * 0.65 + a_meta.z);
      } else {
        vec2 center;
        float scale;
        float flatten;
        float roll;
        float speed;
        if (group < 0.5) {
          center = vec2(mix(0.68, 0.65, portrait), mix(0.30, 0.27, portrait));
          scale = mix(0.43, 0.47, portrait);
          flatten = 0.50;
          roll = -0.43;
          speed = 0.050;
        } else if (group < 1.5) {
          center = vec2(0.13, 0.79);
          scale = 0.25;
          flatten = 0.64;
          roll = 0.50;
          speed = -0.065;
        } else {
          center = vec2(0.10, 0.12);
          scale = 0.14;
          flatten = 0.72;
          roll = -0.35;
          speed = 0.035;
          alpha *= 0.43;
        }
        center += vec2(sin(u_time * 0.021 + group * 2.0) * 0.028, cos(u_time * 0.018 + group) * 0.026);
        float spin = u_time * speed;
        float cs = cos(spin), sn = sin(spin);
        vec2 disk = vec2(a_star.x * cs - a_star.y * sn, a_star.x * sn + a_star.y * cs);
        disk.y = disk.y * flatten + a_star.z;
        float cr = cos(roll), sr = sin(roll);
        disk = vec2(disk.x * cr - disk.y * sr, disk.x * sr + disk.y * cr);
        position = center * u_resolution + disk * extent * scale;
        position += u_pointer * (28.0 - group * 6.0);
        alpha *= 0.88 + 0.12 * sin(u_time * 0.4 + a_meta.z);
        size *= clamp(extent / 1200.0, 0.72, 1.35);
      }
      float age = u_time - u_burst.z;
      if (age >= 0.0 && age < 2.0) {
        vec2 delta = position - u_burst.xy * u_resolution;
        float distance = length(delta);
        float band = (distance - age * 320.0) / 55.0;
        float wave = exp(-(band * band)) * (1.0 - age * 0.5);
        position += delta / max(distance, 1.0) * wave * 7.0;
        alpha += wave * 0.22;
      }
      gl_Position = vec4(position.x / u_resolution.x * 2.0 - 1.0, 1.0 - position.y / u_resolution.y * 2.0, 0.0, 1.0);
      gl_PointSize = clamp(size * u_ratio, 1.0, u_maxPoint);
      v_alpha = alpha;
      v_kind = a_meta.w;
    }
  `;
  const FRAGMENT_SHADER = `
    precision mediump float;
    varying float v_alpha;
    varying float v_kind;
    void main() {
      vec2 p = gl_PointCoord * 2.0 - 1.0;
      float distance = length(p);
      if (distance > 1.0) discard;
      float light;
      if (v_kind > 0.5) {
        light = exp(-distance * distance * 5.5) * (1.0 - smoothstep(0.75, 1.0, distance));
      } else {
        light = pow(1.0 - distance, 1.8);
      }
      gl_FragColor = vec4(vec3(1.0), light * v_alpha);
    }
  `;

  function makeStars() {
    let seed = 873105;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      return (seed >>> 0) / 4294967296;
    };
    const normal = () => random() + random() + random() + random() - 2;
    const factor = modestDevice ? 0.72 : 1;
    const counts = compact ? [3000, 1250, 500] : [6000, 2500, 1100];
    const stars = [];
    for (let group = 0; group < 3; group++) {
      const count = Math.round(counts[group] * factor);
      const arms = group === 1 ? 2 : 3;
      for (let i = 0; i < count; i++) {
        const core = random() < 0.17;
        const r = core ? Math.pow(random(), 0.85) * 0.14 : 0.04 + Math.sqrt(random()) * 0.93;
        const angle = core ? random() * TAU : Math.floor(random() * arms) * TAU / arms + r * 5.6 + normal() * (0.14 + r * 0.12);
        const mist = random() < 0.11;
        const size = mist ? 18 + random() * 24 : 1.1 + Math.pow(random(), 3) * 3.6;
        const alpha = mist ? (0.03 + random() * 0.027) : (0.25 + random() * 0.7) * (1 - r * 0.43);
        stars.push([Math.cos(angle) * r, Math.sin(angle) * r, normal() * (0.014 + r * 0.024), size, group, alpha, random() * TAU, mist ? 1 : 0]);
      }
      stars.push([0, 0, 0, 64, group, 0.36, 0, 1]);
    }
    const fieldCount = compact ? 260 : 720;
    for (let i = 0; i < fieldCount; i++) {
      stars.push([random(), random(), 0.15 + random() * 0.85, 1 + Math.pow(random(), 4) * 3, 3, 0.15 + random() * 0.7, random() * TAU, 0]);
    }
    // Interleave groups so adaptive draw-count reduction preserves all galaxies.
    for (let i = stars.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [stars[i], stars[j]] = [stars[j], stars[i]];
    }
    return new Float32Array(stars.flat());
  }
  const stars = makeStars();

  function freshCanvas() {
    const next = canvas.cloneNode(false);
    canvas.replaceWith(next);
    canvas = next;
  }

  function makeWebGLRenderer() {
    const gl = canvas.getContext("webgl", { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: "low-power" });
    if (!gl) return null;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const reason = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(reason || "Unable to compile galaxy renderer");
      }
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "Unable to link galaxy renderer");
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, stars, gl.STATIC_DRAW);
    for (const [attribute, offset] of [["a_star", 0], ["a_meta", 16]]) {
      const location = gl.getAttribLocation(program, attribute);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 4, gl.FLOAT, false, 32, offset);
    }
    const uniforms = {};
    for (const key of ["resolution", "pointer", "burst", "time", "ratio", "maxPoint"]) uniforms[key] = gl.getUniformLocation(program, "u_" + key);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.clearColor(0, 0, 0, 1);
    const pointRange = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
    gl.uniform1f(uniforms.maxPoint, Math.min(pointRange[1], 72));
    let drawCount = stars.length / 8;
    canvas.addEventListener("webglcontextlost", event => {
      event.preventDefault();
      cancelFrame();
      freshCanvas();
      renderer = makeCanvasRenderer();
      frameStep = 1000 / 30;
      fit();
      syncMotion();
    }, { once: true });
    return {
      mode: "webgl",
      resize(w, h, ratio) {
        canvas.width = Math.max(1, Math.round(w * ratio));
        canvas.height = Math.max(1, Math.round(h * ratio));
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.uniform2f(uniforms.resolution, w, h);
        gl.uniform1f(uniforms.ratio, ratio);
      },
      reduce() { drawCount = Math.floor(stars.length / 8 * 0.7); },
      render() {
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform1f(uniforms.time, time);
        gl.uniform2f(uniforms.pointer, pointer.x, pointer.y);
        gl.uniform3f(uniforms.burst, burst.x, burst.y, burst.at);
        gl.drawArrays(gl.POINTS, 0, drawCount);
      }
    };
  }

  // Fallback: galaxies are cached once, then each frame draws just four images.
  // No per-star trigonometry, text rendering, blur, or image generation per frame.
  function makeCanvasRenderer() {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return null;
    const makeLayer = size => {
      const layer = document.createElement("canvas");
      layer.width = layer.height = size;
      return layer;
    };
    const glow = makeLayer(48);
    const glowCtx = glow.getContext("2d");
    const gradient = glowCtx.createRadialGradient(24, 24, 0, 24, 24, 24);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.18, "rgba(255,255,255,0.45)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    glowCtx.fillStyle = gradient;
    glowCtx.fillRect(0, 0, 48, 48);
    const textures = [0, 1, 2].map(group => {
      const size = compact ? 384 : 640;
      const layer = makeLayer(size);
      const g = layer.getContext("2d");
      g.globalCompositeOperation = "lighter";
      g.fillStyle = "#fff";
      for (let i = 0; i < stars.length; i += 8) {
        if (stars[i + 4] !== group) continue;
        const x = (stars[i] * 0.47 + 0.5) * size;
        const y = (stars[i + 1] * 0.47 + 0.5) * size;
        g.globalAlpha = stars[i + 5];
        if (stars[i + 7] > 0.5) {
          const span = stars[i + 3] * size / 600;
          g.drawImage(glow, x - span / 2, y - span / 2, span, span);
        } else {
          const point = Math.max(0.65, stars[i + 3] * size / 1250);
          g.fillRect(x, y, point, point);
        }
      }
      return layer;
    });
    const field = document.createElement("canvas");
    const f = field.getContext("2d");
    let pixelRatio = 1;
    return {
      mode: "canvas",
      resize(w, h, ratio) {
        pixelRatio = Math.min(ratio, 1);
        canvas.width = Math.max(1, Math.round(w * pixelRatio));
        canvas.height = Math.max(1, Math.round(h * pixelRatio));
        field.width = Math.max(1, Math.round(w * pixelRatio));
        field.height = Math.max(1, Math.round(h * pixelRatio));
        f.fillStyle = "#fff";
        for (let i = 0; i < stars.length; i += 8) {
          if (stars[i + 4] !== 3) continue;
          f.globalAlpha = stars[i + 5] * 0.8;
          const dot = Math.max(0.7, stars[i + 3] * pixelRatio * 0.55);
          f.fillRect(stars[i] * field.width, stars[i + 1] * field.height, dot, dot);
        }
      },
      reduce() {},
      render() {
        ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(field, pointer.x * 8, pointer.y * 8, width, height);
        ctx.globalCompositeOperation = "lighter";
        const portrait = width < height * 0.85;
        const extent = Math.max(width, height);
        for (let group = 0; group < 3; group++) {
          let cx, cy, scale, flatten, roll, speed;
          if (group === 0) { cx = portrait ? 0.65 : 0.68; cy = portrait ? 0.27 : 0.30; scale = portrait ? 0.47 : 0.43; flatten = 0.50; roll = -0.43; speed = 0.050; }
          else if (group === 1) { cx = 0.13; cy = 0.79; scale = 0.25; flatten = 0.64; roll = 0.50; speed = -0.065; }
          else { cx = 0.10; cy = 0.12; scale = 0.14; flatten = 0.72; roll = -0.35; speed = 0.035; }
          cx += Math.sin(time * 0.021 + group * 2) * 0.028;
          cy += Math.cos(time * 0.018 + group) * 0.026;
          const diameter = extent * scale / 0.47;
          ctx.save();
          ctx.translate(cx * width + pointer.x * 22, cy * height + pointer.y * 22);
          ctx.rotate(roll);
          ctx.scale(1, flatten);
          ctx.rotate(time * speed);
          ctx.globalAlpha = group === 2 ? 0.43 : 0.95;
          ctx.drawImage(textures[group], -diameter / 2, -diameter / 2, diameter, diameter);
          ctx.restore();
        }
        ctx.globalCompositeOperation = "source-over";
        const age = time - burst.at;
        if (age >= 0 && age < 2) {
          ctx.globalAlpha = (1 - age / 2) * 0.32;
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 0.7;
          ctx.beginPath();
          ctx.arc(burst.x * width, burst.y * height, 8 + age * 320, 0, TAU);
          ctx.stroke();
        }
      }
    };
  }

  function fit() {
    if (!renderer) return;
    width = Math.max(1, window.innerWidth);
    height = Math.max(1, window.innerHeight);
    const pixelBudget = reducedQuality || modestDevice ? 1200000 : 2000000;
    const ratio = Math.min(window.devicePixelRatio || 1, compact ? 1.25 : 1.5, Math.sqrt(pixelBudget / (width * height)));
    renderer.resize(width, height, ratio);
    renderer.render();
  }

  function cancelFrame() {
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
  }

  function syncMotion() {
    cancelFrame();
    const inactive = paused || document.hidden || !renderer;
    document.body.classList.toggle("motion-static", inactive);
    lastTime = lastDraw = 0;
    if (inactive) nameFace.textContent = "HoodX";
    else frame = window.requestAnimationFrame(animate);
  }

  const byte = () => Math.floor(Math.random() * 256).toString(2).padStart(8, "0");
  function updateText() {
    if (time - textAt > 0.28) {
      cipher.textContent = byte() + " " + byte() + " " + byte();
      textAt = time;
    }
    if (time - fragmentAt > 0.65) {
      fragments.forEach(fragment => { fragment.textContent = byte() + " " + byte(); });
      fragmentAt = time;
    }
    const age = time - scrambleAt;
    if (age >= 0 && age < 0.75 && time - scrambleTick > 0.09) {
      const resolved = Math.floor(age / 0.65 * 5);
      nameFace.textContent = "HoodX".split("").map((character, i) => i < resolved ? character : (Math.random() > 0.5 ? "1" : "0")).join("");
      scrambleTick = time;
    } else if (age >= 0.75 && nameFace.textContent !== "HoodX") nameFace.textContent = "HoodX";
  }

  function animate(now) {
    frame = null;
    if (paused || document.hidden || !renderer) return;
    const elapsed = lastTime ? Math.min(now - lastTime, 100) : 0;
    lastTime = now;
    time += elapsed / 1000;
    const smooth = Math.min(1, elapsed * 0.004);
    pointer.x += (pointer.tx - pointer.x) * smooth;
    pointer.y += (pointer.ty - pointer.y) * smooth;
    if (elapsed > 0) {
      observedFrames++;
      if (elapsed > 39) slowFrames++;
      if (observedFrames >= 150 && !reducedQuality) {
        if (slowFrames > 45) {
          reducedQuality = true;
          frameStep = 1000 / 30;
          renderer.reduce();
          fit();
        }
        observedFrames = slowFrames = 0;
      }
    }
    const sinceDraw = now - lastDraw;
    if (!lastDraw || sinceDraw + 0.75 >= frameStep) {
      renderer.render();
      updateText();
      lastDraw = now - (sinceDraw % frameStep);
    }
    frame = window.requestAnimationFrame(animate);
  }

  window.addEventListener("pointermove", event => {
    if (paused || !finePointer.matches) return;
    pointer.tx = event.clientX / width - 0.5;
    pointer.ty = event.clientY / height - 0.5;
  }, { passive: true });
  document.documentElement.addEventListener("pointerleave", () => { pointer.tx = pointer.ty = 0; });
  window.addEventListener("pointerdown", event => {
    if (paused || event.button > 0 || event.target.closest("a")) return;
    burst.x = event.clientX / width;
    burst.y = event.clientY / height;
    burst.at = time;
  }, { passive: true });
  name.addEventListener("pointerenter", () => { if (!paused && time - scrambleAt > 2) scrambleAt = time; });
  motionPreference.addEventListener("change", event => { paused = event.matches; scrambleAt = -10; syncMotion(); });
  document.addEventListener("visibilitychange", syncMotion);
  window.addEventListener("resize", () => {
    if (resizeTimer !== null) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => { resizeTimer = null; fit(); }, 120);
  }, { passive: true });

  try { renderer = makeWebGLRenderer(); }
  catch { freshCanvas(); }
  if (!renderer) {
    renderer = makeCanvasRenderer();
    frameStep = 1000 / 30;
  }
  if (!renderer) return;
  fit();
  syncMotion();
})();
