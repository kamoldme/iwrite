const Editor = {
  active: false,
  mode: 'normal',
  duration: 15,
  startTime: null,
  documentId: null,
  autoSaveInterval: null,
  timerInterval: null,
  dangerInterval: null,
  lastKeystroke: null,
  dangerThreshold: 6000,
  tabLeftTime: null,
  tabGracePeriod: 10,
  abandoned: false,
  wordMilestones: [50, 100, 250, 500, 1000, 2500],
  lastWordMilestone: 0,

  get textarea() { return document.getElementById('editor-textarea'); },
  get container() { return document.getElementById('editor-container'); },
  get timerEl() { return document.getElementById('editor-timer'); },
  get wordCountEl() { return document.getElementById('editor-word-count'); },
  get titleInput() { return document.getElementById('editor-title'); },
  get modeBadge() { return document.getElementById('editor-mode-badge'); },
  get dangerProgress() { return document.getElementById('danger-progress'); },
  get dangerProgressBar() { return document.getElementById('danger-progress-bar'); },
  get vignette() { return document.getElementById('screen-vignette'); },
  get tabWarning() { return document.getElementById('tab-warning'); },
  get tabWarningTimer() { return document.getElementById('tab-warning-timer'); },

  async start(duration, mode) {
    this.duration = duration;
    this.mode = mode;
    this.startTime = Date.now();
    this.lastKeystroke = Date.now();
    this.abandoned = false;
    this.lastWordMilestone = 0;

    try {
      const doc = await API.createDocument(this.titleInput.value || 'Untitled', '', mode);
      this.documentId = doc.id;
    } catch {
      App.toast('Failed to create document', 'error');
      return;
    }

    this.container.classList.add('active');
    this.textarea.value = '';
    this.textarea.focus();
    this.active = true;

    this.modeBadge.textContent = mode === 'dangerous' ? 'Dangerous' : 'Normal';
    this.modeBadge.className = `editor-mode-badge ${mode}`;

    if (mode === 'dangerous') {
      this.container.classList.add('dangerous-active');
      this.dangerProgress.style.display = 'block';
      this.startDangerMode();
    }

    this.timerInterval = setInterval(() => this.updateTimer(), 100);
    this.autoSaveInterval = setInterval(() => this.autoSave(), 10000);

    this.textarea.addEventListener('input', this.onInput);
    this.textarea.addEventListener('keydown', this.onKeydown);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('focus', this.onFocus);
  },

  onInput: () => {
    Editor.lastKeystroke = Date.now();
    Editor.updateWordCount();
    Editor.textarea.style.opacity = '1';
    Editor.textarea.classList.remove('fading');
    Editor.vignette.classList.remove('active');
  },

  onKeydown: (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = Editor.textarea.selectionStart;
      const end = Editor.textarea.selectionEnd;
      Editor.textarea.value =
        Editor.textarea.value.substring(0, start) + '  ' + Editor.textarea.value.substring(end);
      Editor.textarea.selectionStart = Editor.textarea.selectionEnd = start + 2;
    }
  },

  onVisibilityChange: () => {
    if (document.hidden && Editor.active) {
      Editor.onTabLeave();
    } else if (!document.hidden && Editor.active) {
      Editor.onTabReturn();
    }
  },

  onBlur: () => {
    if (Editor.active) Editor.onTabLeave();
  },

  onFocus: () => {
    if (Editor.active) Editor.onTabReturn();
  },

  onTabLeave() {
    if (this.abandoned || !this.active) return;
    this.tabLeftTime = Date.now();
    this.tabWarning.classList.add('active');
    this.tabCountdown = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.tabLeftTime) / 1000);
      const remaining = this.tabGracePeriod - elapsed;
      this.tabWarningTimer.textContent = remaining;
      if (remaining <= 0) {
        this.abandonSession();
      }
    }, 200);
  },

  onTabReturn() {
    if (this.tabCountdown) {
      clearInterval(this.tabCountdown);
      this.tabCountdown = null;
    }
    this.tabWarning.classList.remove('active');
    this.tabLeftTime = null;
    if (!this.abandoned) {
      this.textarea.focus();
    }
  },

  async abandonSession() {
    this.abandoned = true;
    clearInterval(this.tabCountdown);
    this.cleanup();

    if (this.documentId) {
      try {
        await API.abandonDocument(this.documentId);
      } catch {}
    }

    this.tabWarning.classList.remove('active');
    this.container.classList.remove('active');
    App.showSessionFailed('You left the tab. Your writing is gone.');
  },

  startDangerMode() {
    this.dangerInterval = setInterval(() => {
      if (!this.active) return;
      const elapsed = Date.now() - this.lastKeystroke;
      const progressRatio = Math.min(elapsed / this.dangerThreshold, 1);
      const barPercent = Math.min((elapsed / (this.dangerThreshold - 1000)) * 100, 100);
      this.dangerProgressBar.style.width = `${barPercent}%`;

      if (progressRatio > 0.5) {
        this.vignette.classList.add('active');
      } else {
        this.vignette.classList.remove('active');
      }

      if (progressRatio > 0.6 && !this.textarea.classList.contains('fading')) {
        this.textarea.classList.add('fading');
      }

      if (elapsed >= this.dangerThreshold) {
        this.failDangerMode();
      }
    }, 50);
  },

  async failDangerMode() {
    this.cleanup();
    this.abandoned = true;

    if (this.documentId) {
      try {
        await API.abandonDocument(this.documentId);
      } catch {}
    }

    this.container.classList.remove('active');
    App.showSessionFailed('You stopped typing. Your writing is gone.');
  },

  updateTimer() {
    if (this.duration === 0) {
      const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
      const min = Math.floor(elapsed / 60);
      const sec = elapsed % 60;
      this.timerEl.textContent = `${min}:${String(sec).padStart(2, '0')}`;
      this.timerEl.className = 'editor-timer';
      return;
    }

    const totalSeconds = this.duration * 60;
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const remaining = Math.max(0, totalSeconds - elapsed);
    const min = Math.floor(remaining / 60);
    const sec = remaining % 60;
    this.timerEl.textContent = `${min}:${String(sec).padStart(2, '0')}`;

    if (remaining <= 60) {
      this.timerEl.className = 'editor-timer danger';
    } else if (remaining <= 180) {
      this.timerEl.className = 'editor-timer warning';
    } else {
      this.timerEl.className = 'editor-timer';
    }

    if (remaining <= 0) {
      this.completeSession();
    }
  },

  updateWordCount() {
    const words = this.getWordCount();
    this.wordCountEl.textContent = `${words} word${words !== 1 ? 's' : ''}`;

    const milestone = this.wordMilestones.find(m => words >= m && m > this.lastWordMilestone);
    if (milestone) {
      this.lastWordMilestone = milestone;
      this.showXPFloat(milestone >= 500 ? '+25 XP' : milestone >= 100 ? '+10 XP' : '+5 XP');
    }
  },

  getWordCount() {
    return this.textarea.value.trim().split(/\s+/).filter(Boolean).length;
  },

  showXPFloat(text) {
    const el = document.createElement('div');
    el.className = 'editor-xp-float';
    el.textContent = text;
    el.style.left = '50%';
    el.style.top = '80px';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1500);
  },

  async autoSave() {
    if (!this.active || !this.documentId || this.abandoned) return;
    try {
      await API.updateDocument(this.documentId, {
        title: this.titleInput.value,
        content: this.textarea.value
      });
    } catch {}
  },

  async completeSession() {
    if (!this.active || this.abandoned) return;
    this.active = false;
    this.cleanup();

    const wordCount = this.getWordCount();
    const duration = Math.floor((Date.now() - this.startTime) / 1000);
    const baseXP = Math.floor(wordCount * 0.5);
    const timeBonus = Math.floor(duration / 60) * 2;
    const modeBonus = this.mode === 'dangerous' ? Math.floor(baseXP * 0.5) : 0;
    const xpEarned = baseXP + timeBonus + modeBonus;

    await API.updateDocument(this.documentId, {
      title: this.titleInput.value,
      content: this.textarea.value
    });

    let result;
    try {
      result = await API.completeSession(this.documentId, { wordCount, duration, xpEarned });
    } catch {
      this.container.classList.remove('active');
      App.loadDashboard();
      return;
    }

    this.container.classList.remove('active');
    this.showComplete(wordCount, duration, xpEarned, result.user);
  },

  showComplete(words, duration, xp, user) {
    document.getElementById('sc-words').textContent = words.toLocaleString();
    const min = Math.floor(duration / 60);
    const sec = duration % 60;
    document.getElementById('sc-time').textContent = `${min}:${String(sec).padStart(2, '0')}`;
    document.getElementById('sc-xp').textContent = `+${xp} XP`;

    if (user.streak > 0) {
      document.getElementById('sc-streak').style.display = 'flex';
      document.getElementById('sc-streak-count').textContent = `${user.streak} day streak!`;
    }

    document.getElementById('session-complete').classList.add('active');
  },

  cleanup() {
    this.active = false;
    clearInterval(this.timerInterval);
    clearInterval(this.autoSaveInterval);
    clearInterval(this.dangerInterval);
    clearInterval(this.tabCountdown);
    this.container.classList.remove('dangerous-active');
    this.dangerProgress.style.display = 'none';
    this.vignette.classList.remove('active');
    this.textarea.classList.remove('fading');
    this.textarea.style.opacity = '1';
    this.textarea.removeEventListener('input', this.onInput);
    this.textarea.removeEventListener('keydown', this.onKeydown);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('focus', this.onFocus);
  },

  abort() {
    if (!this.active) {
      this.container.classList.remove('active');
      return;
    }
    if (confirm('Are you sure? Leaving will save your current progress but end the session early.')) {
      this.completeSession();
    }
  }
};
