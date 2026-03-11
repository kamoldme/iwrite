const Monsters = {
  mouseX: window.innerWidth / 2,
  mouseY: window.innerHeight / 2,
  lookAway: false,
  animFrame: null,
  canvases: [],

  configs: [
    { type: 'horns',    color: '#7c6fe0', accent: '#a78bfa', side: 'left'  },
    { type: 'ears',     color: '#1ab5a0', accent: '#00cec9', side: 'right' },
    { type: 'spiky',    color: '#e07055', accent: '#d63031', side: 'left'  },
    { type: 'antenna',  color: '#fd6db5', accent: '#e84393', side: 'right' }
  ],

  init() {
    const container = document.getElementById('auth-monsters');
    if (!container) return;
    this.canvases = [];

    this.configs.forEach((cfg, i) => {
      const canvas = document.createElement('canvas');
      canvas.width = 80;
      canvas.height = 96;
      canvas.className = `auth-monster auth-monster-${i + 1}`;
      container.appendChild(canvas);
      this.canvases.push(canvas);
    });

    document.addEventListener('mousemove', this._onMouseMove);
    this._startLoop();
  },

  _onMouseMove(e) {
    Monsters.mouseX = e.clientX;
    Monsters.mouseY = e.clientY;
  },

  setLookAway(val) {
    this.lookAway = val;
  },

  _startLoop() {
    const tick = () => {
      this._draw();
      this.animFrame = requestAnimationFrame(tick);
    };
    this.animFrame = requestAnimationFrame(tick);
  },

  _draw() {
    this.canvases.forEach((canvas, i) => {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const cfg = this.configs[i];
      const rect = canvas.getBoundingClientRect();
      const w = canvas.width, h = canvas.height;
      const cx = w / 2, cy = h * 0.54;
      const r = w * 0.32;

      const eyes = this._eyePositions(cfg.type, w, h);
      const pupils = eyes.map(eye => {
        if (this.lookAway) {
          const dir = cfg.side === 'left' ? -1 : 1;
          return { dx: dir * eye.r * 0.85, dy: -eye.r * 0.4 };
        }
        const worldX = rect.left + eye.cx;
        const worldY = rect.top + eye.cy;
        const angle = Math.atan2(this.mouseY - worldY, this.mouseX - worldX);
        const maxDist = eye.r * 0.58;
        return { dx: Math.cos(angle) * maxDist, dy: Math.sin(angle) * maxDist };
      });

      // shadow
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      ctx.beginPath();
      ctx.ellipse(cx, h * 0.94, r * 0.65, 5, 0, 0, Math.PI * 2);
      ctx.fill();

      switch (i) {
        case 0: this._drawHorns(ctx, cfg, w, h, cx, cy, r, pupils); break;
        case 1: this._drawEars(ctx, cfg, w, h, cx, cy, r, pupils); break;
        case 2: this._drawSpiky(ctx, cfg, w, h, cx, cy, r, pupils); break;
        case 3: this._drawAntenna(ctx, cfg, w, h, cx, cy, r, pupils); break;
      }
    });
  },

  _eyePositions(type, w, h) {
    const map = {
      horns:   [{ cx: w*0.365, cy: h*0.47, r: 9  }, { cx: w*0.635, cy: h*0.47, r: 9  }],
      ears:    [{ cx: w*0.36,  cy: h*0.455, r: 10 }, { cx: w*0.64,  cy: h*0.455, r: 10 }],
      spiky:   [{ cx: w*0.36,  cy: h*0.485, r: 8  }, { cx: w*0.64,  cy: h*0.485, r: 8  }],
      antenna: [{ cx: w*0.36,  cy: h*0.46,  r: 11 }, { cx: w*0.64,  cy: h*0.46,  r: 11 }]
    };
    return map[type] || map.horns;
  },

  _body(ctx, cfg, cx, cy, r) {
    const g = ctx.createRadialGradient(cx - r*0.22, cy - r*0.22, r*0.05, cx, cy, r*1.05);
    g.addColorStop(0, cfg.accent);
    g.addColorStop(1, cfg.color);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    // highlight
    ctx.fillStyle = 'rgba(255,255,255,0.13)';
    ctx.beginPath();
    ctx.ellipse(cx - r*0.2, cy - r*0.24, r*0.28, r*0.16, -0.7, 0, Math.PI*2);
    ctx.fill();
  },

  _eye(ctx, cx, cy, r, dx, dy) {
    // white
    ctx.fillStyle = 'white';
    ctx.beginPath();
    ctx.ellipse(cx, cy, r, r*0.88, 0, 0, Math.PI*2);
    ctx.fill();
    // pupil
    ctx.fillStyle = '#1a1a2e';
    ctx.beginPath();
    ctx.arc(cx + dx, cy + dy, r*0.44, 0, Math.PI*2);
    ctx.fill();
    // shine
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(cx + dx - r*0.14, cy + dy - r*0.14, r*0.17, 0, Math.PI*2);
    ctx.fill();
    // eyelid when looking away
    if (this.lookAway) {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.ellipse(cx, cy - r*0.08, r*1.04, r*0.52, 0, Math.PI, 0);
      ctx.fill();
    }
  },

  _drawHorns(ctx, cfg, w, h, cx, cy, r, pupils) {
    ctx.fillStyle = cfg.accent;
    [[-0.42, -1.38, -0.2], [0.42, -1.38, 0.2]].forEach(([ox, oy, ix]) => {
      ctx.beginPath();
      ctx.moveTo(cx + ox*r, cy - r*0.78);
      ctx.lineTo(cx + (ox+ix*0.5)*r, cy + oy*r);
      ctx.lineTo(cx + ix*r, cy - r*0.88);
      ctx.fill();
    });
    this._body(ctx, cfg, cx, cy, r);
    const ey = cy - r*0.1;
    this._eye(ctx, cx - r*0.37, ey, r*0.28, pupils[0].dx, pupils[0].dy);
    this._eye(ctx, cx + r*0.37, ey, r*0.28, pupils[1].dx, pupils[1].dy);
    // smile
    ctx.strokeStyle = 'rgba(255,255,255,0.65)';
    ctx.lineWidth = 1.5; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy + r*0.3, r*0.2, 0.1, Math.PI - 0.1);
    ctx.stroke();
  },

  _drawEars(ctx, cfg, w, h, cx, cy, r, pupils) {
    ctx.fillStyle = cfg.color;
    [[-0.88, -0.28, -0.25, 0.32], [0.88, -0.28, 0.25, 0.32]].forEach(([ex, ey, rx, ry]) => {
      ctx.beginPath();
      ctx.ellipse(cx + ex*r, cy + ey*r, Math.abs(rx)*r, ry*r, ex < 0 ? -0.35 : 0.35, 0, Math.PI*2);
      ctx.fill();
    });
    this._body(ctx, cfg, cx, cy, r);
    const ey = cy - r*0.12;
    this._eye(ctx, cx - r*0.37, ey, r*0.3, pupils[0].dx, pupils[0].dy);
    this._eye(ctx, cx + r*0.37, ey, r*0.3, pupils[1].dx, pupils[1].dy);
    // nose
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(cx, cy + r*0.14, r*0.07, r*0.05, 0, 0, Math.PI*2);
    ctx.fill();
    // wavy mouth
    ctx.strokeStyle = 'rgba(255,255,255,0.65)';
    ctx.lineWidth = 1.5; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - r*0.22, cy + r*0.32);
    ctx.quadraticCurveTo(cx, cy + r*0.46, cx + r*0.22, cy + r*0.32);
    ctx.stroke();
  },

  _drawSpiky(ctx, cfg, w, h, cx, cy, r, pupils) {
    ctx.fillStyle = cfg.accent;
    [-0.38, 0, 0.38].forEach(ox => {
      ctx.beginPath();
      ctx.moveTo(cx + ox*r, cy - r*0.82);
      ctx.lineTo(cx + (ox - 0.1)*r, cy - r*1.32);
      ctx.lineTo(cx + (ox + 0.1)*r, cy - r*1.32);
      ctx.fill();
    });
    this._body(ctx, cfg, cx, cy, r);
    const ey = cy - r*0.08;
    this._eye(ctx, cx - r*0.36, ey, r*0.26, pupils[0].dx, pupils[0].dy);
    this._eye(ctx, cx + r*0.36, ey, r*0.26, pupils[1].dx, pupils[1].dy);
    // grumpy brows
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 2.2; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx - r*0.56, ey - r*0.32); ctx.lineTo(cx - r*0.18, ey - r*0.21); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + r*0.56, ey - r*0.32); ctx.lineTo(cx + r*0.18, ey - r*0.21); ctx.stroke();
    // fangs
    ctx.fillStyle = 'white';
    [[-0.1, -0.18, -0.02], [0.1, 0.18, 0.02]].forEach(([lx, rx, rx2]) => {
      ctx.beginPath();
      ctx.moveTo(cx + lx*r, cy + r*0.28);
      ctx.lineTo(cx + rx*r, cy + r*0.46);
      ctx.lineTo(cx + rx2*r, cy + r*0.28);
      ctx.fill();
    });
  },

  _drawAntenna(ctx, cfg, w, h, cx, cy, r, pupils) {
    ctx.strokeStyle = cfg.color;
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx + r*0.05, cy - r*0.88);
    ctx.lineTo(cx + r*0.18, cy - r*1.52);
    ctx.stroke();
    ctx.fillStyle = cfg.accent;
    ctx.beginPath();
    ctx.arc(cx + r*0.18, cy - r*1.57, r*0.16, 0, Math.PI*2);
    ctx.fill();
    this._body(ctx, cfg, cx, cy, r);
    const ey = cy - r*0.12;
    this._eye(ctx, cx - r*0.37, ey, r*0.32, pupils[0].dx, pupils[0].dy);
    this._eye(ctx, cx + r*0.37, ey, r*0.32, pupils[1].dx, pupils[1].dy);
    // heart mouth
    const hx = cx, hy = cy + r*0.36;
    const hr = r * 0.1;
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.beginPath();
    ctx.arc(hx - hr*0.9, hy - hr*0.6, hr, Math.PI, 0);
    ctx.arc(hx + hr*0.9, hy - hr*0.6, hr, Math.PI, 0);
    ctx.lineTo(hx, hy + hr*2);
    ctx.closePath();
    ctx.fill();
  },

  destroy() {
    if (this.animFrame) cancelAnimationFrame(this.animFrame);
    document.removeEventListener('mousemove', this._onMouseMove);
    const container = document.getElementById('auth-monsters');
    if (container) container.innerHTML = '';
    this.canvases = [];
  }
};
