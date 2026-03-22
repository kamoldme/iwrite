document.addEventListener('DOMContentLoaded', () => {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
      }
    });
  }, { threshold: 0.1 });

  document.querySelectorAll('[data-aos]').forEach(el => observer.observe(el));

  const mobileMenu = document.querySelector('.mobile-menu');
  const navLinks = document.querySelector('.nav-links');
  if (mobileMenu) {
    mobileMenu.addEventListener('click', () => {
      navLinks.classList.toggle('mobile-open');
    });
  }

  function animateValue(el, start, end, duration) {
    if (start === end) {
      el.textContent = end.toLocaleString();
      return;
    }
    const range = end - start;
    const startTime = performance.now();
    function step(now) {
      const progress = Math.min((now - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = Math.floor(start + range * eased).toLocaleString();
      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  let currentStats = { totalWords: 0, totalSessions: 0, totalWriters: 0 };
  let statsVisible = false;

  async function fetchStats() {
    try {
      const res = await fetch('/api/stats/public');
      if (!res.ok) return;
      const data = await res.json();

      const wordEl = document.getElementById('stat-words');
      const sessionEl = document.getElementById('stat-sessions');
      const writerEl = document.getElementById('stat-writers');

      if (statsVisible) {
        animateValue(wordEl, currentStats.totalWords, data.totalWords, 800);
        animateValue(sessionEl, currentStats.totalSessions, data.totalSessions, 800);
        animateValue(writerEl, currentStats.totalWriters, data.totalWriters, 800);
      } else {
        wordEl.textContent = data.totalWords.toLocaleString();
        sessionEl.textContent = data.totalSessions.toLocaleString();
        writerEl.textContent = data.totalWriters.toLocaleString();
      }

      currentStats = data;
      if (data.totalWords > 0) drawGrowthChart(data.totalWords);
    } catch {}
  }

  const statsBar = document.querySelector('.stats-bar');
  const statsObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && !statsVisible) {
      statsVisible = true;
      fetchStats();
    }
  }, { threshold: 0.3 });
  statsObserver.observe(statsBar);

  fetchStats();
  setInterval(fetchStats, 30000);

  // ── Releases Carousel ──
  const track = document.getElementById('releases-track');
  const cards = track ? Array.from(track.querySelectorAll('.release-card')) : [];
  const prevBtn = document.getElementById('rel-prev');
  const nextBtn = document.getElementById('rel-next');
  const dotsWrap = document.getElementById('releases-dots');
  const counterCurrent = document.getElementById('release-current');
  const counterTotal = document.getElementById('release-total');
  let activeIndex = 0;

  if (track && cards.length) {
    if (counterTotal) counterTotal.textContent = String(cards.length).padStart(2, '0');

    cards.forEach((_, i) => {
      const dot = document.createElement('button');
      dot.className = 'releases-dot' + (i === 0 ? ' active' : '');
      dot.setAttribute('aria-label', `Release ${i + 1}`);
      dot.addEventListener('click', () => goTo(i));
      dotsWrap.appendChild(dot);
    });

    function goTo(index) {
      if (index < 0 || index >= cards.length) return;
      activeIndex = index;

      // Use the viewport and card widths to calculate pixel offset
      const viewport = track.parentElement;
      const vpWidth = viewport.offsetWidth;
      const cardEl = cards[index];
      // Get the card's left offset relative to track start
      const cardLeft = cardEl.offsetLeft;
      const cardWidth = cardEl.offsetWidth;
      // Center the card in the viewport
      const offset = cardLeft - (vpWidth / 2) + (cardWidth / 2);
      track.style.transform = `translateX(-${Math.max(0, offset)}px)`;

      cards.forEach((c, i) => c.classList.toggle('active', i === index));
      dotsWrap.querySelectorAll('.releases-dot').forEach((d, i) => d.classList.toggle('active', i === index));
      if (counterCurrent) counterCurrent.textContent = String(index + 1).padStart(2, '0');
      prevBtn.disabled = index === 0;
      nextBtn.disabled = index === cards.length - 1;
    }

    prevBtn.addEventListener('click', () => goTo(activeIndex - 1));
    nextBtn.addEventListener('click', () => goTo(activeIndex + 1));

    // Touch/swipe
    let touchStartX = 0;
    let touchDelta = 0;
    const viewport = track.parentElement;
    viewport.addEventListener('touchstart', (e) => { touchStartX = e.touches[0].clientX; touchDelta = 0; }, { passive: true });
    viewport.addEventListener('touchmove', (e) => { touchDelta = e.touches[0].clientX - touchStartX; }, { passive: true });
    viewport.addEventListener('touchend', () => {
      if (Math.abs(touchDelta) > 50) {
        if (touchDelta < 0) goTo(activeIndex + 1);
        else goTo(activeIndex - 1);
      }
      touchDelta = 0;
    });

    // Initialize after a frame so offsetLeft values are correct
    requestAnimationFrame(() => goTo(0));

    // Recalc on resize
    window.addEventListener('resize', () => goTo(activeIndex));
  }

  // ── Growth Chart (organic, fluctuating) ──
  let chartDrawn = false;

  function drawGrowthChart(totalWords) {
    if (chartDrawn) {
      const el = document.getElementById('growth-total');
      if (el) el.textContent = totalWords.toLocaleString();
      return;
    }
    chartDrawn = true;

    const canvas = document.getElementById('growth-chart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    const rect = canvas.parentElement.getBoundingClientRect();
    const w = rect.width - 56;
    const h = 220;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.scale(dpr, dpr);

    // Generate daily data points (56 days) with realistic fluctuations
    const days = 56;
    const labels = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      labels.push(d);
    }

    // Seeded PRNG for consistent results
    function seededRandom(seed) {
      let s = seed;
      return function() {
        s = (s * 16807 + 0) % 2147483647;
        return (s - 1) / 2147483646;
      };
    }
    const rand = seededRandom(42);

    const dailyWords = [];
    for (let i = 0; i < days; i++) {
      const trendMultiplier = 0.3 + 0.7 * Math.pow(i / days, 1.2);
      const dayOfWeek = labels[i].getDay();
      const weekendFactor = (dayOfWeek === 0 || dayOfWeek === 6) ? 0.6 : 1.0;
      const dailyRand = rand();
      let dailyAmount;
      if (dailyRand < 0.08) {
        dailyAmount = 0;
      } else if (dailyRand > 0.92) {
        dailyAmount = (800 + rand() * 1200) * trendMultiplier;
      } else {
        dailyAmount = (100 + rand() * 500) * trendMultiplier * weekendFactor;
      }
      dailyWords.push(Math.round(dailyAmount));
    }

    const rawTotal = dailyWords.reduce((a, b) => a + b, 0);
    const scale = rawTotal > 0 ? totalWords / rawTotal : 1;
    const cumulative = [];
    let running = 0;
    for (let i = 0; i < days; i++) {
      running += dailyWords[i] * scale;
      cumulative.push(Math.round(running));
    }
    cumulative[cumulative.length - 1] = totalWords;

    const padLeft = 52;
    const padRight = 20;
    const padTop = 16;
    const padBottom = 32;
    const chartW = w - padLeft - padRight;
    const chartH = h - padTop - padBottom;
    const maxVal = totalWords * 1.12;

    function xPos(i) { return padLeft + (i / (days - 1)) * chartW; }
    function yPos(v) { return padTop + chartH - (v / maxVal) * chartH; }

    const isSepia = document.documentElement.classList.contains('sepia');
    const isDark = !document.documentElement.classList.contains('light') && !isSepia;
    const gridColor = isDark ? 'rgba(255,255,255,0.06)' : isSepia ? 'rgba(100,65,20,0.08)' : 'rgba(0,0,0,0.06)';
    const labelColor = isDark ? 'rgba(255,255,255,0.35)' : isSepia ? 'rgba(100,65,20,0.5)' : 'rgba(0,0,0,0.4)';
    const accentColor = isSepia ? '#C37E3F' : '#4ade80';

    const gridLines = 4;

    // Helper: build the curve path (reused everywhere)
    function buildCurvePath(count) {
      ctx.moveTo(xPos(0), yPos(cumulative[0]));
      for (let i = 1; i < count; i++) {
        const prevX = xPos(i - 1);
        const prevY = yPos(cumulative[i - 1]);
        const currX = xPos(i);
        const currY = yPos(cumulative[i]);
        const cpx = (prevX + currX) / 2;
        ctx.bezierCurveTo(cpx, prevY, cpx, currY, currX, currY);
      }
    }

    function drawFullFrame(drawCount, showDot, timestamp) {
      // Clear entire canvas
      ctx.clearRect(0, 0, w, h);

      // Grid
      ctx.strokeStyle = gridColor;
      ctx.lineWidth = 1;
      for (let i = 0; i <= gridLines; i++) {
        const y = padTop + (chartH / gridLines) * i;
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(w - padRight, y);
        ctx.stroke();

        const val = Math.round(maxVal - (maxVal / gridLines) * i);
        ctx.fillStyle = labelColor;
        ctx.font = '11px "Instrument Sans", system-ui, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(val >= 1000 ? (val / 1000).toFixed(1) + 'k' : val.toString(), padLeft - 8, y + 4);
      }

      // X-axis labels
      ctx.fillStyle = labelColor;
      ctx.font = '10px "Instrument Sans", system-ui, sans-serif';
      ctx.textAlign = 'center';
      const step = Math.floor(days / 7);
      for (let i = 0; i < days; i += step) {
        ctx.fillText(labels[i].toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), xPos(i), h - 8);
      }
      ctx.fillText(labels[days - 1].toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), xPos(days - 1), h - 8);

      // Filled area
      ctx.beginPath();
      ctx.moveTo(xPos(0), yPos(0));
      ctx.lineTo(xPos(0), yPos(cumulative[0]));
      for (let i = 1; i < drawCount; i++) {
        const prevX = xPos(i - 1);
        const prevY = yPos(cumulative[i - 1]);
        const currX = xPos(i);
        const currY = yPos(cumulative[i]);
        const cpx = (prevX + currX) / 2;
        ctx.bezierCurveTo(cpx, prevY, cpx, currY, currX, currY);
      }
      ctx.lineTo(xPos(drawCount - 1), yPos(0));
      ctx.closePath();

      const grad = ctx.createLinearGradient(0, padTop, 0, padTop + chartH);
      grad.addColorStop(0, 'rgba(74, 222, 128, 0.22)');
      grad.addColorStop(0.6, 'rgba(74, 222, 128, 0.06)');
      grad.addColorStop(1, 'rgba(74, 222, 128, 0.01)');
      ctx.fillStyle = grad;
      ctx.fill();

      // Line
      ctx.beginPath();
      buildCurvePath(drawCount);
      ctx.strokeStyle = accentColor;
      ctx.lineWidth = 2;
      ctx.stroke();

      // Glow
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.filter = 'blur(6px)';
      ctx.beginPath();
      buildCurvePath(drawCount);
      ctx.strokeStyle = accentColor;
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.restore();

      // Dot
      if (showDot) {
        const lastI = drawCount - 1;
        const pulseSize = timestamp ? 4 + Math.sin(timestamp / 400) * 1.5 : 4;
        ctx.beginPath();
        ctx.arc(xPos(lastI), yPos(cumulative[lastI]), pulseSize, 0, Math.PI * 2);
        ctx.fillStyle = accentColor;
        ctx.fill();
        ctx.strokeStyle = isDark ? '#111111' : '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // Animate
    const animDuration = 1800;
    const animStart = performance.now();

    function animate(timestamp) {
      const progress = Math.min((timestamp - animStart) / animDuration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const drawCount = Math.max(2, Math.ceil(days * eased));

      drawFullFrame(drawCount, true, timestamp);

      // Counter
      const el = document.getElementById('growth-total');
      if (el) el.textContent = Math.floor(totalWords * eased).toLocaleString();

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        // Pulse loop — full redraw each frame to avoid artifacts
        function pulse(ts) {
          drawFullFrame(days, true, ts);
          requestAnimationFrame(pulse);
        }
        requestAnimationFrame(pulse);
      }
    }

    const chartObserver = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        chartObserver.disconnect();
        requestAnimationFrame(animate);
      }
    }, { threshold: 0.3 });
    chartObserver.observe(canvas);
  }
});
