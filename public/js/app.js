const App = {
  user: null,
  documents: [],
  friends: [],
  folders: [],
  currentFolder: null, // null = root
  currentView: 'dashboard',
  sessionDuration: 15,
  sessionMode: 'normal',
  toastTimer: null,
  notifInterval: null,

  calcXPLevel(xp) {
    let level = 0;
    let xpUsed = 0;
    let threshold = 300; // Level 1 = 300 XP
    while (xp >= xpUsed + threshold) {
      xpUsed += threshold;
      level++;
      threshold = Math.round(threshold * 1.25); // 25% harder each level
    }
    return { level, xpInLevel: xp - xpUsed, xpForNextLevel: threshold };
  },

  async init() {
    // Check for token in URL (from Google OAuth redirect)
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token');
    if (urlToken) {
      API.setToken(urlToken);
      window.history.replaceState({}, document.title, '/app');
    }

    const token = API.getToken();
    if (!token) {
      this.showAuth();
      return;
    }

    try {
      this.user = await API.getMe();
      this.showApp();
    } catch {
      API.clearToken();
      this.showAuth();
    }
  },

  showAuth() {
    document.getElementById('auth-view').style.display = 'flex';
    document.getElementById('app-view').style.display = 'none';
    this.bindAuthEvents();
    this.initGoogleSignIn();
    Monsters.init();
  },

  async initGoogleSignIn() {
    try {
      const res = await fetch('/api/auth/google-client-id');
      const { clientId } = await res.json();
      if (!clientId) return;

      // Initialize Google Sign-In with auto-select for returning users
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: this.handleGoogleCredential.bind(this),
        auto_select: true
      });

      // Try One Tap auto-sign-in first (silent for returning users)
      window.google.accounts.id.prompt();

      // Render button as fallback
      const loginBtn = document.getElementById('google-login-btn');
      if (loginBtn) {
        const cardWidth = loginBtn.closest('.auth-card')?.offsetWidth || 380;
        window.google.accounts.id.renderButton(loginBtn, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          width: cardWidth
        });
      }
    } catch (err) {
      console.error('Failed to initialize Google Sign-In:', err);
    }
  },

  async handleGoogleCredential(response) {
    const errorEl = document.getElementById('login-error');
    try {
      const res = await fetch('/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: response.credential })
      });

      if (!res.ok) {
        const error = await res.json();
        if (errorEl) errorEl.textContent = error.error || 'Google sign-in failed';
        if (errorEl) errorEl.classList.add('visible');
        return;
      }

      const data = await res.json();
      API.setToken(data.token);
      this.user = data.user;
      this.showApp();
    } catch (err) {
      console.error('Google sign-in error:', err);
      if (errorEl) errorEl.textContent = 'Google sign-in failed';
      if (errorEl) errorEl.classList.add('visible');
    }
  },

  showApp() {
    Monsters.destroy();
    document.getElementById('auth-view').style.display = 'none';
    document.getElementById('app-view').style.display = 'block';
    this.updateUserUI();

    // Initialize level tracking if not set (prevents false level-up on first visit)
    if (!localStorage.getItem('iwrite_last_level')) {
      const { level } = this.calcXPLevel(this.user.xp || 0);
      localStorage.setItem('iwrite_last_level', level.toString());
    }

    const savedTheme = localStorage.getItem('iwrite_theme') || 'dark';
    if (savedTheme === 'light') document.documentElement.classList.add('light');

    // Try to resume session in background (non-blocking)
    Editor.resumeSession().then(sessionResumed => {
      if (!sessionResumed) {
        const savedView = localStorage.getItem('iwrite_view') || 'dashboard';
        this.switchView(savedView);
      }
    }).catch(() => {
      const savedView = localStorage.getItem('iwrite_view') || 'dashboard';
      this.switchView(savedView);
    });

    this.bindAppEvents();
    this.startNotifPolling();
  },

  bindAuthEvents() {
    // Google Sign-In only — no email/password bindings needed
  },

  bindAppEvents() {
    document.querySelectorAll('.sidebar-nav-item[data-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.switchView(btn.dataset.view);
      });
    });

    document.getElementById('logout-btn').addEventListener('click', () => API.logout());

    // Pricing modal
    document.getElementById('user-info-btn').addEventListener('click', () => this.openPricing());
    document.getElementById('pricing-close').addEventListener('click', () => this.closePricing());
    document.getElementById('pricing-overlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.closePricing();
    });

    // Mobile sidebar toggle
    const mobileSidebarToggle = document.getElementById('mobile-sidebar-toggle');
    const mobileSidebarOverlay = document.getElementById('mobile-sidebar-overlay');
    const sidebar = document.getElementById('sidebar');

    const openMobileSidebar = () => {
      sidebar.classList.add('open');
      mobileSidebarToggle.classList.add('open');
      mobileSidebarOverlay.style.display = 'block';
    };
    const closeMobileSidebar = () => {
      sidebar.classList.remove('open');
      mobileSidebarToggle.classList.remove('open');
      mobileSidebarOverlay.style.display = 'none';
    };

    mobileSidebarToggle.addEventListener('click', () => {
      sidebar.classList.contains('open') ? closeMobileSidebar() : openMobileSidebar();
    });
    mobileSidebarOverlay.addEventListener('click', closeMobileSidebar);

    // Close sidebar on mobile when a nav item is clicked
    sidebar.querySelectorAll('.sidebar-nav-item[data-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (window.innerWidth <= 768) closeMobileSidebar();
      });
    });

    // Theme toggle — sync button state with current theme
    const isLightNow = document.documentElement.classList.contains('light');
    this._applyTheme(isLightNow ? 'light' : 'dark');
    document.getElementById('theme-toggle-btn').addEventListener('click', () => {
      const isLight = document.documentElement.classList.contains('light');
      this._applyTheme(isLight ? 'dark' : 'light');
    });

    // Support submit
    const supportBtn = document.getElementById('support-submit-btn');
    if (supportBtn) supportBtn.addEventListener('click', () => this.submitSupportTicket());

    // Help popup close
    document.getElementById('help-popup-close').addEventListener('click', () => this.closeHelpPopup());
    document.getElementById('help-popup-overlay').addEventListener('click', () => this.closeHelpPopup());

    document.getElementById('new-doc-btn').addEventListener('click', () => this.openSessionModal());
    document.getElementById('new-doc-btn-2').addEventListener('click', () => this.openSessionModal());
    document.getElementById('new-doc-btn-3').addEventListener('click', () => this.openSessionModal());

    document.getElementById('modal-cancel').addEventListener('click', () => this.closeSessionModal());
    document.getElementById('modal-start').addEventListener('click', () => this.startSession());

    document.querySelectorAll('#time-presets .time-preset[data-minutes]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#time-presets .time-preset').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.sessionDuration = parseInt(btn.dataset.minutes);
        document.getElementById('time-custom-row').style.display = 'none';
      });
    });

    document.getElementById('time-preset-add-btn').addEventListener('click', () => {
      const row = document.getElementById('time-custom-row');
      row.style.display = row.style.display === 'none' ? 'flex' : 'none';
      if (row.style.display === 'flex') document.getElementById('custom-time-input').focus();
    });

    const setCustomTime = () => {
      const val = parseInt(document.getElementById('custom-time-input').value);
      if (!val || val < 1) return;
      document.querySelectorAll('#time-presets .time-preset').forEach(b => b.classList.remove('active'));
      document.getElementById('time-preset-add-btn').textContent = `${val} min`;
      document.getElementById('time-preset-add-btn').classList.add('active');
      this.sessionDuration = val;
      document.getElementById('time-custom-row').style.display = 'none';
      document.getElementById('custom-time-input').value = '';
    };
    document.getElementById('custom-time-set').addEventListener('click', setCustomTime);
    document.getElementById('custom-time-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') setCustomTime();
    });

    document.querySelectorAll('.mode-option').forEach(opt => {
      opt.addEventListener('click', () => {
        document.querySelectorAll('.mode-option').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        this.sessionMode = opt.dataset.mode;
        // Swap time preset panels based on mode
        const isDanger = this.sessionMode === 'dangerous';
        document.getElementById('time-presets').style.display = isDanger ? 'none' : 'flex';
        document.getElementById('danger-time-presets').style.display = isDanger ? 'flex' : 'none';
        document.getElementById('time-custom-row').style.display = 'none';
        if (isDanger) {
          // Default danger duration to the active preset
          const dangerActive = document.querySelector('#danger-time-presets .time-preset.active');
          this.sessionDuration = parseInt(dangerActive?.dataset.minutes || 5);
        } else {
          const normalActive = document.querySelector('#time-presets .time-preset.active');
          this.sessionDuration = parseInt(normalActive?.dataset.minutes || 15);
        }
      });
    });

    // Bind danger mode time presets
    document.querySelectorAll('#danger-time-presets .time-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#danger-time-presets .time-preset').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.sessionDuration = parseInt(btn.dataset.minutes);
      });
    });

    document.getElementById('editor-back').addEventListener('click', () => Editor.abort());
    document.getElementById('editor-save-btn').addEventListener('click', () => Editor.completeSession());
    document.getElementById('editor-edit-btn').addEventListener('click', () => Editor.enterEditMode());
    document.getElementById('editor-save-edit-btn').addEventListener('click', () => Editor.saveEdits());

    // Editor toolbar: theme toggle
    document.getElementById('editor-theme-btn').addEventListener('click', () => Editor.toggleEditorTheme());

    // Editor toolbar: fullscreen toggle
    document.getElementById('editor-fullscreen-btn').addEventListener('click', () => Editor.toggleFullscreen());

    // Editor toolbar: font dropdown
    const fontBtn = document.getElementById('editor-font-btn');
    const fontDrop = document.getElementById('editor-font-dropdown');
    fontBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      fontDrop.style.display = fontDrop.style.display === 'none' ? 'block' : 'none';
      // Close audio dropdown if open
      document.getElementById('editor-audio-dropdown').style.display = 'none';
    });
    document.querySelectorAll('.font-option').forEach(btn => {
      btn.addEventListener('click', () => {
        Editor.setFont(btn.dataset.font);
        fontDrop.style.display = 'none';
      });
    });

    // Editor toolbar: audio dropdown
    const audioBtn = document.getElementById('editor-audio-btn');
    const audioDrop = document.getElementById('editor-audio-dropdown');
    audioBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      audioDrop.style.display = audioDrop.style.display === 'none' ? 'block' : 'none';
      fontDrop.style.display = 'none';
    });

    // Close dropdowns when clicking elsewhere
    document.addEventListener('click', () => {
      fontDrop.style.display = 'none';
      audioDrop.style.display = 'none';
    });

    // Restore saved font preference
    const savedFont = localStorage.getItem('iwrite_editor_font') || 'sans';
    if (savedFont !== 'sans') Editor.setFont(savedFont);

    // Init selection popup + audio
    Editor.initSelectionPopup();
    Editor.initAudio();
    document.getElementById('editor-copy-btn').addEventListener('click', async () => {
      const textarea = document.getElementById('editor-textarea');
      try {
        // Copy as both HTML (for Google Docs) and plain text
        const html = textarea.innerHTML;
        const text = textarea.innerText;
        if (navigator.clipboard && ClipboardItem) {
          await navigator.clipboard.write([
            new ClipboardItem({
              'text/html': new Blob([html], { type: 'text/html' }),
              'text/plain': new Blob([text], { type: 'text/plain' })
            })
          ]);
        } else {
          await navigator.clipboard.writeText(text);
        }
        this.toast('Copied to clipboard!', 'success');
      } catch {
        // Fallback
        try {
          await navigator.clipboard.writeText(textarea.innerText);
          this.toast('Copied as plain text!', 'success');
        } catch {
          this.toast('Failed to copy', 'error');
        }
      }
    });

    document.getElementById('sc-dashboard').addEventListener('click', () => {
      document.getElementById('session-complete').classList.remove('active');
      this.loadDashboard();
    });

    document.getElementById('sc-new-session').addEventListener('click', () => {
      document.getElementById('session-complete').classList.remove('active');
      this.openSessionModal();
    });

    document.getElementById('sf-dashboard').addEventListener('click', () => {
      document.getElementById('session-failed').classList.remove('active');
      this.switchView('documents');
    });

    document.getElementById('sf-retry').addEventListener('click', () => {
      document.getElementById('session-failed').classList.remove('active');
      this.openSessionModal();
    });

    document.getElementById('new-duel-btn').addEventListener('click', () => this.openDuelModal());
    document.getElementById('duel-cancel').addEventListener('click', () => this.closeDuelModal());
    document.getElementById('duel-start').addEventListener('click', () => this.createDuel());

    document.querySelectorAll('#duel-time-presets .time-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#duel-time-presets .time-preset').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    document.getElementById('add-friend-btn').addEventListener('click', () => this.addFriend());
    document.getElementById('save-profile-btn').addEventListener('click', () => this.saveProfile());
    document.getElementById('change-password-btn').addEventListener('click', () => this.changePassword());

    document.getElementById('create-folder-btn').addEventListener('click', () => this.createFolder());
    document.getElementById('history-btn').addEventListener('click', () => this.openHistoryModal());
    document.getElementById('history-close').addEventListener('click', () => this.closeHistorySidebar());
    document.getElementById('history-sidebar-overlay').addEventListener('click', () => this.closeHistorySidebar());
    document.getElementById('comment-history-close').addEventListener('click', () => this.closeCommentHistorySidebar());
    document.getElementById('comment-history-sidebar-overlay').addEventListener('click', () => this.closeCommentHistorySidebar());
    document.getElementById('editor-comment-history-btn').addEventListener('click', () => this.openCommentHistory());
  },

  switchView(view) {
    this.currentView = view;
    localStorage.setItem('iwrite_view', view);
    document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
    document.getElementById(`view-${view}`).style.display = 'block';
    document.querySelectorAll('.sidebar-nav-item[data-view]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === view);
    });

    if (view === 'dashboard') this.loadDashboard();
    if (view === 'documents') this.loadDocuments();
    if (view === 'leaderboard') this.loadLeaderboard();
    if (view === 'profile') this.loadProfile();
    if (view === 'friends') this.loadFriends();
    if (view === 'support') this.loadSupport();
  },

  updateUserUI() {
    if (!this.user) return;
    document.getElementById('user-name').textContent = this.user.name;
    const { level } = this.calcXPLevel(this.user.xp || 0);
    document.getElementById('user-level').textContent = `Level ${level}`;
    document.getElementById('user-avatar').textContent = this.user.name.charAt(0).toUpperCase();

    const badge = document.getElementById('plan-badge');
    if (badge) {
      const isPro = this.user.plan === 'premium';
      badge.textContent = isPro ? 'Pro' : 'Free';
      badge.className = 'plan-badge' + (isPro ? ' pro' : '');
    }

    if (this.user.streak > 0) {
      document.getElementById('streak-badge').style.display = 'flex';
      document.getElementById('streak-count').textContent = this.user.streak;
    } else {
      document.getElementById('streak-badge').style.display = 'none';
    }

    const hour = new Date().getHours();
    let greeting = 'Good evening';
    let emoji = '&#x1F319;';
    if (hour < 12) { greeting = 'Good morning'; emoji = '&#x2600;&#xFE0F;'; }
    else if (hour < 18) { greeting = 'Good afternoon'; emoji = '&#x1F324;&#xFE0F;'; }
    document.getElementById('greeting-text').innerHTML = `${emoji} ${greeting}, <em>${this.user.name}</em>`;
  },

  async loadDashboard() {
    try {
      this.user = await API.getMe();
      this.updateUserUI();
    } catch {}

    document.getElementById('total-words').textContent = (this.user.totalWords || 0).toLocaleString();
    document.getElementById('total-sessions').textContent = this.user.totalSessions || 0;
    document.getElementById('current-streak').textContent = this.user.streak || 0;
    document.getElementById('longest-streak-text').textContent = `Best: ${this.user.longestStreak || 0}`;
    document.getElementById('total-xp').textContent = (this.user.xp || 0).toLocaleString();

    const { level, xpInLevel, xpForNextLevel } = this.calcXPLevel(this.user.xp || 0);
    document.getElementById('xp-level-text').innerHTML = `&#x1F396;&#xFE0F; Level ${level}`;
    document.getElementById('xp-progress-text').textContent = `${xpInLevel.toLocaleString()} / ${xpForNextLevel.toLocaleString()} XP`;
    document.getElementById('xp-bar-fill').style.width = `${Math.min(100, (xpInLevel / xpForNextLevel) * 100)}%`;

    // Queue level-up celebrations (layer by layer)
    const prevLevel = parseInt(localStorage.getItem('iwrite_last_level') || '0');
    if (level > prevLevel && prevLevel > 0) {
      const pendingLevels = [];
      for (let l = prevLevel + 1; l <= level; l++) {
        pendingLevels.push(l);
      }
      localStorage.setItem('iwrite_last_level', level.toString());
      this._showLevelUpQueue(pendingLevels);
    } else {
      localStorage.setItem('iwrite_last_level', level.toString());
    }

    const canvas = document.getElementById('tree-canvas');
    const stage = this.user.treeStage || 0;
    TreeRenderer.draw(canvas, stage, this.user.streak || 0);
    document.getElementById('tree-stage-text').textContent = TreeRenderer.stages[stage] || 'Seed';

    try {
      this.documents = await API.getDocuments();
    } catch {
      this.documents = [];
    }
    // Only show non-failed, non-admin-deactivated docs in main lists
    const visibleDocs = this.documents.filter(d => !d.deletedBySystem && !d.deactivatedByAdmin);
    this.renderDocumentList('recent-docs', visibleDocs.slice(0, 5));
  },

  async loadDocuments() {
    try {
      this.documents = await API.getDocuments();
    } catch {
      this.documents = [];
    }
    try {
      this.folders = await API.getFolders();
    } catch {
      this.folders = [];
    }

    // Only show non-failed, non-admin-deactivated docs in main list
    const visibleDocs = this.documents.filter(d => !d.deletedBySystem && !d.deactivatedByAdmin);

    // Build breadcrumb path
    const bc = document.getElementById('folder-breadcrumb');
    if (this.currentFolder) {
      const path = this.getFolderPath(this.currentFolder);
      bc.style.display = 'flex';
      let html = `<button class="folder-breadcrumb-link" data-bc-folder="">All Sessions</button>`;
      path.forEach((f, i) => {
        const isLast = i === path.length - 1;
        html += `<span class="folder-breadcrumb-sep">›</span>`;
        if (isLast) {
          html += `<span style="color:var(--text-primary);font-weight:600">${this.escapeHtml(f.name)}</span>`;
        } else {
          html += `<button class="folder-breadcrumb-link" data-bc-folder="${f.id}">${this.escapeHtml(f.name)}</button>`;
        }
      });
      bc.innerHTML = html;
      bc.querySelectorAll('[data-bc-folder]').forEach(btn => {
        btn.onclick = () => {
          this.currentFolder = btn.dataset.bcFolder || null;
          this.loadDocuments();
        };
      });
    } else {
      bc.style.display = 'none';
    }

    // Add back button when inside a folder
    const backBtnContainer = document.getElementById('folder-back-btn');
    if (backBtnContainer) {
      if (this.currentFolder) {
        const currentFolderObj = this.folders.find(f => f.id === this.currentFolder);
        const parentId = currentFolderObj?.parentFolder || null;
        const parentName = parentId ? (this.folders.find(f => f.id === parentId)?.name || 'Parent') : 'All Sessions';
        backBtnContainer.style.display = 'flex';
        backBtnContainer.innerHTML = `<button class="folder-back-link" id="folder-back-action">← Back to ${this.escapeHtml(parentName)}</button>`;
        document.getElementById('folder-back-action').onclick = () => {
          this.currentFolder = parentId;
          this.loadDocuments();
        };
      } else {
        backBtnContainer.style.display = 'none';
      }
    }

    // Render folders for current level
    const folderContainer = document.getElementById('folder-list');
    const childFolders = this.folders.filter(f => (f.parentFolder || null) === this.currentFolder);
    if (childFolders.length > 0) {
      folderContainer.innerHTML = childFolders.map(f => {
        const count = this.countDocsInFolder(f.id, visibleDocs);
        return `<div class="folder-card" data-folder-id="${f.id}">
          <span class="folder-card-icon">📁</span>
          <span class="folder-card-name">${this.escapeHtml(f.name)}</span>
          <span class="folder-card-count">${count}</span>
          <button class="folder-card-menu" data-folder-menu="${f.id}" title="Options">⋯</button>
        </div>`;
      }).join('');

      folderContainer.onclick = (e) => {
        const menuBtn = e.target.closest('[data-folder-menu]');
        if (menuBtn) {
          e.stopPropagation();
          this.showFolderMenu(menuBtn.dataset.folderMenu, menuBtn);
          return;
        }
        const card = e.target.closest('.folder-card');
        if (card) {
          this.currentFolder = card.dataset.folderId;
          this.loadDocuments();
        }
      };
    } else {
      folderContainer.innerHTML = '';
    }

    // Filter docs by current folder
    const folderDocs = this.currentFolder
      ? visibleDocs.filter(d => d.folder === this.currentFolder)
      : visibleDocs.filter(d => !d.folder);

    this.renderDocumentList('all-docs', folderDocs);

    try {
      const sharedDocs = await API.getSharedDocuments();
      const section = document.getElementById('shared-docs-section');
      if (sharedDocs.length > 0 && !this.currentFolder) {
        section.style.display = 'block';
        this.renderSharedDocumentList('shared-docs', sharedDocs);
      } else {
        section.style.display = 'none';
      }
    } catch {
      document.getElementById('shared-docs-section').style.display = 'none';
    }
  },

  renderSharedDocumentList(containerId, docs) {
    const container = document.getElementById(containerId);
    const permLabels = { view: 'View', comment: 'Comment', edit: 'Edit' };
    const permColors = { view: '#6c5ce7', comment: '#1ab5a0', edit: '#fd6db5' };
    container.innerHTML = docs.map(doc => `
      <div class="doc-card" data-id="${doc.id}" data-token="${doc.token}" style="cursor:pointer">
        <div class="doc-card-info">
          <h4>${this.escapeHtml(doc.title)}
            <span style="display:inline-block;margin-left:6px;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;background:${permColors[doc.permission] || '#6c5ce7'}22;color:${permColors[doc.permission] || '#6c5ce7'}">${permLabels[doc.permission] || doc.permission}</span>
          </h4>
          <div class="doc-card-meta">
            <span>${doc.wordCount || 0} words</span>
            <span>${this.formatDate(doc.updatedAt)}</span>
          </div>
        </div>
      </div>`).join('');

    container.onclick = (e) => {
      const card = e.target.closest('.doc-card');
      if (card) {
        window.open(`/shared/${card.dataset.token}`, '_blank');
      }
    };
  },

  renderDocumentList(containerId, docs) {
    const container = document.getElementById(containerId);
    if (docs.length === 0) {
      // Don't show "No documents yet" if there are child folders at this level
      const childFolders = this.folders.filter(f => (f.parentFolder || null) === this.currentFolder);
      const hasFolders = childFolders.length > 0;
      if (hasFolders && containerId === 'all-docs') {
        container.innerHTML = '';
        return;
      }
      // Inside a folder, say "No documents in this folder"
      const emptyMsg = this.currentFolder
        ? { title: 'No documents in this folder', sub: 'Move documents here or start a new session.' }
        : { title: 'No documents yet', sub: 'Start a new writing session to create your first document.' };
      container.innerHTML = `
        <div class="empty-state">
          <h3>${emptyMsg.title}</h3>
          <p>${emptyMsg.sub}</p>
          <button class="btn btn-primary btn-small" onclick="App.openSessionModal()">New Session</button>
        </div>`;
      return;
    }

    container.innerHTML = docs.map(doc => {
      const isFailed = doc.deletedBySystem;
      return `
      <div class="doc-card ${isFailed ? 'doc-failed' : ''}" data-id="${doc.id}">
        <div class="doc-card-info">
          <h4>${this.escapeHtml(doc.title)} ${isFailed ? '<span class="badge badge-failed">FAILED</span>' : ''}</h4>
          <div class="doc-card-meta">
            <span>${doc.wordCount || 0} words</span>
            <span>${doc.mode === 'dangerous' ? '&#x26A1; Dangerous' : 'Normal'}</span>
            <span>${this.formatDate(doc.updatedAt)}</span>
            ${doc.xpEarned ? `<span class="xp-gained">+${doc.xpEarned} XP</span>` : ''}
          </div>
        </div>
        <button class="doc-card-menu-btn" data-doc-id="${doc.id}" title="Options">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
        </button>
      </div>`;
    }).join('');

    container.onclick = (e) => {
      const menuBtn = e.target.closest('.doc-card-menu-btn');
      if (menuBtn) {
        e.stopPropagation();
        const docId = menuBtn.dataset.docId;
        const doc = docs.find(d => d.id === docId);
        this.showDocMenu(menuBtn, doc);
        return;
      }
      const card = e.target.closest('.doc-card');
      if (card && !card.classList.contains('doc-failed')) {
        this.openDocument(card.dataset.id);
      }
    };
  },

  async openDocument(id) {
    try {
      const doc = await API.request(`/documents/${id}`);
      document.getElementById('editor-title').value = doc.title;
      document.getElementById('editor-textarea').innerHTML = doc.content || '';
      Editor.documentId = id;
      Editor.active = false;
      Editor.isEditing = false;
      Editor.originalContent = doc.content || '';
      Editor.originalTitle = doc.title;

      document.getElementById('editor-container').classList.add('active');
      document.getElementById('editor-timer').textContent = 'View';
      document.getElementById('editor-mode-badge').textContent = 'Viewing';
      document.getElementById('editor-mode-badge').className = 'editor-mode-badge normal';
      document.getElementById('danger-progress').style.display = 'none';
      document.getElementById('formatting-toolbar').style.display = 'none'; // shown on Edit

      // Show Edit button, hide session buttons
      document.getElementById('editor-save-btn').style.display = 'none';
      document.getElementById('editor-edit-btn').style.display = 'inline-flex';
      document.getElementById('editor-save-edit-btn').style.display = 'none';
      document.getElementById('editor-comment-history-btn').style.display = 'inline-flex';

      // Read-only initially
      document.getElementById('editor-title').readOnly = true;
      document.getElementById('editor-textarea').contentEditable = 'false';

      // Show status bar and update word count after rendering
      document.getElementById('status-bar').style.display = 'flex';
      setTimeout(() => Editor.updateWordCount(), 50);

      // Load comments for this document
      CommentSystem.destroy();
      try {
        const comments = await API.getDocumentComments(id);
        if (comments.length > 0) {
          // Find a share token for this doc
          let token = null;
          if (doc.shareLinks && doc.shareLinks.length > 0) {
            const commentLink = doc.shareLinks.find(l => l.type === 'comment' || l.type === 'edit');
            if (commentLink) token = commentLink.token;
            else token = doc.shareLinks[0].token;
          }
          CommentSystem.init(id, comments, true, token);
        }
      } catch {}
    } catch {
      this.toast('Failed to open document', 'error');
    }
  },

  openSessionModal() {
    document.getElementById('session-modal').classList.add('active');
    document.getElementById('time-custom-row').style.display = 'none';
    const addBtn = document.getElementById('time-preset-add-btn');
    addBtn.textContent = '+';
    addBtn.classList.remove('active');
    // Reset to normal mode when opening
    document.querySelectorAll('.mode-option').forEach(o => o.classList.remove('active'));
    document.querySelector('.mode-option[data-mode="normal"]').classList.add('active');
    this.sessionMode = 'normal';
    this.sessionDuration = 15;
    document.getElementById('time-presets').style.display = 'flex';
    document.getElementById('danger-time-presets').style.display = 'none';
    document.querySelectorAll('#time-presets .time-preset').forEach(b => b.classList.remove('active'));
    document.querySelector('#time-presets .time-preset[data-minutes="15"]').classList.add('active');
    // Reset new fields
    document.getElementById('session-topic-input').value = '';
    document.getElementById('session-target-words').value = '';
  },

  closeSessionModal() {
    document.getElementById('session-modal').classList.remove('active');
  },

  startSession() {
    this.closeSessionModal();
    const topic = document.getElementById('session-topic-input').value.trim();
    const targetWords = parseInt(document.getElementById('session-target-words').value) || 0;
    document.getElementById('editor-title').value = topic ? topic.substring(0, 60) : 'Untitled';
    Editor.start(this.sessionDuration, this.sessionMode, { topic, targetWords });
  },

  showSessionFailed(reason) {
    document.getElementById('sf-reason').textContent = reason;
    document.getElementById('session-failed').classList.add('active');
  },

  // ===== LEADERBOARD =====
  async loadLeaderboard() {
    const tbody = document.querySelector('#leaderboard-table tbody');
    const podium = document.getElementById('leaderboard-podium');

    try {
      const data = await API.getLeaderboard();

      // Podium for top 3
      const top3 = data.slice(0, 3);
      const podiumOrder = [top3[1], top3[0], top3[2]]; // silver, gold, bronze
      const medals = ['&#x1F948;', '&#x1F947;', '&#x1F949;'];
      const podiumLabels = ['2nd', '1st', '3rd'];
      const heights = ['160px', '200px', '140px'];

      podium.innerHTML = podiumOrder.map((entry, i) => {
        if (!entry) return '<div class="podium-slot empty"></div>';
        return `
          <div class="podium-slot">
            <div class="podium-avatar">${entry.name.charAt(0).toUpperCase()}</div>
            <div class="podium-name">${this.escapeHtml(entry.name)}</div>
            <div class="podium-words">${(entry.totalWords || 0).toLocaleString()} words</div>
            <div class="podium-pedestal" style="height:${heights[i]}">
              <span class="podium-medal">${medals[i]}</span>
              <span class="podium-rank">${podiumLabels[i]}</span>
            </div>
          </div>`;
      }).join('');

      // Full table
      tbody.innerHTML = data.map((entry, i) => {
        const rankEmoji = i === 0 ? '&#x1F947;' : i === 1 ? '&#x1F948;' : i === 2 ? '&#x1F949;' : `${i + 1}`;
        const isMe = this.user && entry.name === this.user.name;
        return `
          <tr class="${isMe ? 'leaderboard-me' : ''}">
            <td class="lb-rank">${rankEmoji}</td>
            <td class="lb-name">${this.escapeHtml(entry.name)} ${isMe ? '<span class="lb-you">YOU</span>' : ''}</td>
            <td><strong>${(entry.totalWords || 0).toLocaleString()}</strong></td>
            <td>${entry.totalSessions || 0}</td>
            <td>${entry.minutesWritten || 0}m</td>
            <td><span class="lb-level">Lv.${this.calcXPLevel(entry.totalWords || 0).level}</span></td>
            <td>${entry.streak ? '&#x1F525; ' + entry.streak : '-'}</td>
          </tr>`;
      }).join('');

      if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text-muted)">No writers yet. Be the first!</td></tr>';
        podium.innerHTML = '';
      }
    } catch {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text-muted)">Failed to load leaderboard</td></tr>';
    }
  },

  // ===== PASSWORD CHANGE =====
  async changePassword() {
    const currentPassword = document.getElementById('current-password').value;
    const newPassword = document.getElementById('new-password').value;
    const confirmPassword = document.getElementById('confirm-password').value;
    const errorEl = document.getElementById('password-error');
    const successEl = document.getElementById('password-success');
    errorEl.className = 'auth-error';
    successEl.className = 'auth-error';
    successEl.style.color = 'var(--success)';

    if (!currentPassword || !newPassword || !confirmPassword) {
      errorEl.textContent = 'All password fields are required';
      errorEl.classList.add('visible');
      return;
    }

    if (newPassword !== confirmPassword) {
      errorEl.textContent = 'New passwords do not match';
      errorEl.classList.add('visible');
      return;
    }

    if (newPassword.length < 6) {
      errorEl.textContent = 'New password must be at least 6 characters';
      errorEl.classList.add('visible');
      return;
    }

    try {
      await API.changePassword(currentPassword, newPassword, confirmPassword);
      document.getElementById('current-password').value = '';
      document.getElementById('new-password').value = '';
      document.getElementById('confirm-password').value = '';
      successEl.textContent = 'Password updated successfully!';
      successEl.classList.add('visible');
      setTimeout(() => { successEl.className = 'auth-error'; }, 3000);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.add('visible');
    }
  },

  openDuelModal() {
    document.getElementById('duel-modal').classList.add('active');
    const select = document.getElementById('duel-friend-select');
    select.innerHTML = '<option value="">Choose a friend...</option>';
    this.friends.forEach(f => {
      select.innerHTML += `<option value="${f.id}">${this.escapeHtml(f.name)}</option>`;
    });
  },

  closeDuelModal() {
    document.getElementById('duel-modal').classList.remove('active');
  },

  async createDuel() {
    const friendId = document.getElementById('duel-friend-select').value;
    if (!friendId) {
      this.toast('Select a friend first', 'error');
      return;
    }
    const activePreset = document.querySelector('#duel-time-presets .time-preset.active');
    const duration = parseInt(activePreset?.dataset.minutes || 10);
    this.toast(`Duel challenge sent! ${duration} minute battle.`, 'success');
    this.closeDuelModal();
  },

  async shareDoc(id) {
    const type = await this.showShareTypeModal();
    if (!type) return;

    try {
      const link = await API.shareDocument(id, type);
      const url = `${window.location.origin}/shared/${link.token}`;
      await navigator.clipboard.writeText(url);
      this.toast(`${type.charAt(0).toUpperCase() + type.slice(1)} link copied to clipboard!`, 'success');
    } catch {
      this.toast('Failed to create share link', 'error');
    }
  },

  showShareTypeModal() {
    return new Promise((resolve) => {
      const overlay = document.getElementById('share-type-modal');
      overlay.classList.add('active');

      const cleanup = () => { overlay.classList.remove('active'); };

      document.getElementById('share-view-btn').onclick = () => { cleanup(); resolve('view'); };
      document.getElementById('share-comment-btn').onclick = () => { cleanup(); resolve('comment'); };
      document.getElementById('share-edit-btn').onclick = () => { cleanup(); resolve('edit'); };
      document.getElementById('share-cancel-btn').onclick = () => { cleanup(); resolve(null); };
    });
  },

  async deleteDoc(id) {
    const ok = await this.showConfirm('Delete this document?');
    if (!ok) return;
    try {
      await API.deleteDocument(id);
      if (this.currentView === 'dashboard') this.loadDashboard();
      else this.loadDocuments();
    } catch {
      this.toast('Failed to delete document', 'error');
    }
  },

  loadProfile() {
    document.getElementById('profile-name').value = this.user.name;
    document.getElementById('profile-email').value = this.user.email;
    const pwSection = document.getElementById('change-password-section');
    if (pwSection) pwSection.style.display = this.user.provider === 'google' ? 'none' : '';
    document.getElementById('profile-plan').value = this.user.plan === 'premium' ? 'Pro' : 'Free';
    document.getElementById('profile-since').value = new Date(this.user.createdAt).toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric'
    });

    const achievements = this.getAchievements();
    const container = document.getElementById('achievements-list');
    container.innerHTML = achievements.map(a => `
      <div class="achievement-card ${a.earned ? 'earned' : ''}">
        <div class="achievement-icon">${a.icon}</div>
        <h3>${a.name}</h3>
        <p>${a.description}</p>
      </div>
    `).join('');
  },

  getAchievements() {
    const u = this.user;
    return [
      // Session milestones
      { icon: '&#x1F331;', name: 'First Seed', description: 'Complete your first session', earned: (u.totalSessions || 0) >= 1 },
      { icon: '&#x270D;&#xFE0F;', name: 'Getting Started', description: 'Complete 5 sessions', earned: (u.totalSessions || 0) >= 5 },
      { icon: '&#x1F4DD;', name: 'Regular Writer', description: 'Complete 25 sessions', earned: (u.totalSessions || 0) >= 25 },
      { icon: '&#x1F58B;&#xFE0F;', name: 'Session Master', description: 'Complete 100 sessions', earned: (u.totalSessions || 0) >= 100 },
      // Streak milestones
      { icon: '&#x1F525;', name: 'On Fire', description: '3-day writing streak', earned: (u.longestStreak || 0) >= 3 },
      { icon: '&#x1F3AF;', name: 'Consistent', description: '7-day writing streak', earned: (u.longestStreak || 0) >= 7 },
      { icon: '&#x1F4AA;', name: 'Dedicated', description: '14-day writing streak', earned: (u.longestStreak || 0) >= 14 },
      { icon: '&#x1F3C6;', name: 'Legend', description: '30-day writing streak', earned: (u.longestStreak || 0) >= 30 },
      { icon: '&#x1F451;', name: 'Unstoppable', description: '60-day writing streak', earned: (u.longestStreak || 0) >= 60 },
      { icon: '&#x1F30D;', name: 'World Writer', description: '100-day writing streak', earned: (u.longestStreak || 0) >= 100 },
      // Word milestones
      { icon: '&#x26A1;', name: 'Speed Writer', description: 'Write 500 total words', earned: (u.totalWords || 0) >= 500 },
      { icon: '&#x1F4D6;', name: 'Storyteller', description: 'Write 2,500 total words', earned: (u.totalWords || 0) >= 2500 },
      { icon: '&#x1F4DA;', name: 'Prolific', description: 'Write 10,000 total words', earned: (u.totalWords || 0) >= 10000 },
      { icon: '&#x1F4D5;', name: 'Novelist', description: 'Write 50,000 total words', earned: (u.totalWords || 0) >= 50000 },
      { icon: '&#x1F3DB;&#xFE0F;', name: 'Epic Author', description: 'Write 100,000 total words', earned: (u.totalWords || 0) >= 100000 },
      // Level milestones
      { icon: '&#x2B50;', name: 'Rising Star', description: 'Reach Level 5', earned: (u.level || 0) >= 5 },
      { icon: '&#x1F31F;', name: 'Shining Bright', description: 'Reach Level 10', earned: (u.level || 0) >= 10 },
      { icon: '&#x1F48E;', name: 'Diamond Writer', description: 'Reach Level 25', earned: (u.level || 0) >= 25 },
      // Special
      { icon: '&#x1F480;', name: 'Danger Zone', description: 'Complete a Dangerous mode session', earned: (u.achievements || []).includes('danger_zone') },
      { icon: '&#x1F333;', name: 'Forest', description: 'Grow your tree to max stage', earned: (u.treeStage || 0) >= 11 },
      { icon: '&#x1F91D;', name: 'Social Writer', description: 'Add your first friend', earned: (u.friends || []).length >= 1 },
      { icon: '&#x1F465;', name: 'Writing Circle', description: 'Have 5 friends', earned: (u.friends || []).length >= 5 },
    ];
  },

  async loadFriends() {
    const container = document.getElementById('friends-list');
    const reqSection = document.getElementById('friend-requests-section');
    const sugSection = document.getElementById('friend-suggestions-section');

    try {
      const [friends, requests, suggestions] = await Promise.all([
        API.getFriends(),
        API.getFriendRequests(),
        API.getFriendSuggestions()
      ]);
      this.friends = friends;

      // Friend requests
      if (requests.length > 0) {
        reqSection.style.display = 'block';
        document.getElementById('friend-requests-list').innerHTML = requests.map(r => `
          <div class="doc-card" style="margin-bottom:8px">
            <div class="doc-card-info">
              <h4>${this.escapeHtml(r.name)}</h4>
              <div class="doc-card-meta"><span>${r.email}</span><span>Level ${this.calcXPLevel(r.totalWords || 0).level}</span></div>
            </div>
            <div class="doc-card-actions">
              <button class="btn btn-small btn-primary" onclick="App.acceptRequest('${r.id}')">Accept</button>
              <button class="doc-action-btn delete" onclick="App.rejectRequest('${r.id}')" title="Decline">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          </div>`).join('');
      } else {
        reqSection.style.display = 'none';
      }

      // Suggestions
      if (suggestions.length > 0) {
        sugSection.style.display = 'block';
        document.getElementById('friend-suggestions-list').innerHTML = suggestions.map(s => `
          <div class="doc-card" style="margin-bottom:8px">
            <div class="doc-card-info">
              <h4>${this.escapeHtml(s.name)}</h4>
              <div class="doc-card-meta"><span>${s.mutualCount} mutual friend${s.mutualCount !== 1 ? 's' : ''}</span><span>Level ${this.calcXPLevel(s.totalWords || 0).level}</span></div>
            </div>
            <div class="doc-card-actions">
              <button class="btn btn-small" onclick="App.addFriendById('${s.email}')">Add</button>
            </div>
          </div>`).join('');
      } else {
        sugSection.style.display = 'none';
      }

      // Friends list
      if (friends.length === 0) {
        container.innerHTML = `<div class="empty-state"><h3>No friends yet</h3><p>Send a request to someone by their email above.</p></div>`;
      } else {
        container.innerHTML = friends.map(f => `
          <div class="doc-card">
            <div class="doc-card-info">
              <h4>${this.escapeHtml(f.name)}</h4>
              <div class="doc-card-meta"><span>${f.email}</span><span>Level ${this.calcXPLevel(f.totalWords || 0).level}</span></div>
            </div>
            <div class="doc-card-actions">
              <button class="btn btn-small" onclick="App.challengeFriend('${f.id}')">Challenge</button>
              <button class="doc-action-btn delete" onclick="App.removeFriend('${f.id}')" title="Remove">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          </div>`).join('');
      }
    } catch {
      container.innerHTML = `<div class="empty-state"><p>Failed to load friends.</p></div>`;
    }
  },

  async addFriend() {
    const input = document.getElementById('friend-email-input');
    const email = input.value.trim();
    if (!email) return;
    try {
      const result = await API.sendFriendRequest(email);
      input.value = '';
      this.toast(result.message || 'Request sent!', 'success');
      this.loadFriends();
    } catch (err) {
      this.toast(err.message || 'Failed to send request', 'error');
    }
  },

  async addFriendById(email) {
    try {
      const result = await API.sendFriendRequest(email);
      this.toast(result.message || 'Request sent!', 'success');
      this.loadFriends();
    } catch (err) {
      this.toast(err.message || 'Failed', 'error');
    }
  },

  async acceptRequest(fromId) {
    try {
      await API.acceptFriendRequest(fromId);
      this.toast('Friend request accepted!', 'success');
      this.loadFriends();
      this.updateNotifBadge();
    } catch (err) {
      this.toast(err.message || 'Failed', 'error');
    }
  },

  async rejectRequest(fromId) {
    try {
      await API.rejectFriendRequest(fromId);
      this.toast('Request declined', '');
      this.loadFriends();
      this.updateNotifBadge();
    } catch (err) {
      this.toast(err.message || 'Failed', 'error');
    }
  },

  async removeFriend(id) {
    try {
      await API.removeFriend(id);
      this.toast('Friend removed', '');
      this.loadFriends();
    } catch {
      this.toast('Failed to remove friend', 'error');
    }
  },

  async startNotifPolling() {
    const poll = async () => {
      try { await this.updateNotifBadge(); } catch {}
    };
    poll();
    this.notifInterval = setInterval(poll, 30000);
  },

  async updateNotifBadge() {
    try {
      const requests = await API.getFriendRequests();
      const badge = document.getElementById('friends-badge');
      if (!badge) return;
      if (requests.length > 0) {
        badge.textContent = requests.length;
        badge.style.display = 'inline-flex';
      } else {
        badge.style.display = 'none';
      }
    } catch {}
  },

  async createFolder() {
    // Use a simple prompt-style inline approach via the confirm dialog
    const overlay = document.getElementById('confirm-overlay');
    const msgEl = document.getElementById('confirm-message');
    msgEl.innerHTML = '<span>Folder name:</span><br><input id="folder-name-input" style="margin-top:10px;width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-elevated);color:var(--text-primary);font-family:var(--font-sans);font-size:13px" placeholder="My Folder" autofocus>';
    overlay.classList.add('active');
    setTimeout(() => document.getElementById('folder-name-input')?.focus(), 100);

    const result = await new Promise(resolve => {
      document.getElementById('confirm-ok').onclick = () => {
        const val = document.getElementById('folder-name-input')?.value?.trim();
        overlay.classList.remove('active');
        resolve(val || null);
      };
      document.getElementById('confirm-cancel').onclick = () => {
        overlay.classList.remove('active');
        resolve(null);
      };
    });

    if (!result) return;
    try {
      await API.createFolder(result, this.currentFolder);
      this.toast('Folder created', 'success');
      this.loadDocuments();
    } catch (err) {
      this.toast(err.message || 'Failed to create folder', 'error');
    }
  },

  getFolderPath(folderId) {
    const path = [];
    let id = folderId;
    while (id) {
      const f = this.folders.find(fl => fl.id === id);
      if (!f) break;
      path.unshift(f);
      id = f.parentFolder || null;
    }
    return path;
  },

  countDocsInFolder(folderId, docs) {
    let count = docs.filter(d => d.folder === folderId).length;
    const children = this.folders.filter(f => f.parentFolder === folderId);
    children.forEach(c => { count += this.countDocsInFolder(c.id, docs); });
    return count;
  },

  getDescendantFolderIds(folderId) {
    const ids = new Set([folderId]);
    const collect = (id) => {
      this.folders.filter(f => f.parentFolder === id).forEach(f => {
        ids.add(f.id);
        collect(f.id);
      });
    };
    collect(folderId);
    return ids;
  },

  showDocMenu(anchorEl, doc) {
    document.querySelectorAll('.folder-context-menu').forEach(m => m.remove());

    const isFailed = doc.deletedBySystem;
    const menu = document.createElement('div');
    menu.className = 'folder-context-menu';
    menu.innerHTML = `
      ${isFailed ? '' : `<button data-action="move"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg> Move to folder</button>`}
      ${isFailed ? '' : `<button data-action="share"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/><polyline points="16,6 12,2 8,6"/><line x1="12" y1="2" x2="12" y2="15"/></svg> Share</button>`}
      <button data-action="delete" style="color:var(--danger)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg> Delete</button>
    `;

    const rect = anchorEl.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.right = `${window.innerWidth - rect.right}px`;
    menu.style.left = 'auto';
    document.body.appendChild(menu);

    const close = () => { menu.remove(); document.removeEventListener('click', close); };
    setTimeout(() => document.addEventListener('click', close), 0);

    if (!isFailed) {
      menu.querySelector('[data-action="move"]').onclick = (e) => { e.stopPropagation(); close(); this.moveDocToFolder(doc.id); };
      menu.querySelector('[data-action="share"]').onclick = (e) => { e.stopPropagation(); close(); this.shareDoc(doc.id); };
    }
    menu.querySelector('[data-action="delete"]').onclick = (e) => { e.stopPropagation(); close(); this.deleteDoc(doc.id); };
  },

  showFolderMenu(folderId, anchorEl) {
    // Remove existing menu
    document.querySelectorAll('.folder-context-menu').forEach(m => m.remove());

    const menu = document.createElement('div');
    menu.className = 'folder-context-menu';
    menu.innerHTML = `
      <button data-action="rename">Rename</button>
      <button data-action="move">Move to...</button>
      <button data-action="delete" style="color:var(--danger)">Delete</button>
    `;

    const rect = anchorEl.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${rect.left}px`;
    document.body.appendChild(menu);

    const close = () => { menu.remove(); document.removeEventListener('click', close); };
    setTimeout(() => document.addEventListener('click', close), 0);

    menu.querySelector('[data-action="rename"]').onclick = (e) => {
      e.stopPropagation();
      close();
      this.renameFolder(folderId);
    };
    menu.querySelector('[data-action="move"]').onclick = (e) => {
      e.stopPropagation();
      close();
      this.openFolderPicker(folderId, 'folder');
    };
    menu.querySelector('[data-action="delete"]').onclick = (e) => {
      e.stopPropagation();
      close();
      this.deleteFolder(folderId);
    };
  },

  async renameFolder(folderId) {
    const folder = this.folders.find(f => f.id === folderId);
    if (!folder) return;

    const overlay = document.getElementById('confirm-overlay');
    const msgEl = document.getElementById('confirm-message');
    msgEl.innerHTML = `<span>Rename folder:</span><br><input id="folder-rename-input" value="${this.escapeHtml(folder.name)}" style="margin-top:10px;width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-elevated);color:var(--text-primary);font-family:var(--font-sans);font-size:13px" autofocus>`;
    overlay.classList.add('active');
    setTimeout(() => { const inp = document.getElementById('folder-rename-input'); inp?.focus(); inp?.select(); }, 100);

    const result = await new Promise(resolve => {
      document.getElementById('confirm-ok').onclick = () => {
        const val = document.getElementById('folder-rename-input')?.value?.trim();
        overlay.classList.remove('active');
        resolve(val || null);
      };
      document.getElementById('confirm-cancel').onclick = () => {
        overlay.classList.remove('active');
        resolve(null);
      };
    });

    if (!result || result === folder.name) return;
    try {
      await API.renameFolder(folderId, result);
      this.toast('Folder renamed', 'success');
      this.loadDocuments();
    } catch (err) {
      this.toast(err.message || 'Failed to rename', 'error');
    }
  },

  async deleteFolder(folderId) {
    const ok = await this.showConfirm('Delete this folder? Documents inside will be moved to the parent folder.');
    if (!ok) return;
    try {
      await API.deleteFolder(folderId);
      if (this.currentFolder === folderId) this.currentFolder = null;
      this.toast('Folder deleted', 'success');
      this.loadDocuments();
    } catch {
      this.toast('Failed to delete folder', 'error');
    }
  },

  // Finder-style folder picker for moving docs or folders
  openFolderPicker(itemId, itemType) {
    const overlay = document.getElementById('confirm-overlay');
    const msgEl = document.getElementById('confirm-message');
    const okBtn = document.getElementById('confirm-ok');
    const cancelBtn = document.getElementById('confirm-cancel');

    // Exclude the item itself and its descendants (if folder)
    const excludeIds = itemType === 'folder' ? this.getDescendantFolderIds(itemId) : new Set();

    // Build flat indented tree
    const buildTree = (parentId, depth) => {
      const children = this.folders.filter(f =>
        (f.parentFolder || null) === parentId && !excludeIds.has(f.id)
      );
      let rows = [];
      children.forEach(f => {
        rows.push({ id: f.id, name: f.name, depth });
        rows = rows.concat(buildTree(f.id, depth + 1));
      });
      return rows;
    };

    const treeRows = buildTree(null, 0);

    // Determine where the item currently lives
    let currentFolderId = null;
    if (itemType === 'doc') {
      const doc = this.documents.find(d => d.id === itemId);
      currentFolderId = doc?.folder || null;
    } else {
      const folder = this.folders.find(f => f.id === itemId);
      currentFolderId = folder?.parentFolder || null;
    }
    const currentFolderName = currentFolderId
      ? (this.folders.find(f => f.id === currentFolderId)?.name || 'Unknown')
      : 'All Sessions (Root)';
    const isRootCurrent = !currentFolderId;

    let html = `<div class="finder-picker">`;
    html += `<div class="finder-current-loc">Currently in: <strong>${this.escapeHtml(currentFolderName)}</strong></div>`;
    html += `<div class="finder-list">`;
    // Root option
    html += `<div class="finder-row finder-row-depth-0${isRootCurrent ? ' current' : ''}" data-picker-id="">
      <span class="finder-row-icon">📂</span>
      <span class="finder-row-name">All Sessions (Root)</span>
      ${isRootCurrent ? '<span class="finder-row-current">📍 Here</span>' : ''}
    </div>`;
    treeRows.forEach(r => {
      const pad = 12 + r.depth * 24;
      const isCurrent = r.id === currentFolderId;
      html += `<div class="finder-row finder-row-depth-${r.depth}${isCurrent ? ' current' : ''}" data-picker-id="${r.id}" style="padding-left:${pad}px">
        <span class="finder-row-icon">${r.depth === 0 ? '📂' : '📁'}</span>
        <span class="finder-row-name">${this.escapeHtml(r.name)}</span>
        ${isCurrent ? '<span class="finder-row-current">📍 Here</span>' : ''}
      </div>`;
    });
    if (treeRows.length === 0) {
      html += `<div class="finder-empty">No folders yet</div>`;
    }
    html += `</div></div>`;

    msgEl.innerHTML = `<span style="font-weight:600">Move to:</span>${html}`;

    // Bind selection
    msgEl.querySelectorAll('.finder-row[data-picker-id]').forEach(row => {
      row.onclick = () => {
        msgEl.querySelectorAll('.finder-row').forEach(r => r.classList.remove('selected'));
        row.classList.add('selected');
      };
    });

    okBtn.textContent = 'Move Here';
    overlay.classList.add('active');

    const cleanup = () => { okBtn.textContent = 'OK'; };

    return new Promise(resolve => {
      okBtn.onclick = async () => {
        overlay.classList.remove('active');
        cleanup();
        const selected = msgEl.querySelector('.finder-row.selected');
        const target = selected ? (selected.dataset.pickerId || null) : null;
        try {
          if (itemType === 'folder') {
            await API.moveFolderTo(itemId, target);
          } else {
            await API.moveToFolder(itemId, target);
          }
          this.toast('Moved!', 'success');
          this.loadDocuments();
        } catch {
          this.toast('Failed to move', 'error');
        }
        resolve();
      };
      cancelBtn.onclick = () => {
        overlay.classList.remove('active');
        cleanup();
        resolve();
      };
    });
  },

  async moveDocToFolder(docId) {
    if (this.folders.length === 0) {
      this.toast('Create a folder first', 'error');
      return;
    }
    this.openFolderPicker(docId, 'doc');
  },

  openHistoryModal() {
    // Include completed, failed/abandoned, AND admin-deactivated sessions
    const completed = this.documents.filter(d => !d.deleted && !d.deactivatedByAdmin && d.duration > 0);
    const failed = this.documents.filter(d => d.deleted && d.deletedBySystem && !d.deactivatedByAdmin);
    const adminDeactivated = this.documents.filter(d => d.deactivatedByAdmin);

    const totalWords = completed.reduce((s, d) => s + (d.wordCount || 0), 0);
    const totalSessions = completed.length;
    const totalMinutes = Math.round(completed.reduce((s, d) => s + (d.duration || 0), 0) / 60);
    const failedCount = failed.length;

    document.getElementById('history-stats').innerHTML = `
      <div class="history-stat"><div class="history-stat-val">${totalSessions}</div><div class="history-stat-label">Completed</div></div>
      <div class="history-stat"><div class="history-stat-val">${totalWords.toLocaleString()}</div><div class="history-stat-label">Words</div></div>
      <div class="history-stat"><div class="history-stat-val">${totalMinutes}m</div><div class="history-stat-label">Written</div></div>
      <div class="history-stat"><div class="history-stat-val">${failedCount}</div><div class="history-stat-label">Failed</div></div>`;

    // Merge and sort all sessions by date
    const allSessions = [
      ...completed.slice(0, 25).map(d => ({ ...d, _failed: false, _adminDeactivated: false })),
      ...failed.slice(0, 10).map(d => ({ ...d, _failed: true, _adminDeactivated: false })),
      ...adminDeactivated.slice(0, 10).map(d => ({ ...d, _failed: false, _adminDeactivated: true }))
    ].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

    document.getElementById('history-sessions').innerHTML = allSessions.length === 0
      ? '<p style="text-align:center;color:var(--text-muted);padding:20px">No sessions yet</p>'
      : allSessions.map(d => {
          const adminTag = d._adminDeactivated
            ? '<span class="session-admin-tag">Deactivated by Admin</span>' : '';
          const failReason = d.failReason === 'typing_stopped'
            ? '<span class="session-danger-tag">Stopped Typing</span>'
            : d.failReason === 'tab_left'
            ? '<span class="session-tab-tag">Left Tab</span>'
            : d.failReason === 'left' || d.failReason === 'abandoned'
            ? '<span class="session-left-tag">Left</span>'
            : d._failed ? '<span class="session-left-tag">Left</span>' : '';
          const modeTag = d.mode === 'dangerous'
            ? '<span class="session-danger-tag" style="background:rgba(239,68,68,0.08)">⚡ Danger</span>' : '';

          const statusTag = d._adminDeactivated ? adminTag : d._failed ? failReason : modeTag;

          return `<div class="session-entry${d._failed ? ' failed-entry' : ''}${d._adminDeactivated ? ' admin-deactivated-entry' : ''}">
            <div>
              <div style="font-weight:600;color:var(--text-primary);font-size:13px">${this.escapeHtml(d.title)}${statusTag}</div>
              <div style="color:var(--text-muted);font-size:11px;margin-top:3px">${this.formatDate(d.updatedAt)}${d._failed && !failReason ? '&nbsp;· Failed' : ''}${d._adminDeactivated ? '&nbsp;· Admin action' : ''}</div>
            </div>
            <div style="text-align:right;flex-shrink:0">
              ${d._adminDeactivated
                ? `<div style="font-size:12px;color:var(--warning)">${(d.wordCount || 0)} words</div>
                   <div style="font-size:11px;color:var(--text-muted)">Deactivated</div>`
                : d._failed
                ? `<div style="font-size:12px;color:var(--danger)">${(d.wordCount || 0)} words lost</div>`
                : `<div style="font-weight:600;font-size:13px">${(d.wordCount || 0).toLocaleString()} words</div>
                   <div style="color:var(--xp-color);font-size:11px">+${d.xpEarned || 0} XP</div>`}
            </div>
          </div>`;
        }).join('');

    document.getElementById('history-modal').classList.add('active');
    document.getElementById('history-sidebar-overlay').classList.add('active');
  },

  closeHistorySidebar() {
    document.getElementById('history-modal').classList.remove('active');
    document.getElementById('history-sidebar-overlay').classList.remove('active');
  },

  closeCommentHistorySidebar() {
    document.getElementById('comment-history-modal').classList.remove('active');
    document.getElementById('comment-history-sidebar-overlay').classList.remove('active');
  },

  challengeFriend(id) {
    document.getElementById('duel-friend-select').value = id;
    this.openDuelModal();
  },

  async saveProfile() {
    const name = document.getElementById('profile-name').value;
    try {
      await API.request('/auth/me', { method: 'PATCH', body: JSON.stringify({ name }) });
      this.user.name = name;
      this.updateUserUI();
      this.toast('Profile updated!', 'success');
    } catch {
      this.toast('Failed to update profile', 'error');
    }
  },

  openPricing() {
    const overlay = document.getElementById('pricing-overlay');
    overlay.classList.add('active');
    const isPro = this.user && this.user.plan === 'premium';
    document.getElementById('pricing-free').classList.toggle('current', !isPro);
    document.getElementById('pricing-pro').classList.toggle('current', isPro);
    document.getElementById('plan-free-btn').textContent = !isPro ? 'Current Plan' : 'Downgrade';
    document.getElementById('plan-free-btn').disabled = !isPro;
    document.getElementById('plan-pro-btn').textContent = isPro ? 'Current Plan' : 'Upgrade to Pro';
    document.getElementById('plan-pro-btn').disabled = isPro;
  },

  closePricing() {
    document.getElementById('pricing-overlay').classList.remove('active');
  },

  openStreakPopup() {
    const overlay = document.getElementById('streak-popup-overlay');
    const streak = this.user?.streak || 0;
    const best = this.user?.longestStreak || 0;
    document.getElementById('streak-popup-count').textContent = streak;
    document.getElementById('streak-popup-best').textContent = `Best: ${best} days`;
    // Dynamic motivational message
    let msg = 'Start writing today to begin your streak!';
    if (streak >= 100) msg = 'Absolutely legendary. You are a writing machine!';
    else if (streak >= 60) msg = 'Two months strong! Nothing can stop you!';
    else if (streak >= 30) msg = 'A full month! You\'re a writing legend!';
    else if (streak >= 14) msg = 'Two weeks! Your dedication is inspiring!';
    else if (streak >= 7) msg = 'A whole week! Keep the momentum going!';
    else if (streak >= 3) msg = 'You\'re on fire! Don\'t break the chain!';
    else if (streak >= 1) msg = 'Great start! Come back tomorrow to keep it going!';
    document.getElementById('streak-popup-message').textContent = msg;
    overlay.classList.add('active');
    overlay.onclick = (e) => { if (e.target === overlay) this.closeStreakPopup(); };
  },

  closeStreakPopup() {
    document.getElementById('streak-popup-overlay').classList.remove('active');
  },

  _showLevelUpQueue(levels) {
    if (!levels || levels.length === 0) return;
    const level = levels[0];
    const remaining = levels.slice(1);

    this.launchConfetti();

    const overlay = document.createElement('div');
    overlay.className = 'levelup-overlay';
    const queueText = remaining.length > 0 ? `<p class="levelup-queue">${remaining.length} more level-up${remaining.length > 1 ? 's' : ''} waiting...</p>` : '';
    overlay.innerHTML = `
      <div class="levelup-modal">
        <div class="levelup-glow"></div>
        <div class="levelup-badge">${level}</div>
        <h2 class="levelup-title">Level Up!</h2>
        <p class="levelup-sub">You've reached <strong>Level ${level}</strong></p>
        <p class="levelup-msg">Keep writing to unlock the next level. Every word counts!</p>
        ${queueText}
        <button class="btn btn-primary levelup-btn">${remaining.length > 0 ? 'Next' : 'Keep Writing'}</button>
      </div>
    `;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('active'));

    const dismiss = () => {
      overlay.classList.remove('active');
      setTimeout(() => {
        overlay.remove();
        if (remaining.length > 0) {
          setTimeout(() => this._showLevelUpQueue(remaining), 300);
        }
      }, 400);
    };

    overlay.querySelector('.levelup-btn').onclick = dismiss;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) dismiss();
    });
  },

  launchConfetti() {
    const colors = ['#6c5ce7', '#a78bfa', '#f59e0b', '#22c55e', '#ef4444', '#3b82f6', '#ec4899'];
    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:30000;overflow:hidden';
    document.body.appendChild(container);

    for (let i = 0; i < 80; i++) {
      const piece = document.createElement('div');
      const color = colors[Math.floor(Math.random() * colors.length)];
      const x = 50 + (Math.random() - 0.5) * 40;
      const rotation = Math.random() * 360;
      const delay = Math.random() * 0.3;
      const size = 6 + Math.random() * 6;
      const shape = Math.random() > 0.5 ? '50%' : '2px';

      piece.style.cssText = `
        position:absolute;left:${x}%;top:40%;width:${size}px;height:${size * 1.4}px;
        background:${color};border-radius:${shape};opacity:1;
        animation:confetti-fall ${1.5 + Math.random()}s ease-out ${delay}s forwards;
      `;
      container.appendChild(piece);
    }

    setTimeout(() => container.remove(), 3000);
  },

  formatDate(dateStr) {
    const d = new Date(dateStr);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  },

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  _applyTheme(theme) {
    const isLight = theme === 'light';
    document.documentElement.classList.toggle('light', isLight);
    localStorage.setItem('iwrite_theme', theme);
    const btn = document.getElementById('theme-toggle-btn');
    if (!btn) return;
    btn.querySelector('.theme-icon-dark').style.display = isLight ? 'none' : '';
    btn.querySelector('.theme-icon-light').style.display = isLight ? '' : 'none';
    btn.querySelector('.theme-toggle-label').textContent = isLight ? 'Dark Mode' : 'Light Mode';
  },

  async openCommentHistory() {
    if (!Editor.documentId) {
      this.toast('No document open', 'error');
      return;
    }
    const sidebar = document.getElementById('comment-history-modal');
    const overlay = document.getElementById('comment-history-sidebar-overlay');
    const list = document.getElementById('comment-history-list');
    list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">Loading...</div>';
    sidebar.classList.add('active');
    overlay.classList.add('active');

    try {
      const history = await API.getCommentHistory(Editor.documentId);
      if (!history || history.length === 0) {
        list.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:20px">No resolved comments yet.</p>';
        return;
      }
      list.innerHTML = history.map(c => `
        <div style="padding:12px 0;border-bottom:1px solid var(--border-light)">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <span style="font-weight:600;font-size:13px">${this.escapeHtml(c.author || 'Unknown')}</span>
            <span style="font-size:11px;color:var(--text-muted)">${new Date(c.resolvedAt || c.createdAt).toLocaleDateString()}</span>
          </div>
          ${c.highlightedText ? `<div style="font-size:12px;color:var(--text-muted);font-style:italic;margin-bottom:4px">"${this.escapeHtml(c.highlightedText.substring(0, 80))}${c.highlightedText.length > 80 ? '...' : ''}"</div>` : ''}
          <div style="font-size:13px;color:var(--text-secondary)">${this.escapeHtml(c.text || '')}</div>
          <div style="margin-top:4px">
            <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:${c.status === 'rejected' ? 'var(--danger)' : 'var(--success)'}">
              ${c.status === 'rejected' ? '✗ Rejected' : '✓ Resolved'}
            </span>
          </div>
        </div>`).join('');
    } catch (err) {
      list.innerHTML = `<p style="text-align:center;color:var(--text-muted);padding:20px">No comment history found.</p>`;
    }
  },

  showConfirm(message) {
    return new Promise((resolve) => {
      const overlay = document.getElementById('confirm-overlay');
      const msgEl = document.getElementById('confirm-message');
      msgEl.textContent = message;
      overlay.classList.add('active');
      document.getElementById('confirm-ok').onclick = () => {
        overlay.classList.remove('active');
        resolve(true);
      };
      document.getElementById('confirm-cancel').onclick = () => {
        overlay.classList.remove('active');
        resolve(false);
      };
    });
  },

  toast(message, type = '') {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    const el = document.getElementById('toast');
    el.textContent = message;
    el.className = `toast visible ${type}`;
    this.toastTimer = setTimeout(() => {
      el.className = 'toast';
      this.toastTimer = null;
    }, 3000);
  },

  // ===== SUPPORT =====
  async loadSupport() {
    const list = document.getElementById('support-tickets-list');
    try {
      const tickets = await API.getSupportTickets();
      if (tickets.length === 0) {
        list.innerHTML = '<div class="empty-state"><p>No tickets yet. Submit one above!</p></div>';
        return;
      }
      list.innerHTML = tickets.map(t => {
        const statusClass = t.status === 'open' ? 'open' : t.status === 'replied' ? 'replied' : 'closed';
        return `
        <div class="ticket">
          <div class="ticket-row">
            <span class="ticket-type ticket-type--${t.type}">${t.type}</span>
            <strong class="ticket-subject">${this._esc(t.subject)}</strong>
            <span class="ticket-meta">
              <span class="ticket-date">${new Date(t.createdAt).toLocaleDateString()}</span>
              <span class="ticket-status ticket-status--${statusClass}">${t.status}</span>
            </span>
          </div>
          <p class="ticket-body">${this._esc(t.message)}</p>
          ${t.adminReply ? `<div class="ticket-reply"><span class="ticket-reply-label">Reply</span> ${this._esc(t.adminReply)}</div>` : ''}
        </div>`;
      }).join('');
    } catch {
      list.innerHTML = '<div class="empty-state"><p>Failed to load tickets.</p></div>';
    }
  },

  async submitSupportTicket() {
    const type = document.getElementById('support-type').value;
    const subject = document.getElementById('support-subject').value.trim();
    const message = document.getElementById('support-message').value.trim();
    if (!subject || !message) {
      this.toast('Please fill in subject and message', 'error');
      return;
    }
    try {
      await API.submitSupportTicket(subject, message, type);
      document.getElementById('support-subject').value = '';
      document.getElementById('support-message').value = '';
      this.toast('Ticket submitted!', 'success');
      this.loadSupport();
    } catch (err) {
      this.toast(err.message || 'Failed to submit', 'error');
    }
  },

  _esc(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  },

  // ===== HELP POPUP =====
  _helpTopics: {
    'how-it-works': {
      title: 'How It Works',
      html: `<p>iWrite is a distraction-free writing tool built on one rule: <strong>write it or lose it</strong>.</p>
        <ol><li>Set a timer and choose a mode.</li><li>The editor opens — tab switching is locked.</li><li>Leave the tab and a 10-second countdown starts. Don't come back in time and your writing is deleted forever.</li><li>Complete the session to save your document and earn XP.</li></ol>`
    },
    'writing-modes': {
      title: 'Writing Modes',
      html: `<p>Choose your level of risk before each session.</p>
        <p><strong>Normal</strong> — Tab-lock only. Leave the tab and your writing gets a 10-second grace period. Come back before it runs out.</p>
        <p><strong>Dangerous</strong> — Stop typing for <strong>5 seconds</strong> and the session fails automatically. Your writing is deleted. No exceptions.</p>`
    },
    'xp-levels': {
      title: 'XP & Levels',
      html: `<p>Every completed session earns you XP based on your output:</p>
        <ul><li><strong>Base XP</strong> — 0.5 XP per word written</li><li><strong>Time bonus</strong> — 2 XP per minute of writing</li><li><strong>Dangerous bonus</strong> — +50% of base XP for completing Dangerous mode</li></ul>
        <p>You level up at increasing XP thresholds. Level 1 = <strong>300 XP</strong>, each next level requires <strong>25% more</strong> (375, 469, 586...). There's no level cap — keep writing.</p>`
    },
    'streaks': {
      title: 'Streaks',
      html: `<p>Write at least one session every day to maintain your streak.</p>
        <ul><li>Miss a day and your streak resets to 0.</li><li>Your longest streak is always saved on your profile.</li><li>Streak milestones unlock achievements.</li></ul>`
    },
    'tree': {
      title: 'Your Writing Tree',
      html: `<p>Your tree is a visual reflection of your consistency. It grows one stage each day you complete a session.</p>
        <ul><li>12 stages: Seed, Sprout, Seedling, Sapling, Young Tree, Growing Tree, Mature Tree, Strong Tree, Grand Tree, Ancient Tree, World Tree, <strong>Forest</strong></li><li>Break your streak and your tree <strong>resets back to a seed</strong>.</li><li>Active streaks give your tree a warm golden glow.</li></ul>`
    },
    'leaderboard': {
      title: 'Leaderboard',
      html: `<p>The public leaderboard ranks all writers by total words written, showing the top 50.</p>
        <ul><li>Total words are cumulative across all sessions — they never reset.</li><li>The podium shows the top 3 writers.</li><li>Your row is highlighted so you can see where you stand.</li></ul>`
    },
    'friends-duels': {
      title: 'Friends & Duels',
      html: `<p>Add friends by their email address to challenge them to writing duels.</p>
        <ul><li><strong>Duels</strong> — a timed head-to-head battle. Most words written in the time limit wins.</li><li><strong>Adding friends</strong> — enter their email in the Friends tab. They'll appear in your friends list.</li></ul>
        <p style="color:var(--text-muted);font-size:13px">Live duel matchmaking is coming soon.</p>`
    },
    'sharing': {
      title: 'Sharing Documents',
      html: `<p>Completed documents can be shared with a unique link.</p>
        <ul><li><strong>View</strong> — recipient can read your document.</li><li><strong>Comment</strong> — recipient can leave comments.</li><li><strong>Edit</strong> — recipient can edit the content.</li></ul>
        <p>Click the share icon on any document card to copy a view link to clipboard.</p>`
    }
  },

  openHelpTopic(key) {
    const topic = this._helpTopics[key];
    if (!topic) return;
    document.getElementById('help-popup-body').innerHTML = `<h3>${topic.title}</h3>${topic.html}`;
    document.getElementById('help-popup-overlay').classList.add('visible');
    document.getElementById('help-popup').classList.add('visible');
  },

  closeHelpPopup() {
    document.getElementById('help-popup-overlay').classList.remove('visible');
    document.getElementById('help-popup').classList.remove('visible');
  }
};

// ===== COMMENT SYSTEM =====
const CommentSystem = {
  comments: [],
  documentId: null,
  shareToken: null,
  isOwner: false,
  _selectionHandler: null,

  init(documentId, comments, isOwner, shareToken) {
    this.documentId = documentId;
    this.comments = comments.filter(c => c.status === 'pending');
    this.isOwner = isOwner;
    this.shareToken = shareToken;
    this.renderHighlights();
    this.renderPanel();
    this.bindSelectionListener();
  },

  destroy() {
    if (this._selectionHandler) {
      document.getElementById('editor-textarea')?.removeEventListener('mouseup', this._selectionHandler);
      this._selectionHandler = null;
    }
    const panel = document.getElementById('comments-panel');
    if (panel) panel.remove();
    const btn = document.getElementById('add-comment-btn');
    if (btn) btn.remove();
    const popup = document.getElementById('comment-input-popup');
    if (popup) popup.remove();
    document.getElementById('editor-container')?.classList.remove('has-comments');
    this.comments = [];
  },

  bindSelectionListener() {
    const contentEl = document.getElementById('editor-textarea');
    if (!contentEl) return;

    this._selectionHandler = () => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        this.hideCommentButton();
        return;
      }

      const range = selection.getRangeAt(0);
      if (!contentEl.contains(range.commonAncestorContainer)) return;

      const selectedText = selection.toString().trim();
      if (selectedText.length === 0) return;

      const preRange = document.createRange();
      preRange.selectNodeContents(contentEl);
      preRange.setEnd(range.startContainer, range.startOffset);
      const startOffset = preRange.toString().length;
      const endOffset = startOffset + selectedText.length;

      this.showCommentButton(range, selectedText, startOffset, endOffset);
    };

    contentEl.addEventListener('mouseup', this._selectionHandler);
  },

  showCommentButton(range, selectedText, startOffset, endOffset) {
    let btn = document.getElementById('add-comment-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'add-comment-btn';
      btn.className = 'comment-add-btn';
      btn.textContent = 'Comment';
      document.body.appendChild(btn);
    }

    const rect = range.getBoundingClientRect();
    btn.style.display = 'block';
    btn.style.top = `${rect.top - 40 + window.scrollY}px`;
    btn.style.left = `${rect.left + rect.width / 2}px`;

    btn.onclick = () => {
      this.showCommentInput(selectedText, startOffset, endOffset, rect);
      btn.style.display = 'none';
    };
  },

  hideCommentButton() {
    const btn = document.getElementById('add-comment-btn');
    if (btn) btn.style.display = 'none';
  },

  showCommentInput(selectedText, startOffset, endOffset, rect) {
    let popup = document.getElementById('comment-input-popup');
    if (!popup) {
      popup = document.createElement('div');
      popup.id = 'comment-input-popup';
      popup.className = 'comment-input-popup';
      popup.innerHTML = `
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;font-style:italic">"${App.escapeHtml(selectedText.substring(0, 60))}${selectedText.length > 60 ? '...' : ''}"</div>
        <textarea id="comment-input-text" placeholder="Write your comment..."></textarea>
        <div class="comment-input-actions">
          <button class="btn btn-ghost btn-small" id="comment-input-cancel">Cancel</button>
          <button class="btn btn-primary btn-small" id="comment-input-submit">Post</button>
        </div>
      `;
      document.body.appendChild(popup);
    } else {
      popup.querySelector('div').innerHTML = `"${App.escapeHtml(selectedText.substring(0, 60))}${selectedText.length > 60 ? '...' : ''}"`;
      popup.querySelector('textarea').value = '';
    }

    popup.style.top = `${rect.bottom + 8 + window.scrollY}px`;
    popup.style.left = `${Math.min(rect.left, window.innerWidth - 300)}px`;
    popup.classList.add('active');
    popup.querySelector('textarea').focus();

    document.getElementById('comment-input-cancel').onclick = () => {
      popup.classList.remove('active');
    };

    document.getElementById('comment-input-submit').onclick = async () => {
      const text = document.getElementById('comment-input-text').value.trim();
      if (!text) return;

      try {
        // Find a comment-type share token for this document
        let token = this.shareToken;
        if (!token) {
          // Owner commenting on own doc — need to find or create a share link
          const link = await API.shareDocument(this.documentId, 'comment');
          token = link.token;
          this.shareToken = token;
        }
        const comment = await API.addComment(token, text, selectedText, startOffset, endOffset);
        this.comments.push(comment);
        this.renderHighlights();
        this.renderPanel();
        popup.classList.remove('active');
        App.toast('Comment added', 'success');
      } catch (e) {
        App.toast('Failed to add comment', 'error');
      }
    };
  },

  renderHighlights() {
    const contentEl = document.getElementById('editor-textarea');
    if (!contentEl) return;

    // Remove existing highlights
    contentEl.querySelectorAll('.comment-highlight').forEach(mark => {
      const parent = mark.parentNode;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
    });

    if (this.comments.length === 0) return;

    // Sort comments by startOffset descending to avoid offset shifting
    const sorted = [...this.comments]
      .filter(c => c.startOffset !== null && c.endOffset !== null)
      .sort((a, b) => b.startOffset - a.startOffset);

    sorted.forEach(comment => {
      try {
        this._highlightRange(contentEl, comment.startOffset, comment.endOffset, comment.id);
      } catch {}
    });
  },

  _highlightRange(root, startOffset, endOffset, commentId) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let currentOffset = 0;
    let startNode = null, startNodeOffset = 0;
    let endNode = null, endNodeOffset = 0;

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const nodeLen = node.textContent.length;

      if (!startNode && currentOffset + nodeLen > startOffset) {
        startNode = node;
        startNodeOffset = startOffset - currentOffset;
      }
      if (currentOffset + nodeLen >= endOffset) {
        endNode = node;
        endNodeOffset = endOffset - currentOffset;
        break;
      }
      currentOffset += nodeLen;
    }

    if (!startNode || !endNode) return;

    const range = document.createRange();
    range.setStart(startNode, Math.min(startNodeOffset, startNode.textContent.length));
    range.setEnd(endNode, Math.min(endNodeOffset, endNode.textContent.length));

    const mark = document.createElement('mark');
    mark.className = 'comment-highlight';
    mark.dataset.commentId = commentId;
    mark.addEventListener('click', () => {
      document.querySelectorAll('.comment-bubble').forEach(b => b.classList.remove('active'));
      const bubble = document.querySelector(`.comment-bubble[data-id="${commentId}"]`);
      if (bubble) {
        bubble.classList.add('active');
        bubble.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });

    try {
      range.surroundContents(mark);
    } catch {
      // If range spans multiple nodes, wrap what we can
      mark.appendChild(range.extractContents());
      range.insertNode(mark);
    }
  },

  renderPanel() {
    let panel = document.getElementById('comments-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'comments-panel';
      panel.className = 'comments-panel';
      document.getElementById('editor-container')?.appendChild(panel);
    }

    if (this.comments.length === 0) {
      panel.classList.remove('active');
      document.getElementById('editor-container')?.classList.remove('has-comments');
      return;
    }

    panel.classList.add('active');
    document.getElementById('editor-container')?.classList.add('has-comments');

    panel.innerHTML = `
      <div class="comments-panel-header">Comments (${this.comments.length})</div>
      ${this.comments.map(c => `
        <div class="comment-bubble" data-id="${c.id}">
          <div class="comment-bubble-header">
            <span class="comment-bubble-author">${App.escapeHtml(c.author)}</span>
            <span class="comment-bubble-date">${new Date(c.createdAt).toLocaleDateString()}</span>
          </div>
          ${c.highlightedText ? `<div class="comment-bubble-quote">"${App.escapeHtml(c.highlightedText.substring(0, 80))}${c.highlightedText.length > 80 ? '...' : ''}"</div>` : ''}
          <div class="comment-bubble-text">${App.escapeHtml(c.text)}</div>
          ${this.isOwner ? `
            <div class="comment-bubble-actions">
              <button class="comment-resolve-btn accept" onclick="CommentSystem.resolveComment('${c.id}', 'done')">Done</button>
            </div>
          ` : ''}
        </div>
      `).join('')}
    `;

    // Hover highlight connection
    panel.querySelectorAll('.comment-bubble').forEach(bubble => {
      bubble.addEventListener('mouseenter', () => {
        const mark = document.querySelector(`.comment-highlight[data-comment-id="${bubble.dataset.id}"]`);
        if (mark) mark.classList.add('active');
      });
      bubble.addEventListener('mouseleave', () => {
        document.querySelectorAll('.comment-highlight.active').forEach(m => m.classList.remove('active'));
      });
    });
  },

  async resolveComment(commentId, status) {
    try {
      let token = this.shareToken;
      if (!token) {
        // Find a share link for this document
        const link = await API.shareDocument(this.documentId, 'comment');
        token = link.token;
        this.shareToken = token;
      }
      await API.resolveComment(token, commentId, status);
      this.comments = this.comments.filter(c => c.id !== commentId);
      this.renderHighlights();
      this.renderPanel();
      App.toast('Comment marked as done', 'success');
    } catch {
      App.toast('Failed to resolve comment', 'error');
    }
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());
