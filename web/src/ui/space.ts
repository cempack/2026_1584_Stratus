// A still star field behind the globe (dark theme only; CSS hides it in light). Seeded so it never shifts between visits.
export function initStars() {
  const cv = document.getElementById("stars") as HTMLCanvasElement | null;
  if (!cv) return;
  const g = cv.getContext("2d");
  if (!g) return;
  let seed = 20260101;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const stars = Array.from({ length: 520 }, () => ({ x: rnd(), y: rnd(), r: 0.35 + Math.pow(rnd(), 5) * 1.25, a: 0.18 + rnd() * 0.6, h: rnd() }));
  const paint = () => {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = innerWidth, h = innerHeight;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    for (const s of stars) {
      g.globalAlpha = s.a;
      g.fillStyle = s.h < 0.12 ? "#bcd0ff" : s.h > 0.9 ? "#ffe3b8" : "#ffffff";
      g.beginPath(); g.arc(s.x * w, s.y * h, s.r, 0, Math.PI * 2); g.fill();
    }
  };
  paint();
  let t: ReturnType<typeof setTimeout> | undefined;
  addEventListener("resize", () => { clearTimeout(t); t = setTimeout(paint, 150); });
}
