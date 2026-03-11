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
});
