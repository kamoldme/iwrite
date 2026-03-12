const TreeRenderer = {
  stages: [
    'Seed', 'Sprout', 'Seedling', 'Sapling', 'Young Tree',
    'Growing Tree', 'Mature Tree', 'Strong Tree', 'Grand Tree', 'Ancient Tree', 'World Tree', 'Forest'
  ],

  draw(canvas, stage, streak) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const groundY = h - 40;
    ctx.fillStyle = '#f0f9f0';
    ctx.beginPath();
    ctx.ellipse(w / 2, groundY + 10, 120, 20, 0, 0, Math.PI * 2);
    ctx.fill();

    if (stage === 0) {
      this.drawSeed(ctx, w / 2, groundY);
      return;
    }

    if (stage >= 11) {
      this.drawForest(ctx, w, h, groundY, streak);
      return;
    }

    const trunkHeight = Math.min(30 + stage * 18, 180);
    const trunkWidth = Math.min(4 + stage * 2, 24);
    this.drawTrunk(ctx, w / 2, groundY, trunkHeight, trunkWidth, stage);

    if (stage >= 2) {
      this.drawBranches(ctx, w / 2, groundY - trunkHeight, stage, streak);
    }

    if (stage >= 1) {
      this.drawLeaves(ctx, w / 2, groundY - trunkHeight, stage, streak);
    }

    if (stage >= 7) {
      this.drawFruits(ctx, w / 2, groundY - trunkHeight, stage);
    }

    if (streak > 0) {
      this.drawStreakGlow(ctx, w / 2, groundY - trunkHeight / 2, streak);
    }
  },

  drawSeed(ctx, x, y) {
    ctx.fillStyle = '#8B6914';
    ctx.beginPath();
    ctx.ellipse(x, y - 8, 8, 10, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#654B0F';
    ctx.beginPath();
    ctx.moveTo(x - 2, y - 18);
    ctx.quadraticCurveTo(x + 3, y - 22, x + 1, y - 14);
    ctx.fill();
  },

  drawTrunk(ctx, x, groundY, height, width, stage) {
    const gradient = ctx.createLinearGradient(x - width / 2, groundY, x + width / 2, groundY);
    gradient.addColorStop(0, '#5D4037');
    gradient.addColorStop(0.5, '#795548');
    gradient.addColorStop(1, '#5D4037');

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(x - width / 2, groundY);
    ctx.lineTo(x - width / 3, groundY - height);
    ctx.lineTo(x + width / 3, groundY - height);
    ctx.lineTo(x + width / 2, groundY);
    ctx.fill();

    if (stage >= 4) {
      ctx.strokeStyle = '#4E342E';
      ctx.lineWidth = 0.5;
      for (let i = 0; i < 3; i++) {
        const ly = groundY - height * 0.3 - i * 20;
        ctx.beginPath();
        ctx.moveTo(x - width / 3, ly);
        ctx.quadraticCurveTo(x, ly - 3, x + width / 3, ly);
        ctx.stroke();
      }
    }

    ctx.fillStyle = '#4E342E';
    ctx.beginPath();
    ctx.moveTo(x - width, groundY);
    ctx.quadraticCurveTo(x - width * 1.5, groundY + 8, x - width * 0.5, groundY + 6);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + width, groundY);
    ctx.quadraticCurveTo(x + width * 1.5, groundY + 8, x + width * 0.5, groundY + 6);
    ctx.fill();
  },

  drawBranches(ctx, x, topY, stage, streak) {
    const branchCount = Math.min(2 + stage, 8);
    ctx.strokeStyle = '#5D4037';
    ctx.lineCap = 'round';

    for (let i = 0; i < branchCount; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const yOffset = 10 + (i * 15);
      const length = 20 + stage * 5 + Math.random() * 10;
      ctx.lineWidth = Math.max(1, 4 - i * 0.3);

      ctx.beginPath();
      ctx.moveTo(x, topY + yOffset);
      ctx.quadraticCurveTo(
        x + side * length * 0.6,
        topY + yOffset - 15,
        x + side * length,
        topY + yOffset - 20
      );
      ctx.stroke();
    }
  },

  drawLeaves(ctx, x, topY, stage, streak) {
    const leafCount = stage * 12;
    const spread = 20 + stage * 12;
    const opacity = streak > 0 ? 1 : 0.6;

    for (let i = 0; i < leafCount; i++) {
      const angle = (i / leafCount) * Math.PI * 2;
      const r = Math.random() * spread;
      const lx = x + Math.cos(angle) * r;
      const ly = topY - 10 + Math.sin(angle) * r * 0.6 - Math.random() * 20;

      const hue = 100 + Math.random() * 40;
      const saturation = 40 + stage * 5;
      const lightness = 35 + Math.random() * 20;
      ctx.fillStyle = `hsla(${hue}, ${saturation}%, ${lightness}%, ${opacity})`;

      const size = 4 + Math.random() * (stage * 0.8);
      ctx.beginPath();
      ctx.ellipse(lx, ly, size, size * 0.7, Math.random() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }

    if (stage >= 5) {
      for (let i = 0; i < 5; i++) {
        const angle = (i / 5) * Math.PI * 2;
        const r = spread * 0.5;
        const fx = x + Math.cos(angle) * r;
        const fy = topY - 20 + Math.sin(angle) * r * 0.4;

        ctx.fillStyle = `hsla(330, 70%, 85%, ${opacity})`;
        for (let p = 0; p < 5; p++) {
          const pa = (p / 5) * Math.PI * 2;
          ctx.beginPath();
          ctx.ellipse(
            fx + Math.cos(pa) * 3,
            fy + Math.sin(pa) * 3,
            3, 2, pa, 0, Math.PI * 2
          );
          ctx.fill();
        }
      }
    }
  },

  drawFruits(ctx, x, topY, stage) {
    const fruitCount = stage - 6;
    for (let i = 0; i < fruitCount; i++) {
      const angle = (i / fruitCount) * Math.PI * 2 + 0.5;
      const r = 30 + Math.random() * 20;
      const fx = x + Math.cos(angle) * r;
      const fy = topY + Math.sin(angle) * r * 0.4 + 10;

      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      ctx.arc(fx, fy, 5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.beginPath();
      ctx.arc(fx - 1.5, fy - 1.5, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  },

  drawStreakGlow(ctx, x, y, streak) {
    const intensity = Math.min(streak * 0.05, 0.3);
    const radius = 60 + streak * 5;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, `rgba(255, 183, 77, ${intensity})`);
    gradient.addColorStop(1, 'rgba(255, 183, 77, 0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  },

  drawForest(ctx, w, h, groundY, streak) {
    // Extended ground
    ctx.fillStyle = '#f0f9f0';
    ctx.beginPath();
    ctx.ellipse(w / 2, groundY + 10, w * 0.45, 24, 0, 0, Math.PI * 2);
    ctx.fill();

    // Draw 3 trees: left small, center large, right small
    const trees = [
      { x: w * 0.2, scale: 0.5, stage: 6 },
      { x: w * 0.5, scale: 1.0, stage: 10 },
      { x: w * 0.8, scale: 0.55, stage: 7 }
    ];

    trees.forEach(t => {
      ctx.save();
      ctx.translate(t.x, groundY);
      ctx.scale(t.scale, t.scale);
      const tGroundY = 0;
      const trunkHeight = Math.min(30 + t.stage * 18, 180);
      const trunkWidth = Math.min(4 + t.stage * 2, 24);
      this.drawTrunk(ctx, 0, tGroundY, trunkHeight, trunkWidth, t.stage);
      if (t.stage >= 2) this.drawBranches(ctx, 0, tGroundY - trunkHeight, t.stage, streak);
      if (t.stage >= 1) this.drawLeaves(ctx, 0, tGroundY - trunkHeight, t.stage, streak);
      if (t.stage >= 5) {
        // flowers already drawn by drawLeaves for stage >= 5
      }
      if (t.stage >= 7) this.drawFruits(ctx, 0, tGroundY - trunkHeight, t.stage);
      ctx.restore();
    });

    if (streak > 0) {
      this.drawStreakGlow(ctx, w / 2, groundY - 80, streak);
    }
  }
};
