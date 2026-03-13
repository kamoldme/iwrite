const Editor = {
  active: false,
  mode: 'normal',
  duration: 15,
  startTime: null,
  documentId: null,
  autoSaveInterval: null,
  timerInterval: null,
  dangerInterval: null,
  sessionSaveInterval: null,
  lastKeystroke: null,
  dangerThreshold: 6000,
  tabLeftTime: null,
  tabGracePeriod: 10,
  abandoned: false,
  wordMilestones: [50, 100, 250, 500, 1000, 2500],
  lastWordMilestone: 0,
  isEditing: false,
  isDirty: false,
  originalContent: '',
  originalTitle: '',
  _editChangeHandler: null,
  _fullscreenActive: false,   // tracks whether we requested fullscreen
  _blurCooldown: false,       // prevents blur firing on harmless clicks
  tabCountdown: null,         // timeout for leaving the tab

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

  _saveSessionState() {
    if (!this.active || !this.documentId) return;
    try {
      sessionStorage.setItem('editor_session', JSON.stringify({
        active: true,
        documentId: this.documentId,
        startTime: this.startTime,
        duration: this.duration,
        mode: this.mode,
        lastKeystroke: this.lastKeystroke,
        title: this.titleInput.value,
        content: this.textarea.innerHTML
      }));
    } catch {}
  },

  _clearSessionState() {
    try {
      sessionStorage.removeItem('editor_session');
    } catch {}
  },

  _getSessionState() {
    try {
      const data = sessionStorage.getItem('editor_session');
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  },

  async start(duration, mode) {
    this.duration = duration;
    this.mode = mode;
    this.abandoned = false;
    this.lastWordMilestone = 0;
    this.isEditing = false;
    this.isDirty = false;
    if (typeof CommentSystem !== 'undefined') CommentSystem.destroy();

    try {
      const doc = await API.createDocument(this.titleInput.value || 'Untitled', '', mode);
      this.documentId = doc.id;
    } catch {
      App.toast('Failed to create document', 'error');
      return;
    }

    if (mode === 'dangerous') {
      await this.runCountdown();
    }

    this.startTime = Date.now();
    this.lastKeystroke = Date.now();

    this.container.classList.add('active');
    this.textarea.innerHTML = '';
    this.textarea.contentEditable = 'true';
    this.textarea.focus();
    this.active = true;

    // Show correct buttons for active session
    // In dangerous mode, hide the Complete button — session ends only when time runs out
    document.getElementById('editor-save-btn').style.display = mode === 'dangerous' ? 'none' : 'inline-flex';
    document.getElementById('editor-edit-btn').style.display = 'none';
    document.getElementById('editor-save-edit-btn').style.display = 'none';
    document.getElementById('editor-comment-history-btn').style.display = 'none';
    // Only show formatting bar in normal mode
    document.getElementById('formatting-toolbar').style.display = mode === 'dangerous' ? 'none' : 'flex';
    document.getElementById('status-bar').style.display = 'flex';
    this.titleInput.readOnly = false;

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
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    window.addEventListener('blur', this.onWindowBlur);
    window.addEventListener('focus', this.onWindowFocus);
    if (mode !== 'dangerous') this.bindFormatting();
    this.updateWordCount();

    // Save session state periodically so it survives page refresh
    this.sessionSaveInterval = setInterval(() => this._saveSessionState(), 5000);
    this._saveSessionState();

    // Request fullscreen automatically for both normal and dangerous mode
    this._fullscreenActive = false;
    this._blurCooldown = false;
    try {
      const el = document.documentElement;
      const req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
      if (req) {
        req.call(el).then(() => { this._fullscreenActive = true; }).catch(() => {});
      }
    } catch(e) {}
  },

  bindFormatting() {
    document.querySelectorAll('.fmt-btn[data-command]').forEach(btn => {
      btn.onmousedown = (e) => {
        e.preventDefault();
        document.execCommand(btn.dataset.command, false, null);
        this.updateFormatButtons();
      };
    });

    document.querySelectorAll('.fmt-color-btn').forEach(btn => {
      btn.onmousedown = (e) => {
        e.preventDefault();
        document.execCommand('foreColor', false, btn.dataset.color);
      };
    });

    document.addEventListener('selectionchange', this._onSelectionChange);
  },

  _onSelectionChange() {
    Editor.updateFormatButtons();
  },

  updateFormatButtons() {
    document.querySelectorAll('.fmt-btn[data-command]').forEach(btn => {
      const command = btn.dataset.command;
      try {
        btn.classList.toggle('active', document.queryCommandState(command));
      } catch {}
    });
  },

  runCountdown() {
    return new Promise(resolve => {
      const overlay = document.getElementById('danger-countdown');
      const numEl = document.getElementById('danger-countdown-num');
      overlay.classList.add('active');
      let count = 5;
      numEl.textContent = count;
      const interval = setInterval(() => {
        count--;
        if (count <= 0) {
          clearInterval(interval);
          overlay.classList.remove('active');
          resolve();
        } else {
          numEl.textContent = count;
        }
      }, 1000);
    });
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
      document.execCommand('insertText', false, '  ');
    }
  },

  onVisibilityChange: () => {
    if (document.hidden && Editor.active) {
      Editor.onTabLeave();
    } else if (!document.hidden && Editor.active) {
      Editor.onTabReturn();
    }
  },

  // Fired when the user exits fullscreen (ESC, browser UI, etc.)
  onFullscreenChange: () => {
    if (!Editor.active || Editor.abandoned) return;
    const inFS = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement);
    if (!inFS && Editor._fullscreenActive) {
      // User left fullscreen — this is OK as long as they're still on the tab
      Editor._fullscreenActive = false;
      // If tab is still visible, don't fail
      if (!document.hidden) {
        return;
      }
    } else if (inFS) {
      Editor._fullscreenActive = true;
    }
  },

  // Fired when the browser window loses focus (user switches app, clicks desktop, etc.)
  onWindowBlur: () => {
    if (!Editor.active || Editor.abandoned || Editor._blurCooldown) return;
    // Only count as leaving if also not just switching within the browser UI
    if (!document.hidden) {
      Editor.onTabLeave();
    }
  },

  // Fired when the browser window regains focus
  onWindowFocus: () => {
    if (!Editor.active || Editor.abandoned) return;
    Editor._blurCooldown = true;
    setTimeout(() => { Editor._blurCooldown = false; }, 300);
    if (!document.hidden) {
      Editor.onTabReturn();
    }
  },

  onTabLeave() {
    if (this.abandoned || !this.active) return;
    if (this.tabCountdown) return;
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
      // Re-enter fullscreen if they return in time
      const inFS = !!(document.fullscreenElement || document.webkitFullscreenElement);
      if (this._fullscreenActive && !inFS) {
        try {
          const el = document.documentElement;
          const req = el.requestFullscreen || el.webkitRequestFullscreen;
          if (req) req.call(el).catch(() => {});
        } catch(e) {}
      }
    }
  },

  async abandonSession() {
    this.abandoned = true;
    clearInterval(this.tabCountdown);
    this.cleanup();

    // Save to cache regardless of mode
    const cacheKey = `iwrite_abandon_${Date.now()}`;
    try {
      localStorage.setItem(cacheKey, JSON.stringify({
        documentId: this.documentId,
        title: this.titleInput.value,
        content: this.textarea.innerHTML,
        reason: 'tab_left',
        failedAt: new Date().toISOString()
      }));
    } catch {}

    if (this.documentId) {
      try {
        await API.abandonDocument(this.documentId, 'tab_left');
      } catch {}
    }

    this.tabWarning.classList.remove('active');
    document.getElementById('status-bar').style.display = 'none';
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

    // Save content to localStorage cache (admin-accessible, user-invisible)
    const cacheKey = `iwrite_danger_fail_${Date.now()}`;
    try {
      localStorage.setItem(cacheKey, JSON.stringify({
        documentId: this.documentId,
        title: this.titleInput.value,
        content: this.textarea.innerHTML,
        reason: 'typing_stopped',
        failedAt: new Date().toISOString()
      }));
    } catch {}

    if (this.documentId) {
      try {
        await API.abandonDocument(this.documentId, 'typing_stopped');
      } catch {}
    }

    document.getElementById('status-bar').style.display = 'none';
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
    const el = document.getElementById('editor-word-count');
    if (el) el.textContent = `${words} word${words !== 1 ? 's' : ''}`;

    if (this.active) {
      const milestone = this.wordMilestones.find(m => words >= m && m > this.lastWordMilestone);
      if (milestone) {
        this.lastWordMilestone = milestone;
        this.showXPFloat(milestone >= 500 ? '+25 XP' : milestone >= 100 ? '+10 XP' : '+5 XP');
      }
    }
  },

  getWordCount() {
    return (this.textarea.innerText || '').trim().split(/\s+/).filter(Boolean).length;
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
        content: this.textarea.innerHTML
      });
      // Also save session state on each auto-save
      this._saveSessionState();
    } catch {}
  },

  async resumeSession() {
    const state = this._getSessionState();
    if (!state || !state.active) return false;

    try {
      // Try to update the document to verify it still exists
      await API.updateDocument(state.documentId, {
        title: state.title,
        content: state.content
      });

      // Restore session state
      this.documentId = state.documentId;
      this.duration = state.duration;
      this.mode = state.mode;
      this.startTime = state.startTime;
      this.lastKeystroke = state.lastKeystroke;
      this.abandoned = false;
      this.lastWordMilestone = 0;
      this.isEditing = false;
      this.isDirty = false;

      // Show editor
      this.container.classList.add('active');
      this.titleInput.value = state.title;
      this.textarea.innerHTML = state.content;
      this.textarea.contentEditable = 'true';
      this.textarea.focus();
      this.active = true;

      // Show correct buttons and badges
      document.getElementById('editor-save-btn').style.display = this.mode === 'dangerous' ? 'none' : 'inline-flex';
      document.getElementById('editor-edit-btn').style.display = 'none';
      document.getElementById('editor-save-edit-btn').style.display = 'none';
      document.getElementById('editor-comment-history-btn').style.display = 'none';
      document.getElementById('formatting-toolbar').style.display = this.mode === 'dangerous' ? 'none' : 'flex';
      document.getElementById('status-bar').style.display = 'flex';
      this.titleInput.readOnly = false;

      this.modeBadge.textContent = this.mode === 'dangerous' ? 'Dangerous' : 'Normal';
      this.modeBadge.className = `editor-mode-badge ${this.mode}`;

      // Setup mode-specific UI
      if (this.mode === 'dangerous') {
        this.container.classList.add('dangerous-active');
        this.dangerProgress.style.display = 'block';
        this.startDangerMode();
      }

      // Rebind event listeners
      this.timerInterval = setInterval(() => this.updateTimer(), 100);
      this.autoSaveInterval = setInterval(() => this.autoSave(), 10000);
      this.sessionSaveInterval = setInterval(() => this._saveSessionState(), 5000);

      this.textarea.addEventListener('input', this.onInput);
      this.textarea.addEventListener('keydown', this.onKeydown);
      document.addEventListener('visibilitychange', this.onVisibilityChange);
      document.addEventListener('fullscreenchange', this.onFullscreenChange);
      window.addEventListener('blur', this.onWindowBlur);
      window.addEventListener('focus', this.onWindowFocus);
      if (this.mode !== 'dangerous') this.bindFormatting();
      this.updateWordCount();

      this._fullscreenActive = false;
      this._blurCooldown = false;

      // Request fullscreen again (user was in fullscreen before refresh)
      try {
        const el = document.documentElement;
        const req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
        if (req) {
          req.call(el).then(() => { this._fullscreenActive = true; }).catch(() => {});
        }
      } catch(e) {}

      return true;
    } catch {
      this._clearSessionState();
      return false;
    }
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
      content: this.textarea.innerHTML
    });

    let result;
    try {
      result = await API.completeSession(this.documentId, { wordCount, duration, xpEarned });
    } catch {
      this.container.classList.remove('active');
      App.loadDashboard();
      return;
    }

    document.getElementById('status-bar').style.display = 'none';
    this.container.classList.remove('active');
    // Auto-refresh sessions tab so new doc appears immediately
    try { await App.loadDocuments(); } catch {}
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

  // ===== EDIT MODE FOR COMPLETED DOCS =====

  showBanner(message) {
    const banner = document.getElementById('in-app-banner');
    if (!banner) return;
    banner.textContent = message;
    banner.classList.add('active');
    setTimeout(() => banner.classList.remove('active'), 2800);
  },

  showConfetti() {
    // Show in-app notification banner
    this.showBanner('✅ Document saved successfully!');

    const colors = ['#6c5ce7', '#a78bfa', '#22c55e', '#f59e0b', '#ef4444', '#00cec9', '#fd6db5'];
    // Confetti bursts from top-center
    const ox = window.innerWidth / 2;
    const oy = 0;

    for (let i = 0; i < 48; i++) {
      const el = document.createElement('div');
      const size = 5 + Math.random() * 7;
      el.style.cssText = `position:fixed;width:${size}px;height:${size}px;background:${colors[i % colors.length]};border-radius:${Math.random() > 0.5 ? '50%' : '3px'};left:${ox}px;top:${oy}px;pointer-events:none;z-index:99999`;
      document.body.appendChild(el);
      // Start at top-center, shoot downward with spread
      const vx = (Math.random() - 0.5) * 18;
      let vy = 2 + Math.random() * 8; // positive = downward
      let x = ox + (Math.random() - 0.5) * 80, y = oy, opacity = 1;
      const step = () => {
        vy += 0.3; // gravity accelerates downward
        x += vx;
        y += vy;
        opacity -= 0.018;
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        el.style.opacity = opacity;
        if (opacity > 0 && y < window.innerHeight) requestAnimationFrame(step);
        else el.remove();
      };
      setTimeout(() => requestAnimationFrame(step), i * 10);
    }
  },

  enterEditMode() {
    this.isEditing = true;
    this.isDirty = false;

    this.titleInput.readOnly = false;
    this.textarea.contentEditable = 'true';
    this.textarea.focus();

    document.getElementById('editor-edit-btn').style.display = 'none';
    document.getElementById('editor-save-edit-btn').style.display = 'inline-flex';
    document.getElementById('formatting-toolbar').style.display = 'flex';
    document.getElementById('status-bar').style.display = 'flex';
    this.modeBadge.textContent = '● Editing';
    this.modeBadge.className = 'editor-mode-badge editing';

    this.bindFormatting();
    this.updateWordCount();

    const trackChanges = () => {
      Editor.isDirty = true;
      Editor.updateWordCount();
    };
    this.textarea.addEventListener('input', trackChanges);
    this.titleInput.addEventListener('input', trackChanges);
    this._editChangeHandler = trackChanges;
  },

  async saveEdits() {
    if (!this.documentId) return;
    try {
      await API.updateDocument(this.documentId, {
        title: this.titleInput.value,
        content: this.textarea.innerHTML
      });
      this.isDirty = false;
      this.originalContent = this.textarea.innerHTML;
      this.originalTitle = this.titleInput.value;
      this.exitEditMode();
      this.showConfetti();
      App.toast('Document saved!', 'success');
      // Refresh document list in background
      if (App.currentView === 'documents') App.loadDocuments();
      else if (App.currentView === 'dashboard') App.loadDashboard();
      // Also update local cache entry
      const idx = App.documents.findIndex(d => d.id === this.documentId);
      if (idx !== -1) {
        App.documents[idx].title = this.titleInput.value;
        App.documents[idx].wordCount = this.getWordCount();
        App.documents[idx].updatedAt = new Date().toISOString();
      }
    } catch {
      App.toast('Failed to save changes', 'error');
    }
  },

  exitEditMode() {
    this.isEditing = false;
    this.titleInput.readOnly = true;
    this.textarea.contentEditable = 'false';
    document.getElementById('editor-edit-btn').style.display = 'inline-flex';
    document.getElementById('editor-save-edit-btn').style.display = 'none';
    document.getElementById('formatting-toolbar').style.display = 'none';
    document.getElementById('status-bar').style.display = 'none';
    this.modeBadge.textContent = 'Viewing';
    this.modeBadge.className = 'editor-mode-badge normal';

    if (this._editChangeHandler) {
      this.textarea.removeEventListener('input', this._editChangeHandler);
      this.titleInput.removeEventListener('input', this._editChangeHandler);
      this._editChangeHandler = null;
    }
  },

  cleanup() {
    this.active = false;
    clearInterval(this.timerInterval);
    clearInterval(this.autoSaveInterval);
    clearInterval(this.dangerInterval);
    clearInterval(this.tabCountdown);
    clearInterval(this.sessionSaveInterval);
    this._clearSessionState();
    this.container.classList.remove('dangerous-active');
    this.dangerProgress.style.display = 'none';
    this.vignette.classList.remove('active');
    this.textarea.classList.remove('fading');
    this.textarea.style.opacity = '1';
    this.textarea.removeEventListener('input', this.onInput);
    this.textarea.removeEventListener('keydown', this.onKeydown);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    window.removeEventListener('blur', this.onWindowBlur);
    window.removeEventListener('focus', this.onWindowFocus);
    document.removeEventListener('selectionchange', this._onSelectionChange);
    document.getElementById('formatting-toolbar').style.display = 'none';
    // Exit fullscreen when session ends
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      try {
        const exit = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen;
        if (exit) exit.call(document).catch(() => {});
      } catch(e) {}
    }
    this._fullscreenActive = false;
  },

  async abort() {
    // Active writing session
    if (this.active) {
      const ok = await App.showConfirm('Are you sure? Leaving will save your current progress but end the session early.');
      if (ok) this.completeSession();
      return;
    }

    // Editing a completed document with unsaved changes
    if (this.isEditing && this.isDirty) {
      const ok = await App.showConfirm('Are you sure? New edits will not be saved.');
      if (ok) {
        this.textarea.innerHTML = this.originalContent;
        this.titleInput.value = this.originalTitle;
        this.exitEditMode();
        this.container.classList.remove('active');
        document.getElementById('editor-comment-history-btn').style.display = 'none';
        document.getElementById('status-bar').style.display = 'none';
      }
      return;
    }

    // Just viewing — close
    if (this.isEditing) this.exitEditMode();
    this.container.classList.remove('active');
    document.getElementById('formatting-toolbar').style.display = 'none';
    document.getElementById('editor-comment-history-btn').style.display = 'none';
    document.getElementById('status-bar').style.display = 'none';
  }
};
