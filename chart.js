/* Canvas charts: equity line, candles, score ring. devicePixelRatio aware. */
(function (global) {
  "use strict";

  function dpr() {
    return Math.max(1, window.devicePixelRatio || 1);
  }

  function sizeCanvas(canvas, cssW, cssH) {
    const r = dpr();
    canvas.width = Math.round(cssW * r);
    canvas.height = Math.round(cssH * r);
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(r, 0, 0, r, 0, 0);
    return ctx;
  }

  function reducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function drawEquity(canvas, chart) {
    if (!canvas) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    const w = rect.width || 358;
    const h = rect.height || 180;
    const ctx = sizeCanvas(canvas, w, h);
    ctx.clearRect(0, 0, w, h);

    const points = (chart && chart.points) || [];
    const marks = (chart && chart.marks) || [];
    const startValue = chart && chart.startValue != null ? chart.startValue : (points[0] && points[0].value);
    const empty = !points.length || (chart && chart.empty && points.length <= 1 && !marks.length);

    if (empty || points.length < 1) {
      // dashed start line
      const y = h * 0.55;
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = "rgba(235,235,245,0.3)";
      ctx.beginPath();
      ctx.moveTo(8, y);
      ctx.lineTo(w - 8, y);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }

    const vals = points.map((p) => p.value);
    let min = Math.min(...vals, startValue != null ? startValue : vals[0]);
    let max = Math.max(...vals, startValue != null ? startValue : vals[0]);
    if (min === max) { min -= 1; max += 1; }
    const pad = (max - min) * 0.12;
    min -= pad; max += pad;
    const t0 = points[0].ts;
    const t1 = points[points.length - 1].ts || t0 + 1;
    const xAt = (ts) => 8 + ((ts - t0) / Math.max(1, t1 - t0)) * (w - 16);
    const yAt = (v) => 12 + (1 - (v - min) / (max - min)) * (h - 28);

    // start dashed line
    if (startValue != null) {
      const y = yAt(startValue);
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = "rgba(235,235,245,0.3)";
      ctx.beginPath();
      ctx.moveTo(8, y);
      ctx.lineTo(w - 8, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // gradient fill under line
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "rgba(0,211,90,0.28)");
    grad.addColorStop(1, "rgba(0,211,90,0)");
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = xAt(p.ts), y = yAt(p.value);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    const last = points[points.length - 1];
    ctx.lineTo(xAt(last.ts), h);
    ctx.lineTo(xAt(points[0].ts), h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // line
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = xAt(p.ts), y = yAt(p.value);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "#00d35a";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke();

    // marks — stack rows so they never overlap
    const sorted = marks.slice().sort((a, b) => a.ts - b.ts);
    const lanes = [];
    sorted.forEach((m) => {
      const x = xAt(m.ts);
      let lane = 0;
      while (lanes[lane] != null && Math.abs(lanes[lane] - x) < 56) lane += 1;
      lanes[lane] = x;
      const yLine = yAt(interp(points, m.ts));
      const y = Math.max(14, yLine - 18 - lane * 16);
      ctx.globalAlpha = reducedMotion() ? 1 : 1;
      ctx.fillStyle = m.color || "#0a84ff";
      ctx.font = "600 11px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.textAlign = "center";
      const label = String(m.label || "").slice(0, 18);
      ctx.fillText(label, x, y);
    });
  }

  function interp(points, ts) {
    if (!points.length) return 0;
    if (ts <= points[0].ts) return points[0].value;
    for (let i = 1; i < points.length; i++) {
      if (ts <= points[i].ts) {
        const a = points[i - 1], b = points[i];
        const t = (ts - a.ts) / Math.max(1e-9, b.ts - a.ts);
        return a.value + (b.value - a.value) * t;
      }
    }
    return points[points.length - 1].value;
  }

  function drawCandles(canvas, coin) {
    if (!canvas) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    const w = rect.width || 358;
    const h = rect.height || 200;
    const ctx = sizeCanvas(canvas, w, h);
    ctx.clearRect(0, 0, w, h);
    const candles = (coin && coin.candles) || [];
    if (!candles.length) {
      ctx.fillStyle = "rgba(235,235,245,0.3)";
      ctx.font = "14px -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No candles yet", w / 2, h / 2);
      return;
    }
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    let min = Math.min(...lows);
    let max = Math.max(...highs);
    const exit = coin.exitLines || {};
    const lines = [exit.stop, exit.trail].filter((v) => v != null);
    lines.forEach((v) => { min = Math.min(min, v); max = Math.max(max, v); });
    if (min === max) { min *= 0.99; max *= 1.01; }
    const pad = (max - min) * 0.08;
    min -= pad; max += pad;
    const chartH = h * 0.72;
    const volH = h * 0.22;
    const yAt = (v) => 8 + (1 - (v - min) / (max - min)) * (chartH - 8);
    const slot = (w - 8) / candles.length;

    // trail / stop dashed
    if (exit.trail != null) {
      const y = yAt(exit.trail);
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "#ff9f0a";
      ctx.beginPath();
      ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.setLineDash([]);
    }
    if (exit.stop != null) {
      const y = yAt(exit.stop);
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = "#ff453a";
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
    }

    const maxVol = Math.max(1, ...candles.map((c) => Math.abs(c.volume || 0)));
    candles.forEach((c, i) => {
      const x = 4 + i * slot + slot / 2;
      const up = c.close >= c.open;
      ctx.strokeStyle = up ? "#00d35a" : "#ff453a";
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.moveTo(x, yAt(c.high));
      ctx.lineTo(x, yAt(c.low));
      ctx.stroke();
      const y1 = yAt(c.open), y2 = yAt(c.close);
      const top = Math.min(y1, y2), bh = Math.max(1, Math.abs(y2 - y1));
      ctx.fillRect(x - Math.max(1, slot * 0.3), top, Math.max(2, slot * 0.6), bh);
      // volume
      const vh = (Math.abs(c.volume || 0) / maxVol) * volH;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(x - Math.max(1, slot * 0.3), h - 4 - vh, Math.max(2, slot * 0.6), vh);
      ctx.globalAlpha = 1;
    });
  }

  function drawScoreRing(canvas, score, greenFrom) {
    if (!canvas) return;
    const size = 96;
    const ctx = sizeCanvas(canvas, size, size);
    ctx.clearRect(0, 0, size, size);
    const s = score == null ? 0 : Number(score);
    const gf = greenFrom == null ? 70 : greenFrom;
    const color = s >= gf ? "#00d35a" : "#ffd60a";
    ctx.lineWidth = 8;
    ctx.strokeStyle = "#2c2c2e";
    ctx.beginPath();
    ctx.arc(48, 48, 36, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(48, 48, 36, -Math.PI / 2, -Math.PI / 2 + (Math.min(100, s) / 100) * Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = "700 22px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(score == null ? "—" : String(Math.round(s)), 48, 48);
  }

  global.DeskCharts = { drawEquity, drawCandles, drawScoreRing, reducedMotion };
})(window);
