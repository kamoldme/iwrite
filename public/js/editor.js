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
  targetWords: 0,             // target word count (0 = no target)
  sessionTopic: '',           // essay question / topic
  _lastMotivateAt: 0,         // last word count when motivate was shown
  _currentFont: 'sans',       // current font family
  _audioPlaying: false,       // whether audio is playing
  _ytPlayer: null,            // YouTube iframe

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
      localStorage.setItem('editor_session', JSON.stringify({
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
      localStorage.removeItem('editor_session');
    } catch {}
  },

  _getSessionState() {
    try {
      const data = localStorage.getItem('editor_session');
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  },

  async start(duration, mode, opts = {}) {
    this.duration = duration;
    this.mode = mode;
    this.abandoned = false;
    this.lastWordMilestone = 0;
    this._lastMotivateAt = 0;
    this.isEditing = false;
    this.isDirty = false;
    this.targetWords = opts.targetWords || 0;
    this.sessionTopic = opts.topic || '';
    // Custom danger threshold (Pro feature)
    if (opts.dangerThreshold) this.dangerThreshold = opts.dangerThreshold;
    if (typeof CommentSystem !== 'undefined') CommentSystem.destroy();

    try {
      const doc = await API.createDocument(this.titleInput.value || 'Untitled', '', mode);
      this.documentId = doc.id;
    } catch {
      App.toast('Failed to create document', 'error');
      return;
    }

    // Enter fullscreen for both normal and dangerous modes
    this._fullscreenActive = false;
    try {
      const el = document.documentElement;
      const req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
      if (req) {
        await req.call(el).then(() => { this._fullscreenActive = true; }).catch(() => {});
      }
    } catch(e) {}

    if (mode === 'dangerous') {
      await this.runCountdown();
    }

    this.startTime = Date.now();
    this.lastKeystroke = Date.now();

    this.container.classList.add('active');
    document.body.classList.add('editor-active');
    this.textarea.innerHTML = '';
    this.textarea.contentEditable = 'true';
    this.textarea.focus();
    this.active = true;

    // Show correct buttons for active session
    // In dangerous mode or duel mode, hide the Complete button — session ends only when time runs out
    const isDuel = !!sessionStorage.getItem('activeDuel');
    const saveBtn = document.getElementById('editor-save-btn');
    saveBtn.style.display = (mode === 'dangerous' || isDuel) ? 'none' : 'inline-flex';
    // Gray out Complete button if early complete limit reached (skip during maintenance)
    const currentMonth = new Date().toISOString().slice(0, 7);
    const maintenanceActive = App._maintActive;
    const earlyUsed = (App.user.earlyCompletesMonth === currentMonth) ? (App.user.earlyCompletes || 0) : 0;
    const earlyLimit = App.user.plan === 'premium' ? 15 : 3;
    if (earlyUsed >= earlyLimit && !maintenanceActive) {
      saveBtn.classList.add('btn-disabled');
      saveBtn.style.opacity = '0.4';
    } else {
      saveBtn.classList.remove('btn-disabled');
      saveBtn.style.opacity = '';
    }
    // Gray out Copy button if copy limit reached (skip during maintenance)
    const copyBtn = document.getElementById('editor-copy-btn');
    const now = new Date();
    const copyMonth = `${now.getFullYear()}-${now.getMonth()}`;
    const copyUsed = (App.user.copyCountResetAt === copyMonth) ? (App.user.copyCount || 0) : 0;
    const copyLimit = App.user.plan === 'premium' ? 15 : 3;
    if (copyUsed >= copyLimit && !maintenanceActive) {
      copyBtn.classList.add('btn-disabled');
      copyBtn.style.opacity = '0.4';
      copyBtn.style.cursor = 'not-allowed';
    } else {
      copyBtn.classList.remove('btn-disabled');
      copyBtn.style.opacity = '';
      copyBtn.style.cursor = '';
    }
    document.getElementById('editor-edit-btn').style.display = 'none';
    document.getElementById('editor-save-edit-btn').style.display = 'none';
    document.getElementById('editor-comment-history-btn').style.display = 'none';
    // Only show formatting bar in normal mode
    document.getElementById('formatting-toolbar').style.display = mode === 'dangerous' ? 'none' : 'flex';
    document.getElementById('status-bar').style.display = 'flex';
    this.titleInput.readOnly = false;

    this.modeBadge.textContent = mode === 'dangerous' ? 'Dangerous' : 'Normal';
    this.modeBadge.className = `editor-mode-badge ${mode}`;
    // Show session controls (swap add-time buttons for duel mode)
    document.getElementById('editor-timer').style.display = '';
    document.getElementById('editor-timer-toggle').style.display = '';
    document.querySelector('.editor-add-time').style.display = isDuel ? 'none' : '';
    document.getElementById('duel-add-time-btn').style.display = isDuel ? '' : 'none';
    this._timerHidden = false;
    this._timerMasked = false;
    document.getElementById('timer-eye-open').style.display = '';
    document.getElementById('timer-eye-closed').style.display = 'none';

    if (mode === 'dangerous') {
      this.container.classList.add('dangerous-active');
      this.dangerProgress.style.display = 'none';
      this.startDangerMode();
    }

    this.timerInterval = setInterval(() => this.updateTimer(), 100);
    this.autoSaveInterval = setInterval(() => this.autoSave(), 10000);

    this.textarea.addEventListener('input', this.onInput);
    this.textarea.addEventListener('keydown', this.onKeydown);
    this.textarea.addEventListener('paste', this.onPaste);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    window.addEventListener('blur', this.onWindowBlur);
    window.addEventListener('focus', this.onWindowFocus);
    this._startFocusCheck();
    if (mode !== 'dangerous') this.bindFormatting();
    this.updateWordCount();

    // Block all copying during active session
    this._blockCopy();

    // Save session state periodically so it survives page refresh
    this.sessionSaveInterval = setInterval(() => this._saveSessionState(), 5000);
    this._saveSessionState();

    // Show topic bar if set
    const topicBar = document.getElementById('editor-topic-bar');
    const topicText = document.getElementById('editor-topic-text');
    topicText.value = this.sessionTopic || '';
    topicBar.style.display = 'block';

    // Show target word count in status bar
    this._updateWordsRemaining();

    // Duel mode: start polling opponent word count, sync timer from server
    this._duelInfo = null;
    this._duelEndAt = null;
    try {
      const duelData = sessionStorage.getItem('activeDuel');
      if (duelData) {
        this._duelInfo = JSON.parse(duelData);
        this._duelEndAt = this._duelInfo.endAt ? new Date(this._duelInfo.endAt).getTime() : null;
        this._startDuelPolling();
      }
    } catch {}

    // Fullscreen already requested before countdown; just init blur cooldown
    this._blurCooldown = false;
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

    // Font size +/- in format bar
    const sizeDown = document.getElementById('fmt-size-down');
    const sizeUp = document.getElementById('fmt-size-up');
    if (sizeDown) sizeDown.onmousedown = (e) => { e.preventDefault(); this._changeFontSize(-1, 'fmt-size-label'); };
    if (sizeUp) sizeUp.onmousedown = (e) => { e.preventDefault(); this._changeFontSize(1, 'fmt-size-label'); };

    document.addEventListener('selectionchange', this._onSelectionChange);
  },

  _changeFontSize(dir, labelId) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    let current = 3;
    let node = sel.anchorNode;
    while (node && node !== this.textarea) {
      if (node.nodeType === 1 && node.tagName === 'FONT' && node.size) {
        current = parseInt(node.size);
        break;
      }
      node = node.parentNode;
    }
    const newSize = Math.max(1, Math.min(7, current + dir));
    document.execCommand('fontSize', false, newSize);
    // Update both labels
    const fmtLabel = document.getElementById('fmt-size-label');
    const selLabel = document.getElementById('sel-size-label');
    if (fmtLabel) fmtLabel.textContent = newSize;
    if (selLabel) selLabel.textContent = newSize;
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

  onPaste: (e) => {
    // Block paste if it would exceed word limit
    if ((Editor.active || Editor.isEditing) && App.user) {
      const limit = Editor.getWordLimit();
      const currentWords = Editor.getWordCount();
      if (currentWords >= limit) {
        e.preventDefault();
        return;
      }
      const pasteText = (e.clipboardData || window.clipboardData).getData('text');
      const pasteWords = pasteText.trim().split(/\s+/).filter(Boolean).length;
      if (currentWords + pasteWords > limit) {
        e.preventDefault();
        const remaining = limit - currentWords;
        const trimmed = pasteText.trim().split(/\s+/).slice(0, remaining).join(' ');
        document.execCommand('insertText', false, trimmed);
        Editor.updateWordCount();
      }
    }
  },

  onInput: () => {
    Editor.lastKeystroke = Date.now();

    // Auto-replace shortcuts (-- → em dash, * → bullet)
    Editor._handleAutoReplace();

    // Hard enforce word limit (catches dictation, drag-drop, extensions, IME)
    if ((Editor.active || Editor.isEditing) && App.user) {
      const limit = Editor.getWordLimit();
      const words = Editor.getWordCount();
      if (words > limit) {
        const sel = window.getSelection();
        const text = Editor.textarea.innerText || '';
        const wordArr = text.trim().split(/\s+/);
        const trimmed = wordArr.slice(0, limit).join(' ');
        Editor.textarea.innerText = trimmed;
        // Move cursor to end
        const range = document.createRange();
        range.selectNodeContents(Editor.textarea);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }

    Editor.updateWordCount();
    Editor._updateWordsRemaining();
    Editor._checkMotivation();
    Editor.textarea.style.color = '';
    Editor.textarea.style.opacity = '1';
    Editor.textarea.classList.remove('fading');
    Editor.vignette.classList.remove('active');
    Editor.vignette.style.opacity = 0;
  },

  onKeydown: (e) => {
    // Block new words at word limit (allow delete, backspace, arrows, shortcuts)
    if ((Editor.active || Editor.isEditing) && App.user) {
      const limit = Editor.getWordLimit();
      const words = Editor.getWordCount();
      if (words >= limit) {
        const allowed = ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
          'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'Tab', 'Shift', 'Control', 'Alt', 'Meta',
          'CapsLock', 'F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12'];
        if (!allowed.includes(e.key) && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          return;
        }
      }
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      document.execCommand('insertText', false, '  ');
      return;
    }
    // Keyboard shortcuts for formatting
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
      switch (e.key.toLowerCase()) {
        case 'b':
          e.preventDefault();
          document.execCommand('bold', false, null);
          Editor.updateFormatButtons();
          break;
        case 'i':
          e.preventDefault();
          document.execCommand('italic', false, null);
          Editor.updateFormatButtons();
          break;
        case 'u':
          e.preventDefault();
          document.execCommand('underline', false, null);
          Editor.updateFormatButtons();
          break;
      }
    }
  },

  _handleAutoReplace() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return;

    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return;
    const text = node.textContent;
    const offset = range.startOffset;

    // "-- " → "— " (em dash)
    if (offset >= 3 && text.slice(offset - 3, offset) === '-- ') {
      node.textContent = text.slice(0, offset - 3) + '\u2014 ' + text.slice(offset);
      const newRange = document.createRange();
      newRange.setStart(node, offset - 3 + 2); // after "— "
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);
      return;
    }

    // "* " at start of line → bullet list item
    if (offset >= 2 && text.slice(offset - 2, offset) === '* ') {
      // Only trigger at the start of a line (nothing before, or newline before)
      const before = text.slice(0, offset - 2);
      if (before === '' || before.endsWith('\n')) {
        // Remove the "* " text
        node.textContent = text.slice(0, offset - 2) + text.slice(offset);
        // Place cursor
        const newRange = document.createRange();
        newRange.setStart(node, offset - 2);
        newRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(newRange);
        // Insert an unordered list
        document.execCommand('insertUnorderedList', false, null);
        return;
      }
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

  // Fired when the browser window loses focus (any focus loss counts)
  onWindowBlur: () => {
    if (!Editor.active || Editor.abandoned) return;
    Editor.onTabLeave();
  },

  // Fired when the browser window regains focus
  onWindowFocus: () => {
    if (!Editor.active || Editor.abandoned) return;
    Editor.onTabReturn();
  },

  // Periodic focus check — catches iframe focus stealing that bypasses blur/visibilitychange
  _focusCheckInterval: null,
  _startFocusCheck() {
    clearInterval(this._focusCheckInterval);
    this._focusCheckInterval = setInterval(() => {
      if (!Editor.active || Editor.abandoned) return;
      // If the tab is hidden OR the window doesn't have focus, trigger leave
      if (document.hidden || !document.hasFocus()) {
        if (!Editor.tabCountdown) Editor.onTabLeave();
      } else {
        // Tab is visible and focused — clear any countdown
        if (Editor.tabCountdown) Editor.onTabReturn();
      }
    }, 500);
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

  _tabReturnMessages: [
    "\u{1F62D} Please don't do that again... I almost died",
    "\u{1F631} I was this close to erasing everything!",
    "\u{1F62B} You nearly killed your words. They're still shaking.",
    "\u{1F494} My heart can't take this. Don't leave me again.",
    "\u{1F300} Your writing almost vanished into the void.",
    "\u{1F9F5} I held on by a thread. Please stay.",
    "\u{1F62E}\u200D\u{1F4A8} That was way too close. Your words need you here.",
    "\u{1F630} Don't leave me please... I'm scared of the dark.",
    "\u{1F622} I thought you abandoned me forever.",
    "\u{1F47B} Your words were about to become ghosts.",
  ],

  onTabReturn() {
    if (this.tabCountdown && this.tabLeftTime) {
      const awaySeconds = Math.floor((Date.now() - this.tabLeftTime) / 1000);
      const remaining = this.tabGracePeriod - awaySeconds;
      if (remaining > 0 && remaining <= this.tabGracePeriod) {
        const msg = this._tabReturnMessages[Math.floor(Math.random() * this._tabReturnMessages.length)];
        const color = remaining > 7 ? cssVar('--success') : remaining >= 4 ? '#facc15' : '#f87171';
        App.toast(`<span style="font-weight:800;color:${color}">${remaining}s</span> left before deletion. ${msg}`, remaining <= 3 ? 'error' : 'warning');
      }
    }
    if (this.tabCountdown) {
      clearInterval(this.tabCountdown);
      this.tabCountdown = null;
    }
    this.tabWarning.classList.remove('active');
    this.tabLeftTime = null;
    // Immediately update session timer so it shows correct remaining time
    if (!this.abandoned && this.active) {
      this.updateTimer();
    }
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

    // Forfeit active duel — but check if opponent already forfeited first
    if (this._duelInfo) {
      try {
        const duelStatus = await API.getDuelStatus(this._duelInfo.duelId);
        const oppId = this._duelInfo.isChallenger ? duelStatus.opponentId : duelStatus.challengerId;

        if (duelStatus.status === 'completed') {
          // Duel already ended — show results
          this._stopDuelPolling();
          this.tabWarning.classList.remove('active');
          document.getElementById('status-bar').style.display = 'none';
          this.container.classList.remove('active'); document.body.classList.remove('editor-active');
          App._showDuelResults(duelStatus);
          return;
        }

        if (duelStatus.forfeitedBy === oppId) {
          // Opponent already forfeited — we win even if we leave now
          // Forfeit call will be a no-op (server ignores if forfeitedBy already set)
          // Complete the duel via one more status poll (server cleanup will handle it)
          await API.forfeitDuel(this._duelInfo.duelId);
          this._stopDuelPolling();
          this.tabWarning.classList.remove('active');
          document.getElementById('status-bar').style.display = 'none';
          this.container.classList.remove('active'); document.body.classList.remove('editor-active');
          // Show win result
          const finalDuel = await API.getDuelStatus(this._duelInfo.duelId);
          App._showDuelResults(finalDuel.status === 'completed' ? finalDuel : { ...finalDuel, status: 'completed', winnerId: this._duelInfo.isChallenger ? finalDuel.challengerId : finalDuel.opponentId });
          return;
        }

        // Duel still active, no one forfeited yet — we're the first to leave
        await API.forfeitDuel(this._duelInfo.duelId);
      } catch {}
      this._stopDuelPolling();
    }

    this.tabWarning.classList.remove('active');
    document.getElementById('status-bar').style.display = 'none';
    this.container.classList.remove('active'); document.body.classList.remove('editor-active');
    App.showSessionFailed('You left the tab. Your writing is gone.');
  },

  startDangerMode() {
    this.dangerInterval = setInterval(() => {
      if (!this.active) return;
      const elapsed = Date.now() - this.lastKeystroke;
      const total = this.dangerThreshold;
      const remaining = total - elapsed;

      // 3-phase red vignette based on time remaining:
      // Phase 1: nothing (remaining > 5000ms, or first chunk of short timers)
      // Phase 2: gentle glow (remaining 3000-5000ms)
      // Phase 3: intense red (remaining < 3000ms, last ~3 seconds)
      let opacity = 0;
      if (total <= 5000) {
        // Short timer (5s or less): start red immediately after 30% passes
        const ratio = Math.min(elapsed / total, 1);
        if (ratio > 0.3) opacity = (ratio - 0.3) / 0.7;
      } else {
        // Longer timer: phase based on remaining time
        const safeZone = Math.max(total - 5000, total * 0.4); // nothing happens in safe zone
        if (elapsed <= safeZone) {
          opacity = 0;
        } else if (remaining > 3000) {
          // Gentle phase: 5s to 3s remaining
          opacity = 0.15 + ((elapsed - safeZone) / (total - safeZone - 3000)) * 0.2;
        } else {
          // Intense phase: last 3 seconds
          opacity = 0.35 + ((3000 - remaining) / 3000) * 0.65;
        }
      }

      if (opacity > 0.01) {
        this.vignette.classList.add('active');
        this.vignette.style.opacity = Math.min(opacity, 1);
      } else {
        this.vignette.classList.remove('active');
        this.vignette.style.opacity = 0;
      }

      if (elapsed >= total) {
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
    this.container.classList.remove('active'); document.body.classList.remove('editor-active');
    App.showSessionFailed('You stopped typing. Your writing is gone.');
  },

  _timerHidden: false,

  toggleTimerVisibility() {
    this._timerHidden = !this._timerHidden;
    document.getElementById('timer-eye-open').style.display = this._timerHidden ? 'none' : '';
    document.getElementById('timer-eye-closed').style.display = this._timerHidden ? '' : 'none';
    // Don't hide if last 3 minutes
    this._applyTimerVisibility();
  },

  _applyTimerVisibility() {
    if (!this._timerHidden) {
      this._timerMasked = false;
      return;
    }
    // Auto-show in last 3 minutes
    if (this.duration > 0) {
      const totalSeconds = this.duration * 60;
      const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
      const remaining = totalSeconds - elapsed;
      if (remaining <= 180) {
        this._timerMasked = false;
        return;
      }
    }
    this._timerMasked = true;
  },

  addTime(minutes) {
    this.duration += minutes;
    // Show a brief toast
    App.showToast(`+${minutes} min added`, 'info');
  },

  _timerMasked: false,

  updateTimer() {
    if (this.duration === 0) {
      const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
      const min = Math.floor(elapsed / 60);
      const sec = elapsed % 60;
      this.timerEl.textContent = this._timerMasked ? '**:**' : `${min}:${String(sec).padStart(2, '0')}`;
      this.timerEl.className = 'editor-timer';
      this._applyTimerVisibility();
      return;
    }

    // In duel mode, use server-synced endAt for timer (both sides see same clock)
    let remaining;
    if (this._duelEndAt) {
      remaining = Math.max(0, Math.ceil((this._duelEndAt - Date.now()) / 1000));
    } else {
      const totalSeconds = this.duration * 60;
      const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
      remaining = Math.max(0, totalSeconds - elapsed);
    }
    const min = Math.floor(remaining / 60);
    const sec = remaining % 60;

    // Auto-show timer when entering last 3 minutes
    this._applyTimerVisibility();

    this.timerEl.textContent = this._timerMasked ? '**:**' : `${min}:${String(sec).padStart(2, '0')}`;

    if (remaining <= 60) {
      this.timerEl.className = 'editor-timer danger';
    } else if (remaining <= 180) {
      this.timerEl.className = 'editor-timer warning';
    } else {
      this.timerEl.className = 'editor-timer';
    }

    if (remaining <= 0) {
      this.completeSession(true);
    }
  },

  FREE_WORD_LIMIT: 1500,
  PRO_WORD_LIMIT: 10000,
  FREE_EDIT_LIMIT: 3000,
  PRO_EDIT_LIMIT: 20000,

  getWordLimit() {
    const isPro = App.user && App.user.plan === 'premium';
    if (this.isEditing) return isPro ? this.PRO_EDIT_LIMIT : this.FREE_EDIT_LIMIT;
    return isPro ? this.PRO_WORD_LIMIT : this.FREE_WORD_LIMIT;
  },

  updateWordCount() {
    const words = this.getWordCount();
    const el = document.getElementById('editor-word-count');
    if (el) el.textContent = `${words} word${words !== 1 ? 's' : ''}`;

    // Word limit for all users
    if ((this.active || this.isEditing) && App.user) {
      const limit = this.getWordLimit();
      const isPro = App.user.plan === 'premium';
      const limitIndicator = document.getElementById('word-limit-indicator');
      if (words >= limit) {
        if (limitIndicator) {
          if (isPro) {
            limitIndicator.textContent = `bro, chill. take a rest for a while (${words.toLocaleString()}/${limit.toLocaleString()})`;
          } else {
            limitIndicator.textContent = `Word limit reached (${words}/${limit}) — upgrade to Pro for a larger limit`;
          }
          limitIndicator.className = 'word-limit-indicator limit-reached';
          limitIndicator.style.display = 'block';
        }
      } else if (words >= limit - 100) {
        if (limitIndicator) {
          limitIndicator.textContent = `${words.toLocaleString()}/${limit.toLocaleString()} words`;
          limitIndicator.className = 'word-limit-indicator limit-warning';
          limitIndicator.style.display = 'block';
        }
      } else {
        if (limitIndicator) limitIndicator.style.display = 'none';
      }
    }

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

  // Ensure forfeit is sent even if user closes tab/browser
  _onBeforeUnload() {
    if (Editor._duelInfo && Editor.active && !Editor.abandoned) {
      const token = API.getToken();
      if (token) {
        navigator.sendBeacon(
          `/api/duels/${Editor._duelInfo.duelId}/beacon-forfeit`,
          new Blob([JSON.stringify({ token })], { type: 'application/json' })
        );
      }
    }
  },

  _startDuelPolling() {
    if (!this._duelInfo) return;
    // Register beforeunload for reliable forfeit on tab close
    window.addEventListener('beforeunload', this._onBeforeUnload);
    // Show duel bar
    const bar = document.getElementById('duel-bar');
    if (bar) {
      bar.classList.add('active');
      // Same layout for both sides: challenger on left, opponent on right
      const challengerName = this._duelInfo.isChallenger ? (App.user?.name || 'You') : this._duelInfo.opponentName;
      const opponentName = this._duelInfo.isChallenger ? this._duelInfo.opponentName : (App.user?.name || 'You');
      document.getElementById('duel-bar-left-name').textContent = challengerName;
      document.getElementById('duel-bar-right-name').textContent = opponentName;
      document.getElementById('duel-bar-forfeit').style.display = 'none';
    }
    // Associate document with duel
    if (this.documentId && this._duelInfo.duelId) {
      try { API.setDuelDoc(this._duelInfo.duelId, this.documentId); } catch {}
    }
    // Reset forfeit notification flag
    this._duelForfeitNotified = false;
    // Poll every 3 seconds with backoff on failure
    this._duelPollDelay = 3000;
    this._duelPollTimer = setTimeout(() => this._pollDuel(), this._duelPollDelay);
    this._pollDuel();
  },

  async _pollDuel() {
    if (!this._duelInfo) return;
    try {
      // Send our current word count
      const myWords = this.getWordCount();
      await API.updateDuelWords(this._duelInfo.duelId, myWords);

      // Get duel status
      const duel = await API.getDuelStatus(this._duelInfo.duelId);

      // Sync timer from server endAt (both sides see same clock)
      if (duel.endAt) {
        this._duelEndAt = new Date(duel.endAt).getTime();
      }

      // Update word counts — same layout for both sides: challenger left, opponent right
      const leftWords = document.getElementById('duel-bar-left-words');
      const rightWords = document.getElementById('duel-bar-right-words');
      if (this._duelInfo.isChallenger) {
        if (leftWords) leftWords.textContent = myWords;
        if (rightWords) rightWords.textContent = duel.opponentWords || 0;
      } else {
        if (leftWords) leftWords.textContent = duel.challengerWords || 0;
        if (rightWords) rightWords.textContent = myWords;
      }

      // Check for incoming extra time request from opponent
      const myId = this._duelInfo.isChallenger ? duel.challengerId : duel.opponentId;
      if (duel.extraTimeRequest && duel.extraTimeRequest.requestedBy !== myId) {
        // Opponent wants extra time — show accept/reject toast
        const reqEl = document.getElementById('duel-extra-time-req');
        if (reqEl && reqEl.style.display === 'none') {
          document.getElementById('duel-extra-time-text').textContent = `+${duel.extraTimeRequest.minutes} min?`;
          reqEl.style.display = 'flex';
        }
      } else {
        // No pending request or it's mine — hide toast
        const reqEl = document.getElementById('duel-extra-time-req');
        if (reqEl) reqEl.style.display = 'none';
      }

      // Detect extra time added (endAt extended since last poll)
      if (this._lastKnownEndAt && duel.endAt && duel.endAt !== this._lastKnownEndAt && new Date(duel.endAt) > new Date(this._lastKnownEndAt)) {
        App.toast('Extra time added! ⏰', 'success');
      }
      this._lastKnownEndAt = duel.endAt;

      // Check if opponent forfeited (forfeitedBy = single user ID string)
      const oppId = this._duelInfo.isChallenger ? duel.opponentId : duel.challengerId;
      if (duel.forfeitedBy && duel.forfeitedBy === oppId) {
        if (!this._duelForfeitNotified) {
          this._duelForfeitNotified = true;
          App.toast(`${this._duelInfo.opponentName} left the duel!`, 'info');
          const forfeitEl = document.getElementById('duel-bar-forfeit');
          if (forfeitEl) forfeitEl.style.display = '';
        }
      }

      // Check if duel completed
      if (duel.status === 'completed') {
        this._stopDuelPolling();
        App._showDuelResults(duel);
        return;
      }
      // Success — reset to normal poll rate
      this._duelPollDelay = 3000;
    } catch {
      // Backoff on failure: double delay, cap at 60s
      this._duelPollDelay = Math.min((this._duelPollDelay || 5000) * 2, 60000);
    }
    // Schedule next poll
    this._duelPollTimer = setTimeout(() => this._pollDuel(), this._duelPollDelay);
  },

  // Request +5 min — if opponent left, adds directly; otherwise sends request
  async addExtraTime() {
    if (!this._duelInfo) return;
    try {
      const result = await API.requestDuelTime(this._duelInfo.duelId, 5);
      // If opponent already left, server adds time directly (no extraTimeRequest in response)
      if (this._duelForfeitNotified || !result.extraTimeRequest) {
        App.toast('+5 min added! ⏰', 'success');
      } else {
        App.toast('Requested +5 min — waiting for opponent', 'info');
      }
    } catch (e) {
      App.toast(e.message || 'Failed to request extra time', 'error');
    }
  },

  async acceptExtraTime() {
    if (!this._duelInfo) return;
    try {
      await API.respondDuelTime(this._duelInfo.duelId, true);
      App.toast('+5 min added! ⏰', 'success');
    } catch (e) {
      App.toast(e.message || 'Failed to accept', 'error');
    }
    this._hideExtraTimeToast();
  },

  async declineExtraTime() {
    if (!this._duelInfo) return;
    try {
      await API.respondDuelTime(this._duelInfo.duelId, false);
      App.toast('Extra time declined', '');
    } catch (e) {
      App.toast(e.message || 'Failed to decline', 'error');
    }
    this._hideExtraTimeToast();
  },

  _hideExtraTimeToast() {
    const el = document.getElementById('duel-extra-time-req');
    if (el) el.style.display = 'none';
  },

  _stopDuelPolling() {
    if (this._duelPollTimer) {
      clearTimeout(this._duelPollTimer);
      this._duelPollTimer = null;
    }
    const bar = document.getElementById('duel-bar');
    if (bar) bar.classList.remove('active');
    this._duelInfo = null;
    sessionStorage.removeItem('activeDuel');
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
        this.dangerProgress.style.display = 'none';
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
      this._startFocusCheck();
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

  _isTimerExpired() {
    if (this.duration === 0) return false; // unlimited sessions can always complete
    const totalSeconds = this.duration * 60;
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    return elapsed >= totalSeconds;
  },

  async completeSession(timerExpired) {
    if (!this.active || this.abandoned) return;

    // Check early complete limit (only when user clicks Complete, not when timer expires)
    // Bypass during maintenance — unlimited saves/copies
    const maintenanceActive = App._maintActive;
    const isEarly = !timerExpired && !this._isTimerExpired();
    if (isEarly && !maintenanceActive) {
      const user = App.user;
      const currentMonth = new Date().toISOString().slice(0, 7); // "2026-03"
      const usedThisMonth = (user.earlyCompletesMonth === currentMonth) ? (user.earlyCompletes || 0) : 0;
      const earlyLim = user.plan === 'premium' ? 15 : 3;
      if (usedThisMonth >= earlyLim) {
        App.toast(`Early complete limit reached (${earlyLim}/month). Wait for the timer to finish.`, 'warning');
        return;
      }
    }

    this.active = false;
    this._earlyComplete = isEarly;
    this.cleanup();

    const wordCount = this.getWordCount();
    const duration = Math.floor((Date.now() - this.startTime) / 1000);

    // If no words were written, silently discard — no XP, no streak, no stats
    if (wordCount === 0) {
      if (this.documentId) {
        try { await API.abandonDocument(this.documentId, 'empty_session'); } catch {}
      }
      document.getElementById('status-bar').style.display = 'none';
      this.container.classList.remove('active'); document.body.classList.remove('editor-active');
      App.toast('Session discarded — no words written', 'info');
      App._docsCacheDirty = true;
      try { await App.loadDocuments(true); } catch {}
      return;
    }

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
      result = await API.completeSession(this.documentId, { wordCount, duration, xpEarned, earlyComplete: !!this._earlyComplete });
    } catch {
      this.container.classList.remove('active'); document.body.classList.remove('editor-active');
      App.loadDashboard();
      return;
    }

    document.getElementById('status-bar').style.display = 'none';
    this.container.classList.remove('active'); document.body.classList.remove('editor-active');

    // If in duel mode, submit final word count. Don't forfeit — timer expired naturally.
    // The server auto-completes the duel when status is polled after endAt.
    if (this._duelInfo) {
      try {
        await API.updateDuelWords(this._duelInfo.duelId, wordCount);
        // Poll one last time to trigger server-side completion
        const finalDuel = await API.getDuelStatus(this._duelInfo.duelId);
        if (finalDuel.status === 'completed') {
          App._showDuelResults(finalDuel);
        }
      } catch {}
      this._stopDuelPolling();
    }

    // Auto-refresh sessions tab so new doc appears immediately
    // Sync user data (includes earlyCompletes count)
    if (result.user) App.user = { ...App.user, ...result.user };

    // Toast early complete usage
    if (this._earlyComplete && result.user) {
      const currentMonth = new Date().toISOString().slice(0, 7);
      const used = (result.user.earlyCompletesMonth === currentMonth) ? (result.user.earlyCompletes || 0) : 0;
      const elim = (result.user.plan === 'premium') ? 15 : 3;
      App.toast(`Early finish used (${used}/${elim} this month)`, 'info');
    }

    App._docsCacheDirty = true;
    try { await App.loadDocuments(true); } catch {}
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
    this.showConfetti();
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
      App.toast('Document saved', 'success');
      this.showConfetti();
      // Mark docs cache dirty so next tab switch refetches
      App._docsCacheDirty = true;
      if (App.currentView === 'documents') App.loadDocuments(true);
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

  // --- Words remaining / target ---
  _updateWordsRemaining() {
    const el = document.getElementById('editor-words-remaining');
    if (!el) return;
    if (!this.targetWords) { el.style.display = 'none'; return; }
    const words = this.getWordCount();
    const remaining = Math.max(0, this.targetWords - words);
    if (remaining > 0) {
      el.textContent = `${remaining} words to go`;
      el.style.color = '';
    } else {
      el.textContent = 'Target reached!';
      el.style.color = 'var(--success)';
    }
    el.style.display = '';
  },

  // --- Motivating notifications ---
  _motivateMessages: [
    "You're on fire! Keep going!",
    "Great flow! Don't stop now!",
    "Words are coming alive!",
    "You're crushing it!",
    "Incredible progress!",
    "The words are flowing!",
    "Keep that momentum!",
    "Amazing writing streak!",
    "You've got this!",
    "Pure writing magic!",
  ],

  _checkMotivation() {
    if (!this.targetWords || !this.active) return;
    const words = this.getWordCount();
    const pct = words / this.targetWords;
    const milestones = [0.25, 0.5, 0.75, 1.0];
    for (const m of milestones) {
      const threshold = Math.floor(this.targetWords * m);
      if (words >= threshold && this._lastMotivateAt < threshold) {
        this._lastMotivateAt = threshold;
        const label = m === 1 ? 'Target reached!' : `${Math.round(m * 100)}% done!`;
        const msg = this._motivateMessages[Math.floor(Math.random() * this._motivateMessages.length)];
        this._showMotivateToast(`${label} ${msg}`);
        break;
      }
    }
  },

  _showMotivateToast(text) {
    const el = document.createElement('div');
    el.className = 'motivate-toast';
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => { el.classList.add('out'); }, 2500);
    setTimeout(() => el.remove(), 3000);
  },

  // --- Selection popup ---
  _selPopupTimer: null,
  initSelectionPopup() {
    const popup = document.getElementById('selection-popup');
    if (!popup) return;

    // Handle selection popup buttons
    popup.querySelectorAll('.sel-btn').forEach(btn => {
      btn.onmousedown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const cmd = btn.dataset.cmd;
        if (cmd === 'formatBlock') {
          // Toggle blockquote: if already inside one, remove it
          const sel = window.getSelection();
          if (sel && sel.rangeCount) {
            let node = sel.anchorNode;
            while (node && node !== Editor.textarea) {
              if (node.nodeName === 'BLOCKQUOTE') {
                document.execCommand('formatBlock', false, 'DIV');
                Editor.updateFormatButtons();
                return;
              }
              node = node.parentNode;
            }
          }
          document.execCommand('formatBlock', false, btn.dataset.value);
        } else if (cmd === 'fontSize') {
          Editor._changeFontSize(parseInt(btn.dataset.value), 'sel-size-label');
        } else {
          document.execCommand(cmd, false, null);
        }
        Editor.updateFormatButtons();
      };
    });

    const showPopup = () => {
      if (!Editor.active && !Editor.isEditing) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        popup.style.display = 'none';
        return;
      }
      const text = sel.toString().trim();
      if (!text) { popup.style.display = 'none'; return; }
      const range = sel.getRangeAt(0);
      if (!Editor.textarea.contains(range.commonAncestorContainer)) {
        popup.style.display = 'none';
        return;
      }
      const rect = range.getBoundingClientRect();
      popup.style.display = 'flex';
      popup.style.left = Math.max(8, rect.left + rect.width / 2 - popup.offsetWidth / 2) + 'px';
      popup.style.top = (rect.top - popup.offsetHeight - 8) + 'px';
    };

    // Show popup on mouseup (after selection is final) instead of selectionchange
    document.addEventListener('mouseup', () => {
      clearTimeout(Editor._selPopupTimer);
      Editor._selPopupTimer = setTimeout(showPopup, 50);
    });

    // Also show on keyboard selection (shift+arrow)
    document.addEventListener('keyup', (e) => {
      if (e.shiftKey) {
        clearTimeout(Editor._selPopupTimer);
        Editor._selPopupTimer = setTimeout(showPopup, 50);
      }
    });

    // Hide when clicking outside the popup and editor
    document.addEventListener('mousedown', (e) => {
      if (!popup.contains(e.target) && e.target !== Editor.textarea && !Editor.textarea.contains(e.target)) {
        popup.style.display = 'none';
      }
    });
  },

  // --- Font switcher ---
  _fontClasses: ['font-serif', 'font-mono', 'font-georgia', 'font-garamond', 'font-courier'],
  setFont(font) {
    this._currentFont = font;
    this._fontClasses.forEach(c => this.textarea.classList.remove(c));
    if (font !== 'sans') this.textarea.classList.add('font-' + font);
    const sel = document.getElementById('fmt-font-select');
    if (sel) sel.value = font;
    localStorage.setItem('iwrite_editor_font', font);
  },

  // --- Theme toggle (in editor) ---
  toggleEditorTheme() {
    App._cycleTheme();
  },

  // --- Fullscreen toggle ---
  toggleFullscreen() {
    const inFS = !!(document.fullscreenElement || document.webkitFullscreenElement);
    if (inFS) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) exit.call(document).catch(() => {});
      this._fullscreenActive = false;
    } else {
      const el = document.documentElement;
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) req.call(el).then(() => { this._fullscreenActive = true; }).catch(() => {});
    }
  },

  // --- Audio system ---
  // Built-in tracks use direct MP3 files (instant playback, no iframe)
  _audioSources: {
    lofi1: 'https://archive.org/download/chill-lofi-music-relax-study/Leavv%20-%20Cloud%20Shapes.mp3',
    lofi2: 'https://archive.org/download/chill-lofi-music-relax-study/Tom%20Doolie%20-%20Land%20of%20Calm.mp3',
    brown: 'https://archive.org/download/brownnoise_202103/Smoothed%20Brown%20Noise.mp3',
    hz40: 'https://archive.org/download/heightened-awareness-pure-gamma-waves-40-hz-mp-3-160-k/Heightened%20Awareness%20Pure%20Gamma%20Waves%20-%2040%20Hz%28MP3_160K%29.mp3',
    rain: 'https://archive.org/download/relaxingsounds/Rain%207%20%28Lightest%29%208h%20DripsOnTrees-no%20thunder.mp3',
    wind: 'https://archive.org/download/relaxingsounds/Wind%201%208h%20%28or%20Rapids%29%20Gentle%2CLowPitch%2CBrownNoise.mp3',
  },
  _audioElement: null,
  _activeAudioKey: null,
  _ytPlayer: null,
  _ytPaused: false,
  _ytAPIReady: false,
  _ytSeekInterval: null,

  playAudio(key) {
    // If same track, toggle pause/resume
    if (this._activeAudioKey === key && this._audioElement) {
      if (this._audioElement.paused) {
        this._audioElement.play().catch(() => {});
        this._audioPlaying = true;
      } else {
        this._audioElement.pause();
        this._audioPlaying = false;
      }
      this._updateTrackUI();
      return;
    }
    this.stopAudio();
    const src = this._audioSources[key];
    if (!src) return;
    const track = document.querySelector(`.audio-track[data-audio="${key}"]`);
    const vol = track ? track.querySelector('.audio-track-vol').value : 50;
    this._audioElement = new Audio(src);
    this._audioElement.loop = true;
    this._audioElement.volume = vol / 100;
    this._audioElement.crossOrigin = 'anonymous';
    this._audioElement.play().catch(() => {});
    this._audioPlaying = true;
    this._activeAudioKey = key;
    this._updateTrackUI();
  },

  // --- YouTube (custom links only) ---
  _loadYTAPI() {
    if (this._ytAPIReady || document.getElementById('yt-api-script')) return;
    const tag = document.createElement('script');
    tag.id = 'yt-api-script';
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
    window.onYouTubeIframeAPIReady = () => { Editor._ytAPIReady = true; };
  },

  playYouTube(url) {
    this.stopAudio();
    let videoId = '';
    try {
      const u = new URL(url);
      if (u.hostname.includes('youtu.be')) videoId = u.pathname.slice(1);
      else videoId = u.searchParams.get('v') || '';
    } catch { return; }
    if (!videoId) return;
    this._loadYTAPI();
    const vol = parseInt(document.getElementById('audio-yt-vol')?.value || 50);
    const tryCreate = () => {
      if (!this._ytAPIReady || typeof YT === 'undefined' || !YT.Player) {
        setTimeout(tryCreate, 100);
        return;
      }
      const container = document.getElementById('yt-player-container');
      container.innerHTML = '<div id="yt-player-div"></div>';
      this._ytPlayer = new YT.Player('yt-player-div', {
        height: '1', width: '1', videoId,
        playerVars: { autoplay: 1, loop: 1, playlist: videoId },
        events: {
          onReady: (e) => {
            e.target.setVolume(vol);
            this._startSeekSync();
          }
        }
      });
      this._audioPlaying = true;
      this._ytPaused = false;
      this._activeAudioKey = 'youtube';
      const ctrl = document.getElementById('audio-yt-controls');
      if (ctrl) ctrl.style.display = 'flex';
      this._updateTrackUI();
      this._updateYTPauseIcon();
    };
    tryCreate();
  },

  _startSeekSync() {
    clearInterval(this._ytSeekInterval);
    this._ytSeekInterval = setInterval(() => {
      if (!this._ytPlayer || !this._ytPlayer.getDuration) return;
      const dur = this._ytPlayer.getDuration();
      const cur = this._ytPlayer.getCurrentTime();
      if (dur > 0) {
        const seek = document.getElementById('audio-yt-seek');
        if (seek && !seek._dragging) seek.value = (cur / dur) * 100;
      }
    }, 500);
  },

  _toggleYTPause() {
    if (!this._ytPlayer) return;
    if (this._ytPaused) {
      if (this._ytPlayer.playVideo) this._ytPlayer.playVideo();
      this._audioPlaying = true;
      this._ytPaused = false;
    } else {
      if (this._ytPlayer.pauseVideo) this._ytPlayer.pauseVideo();
      this._audioPlaying = false;
      this._ytPaused = true;
    }
    this._updateTrackUI();
    this._updateYTPauseIcon();
  },

  _updateYTPauseIcon() {
    const pauseBtn = document.getElementById('audio-yt-pause');
    if (!pauseBtn) return;
    if (this._ytPaused) {
      pauseBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>';
      pauseBtn.title = 'Resume';
    } else {
      pauseBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
      pauseBtn.title = 'Pause';
    }
  },

  stopAudio() {
    // Stop MP3 audio
    if (this._audioElement) {
      this._audioElement.pause();
      this._audioElement.src = '';
      this._audioElement = null;
    }
    // Stop YouTube
    clearInterval(this._ytSeekInterval);
    if (this._ytPlayer) {
      if (this._ytPlayer.destroy) this._ytPlayer.destroy();
      this._ytPlayer = null;
    }
    const container = document.getElementById('yt-player-container');
    if (container) container.innerHTML = '';
    this._audioPlaying = false;
    this._ytPaused = false;
    this._activeAudioKey = null;
    const ctrl = document.getElementById('audio-yt-controls');
    if (ctrl) ctrl.style.display = 'none';
    this._updateTrackUI();
  },

  _updateTrackUI() {
    document.querySelectorAll('.audio-track').forEach(track => {
      const key = track.dataset.audio;
      const btn = track.querySelector('.audio-play-btn');
      if (key === this._activeAudioKey && this._audioPlaying) {
        track.classList.add('active');
        btn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
      } else if (key === this._activeAudioKey && !this._audioPlaying) {
        track.classList.add('active');
        btn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>';
      } else {
        track.classList.remove('active');
        btn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>';
      }
    });
  },

  initAudio() {
    this._loadYTAPI();
    document.querySelectorAll('.audio-track').forEach(track => {
      const key = track.dataset.audio;
      const playBtn = track.querySelector('.audio-play-btn');
      const volSlider = track.querySelector('.audio-track-vol');
      playBtn.addEventListener('click', () => Editor.playAudio(key));
      volSlider.addEventListener('input', () => {
        if (Editor._activeAudioKey === key && Editor._audioElement) {
          Editor._audioElement.volume = volSlider.value / 100;
        }
      });
    });
    const ytPlayBtn = document.getElementById('audio-yt-play');
    if (ytPlayBtn) ytPlayBtn.addEventListener('click', () => {
      const isPro = App.user && App.user.plan === 'premium';
      if (!isPro) {
        App.toast('YouTube music is a Pro feature.', 'info');
        App.openPricing();
        return;
      }
      const url = document.getElementById('audio-yt-input').value.trim();
      if (url) Editor.playYouTube(url);
    });
    const ytPauseBtn = document.getElementById('audio-yt-pause');
    if (ytPauseBtn) ytPauseBtn.addEventListener('click', () => Editor._toggleYTPause());
    const ytVol = document.getElementById('audio-yt-vol');
    if (ytVol) ytVol.addEventListener('input', () => {
      if (Editor._ytPlayer && Editor._ytPlayer.setVolume) {
        Editor._ytPlayer.setVolume(Math.round(ytVol.value));
      }
    });
    const ytSeek = document.getElementById('audio-yt-seek');
    if (ytSeek) {
      ytSeek.addEventListener('mousedown', () => { ytSeek._dragging = true; });
      ytSeek.addEventListener('mouseup', () => { ytSeek._dragging = false; });
      ytSeek.addEventListener('input', () => {
        if (Editor._ytPlayer && Editor._ytPlayer.getDuration) {
          const dur = Editor._ytPlayer.getDuration();
          Editor._ytPlayer.seekTo(dur * (ytSeek.value / 100), true);
        }
      });
    }
  },

  cleanup() {
    this.active = false;
    clearInterval(this.timerInterval);
    clearInterval(this.autoSaveInterval);
    clearInterval(this.dangerInterval);
    clearInterval(this.tabCountdown);
    clearInterval(this.sessionSaveInterval);
    if (this._duelPollInterval) clearInterval(this._duelPollInterval);
    this._clearSessionState();
    this.container.classList.remove('dangerous-active');
    this.dangerProgress.style.display = 'none';
    this.vignette.classList.remove('active');
    this.vignette.style.opacity = 0;
    this.textarea.classList.remove('fading');
    this.textarea.style.color = '';
    this.textarea.style.opacity = '1';
    this.textarea.removeEventListener('input', this.onInput);
    this.textarea.removeEventListener('keydown', this.onKeydown);
    this.textarea.removeEventListener('paste', this.onPaste);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    window.removeEventListener('blur', this.onWindowBlur);
    window.removeEventListener('focus', this.onWindowFocus);
    window.removeEventListener('beforeunload', this._onBeforeUnload);
    clearInterval(this._focusCheckInterval);
    document.removeEventListener('selectionchange', this._onSelectionChange);
    document.getElementById('formatting-toolbar').style.display = 'none';
    document.getElementById('editor-topic-bar').style.display = 'none';
    document.getElementById('selection-popup').style.display = 'none';
    const limitEl = document.getElementById('word-limit-indicator');
    if (limitEl) limitEl.style.display = 'none';
    this.stopAudio();
    // Unblock copying when session ends
    this._unblockCopy();
    // Reset copy button state (un-gray)
    const copyBtn = document.getElementById('editor-copy-btn');
    if (copyBtn) {
      copyBtn.classList.remove('btn-disabled');
      copyBtn.style.opacity = '';
      copyBtn.style.cursor = '';
    }
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
      // Check if early complete is available
      const user = App.user;
      const currentMonth = new Date().toISOString().slice(0, 7);
      const usedThisMonth = (user.earlyCompletesMonth === currentMonth) ? (user.earlyCompletes || 0) : 0;
      const earlyMax = user.plan === 'premium' ? 15 : 3;
      const canEarlyComplete = usedThisMonth < earlyMax;

      if (canEarlyComplete) {
        const ok = await App.showConfirm('Are you sure? Leaving will save your current progress but end the session early.');
        if (ok) this.completeSession();
      } else {
        const ok = await App.showConfirm('Your early complete limit is reached. Leaving now will DELETE your writing and it won\'t be saved. Are you sure?');
        if (ok) {
          // Abandon without saving
          this.active = false;
          this.cleanup();
          if (this.documentId) {
            try { await API.abandonDocument(this.documentId, 'user_left_no_saves'); } catch {}
          }
          document.getElementById('status-bar').style.display = 'none';
          document.getElementById('word-limit-indicator').style.display = 'none';
          this.container.classList.remove('active');
          document.body.classList.remove('editor-active');
          App.switchView('documents');
          App.toast('Session abandoned — writing was not saved', 'warning');
        }
      }
      return;
    }

    // Editing a completed document with unsaved changes
    if (this.isEditing && this.isDirty) {
      const ok = await App.showConfirm('Are you sure? New edits will not be saved.');
      if (ok) {
        this.textarea.innerHTML = this.originalContent;
        this.titleInput.value = this.originalTitle;
        this.exitEditMode();
        this.container.classList.remove('active'); document.body.classList.remove('editor-active');
        document.getElementById('editor-comment-history-btn').style.display = 'none';
        document.getElementById('status-bar').style.display = 'none';
      }
      return;
    }

    // Just viewing — close
    if (this.isEditing) this.exitEditMode();
    this.container.classList.remove('active'); document.body.classList.remove('editor-active');
    document.getElementById('formatting-toolbar').style.display = 'none';
    document.getElementById('editor-comment-history-btn').style.display = 'none';
    document.getElementById('status-bar').style.display = 'none';
  },

  // ── Copy blocking during active sessions ──
  _onCopyBlock(e) {
    if (Editor.active) {
      e.preventDefault();
      e.stopPropagation();
      App.toast('Copying is disabled during sessions', 'error');
    }
  },

  _onContextMenuBlock(e) {
    if (Editor.active) {
      e.preventDefault();
    }
  },

  _blockCopy() {
    document.addEventListener('copy', this._onCopyBlock, true);
    document.addEventListener('cut', this._onCopyBlock, true);
    document.addEventListener('contextmenu', this._onContextMenuBlock, true);
    // Block text selection in the editor during sessions
    this.textarea.style.userSelect = 'none';
    this.textarea.style.webkitUserSelect = 'none';
    // Still allow typing in contentEditable
    this.textarea.style.caretColor = 'var(--text-primary)';
  },

  _unblockCopy() {
    document.removeEventListener('copy', this._onCopyBlock, true);
    document.removeEventListener('cut', this._onCopyBlock, true);
    document.removeEventListener('contextmenu', this._onContextMenuBlock, true);
    this.textarea.style.userSelect = '';
    this.textarea.style.webkitUserSelect = '';
    this.textarea.style.caretColor = '';
  }
};
