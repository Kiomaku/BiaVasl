// Orb animation: [server] ····●···●···· [your PC]. Orbs flow with real traffic; colour follows state.
const Orbs = (() => {
  const cv = document.getElementById("orbs"), cx = cv.getContext("2d");
  const COL = { idle: [113, 113, 122], connecting: [245, 165, 36], connected: [23, 201, 100], lost: [243, 18, 96] };
  const DOWN = [0, 111, 238], UP = [165, 107, 245];
  let W = 0, H = 0, state = "idle", down = 0, up = 0, ping = 0, parts = [], acc = { d: 0, u: 0, hb: 0 }, last = performance.now();
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  function resize() {
    const r = cv.getBoundingClientRect(), d = devicePixelRatio || 1;
    W = r.width; H = r.height; cv.width = W * d; cv.height = H * d; cx.setTransform(d, 0, 0, d, 0, 0);
  }
  new ResizeObserver(resize).observe(cv); resize();

  function glow(x, y, r, c, a) {
    const g = cx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba(c, a)); g.addColorStop(1, rgba(c, 0));
    cx.fillStyle = g; cx.beginPath(); cx.arc(x, y, r, 0, 7); cx.fill();
  }
  function orb(x, y, r, c, a = 1) {
    glow(x, y, r * 3, c, 0.35 * a);
    const g = cx.createRadialGradient(x - r * .3, y - r * .35, r * .1, x, y, r);
    g.addColorStop(0, rgba([Math.min(255, c[0] + 110), Math.min(255, c[1] + 110), Math.min(255, c[2] + 110)], a));
    g.addColorStop(.6, rgba(c, a)); g.addColorStop(1, rgba(c.map((v) => v * .45), a));
    cx.fillStyle = g; cx.beginPath(); cx.arc(x, y, r, 0, 7); cx.fill();
  }
  function spawn(dir, c, r, extra) { parts.push({ dir, p: dir > 0 ? 0 : 1, c, r, sp: 0.35 + Math.random() * 0.25, ...extra }); }

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now; const t = now / 1000;
    cx.clearRect(0, 0, W, H);
    const c = COL[state], y = H * 0.46, x1 = W * 0.2, x2 = W * 0.8;
    // ambient drifting orbs
    for (let i = 0; i < 3; i++) glow(W * (0.25 + 0.25 * i) + Math.sin(t * 0.3 + i * 2) * 50, y + Math.cos(t * 0.25 + i) * 40, 150, c, state === "idle" ? 0.07 : 0.14);
    // link line
    cx.lineWidth = 2; cx.strokeStyle = rgba(c, 0.5); cx.setLineDash([2, 9]); cx.lineCap = "round";
    cx.beginPath();
    if (state === "lost") { cx.moveTo(x1 + 36, y); cx.lineTo(W / 2 - 22, y); cx.moveTo(W / 2 + 22, y); cx.lineTo(x2 - 36, y); }
    else { cx.moveTo(x1 + 36, y); cx.lineTo(x2 - 36, y); }
    cx.stroke(); cx.setLineDash([]);
    if (state === "lost") { // broken link ✕
      const a = 0.6 + 0.4 * Math.sin(t * 6); cx.strokeStyle = rgba(c, a); cx.lineWidth = 3;
      cx.beginPath(); cx.moveTo(W / 2 - 9, y - 9); cx.lineTo(W / 2 + 9, y + 9); cx.moveTo(W / 2 + 9, y - 9); cx.lineTo(W / 2 - 9, y + 9); cx.stroke();
    }
    // spawn traffic orbs
    if (state === "connected" && !reduce) {
      const rate = (b) => (b > 0 ? Math.min(12, 1.5 + Math.log10(1 + b / 1024) * 3) : 0);
      acc.d += rate(down) * dt; acc.u += rate(up) * dt; acc.hb += dt;
      while (acc.d >= 1) { acc.d--; spawn(+1, DOWN, 4 + Math.random() * 3); }
      while (acc.u >= 1) { acc.u--; spawn(-1, UP, 4 + Math.random() * 3); }
      if (acc.hb > 2.4) { acc.hb = 0; spawn(-1, COL.connected, 6, { hb: true, sp: 1 / (0.7 + (ping || 80) / 250) }); } // heartbeat: to server and back
    }
    parts = parts.filter((o) => {
      o.p += o.dir * o.sp * dt;
      if (o.hb && o.dir < 0 && o.p <= 0) { o.dir = 1; o.p = 0; o.hb = 2; }
      if (o.p < -0.02 || o.p > 1.02) return false;
      const x = x1 + (x2 - x1) * o.p, edge = Math.min(1, o.p * 8, (1 - o.p) * 8);
      orb(x, y + Math.sin(o.p * 12 + o.r) * 3, o.r, o.c, Math.max(0.1, edge)); return true;
    });
    // end nodes
    const pulse = state === "connected" ? 1 + 0.05 * Math.sin(t * 2.4) : 1;
    if (state === "connecting") for (let i = 0; i < 2; i++) { const k = (t * 0.7 + i / 2) % 1; cx.strokeStyle = rgba(c, 0.5 * (1 - k)); cx.lineWidth = 2; for (const x of [x1, x2]) { cx.beginPath(); cx.arc(x, y, 30 + k * 40, 0, 7); cx.stroke(); } }
    const dim = state === "idle" ? 0.6 : 1;
    orb(x1, y, 28 * pulse, c, dim); orb(x2, y, 28 * pulse, state === "connected" ? DOWN : c, dim);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return {
    setState(s) { state = s; if (s !== "connected") parts = []; },
    setRates(d, u, p) { down = d; up = u; ping = p; },
    burst() { for (let i = 0; i < 5; i++) setTimeout(() => spawn(+1, COL.connected, 6), i * 120); },
  };
})();
