// Get CSS variable value from current theme
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const App = {
  user: null,
  documents: [],
  friends: [],
  folders: [],
  currentFolder: null, // null = root
  currentView: 'dashboard',
  _docsCacheLoaded: false,
  _docsCacheDirty: true,
  _docsPage: 1,
  _docsPerPage: 10,
  _searchQuery: '',
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

    // Persist invite param across login flow
    const inviteUser = params.get('invite');
    if (inviteUser) {
      localStorage.setItem('iwrite_pending_invite', inviteUser);
    }

    const pendingStory = params.get('story');
    if (pendingStory) {
      localStorage.setItem('iwrite_pending_story', pendingStory);
    }

    // Persist referral code across login flow
    const refCode = params.get('ref');
    if (refCode) {
      localStorage.setItem('iwrite_ref', refCode);
      window.history.replaceState({}, document.title, '/app');
    }

    // Check for Stripe session_id (returning from checkout)
    const stripeSessionId = params.get('session_id');
    if (stripeSessionId) {
      localStorage.setItem('iwrite_stripe_session', stripeSessionId);
    }

    const token = API.getToken();
    if (!token) {
      // Allow public profile viewing without login
      const hash = location.hash.replace('#', '');
      const [hashBase, hashParam] = hash.split('/', 2);
      if (hashBase === 'user-profile' && hashParam) {
        document.getElementById('auth-view').style.display = 'none';
        document.getElementById('app-view').style.display = 'block';
        document.querySelectorAll('.sidebar').forEach(s => s.style.display = 'none');
        document.querySelector('.main-content').style.marginLeft = '0';
        this.switchView('user-profile');
        this.loadUserProfile(decodeURIComponent(hashParam));
        return;
      }
      this.showAuth();
      return;
    }

    try {
      this.user = await API.getMe();
      if (this.user.role === 'admin') {
        localStorage.setItem('iwrite_admin_token', token);
        window.location.href = '/manual-login';
        return;
      }
      this.showApp();
      if (this.user.needsProfile) {
        this.showProfileCompleteModal();
      }

      // Handle Stripe return — verify payment and celebrate
      const pendingSession = localStorage.getItem('iwrite_stripe_session');
      if (pendingSession) {
        localStorage.removeItem('iwrite_stripe_session');
        this._verifyStripeSession(pendingSession);
      }
    } catch (err) {
      // Only clear token on 401 (expired/invalid) — NOT on network errors
      // so users stay logged in during deploys/restarts
      if (err && err.status === 401) {
        API.clearToken();
        this.showAuth();
      } else {
        // Network error or server down — retry after 3s, keep token
        console.warn('Server unreachable, retrying...', err);
        setTimeout(() => this.init(), 3000);
        return;
      }
    }

    // Analytics pageview
    fetch('/api/analytics/pageview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: window.location.pathname })
    }).catch(() => {});
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
          shape: 'rectangular',
          width: 320
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
        body: JSON.stringify({ credential: response.credential, ref: localStorage.getItem('iwrite_ref') || undefined })
      });

      if (!res.ok) {
        const error = await res.json();
        if (errorEl) errorEl.textContent = error.error || 'Google sign-in failed';
        if (errorEl) errorEl.classList.add('visible');
        return;
      }

      const data = await res.json();
      API.setToken(data.token);
      localStorage.removeItem('iwrite_ref');
      this.user = data.user;
      if (this.user.role === 'admin') {
        localStorage.setItem('iwrite_admin_token', data.token);
        window.location.href = '/manual-login';
        return;
      }
      this.showApp();
      // Show profile completion modal for new Google users
      if (data.isNewUser || this.user.needsProfile) {
        this.showProfileCompleteModal();
      }
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
        const hashView = location.hash.replace('#', '');
        const [hashBase, hashParam] = hashView.split('/', 2);
        if (hashBase === 'user-profile' && hashParam) {
          this.switchView('user-profile');
          this.loadUserProfile(decodeURIComponent(hashParam));
        } else {
          const savedView = (hashView && document.getElementById(`view-${hashView}`)) ? hashView : (localStorage.getItem('iwrite_view') || 'dashboard');
          if (!this._openPendingStory()) this.switchView(savedView);
        }
      }
    }).catch(() => {
      const hashView = location.hash.replace('#', '');
      const [hashBase, hashParam] = hashView.split('/', 2);
      if (hashBase === 'user-profile' && hashParam) {
        this.switchView('user-profile');
        this.loadUserProfile(decodeURIComponent(hashParam));
      } else {
        const savedView = (hashView && document.getElementById(`view-${hashView}`)) ? hashView : (localStorage.getItem('iwrite_view') || 'dashboard');
        if (!this._openPendingStory()) this.switchView(savedView);
      }
    });

    this.bindAppEvents();
    this.startNotifPolling();
    this._applyProLocks();
    this._startMaintenancePolling();
    this._initHoverCards();
    this._checkInviteParam();
    this._updatePaymentFailedBanner();
  },

  _openPendingStory() {
    const params = new URLSearchParams(window.location.search);
    const storyId = params.get('story') || localStorage.getItem('iwrite_pending_story');
    if (!storyId || typeof this.selectStory !== 'function') return false;
    localStorage.removeItem('iwrite_pending_story');
    if (params.get('story')) {
      window.history.replaceState({}, document.title, '/app');
    }
    this.storyTab = 'feed';
    this.storyMineFilter = 'drafts';
    this.switchView('stories');
    setTimeout(() => {
      this.selectStory(storyId).catch(() => {});
    }, 150);
    return true;
  },

  _updatePaymentFailedBanner() {
    // Remove existing banner if any
    const existing = document.getElementById('payment-failed-banner');
    if (existing) existing.remove();

    if (!this.user || !this.user.planPaymentFailed) return;

    const banner = document.createElement('div');
    banner.id = 'payment-failed-banner';
    banner.className = 'payment-failed-banner';
    banner.innerHTML = '&#x26A0;&#xFE0F; Payment failed. <a href="#" id="update-payment-link">Update your payment method &rarr;</a>';

    // Insert at top of app content
    const appView = document.getElementById('app-view');
    if (appView) {
      appView.insertBefore(banner, appView.firstChild);
    }

    const link = document.getElementById('update-payment-link');
    if (link) {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        this._openBillingPortal();
      });
    }
  },

  _checkInviteParam() {
    const params = new URLSearchParams(window.location.search);
    let inviteUser = params.get('invite') || localStorage.getItem('iwrite_pending_invite');
    if (!inviteUser) return;
    // Clean URL and stored invite
    localStorage.removeItem('iwrite_pending_invite');
    window.history.replaceState({}, '', '/app');
    // Switch to friends view
    this.switchView('friends');
    // Don't send to yourself
    const myUsername = this.user && (this.user.username || this.user.name);
    if (myUsername && myUsername.toLowerCase() === inviteUser.toLowerCase()) return;
    // Show invite popup after a tick so friends view finishes rendering
    setTimeout(() => this._showInvitePopup(inviteUser), 300);
  },

  async _showInvitePopup(inviteUser) {
    // Look up the target user's display name
    let displayName = inviteUser;
    try {
      const res = await fetch(`/api/users/lookup/${encodeURIComponent(inviteUser)}`);
      if (res.ok) {
        const data = await res.json();
        displayName = data.name || inviteUser;
      }
    } catch {}

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay active';
    overlay.innerHTML = `
      <div class="modal" style="max-width:380px;text-align:center;padding:32px">
        <div style="font-size:48px;margin-bottom:12px">\u{1F91D}</div>
        <h2 style="font-size:18px;margin-bottom:8px;color:var(--text-primary)">Send Friend Request</h2>
        <p style="font-size:14px;color:var(--text-muted);margin-bottom:20px">Do you want to send a friend request to <strong>${this._esc(displayName)}</strong> (<span style="color:var(--text-secondary)">@${this._esc(inviteUser)}</span>)?</p>
        <div style="display:flex;gap:8px;justify-content:center">
          <button id="invite-accept" style="padding:10px 24px;background:var(--accent);color:#000;font-weight:700;border:none;border-radius:var(--radius-pill);cursor:pointer;font-size:14px">Yes</button>
          <button id="invite-dismiss" style="padding:10px 24px;background:var(--bg-elevated);color:var(--text-primary);font-weight:600;border:1px solid var(--border);border-radius:var(--radius-pill);cursor:pointer;font-size:14px">Maybe Later</button>
        </div>
        <div id="invite-status" style="margin-top:12px;font-size:13px;color:var(--text-muted)"></div>
      </div>`;
    document.body.appendChild(overlay);
    // Click on dark backdrop dismisses
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#invite-dismiss').onclick = () => overlay.remove();
    overlay.querySelector('#invite-accept').onclick = async () => {
      const status = overlay.querySelector('#invite-status');
      const btn = overlay.querySelector('#invite-accept');
      btn.disabled = true; btn.textContent = 'Sending...';
      try {
        const result = await API.sendFriendRequestByUsername(inviteUser);
        status.style.color = 'var(--success)';
        status.textContent = result.autoAccepted ? 'You are now friends!' : 'Friend request sent!';
        setTimeout(() => { overlay.remove(); this._renderFriends(); }, 2000);
      } catch (err) {
        status.style.color = '#f87171';
        status.textContent = err.message || 'Failed to send request';
        btn.disabled = false; btn.textContent = 'Try Again';
      }
    };
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

    // Delegated click handler for all profile links (leaderboard, friends, podium)
    document.addEventListener('click', (e) => {
      const link = e.target.closest('[data-profile-username]');
      if (link) {
        e.preventDefault();
        this.switchView('user-profile', { username: link.dataset.profileUsername });
      }
    });

    // Hash-based navigation (anchor clicks, back/forward)
    const handleHash = () => {
      const hash = location.hash.replace('#', '');
      const [hashBase, hashParam] = hash.split('/', 2);
      if (hashBase === 'user-profile' && hashParam) {
        this.switchView('user-profile', { fromHash: true });
        this.loadUserProfile(decodeURIComponent(hashParam));
      } else if (hash && hash !== this.currentView && document.getElementById(`view-${hash}`)) {
        this.switchView(hash, { fromHash: true });
      }
    };
    window.addEventListener('popstate', handleHash);
    window.addEventListener('hashchange', handleHash);

    // Pricing modal
    document.getElementById('user-info-btn').addEventListener('click', () => this.switchView('settings'));
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
      // When in story-back-mode, the stories.js handler takes over via onclick
      if (mobileSidebarToggle.classList.contains('story-back-mode')) return;
      sidebar.classList.contains('open') ? closeMobileSidebar() : openMobileSidebar();
    });
    mobileSidebarOverlay.addEventListener('click', closeMobileSidebar);
    const sidebarCloseBtn = document.getElementById('sidebar-close-btn');
    if (sidebarCloseBtn) sidebarCloseBtn.addEventListener('click', closeMobileSidebar);

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
      this._cycleTheme();
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

    // Document name modal
    document.getElementById('doc-name-confirm').addEventListener('click', () => {
      const name = document.getElementById('doc-name-input').value.trim();
      this._confirmDocName(name || 'Untitled');
    });
    document.getElementById('doc-name-skip').addEventListener('click', () => this._confirmDocName('Untitled'));
    document.getElementById('doc-name-back').addEventListener('click', () => {
      document.getElementById('doc-name-modal').classList.remove('active');
    });
    document.getElementById('doc-name-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const name = document.getElementById('doc-name-input').value.trim();
        this._confirmDocName(name || 'Untitled');
      }
    });

    document.querySelectorAll('#time-presets .time-preset[data-minutes]').forEach(btn => {
      btn.addEventListener('click', () => {
        const mins = parseInt(btn.dataset.minutes);
        const isPro = this.user && this.user.plan === 'premium';
        const freeMinutes = [30, 45, 60];
        if (!isPro && !freeMinutes.includes(mins)) {
          this.toast('This timer option is a Pro feature.', 'info');
          this.openPricing();
          return;
        }
        document.querySelectorAll('#time-presets .time-preset').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.sessionDuration = mins;
        document.getElementById('time-custom-row').style.display = 'none';
      });
    });

    document.getElementById('time-preset-add-btn').addEventListener('click', () => {
      const isPro = this.user && this.user.plan === 'premium';
      if (!isPro) {
        this.toast('Custom timer is a Pro feature.', 'info');
        this.openPricing();
        return;
      }
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
        const isPro = this.user && this.user.plan === 'premium';
        document.getElementById('time-presets').style.display = isDanger ? 'none' : 'flex';
        document.getElementById('danger-time-presets').style.display = isDanger ? 'flex' : 'none';
        document.getElementById('time-custom-row').style.display = 'none';
        // Show death timer section in dangerous mode
        const deathSection = document.getElementById('death-timer-section');
        if (deathSection) deathSection.style.display = isDanger ? 'block' : 'none';
        if (isDanger) {
          // Default danger duration to the active preset
          const dangerActive = document.querySelector('#danger-time-presets .time-preset.active');
          this.sessionDuration = parseInt(dangerActive?.dataset.minutes || 5);
        } else {
          const normalActive = document.querySelector('#time-presets .time-preset.active');
          this.sessionDuration = parseInt(normalActive?.dataset.minutes || 30);
        }
        this._applyTimerRestrictions();
      });
    });

    // Bind danger mode time presets
    document.querySelectorAll('#danger-time-presets .time-preset[data-minutes]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#danger-time-presets .time-preset').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.sessionDuration = parseInt(btn.dataset.minutes);
        document.getElementById('time-custom-row').style.display = 'none';
      });
    });
    // Danger mode custom time "+" button (Pro only)
    const dangerCustomBtn = document.getElementById('danger-custom-time-btn');
    if (dangerCustomBtn) {
      dangerCustomBtn.addEventListener('click', () => {
        const isPro = this.user && this.user.plan === 'premium';
        if (!isPro) {
          this.toast('Custom danger timer is a Pro feature.', 'info');
          this.openPricing();
          return;
        }
        const row = document.getElementById('time-custom-row');
        row.style.display = row.style.display === 'none' ? 'flex' : 'none';
        if (row.style.display === 'flex') document.getElementById('custom-time-input').focus();
      });
    }

    // Death Timer presets (inactivity threshold for dangerous mode)
    document.querySelectorAll('#death-timer-presets .time-preset[data-seconds]').forEach(btn => {
      btn.addEventListener('click', () => {
        const secs = parseInt(btn.dataset.seconds);
        const isPro = this.user && this.user.plan === 'premium';
        // 5s is free (displayed), 7s and 10s are Pro
        if (!isPro && secs !== 5) {
          this.toast('This death timer option is a Pro feature.', 'info');
          this.openPricing();
          return;
        }
        document.querySelectorAll('#death-timer-presets .time-preset').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('danger-threshold-input').value = secs;
        document.getElementById('death-timer-custom-row').style.display = 'none';
      });
    });
    // Death Timer custom "+" (Pro only)
    const deathCustomBtn = document.getElementById('death-timer-custom-btn');
    if (deathCustomBtn) {
      deathCustomBtn.addEventListener('click', () => {
        const isPro = this.user && this.user.plan === 'premium';
        if (!isPro) {
          this.toast('Custom death timer is a Pro feature.', 'info');
          this.openPricing();
          return;
        }
        const row = document.getElementById('death-timer-custom-row');
        row.style.display = row.style.display === 'none' ? 'flex' : 'none';
        if (row.style.display === 'flex') document.getElementById('death-timer-custom-input').focus();
      });
    }
    const setDeathCustom = () => {
      const val = parseInt(document.getElementById('death-timer-custom-input').value);
      if (!val || val < 2) return;
      document.querySelectorAll('#death-timer-presets .time-preset').forEach(b => b.classList.remove('active'));
      const customBtn = document.getElementById('death-timer-custom-btn');
      customBtn.textContent = `${val}s`;
      customBtn.classList.add('active');
      document.getElementById('danger-threshold-input').value = val;
      document.getElementById('death-timer-custom-row').style.display = 'none';
      document.getElementById('death-timer-custom-input').value = '';
    };
    document.getElementById('death-timer-custom-set').addEventListener('click', setDeathCustom);
    document.getElementById('death-timer-custom-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') setDeathCustom();
    });

    document.getElementById('editor-back').addEventListener('click', () => Editor.abort());
    document.getElementById('editor-save-btn').addEventListener('click', () => Editor.completeSession());
    document.getElementById('editor-edit-btn').addEventListener('click', () => Editor.enterEditMode());
    document.getElementById('editor-save-edit-btn').addEventListener('click', () => Editor.saveEdits());

    // Editor toolbar: theme toggle
    document.getElementById('editor-theme-btn').addEventListener('click', () => Editor.toggleEditorTheme());

    // Editor toolbar: fullscreen toggle
    document.getElementById('editor-fullscreen-btn').addEventListener('click', () => Editor.toggleFullscreen());

    // Timer toggle + add time
    document.getElementById('editor-timer-toggle').addEventListener('click', () => Editor.toggleTimerVisibility());
    document.getElementById('add-time-1').addEventListener('click', () => {
      if (!this.user || this.user.plan !== 'premium') {
        this.toast('Adding time is a Pro feature.', 'info');
        this.openPricing();
        return;
      }
      Editor.addTime(1);
    });
    document.getElementById('add-time-5').addEventListener('click', () => {
      if (!this.user || this.user.plan !== 'premium') {
        this.toast('Adding time is a Pro feature.', 'info');
        this.openPricing();
        return;
      }
      Editor.addTime(5);
    });

    // Format bar: font selector
    const fmtFontSelect = document.getElementById('fmt-font-select');
    if (fmtFontSelect) {
      fmtFontSelect.addEventListener('change', () => {
        Editor.setFont(fmtFontSelect.value);
      });
    }

    // Editor toolbar: audio dropdown — stop propagation inside so it stays open
    const audioBtn = document.getElementById('editor-audio-btn');
    const audioDrop = document.getElementById('editor-audio-dropdown');
    audioBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      audioDrop.style.display = audioDrop.style.display === 'none' ? 'block' : 'none';
    });
    audioDrop.addEventListener('click', (e) => {
      e.stopPropagation(); // Don't close when clicking inside the dropdown
    });

    // Close audio dropdown when clicking elsewhere
    document.addEventListener('click', () => {
      audioDrop.style.display = 'none';
    });

    // Restore saved font preference
    const savedFont = localStorage.getItem('iwrite_editor_font') || 'sans';
    if (savedFont !== 'sans') Editor.setFont(savedFont);
    if (fmtFontSelect) fmtFontSelect.value = savedFont;

    // Init selection popup + audio
    Editor.initSelectionPopup();
    Editor.initAudio();
    document.getElementById('editor-copy-btn').addEventListener('click', async () => {
      const textarea = document.getElementById('editor-textarea');

      // During active sessions: no copying unless maintenance is active
      if (Editor.active) {
        if (!this._maintActive) {
          this.toast('Copying is disabled during sessions', 'error');
          return;
        }
        await this._doCopy(textarea);
        this.toast('Copied! Unlimited during maintenance', 'success');
        return;
      }

      // Not in active session (viewing/editing) — copy freely
      await this._doCopy(textarea);
      this.toast('Copied to clipboard!', 'success');
    });

    // Copy helper — copies content as HTML + plain text
    this._doCopy = async (textarea) => {
      try {
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
      } catch {
        await navigator.clipboard.writeText(textarea.innerText);
      }
    };

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

    document.querySelectorAll('#duel-time-presets .time-preset[data-minutes]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#duel-time-presets .time-preset').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('duel-custom-time-input').style.display = 'none';
      });
    });

    // Custom "+" button for duel duration
    document.getElementById('duel-custom-time-btn').addEventListener('click', () => {
      document.querySelectorAll('#duel-time-presets .time-preset').forEach(b => b.classList.remove('active'));
      document.getElementById('duel-custom-time-btn').classList.add('active');
      const input = document.getElementById('duel-custom-time-input');
      input.style.display = 'block';
      input.focus();
    });

    document.getElementById('add-friend-btn').addEventListener('click', () => this.addFriend());
    document.getElementById('save-profile-btn').addEventListener('click', () => this.saveProfile());
    document.getElementById('change-password-btn').addEventListener('click', () => this.changePassword());

    document.getElementById('create-folder-btn').addEventListener('click', () => {
      if (this.user && this.user.plan !== 'premium') {
        this.toast('Folders are a Pro feature. Upgrade to Pro!', 'info');
        this.openPricing();
        return;
      }
      this.createFolder();
    });
    document.getElementById('history-btn').addEventListener('click', () => this.openHistoryModal());
    document.getElementById('session-search').addEventListener('input', (e) => {
      this._searchQuery = e.target.value.trim().toLowerCase();
      this._docsPage = 1;
      this._renderDocumentsView();
    });
    document.getElementById('history-close').addEventListener('click', () => this.closeHistorySidebar());
    document.getElementById('history-sidebar-overlay').addEventListener('click', () => this.closeHistorySidebar());
    document.getElementById('comment-history-close').addEventListener('click', () => this.closeCommentHistorySidebar());
    document.getElementById('comment-history-sidebar-overlay').addEventListener('click', () => this.closeCommentHistorySidebar());
    document.getElementById('editor-comment-history-btn').addEventListener('click', () => this.openCommentHistory());
  },

  switchView(view, opts = {}) {
    const { fromHash, username } = typeof opts === 'string' ? { username: opts } : opts;
    this.currentView = view;
    // Don't persist user-profile or my-profile as default view (they require data loading)
    if (view !== 'user-profile') localStorage.setItem('iwrite_view', view);

    // Update hash in URL for browser back/forward navigation
    const hashValue = (view === 'user-profile' && username) ? `user-profile/${username}` : view;
    const currentHash = location.hash.replace('#', '');
    if (!fromHash && currentHash !== hashValue) {
      history.pushState(null, '', '#' + hashValue);
    }
    document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
    document.getElementById(`view-${view}`).style.display = 'block';
    document.querySelectorAll('.sidebar-nav-item[data-view]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === view);
    });

    // Restore hamburger if leaving stories while in story-back-mode
    if (view !== 'stories') {
      const toggle = document.getElementById('mobile-sidebar-toggle');
      if (toggle && toggle.classList.contains('story-back-mode')) {
        toggle.classList.remove('story-back-mode');
        toggle.innerHTML = '<span></span><span></span><span></span>';
        toggle.onclick = null;
        toggle._storyBackHandler = null;
      }
    }

    if (view === 'dashboard') this.loadDashboard();
    if (view === 'documents') this.loadDocuments();
    if (view === 'leaderboard') this.loadLeaderboard();
    if (view === 'settings') this.loadProfile();
    if (view === 'my-profile') this.loadMyProfile();
    if (view === 'friends') this.loadFriends();
    if (view === 'support') this.loadSupport();
    if (view === 'analytics') this.loadAnalytics();
    if (view === 'upgrade') this.loadUpgrade();
    if (view === 'user-profile' && username) this.loadUserProfile(username);
    if (view === 'duels') {
      this.loadDuelsView();
      // Auto-refresh duels tab every 10 seconds while viewing
      this._duelsRefreshInterval = setInterval(() => this.loadDuelsView(), 10000);
    } else {
      if (this._duelsRefreshInterval) {
        clearInterval(this._duelsRefreshInterval);
        this._duelsRefreshInterval = null;
      }
    }
  },

  updateUserUI() {
    if (!this.user) return;
    const userNameEl = document.getElementById('user-name');
    if (userNameEl) userNameEl.textContent = (this.user.name || '').split(' ')[0];
    const { level } = this.calcXPLevel(this.user.xp || 0);
    const userLevelEl = document.getElementById('user-level');
    if (userLevelEl) userLevelEl.textContent = `Level ${level}`;
    const avatarEl = document.getElementById('user-avatar');
    if (avatarEl) {
      if (this.user.avatar) {
        const t = this.user.avatarUpdatedAt || 0;
        const newSrc = `${this.user.avatar}?t=${t}`;
        const existing = avatarEl.querySelector('img');
        if (!existing || !existing.src.endsWith(newSrc)) {
          avatarEl.innerHTML = `<img src="${newSrc}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
        }
      } else {
        avatarEl.innerHTML = '';
        avatarEl.textContent = this.user.name.charAt(0).toUpperCase();
      }
    }

    // Update sidebar profile nav label
    const profileNavLabel = document.getElementById('my-profile-nav-label');
    if (profileNavLabel) {
      const uname = this.user.username || '';
      profileNavLabel.textContent = uname ? (uname.length > 14 ? uname.slice(0, 14) + '...' : uname) : 'Profile';
      if (uname.length > 14) profileNavLabel.title = uname;
    }

    const badge = document.getElementById('plan-badge');
    if (badge) {
      const isPro = this.user.plan === 'premium';
      if (isPro && this.user.planExpiresAt && this.user.planExpiresAt !== 'infinite') {
        const expiresAt = new Date(this.user.planExpiresAt);
        const daysLeft = Math.ceil((expiresAt - new Date()) / (1000 * 60 * 60 * 24));
        if (daysLeft <= 7 && daysLeft > 0) {
          badge.textContent = `Pro · ${daysLeft}d left`;
        } else if (daysLeft <= 0) {
          badge.textContent = 'Pro · Expired';
        } else {
          badge.textContent = 'Pro';
        }
      } else if (isPro && this.user.planExpiresAt === 'infinite') {
        badge.textContent = 'Pro ∞';
      } else {
        badge.textContent = isPro ? 'Pro' : 'Free';
      }
      badge.className = 'plan-badge' + (isPro ? ' pro' : '');
    }

    // Update Upgrade nav label for Pro users
    const upgradeNav = document.getElementById('upgrade-nav-btn');
    const upgradeDivTop = document.getElementById('upgrade-divider-top');
    const upgradeDivBottom = document.getElementById('upgrade-divider-bottom');
    const proProfileDiv = document.getElementById('pro-profile-divider');
    const isPremium = this.user.plan === 'premium';
    if (upgradeNav) {
      const label = upgradeNav.childNodes;
      // Update text content (last text node after the SVG)
      const textSpan = upgradeNav.querySelector('.upgrade-nav-label');
      if (textSpan) {
        textSpan.textContent = isPremium ? 'Manage Subscription' : 'Upgrade to Pro';
      }
    }
    if (proProfileDiv) proProfileDiv.style.display = isPremium ? '' : 'none';
    if (upgradeDivTop) upgradeDivTop.style.display = isPremium ? 'none' : '';

    const streakBadge = document.getElementById('streak-badge');
    const streakCount = document.getElementById('streak-count');
    if (streakBadge) {
      if (this.user.streak > 0) {
        streakBadge.style.display = 'flex';
        if (streakCount) streakCount.textContent = this.user.streak;
      } else {
        streakBadge.style.display = 'none';
      }
    }

    const hour = new Date().getHours();
    let greeting = 'Good evening';
    let emoji = '&#x1F319;';
    if (hour < 12) { greeting = 'Good morning'; emoji = '&#x2600;&#xFE0F;'; }
    else if (hour < 18) { greeting = 'Good afternoon'; emoji = '&#x1F324;&#xFE0F;'; }
    const firstName = (this.user.name || '').split(' ')[0];
    const greetingEl = document.getElementById('greeting-text');
    if (greetingEl) greetingEl.innerHTML = `${emoji} ${greeting}, <em>${firstName}</em>`;
  },

  async loadDashboard() {
    try {
      this.user = await API.getMe();
      this.updateUserUI();
      // Show toast if subscription just expired
      if (this.user.subscriptionJustExpired) {
        this.toast('Your Pro subscription has expired. You\'ve been moved to the Free plan.', 'warning');
      }
    } catch {}

    // Username reminder
    const usernameReminder = document.getElementById('username-reminder');
    if (usernameReminder) {
      if (!this.user.username) {
        usernameReminder.style.display = 'flex';
      } else {
        usernameReminder.style.display = 'none';
      }
    }

    document.getElementById('total-words').textContent = (this.user.totalWords || 0).toLocaleString();
    document.getElementById('total-sessions').textContent = this.user.totalSessions || 0;
    document.getElementById('current-streak').textContent = this.user.streak || 0;
    document.getElementById('longest-streak-text').textContent = `Best: ${this.user.longestStreak || 0}`;
    document.getElementById('total-xp').textContent = (this.user.xp || 0).toLocaleString();

    // Fetch and display active users count
    this.loadOnlineCount();
    this._onlineInterval = setInterval(() => this.loadOnlineCount(), 60000);

    const { level, xpInLevel, xpForNextLevel } = this.calcXPLevel(this.user.xp || 0);
    document.getElementById('xp-level-text').innerHTML = `Level ${level}`;
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
      this._docsCacheDirty = false;
      this._docsCacheLoaded = true;
    } catch {
      this.documents = [];
    }

    // --- Render activity heatmap ---
    this._renderHeatmap();

    // Only show non-failed, non-admin-deactivated docs in main lists
    const visibleDocs = this.documents.filter(d => !d.deletedBySystem && !d.deactivatedByAdmin);
    this.renderDocumentList('recent-docs', visibleDocs.slice(0, 3));
  },

  _renderHeatmap() {
    const grid = document.getElementById('heatmap-grid');
    const totalEl = document.getElementById('heatmap-total');
    if (!grid) return;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Build map of last 20 weeks (140 days) — word counts per day
    const totalDays = 140;
    const dayMap = {};
    for (let i = totalDays - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      dayMap[key] = 0;
    }

    // Sum word counts from documents
    const allDocs = this.documents || [];
    let totalWords = 0;
    allDocs.forEach(doc => {
      if (!doc.updatedAt || !doc.wordCount || doc.deletedBySystem) return;
      const key = new Date(doc.updatedAt).toISOString().slice(0, 10);
      if (key in dayMap) {
        dayMap[key] += doc.wordCount;
        totalWords += doc.wordCount;
      }
    });

    // Find max for intensity scaling
    const values = Object.values(dayMap);
    const maxWords = Math.max(...values, 1);

    // Build weeks grid (columns = weeks, rows = days Mon-Sun)
    // Start from the first Monday on or before the earliest date
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - (totalDays - 1));
    // Adjust to previous Monday
    const startDay = startDate.getDay();
    const mondayOffset = startDay === 0 ? -6 : 1 - startDay;
    startDate.setDate(startDate.getDate() + mondayOffset);

    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dayLabels = ['', 'Mon', '', 'Wed', '', 'Fri', ''];

    // Calculate weeks
    const weeks = [];
    const d = new Date(startDate);
    while (d <= today) {
      const week = [];
      for (let dow = 0; dow < 7; dow++) {
        const key = d.toISOString().slice(0, 10);
        const words = dayMap[key] || 0;
        const isFuture = d > today;
        const isInRange = key in dayMap;
        let level = 0;
        if (words > 0) {
          const ratio = words / maxWords;
          if (ratio <= 0.25) level = 1;
          else if (ratio <= 0.5) level = 2;
          else if (ratio <= 0.75) level = 3;
          else level = 4;
        }
        week.push({
          key, words, level,
          hide: isFuture || !isInRange,
          isToday: key === today.toISOString().slice(0, 10),
          month: d.getDate() <= 7 && dow === 0 ? months[d.getMonth()] : null
        });
        d.setDate(d.getDate() + 1);
      }
      weeks.push(week);
    }

    // Render SVG-like grid using divs
    let html = '<div class="heatmap-day-labels">';
    dayLabels.forEach(l => { html += `<span class="heatmap-day-label">${l}</span>`; });
    html += '</div><div class="heatmap-weeks">';

    // Month labels row
    html += '<div class="heatmap-month-row">';
    weeks.forEach((week, wi) => {
      const monthLabel = week[0].month || '';
      html += `<span class="heatmap-month-label">${monthLabel}</span>`;
    });
    html += '</div>';

    // Grid cells
    for (let dow = 0; dow < 7; dow++) {
      html += '<div class="heatmap-row">';
      weeks.forEach(week => {
        const cell = week[dow];
        if (cell.hide) {
          html += '<div class="heatmap-cell heatmap-cell-hidden"></div>';
        } else {
          const todayClass = cell.isToday ? ' heatmap-cell-today' : '';
          const title = cell.words > 0
            ? `${cell.words.toLocaleString()} words on ${cell.key}`
            : `No writing on ${cell.key}`;
          html += `<div class="heatmap-cell${todayClass}" data-level="${cell.level}" title="${title}"></div>`;
        }
      });
      html += '</div>';
    }
    html += '</div>';

    grid.innerHTML = html;

    if (totalEl) {
      const activeDays = values.filter(v => v > 0).length;
      totalEl.textContent = `${totalWords.toLocaleString()} words in ${activeDays} days`;
    }
  },

  _renderDonutChart() {
    const donutEl = document.getElementById('donut-chart');
    const legendEl = document.getElementById('donut-legend');
    if (!donutEl || !legendEl) return;

    const allDocs = this.documents || [];
    const completed = allDocs.filter(d => !d.deletedBySystem && !d.deactivatedByAdmin && d.wordCount > 0).length;
    const failed = allDocs.filter(d => d.deletedBySystem).length;
    const total = completed + failed;

    if (total === 0) {
      donutEl.style.background = 'var(--border)';
      donutEl.innerHTML = `<div class="donut-center"><span class="donut-center-value">--</span><span class="donut-center-label">No data</span></div>`;
      legendEl.innerHTML = '';
      return;
    }

    const completedPct = Math.round((completed / total) * 100);
    const failedPct = 100 - completedPct;
    const completedDeg = (completed / total) * 360;

    donutEl.style.background = `conic-gradient(#34d399 0deg ${completedDeg}deg, #ef4444 ${completedDeg}deg 360deg)`;
    donutEl.innerHTML = `<div class="donut-center"><span class="donut-center-value">${completedPct}%</span><span class="donut-center-label">Success</span></div>`;

    legendEl.innerHTML = `
      <div class="donut-legend-item">
        <span class="donut-legend-dot" style="background:#34d399"></span>
        Completed
        <span class="donut-legend-count">${completed}</span>
      </div>
      <div class="donut-legend-item">
        <span class="donut-legend-dot" style="background:#ef4444"></span>
        Failed
        <span class="donut-legend-count">${failed}</span>
      </div>
    `;
  },

  async loadDocuments(forceRefresh) {
    // Use cache if data already loaded and not dirty
    if (!forceRefresh && !this._docsCacheDirty && this._docsCacheLoaded) {
      this._renderDocumentsView();
      return;
    }

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

    this._docsCacheDirty = false;
    this._docsCacheLoaded = true;
    this._renderDocumentsView();
  },

  _renderDocumentsView() {
    // Update folder button UI based on plan
    const folderBtn = document.getElementById('create-folder-btn');
    if (folderBtn) {
      const isPro = this.user && this.user.plan === 'premium';
      folderBtn.title = isPro ? 'Create Folder' : 'Folders — Pro Feature';
      folderBtn.style.opacity = isPro ? '' : '0.5';
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
          this._docsPage = 1;
          this._renderDocumentsView();
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
          this._docsPage = 1;
          this._renderDocumentsView();
        };
      } else {
        backBtnContainer.style.display = 'none';
      }
    }

    // Render folders for current level (Pro only for free users)
    const folderContainer = document.getElementById('folder-list');
    const isPro = this.user && this.user.plan === 'premium';
    const childFolders = this.folders.filter(f => (f.parentFolder || null) === this.currentFolder);
    if (childFolders.length > 0) {
      folderContainer.innerHTML = childFolders.map(f => {
        const count = this.countDocsInFolder(f.id, visibleDocs);
        return `<div class="folder-card" data-folder-id="${f.id}">
          <span class="folder-card-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg></span>
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
          this._docsPage = 1;
          this._renderDocumentsView();
        }
      };
    } else {
      folderContainer.innerHTML = '';
    }

    // Filter docs by current folder
    let folderDocs = this.currentFolder
      ? visibleDocs.filter(d => d.folder === this.currentFolder)
      : visibleDocs.filter(d => !d.folder);

    // Apply search filter (title only)
    if (this._searchQuery) {
      folderDocs = folderDocs.filter(d => (d.title || '').toLowerCase().includes(this._searchQuery));
    }

    this.renderDocumentList('all-docs', folderDocs);

    // Shared docs (only at root level)
    if (!this.currentFolder) {
      API.getSharedDocuments().then(sharedDocs => {
        const section = document.getElementById('shared-docs-section');
        if (sharedDocs.length > 0) {
          section.style.display = 'block';
          this.renderSharedDocumentList('shared-docs', sharedDocs);
        } else {
          section.style.display = 'none';
        }
      }).catch(() => {
        document.getElementById('shared-docs-section').style.display = 'none';
      });
    } else {
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

    // Sort pinned documents to top
    docs.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

    // Pagination for main docs list
    const isPaginated = containerId === 'all-docs';
    const totalPages = isPaginated ? Math.ceil(docs.length / this._docsPerPage) : 1;
    if (isPaginated && this._docsPage > totalPages) this._docsPage = totalPages || 1;
    const page = isPaginated ? this._docsPage : 1;
    const pageDocs = isPaginated
      ? docs.slice((page - 1) * this._docsPerPage, page * this._docsPerPage)
      : docs;

    let html = pageDocs.map(doc => {
      const isFailed = doc.deletedBySystem;
      const isDangerous = doc.mode === 'dangerous';
      const iconClass = isFailed ? 'doc-icon-failed' : isDangerous ? 'doc-icon-dangerous' : doc.completed ? 'doc-icon-completed' : 'doc-icon-draft';
      const iconSvg = isFailed
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>'
        : isDangerous
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>';
      return `
      <div class="doc-card ${isFailed ? 'doc-failed' : ''}" data-id="${doc.id}">
        <div class="doc-card-info">
          <div class="doc-icon ${iconClass}">${iconSvg}</div>
          <div class="doc-card-text">
            <h4>${doc.pinned ? '<span class="pin-icon" title="Pinned">&#x1F4CC;</span> ' : ''}${this.escapeHtml(doc.title)} ${isFailed ? '<span class="badge badge-failed">FAILED</span>' : ''}</h4>
            <div class="doc-card-meta">
              <span>${doc.wordCount || 0} words</span>
              <span>${isDangerous ? '&#x26A1; Dangerous' : 'Normal'}</span>
              <span>${this.formatDate(doc.updatedAt)}</span>
              ${doc.xpEarned ? `<span class="xp-gained">+${doc.xpEarned} XP</span>` : ''}
            </div>
          </div>
        </div>
        <button class="doc-card-menu-btn" data-doc-id="${doc.id}" title="Options">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
        </button>
      </div>`;
    }).join('');

    // Add pagination controls if more than one page
    if (isPaginated && totalPages > 1) {
      html += `<div class="docs-pagination">
        <button class="docs-pagination-btn" id="docs-prev" ${page <= 1 ? 'disabled' : ''}>← Prev</button>
        <span class="docs-pagination-info">${page} / ${totalPages}</span>
        <button class="docs-pagination-btn" id="docs-next" ${page >= totalPages ? 'disabled' : ''}>Next →</button>
      </div>`;
    }

    container.innerHTML = html;

    // Bind pagination buttons
    if (isPaginated && totalPages > 1) {
      const prevBtn = document.getElementById('docs-prev');
      const nextBtn = document.getElementById('docs-next');
      if (prevBtn) prevBtn.onclick = () => { this._docsPage--; this._renderDocumentsView(); };
      if (nextBtn) nextBtn.onclick = () => { this._docsPage++; this._renderDocumentsView(); };
    }

    container.onclick = (e) => {
      if (e.target.closest('.docs-pagination-btn')) return;
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
      document.getElementById('editor-timer').textContent = '';
      document.getElementById('editor-mode-badge').textContent = 'Viewing';
      document.getElementById('editor-mode-badge').className = 'editor-mode-badge normal';
      document.getElementById('danger-progress').style.display = 'none';
      document.getElementById('formatting-toolbar').style.display = 'none'; // shown on Edit
      // Hide session-only controls
      document.getElementById('editor-timer-toggle').style.display = 'none';
      document.getElementById('editor-timer').style.display = 'none';
      document.querySelector('.editor-add-time').style.display = 'none';
      document.getElementById('duel-add-time-btn').style.display = 'none';
      document.getElementById('editor-topic-bar').style.display = 'none';

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
    this.sessionDuration = 30;
    document.getElementById('time-presets').style.display = 'flex';
    document.getElementById('danger-time-presets').style.display = 'none';
    document.querySelectorAll('#time-presets .time-preset').forEach(b => b.classList.remove('active'));
    document.querySelector('#time-presets .time-preset[data-minutes="30"]').classList.add('active');
    // Reset death timer section
    const deathSection = document.getElementById('death-timer-section');
    if (deathSection) deathSection.style.display = 'none';
    document.getElementById('danger-threshold-input').value = '5';
    document.querySelectorAll('#death-timer-presets .time-preset').forEach(b => b.classList.remove('active'));
    const defaultDeath = document.querySelector('#death-timer-presets .time-preset[data-seconds="5"]');
    if (defaultDeath) defaultDeath.classList.add('active');
    document.getElementById('death-timer-custom-row').style.display = 'none';
    const deathCustBtn = document.getElementById('death-timer-custom-btn');
    if (deathCustBtn) { deathCustBtn.textContent = '+'; deathCustBtn.classList.remove('active'); }
    // Reset new fields
    document.getElementById('session-topic-input').value = '';
    document.getElementById('session-target-words').value = '';
    // Apply plan-based timer restrictions
    this._applyTimerRestrictions();
    // Session limits are invisible — enforced server-side only
    this._showWeeklySessionInfo();
  },

  _applyTimerRestrictions() {
    const isPro = this.user && this.user.plan === 'premium';
    // Normal mode presets: show all, but Pro-locked ones get badge for free users
    document.querySelectorAll('#time-presets .time-preset[data-minutes]').forEach(btn => {
      const mins = parseInt(btn.dataset.minutes);
      btn.style.display = '';
      btn.classList.remove('pro-locked');
      // Remove old PRO indicators
      const oldBadge = btn.querySelector('.timer-pro-badge');
      if (oldBadge) oldBadge.remove();
      const freeMinutes = [30, 45, 60];
      if (!isPro && !freeMinutes.includes(mins)) {
        btn.classList.add('pro-locked');
        btn.style.position = 'relative';
        btn.style.opacity = '0.7';
        const badge = document.createElement('span');
        badge.className = 'timer-pro-badge';
        badge.style.cssText = 'position:absolute;top:-5px;right:-5px;font-size:7px;font-weight:700;background:linear-gradient(135deg,#f59e0b,#d97706);color:#000;padding:1px 3px;border-radius:4px;line-height:1.2';
        badge.textContent = 'PRO';
        btn.appendChild(badge);
      } else {
        btn.style.opacity = '';
      }
    });
    // Custom "+" button: show for all, badge for free
    const addBtn = document.getElementById('time-preset-add-btn');
    if (addBtn) {
      addBtn.style.display = '';
      const oldBadge = addBtn.querySelector('.timer-pro-badge');
      if (oldBadge) oldBadge.remove();
      if (!isPro) {
        addBtn.style.position = 'relative';
        addBtn.style.opacity = '0.7';
        const badge = document.createElement('span');
        badge.className = 'timer-pro-badge';
        badge.style.cssText = 'position:absolute;top:-5px;right:-5px;font-size:7px;font-weight:700;background:linear-gradient(135deg,#f59e0b,#d97706);color:#000;padding:1px 3px;border-radius:4px;line-height:1.2';
        badge.textContent = 'PRO';
        addBtn.appendChild(badge);
      } else {
        addBtn.style.opacity = '';
      }
    }
    // Danger mode presets: all visible
    document.querySelectorAll('#danger-time-presets .time-preset[data-minutes]').forEach(btn => {
      btn.style.display = '';
    });
    // Danger custom time: show for all, badge for free
    const dangerCustomBtn = document.getElementById('danger-custom-time-btn');
    if (dangerCustomBtn) {
      dangerCustomBtn.style.display = '';
      const oldBadge = dangerCustomBtn.querySelector('.timer-pro-badge');
      if (oldBadge) oldBadge.remove();
      if (!isPro) {
        dangerCustomBtn.style.position = 'relative';
        dangerCustomBtn.style.opacity = '0.7';
        const badge = document.createElement('span');
        badge.className = 'timer-pro-badge';
        badge.style.cssText = 'position:absolute;top:-5px;right:-5px;font-size:7px;font-weight:700;background:linear-gradient(135deg,#f59e0b,#d97706);color:#000;padding:1px 3px;border-radius:4px;line-height:1.2';
        badge.textContent = 'PRO';
        dangerCustomBtn.appendChild(badge);
      } else {
        dangerCustomBtn.style.opacity = '';
      }
    }
    // Death timer presets: 5s free (displayed), 7s/10s/+ Pro
    document.querySelectorAll('#death-timer-presets .time-preset[data-seconds]').forEach(btn => {
      const secs = parseInt(btn.dataset.seconds);
      const oldBadge = btn.querySelector('.timer-pro-badge');
      if (oldBadge) oldBadge.remove();
      btn.style.opacity = '';
      if (!isPro && secs !== 5) {
        btn.style.position = 'relative';
        btn.style.opacity = '0.7';
        const badge = document.createElement('span');
        badge.className = 'timer-pro-badge';
        badge.style.cssText = 'position:absolute;top:-5px;right:-5px;font-size:7px;font-weight:700;background:linear-gradient(135deg,#f59e0b,#d97706);color:#000;padding:1px 3px;border-radius:4px;line-height:1.2';
        badge.textContent = 'PRO';
        btn.appendChild(badge);
      }
    });
    const deathCustomBtn = document.getElementById('death-timer-custom-btn');
    if (deathCustomBtn) {
      const oldBadge = deathCustomBtn.querySelector('.timer-pro-badge');
      if (oldBadge) oldBadge.remove();
      deathCustomBtn.style.opacity = '';
      if (!isPro) {
        deathCustomBtn.style.position = 'relative';
        deathCustomBtn.style.opacity = '0.7';
        const badge = document.createElement('span');
        badge.className = 'timer-pro-badge';
        badge.style.cssText = 'position:absolute;top:-5px;right:-5px;font-size:7px;font-weight:700;background:linear-gradient(135deg,#f59e0b,#d97706);color:#000;padding:1px 3px;border-radius:4px;line-height:1.2';
        badge.textContent = 'PRO';
        deathCustomBtn.appendChild(badge);
      }
    }
    // +1m / +5m add-time buttons: Pro only
    document.querySelectorAll('.editor-add-time-btn').forEach(btn => {
      if (btn.id === 'duel-add-time-btn') return;
      const oldBadge = btn.querySelector('.timer-pro-badge');
      if (oldBadge) oldBadge.remove();
      btn.style.opacity = '';
      if (!isPro) {
        btn.style.position = 'relative';
        btn.style.opacity = '0.7';
        const badge = document.createElement('span');
        badge.className = 'timer-pro-badge';
        badge.style.cssText = 'position:absolute;top:-5px;right:-5px;font-size:7px;font-weight:700;background:linear-gradient(135deg,#f59e0b,#d97706);color:#000;padding:1px 3px;border-radius:4px;line-height:1.2';
        badge.textContent = 'PRO';
        btn.appendChild(badge);
      }
    });
  },

  _showWeeklySessionInfo() {
    // Session limits are now invisible (200/month free, 300/month pro)
    // Remove any old weekly-session-info element
    const oldEl = document.getElementById('weekly-session-info');
    if (oldEl) oldEl.style.display = 'none';
  },

  closeSessionModal() {
    document.getElementById('session-modal').classList.remove('active');
  },

  startSession() {
    // Monthly session limit is enforced server-side (invisible to user)
    const targetInput = parseInt(document.getElementById('session-target-words').value) || 0;
    if (targetInput > 0 && targetInput <= 50) {
      const jokes = [
        "Bro, are you even planning to write something? 😂",
        "50 words? That's barely a text message 💀",
        "Come on, even a grocery list is longer than that 🛒",
        "Is this a writing session or a tweet? 🐦",
        "Your target should be at least 51 words. Dream bigger! ✨"
      ];
      this.showToast(jokes[Math.floor(Math.random() * jokes.length)], 'warning');
      return;
    }
    this.closeSessionModal();
    // Show document name modal before starting
    this._pendingTopic = document.getElementById('session-topic-input').value.trim();
    this._pendingTargetWords = targetInput;
    document.getElementById('doc-name-input').value = '';
    document.getElementById('doc-name-modal').classList.add('active');
  },

  _confirmDocName(name) {
    document.getElementById('doc-name-modal').classList.remove('active');
    document.getElementById('editor-title').value = name || 'Untitled';
    // Danger threshold from death timer — always add +1s hidden buffer
    // User sees "5s" but internally gets 6s, "10s" becomes 11s, etc.
    let dangerThreshold = 6000;
    if (this.sessionMode === 'dangerous') {
      const threshInput = document.getElementById('danger-threshold-input');
      if (threshInput) dangerThreshold = (Math.max(2, Math.min(30, parseInt(threshInput.value) || 5)) + 1) * 1000;
    }
    Editor.start(this.sessionDuration, this.sessionMode, {
      topic: this._pendingTopic || '',
      targetWords: this._pendingTargetWords || 0,
      dangerThreshold
    });
  },

  showSessionFailed(reason) {
    document.getElementById('sf-reason').textContent = reason;
    document.getElementById('session-failed').classList.add('active');
  },

  // ===== LEADERBOARD =====
  async loadOnlineCount() {
    try {
      const res = await fetch('/api/stats/public');
      const data = await res.json();
      const count = data.activeNow || 0;
      const el = document.getElementById('online-indicator');
      if (el && count > 0) {
        document.getElementById('online-count').textContent = count;
        document.getElementById('online-writer-text').textContent = count === 1 ? 'writer' : 'writers';
        el.style.display = 'inline-flex';
      } else if (el) {
        el.style.display = 'none';
      }
    } catch {}
  },

  _lbData: null,
  _lbTab: 'streaks',

  async loadLeaderboard() {
    const tbody = document.querySelector('#leaderboard-table tbody');
    const podium = document.getElementById('leaderboard-podium');

    // Wire up tab buttons once
    if (!this._lbTabsWired) {
      this._lbTabsWired = true;
      document.querySelectorAll('.lb-tab').forEach(btn => {
        btn.addEventListener('click', () => {
          this._lbTab = btn.dataset.lbTab;
          document.querySelectorAll('.lb-tab').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          if (this._lbData) this._renderLeaderboard(this._lbData);
        });
      });
    }

    try {
      this._lbData = await API.getLeaderboard();
      this._renderLeaderboard(this._lbData);
    } catch {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:var(--text-muted)">Failed to load leaderboard</td></tr>';
    }
  },

  _renderLeaderboard(rawData) {
    const tbody = document.querySelector('#leaderboard-table tbody');
    const podium = document.getElementById('leaderboard-podium');
    const thead = document.getElementById('leaderboard-thead');
    const isTime = this._lbTab === 'time';

    // Toggle tab class on leaderboard view for mobile column visibility
    const lbView = document.getElementById('view-leaderboard');
    if (lbView) {
      lbView.classList.toggle('lb-tab-time', isTime);
      lbView.classList.toggle('lb-tab-streaks', !isTime);
    }

    // Sort based on active tab
    const data = [...rawData].sort((a, b) => {
      if (isTime) return (b.minutesWritten || 0) - (a.minutesWritten || 0) || (b.totalWords || 0) - (a.totalWords || 0);
      return (b.streak || 0) - (a.streak || 0) || (b.totalWords || 0) - (a.totalWords || 0);
    });

    // Update thead
    if (isTime) {
      thead.innerHTML = `<tr><th>Rank</th><th class="lb-pro-col"></th><th>Writer</th><th class="lb-col-time">Writing Time</th><th class="lb-col-words">Words</th><th class="lb-col-streak">Streak</th><th class="lb-col-sessions">Sessions</th><th class="lb-col-level">Level</th></tr>`;
    } else {
      thead.innerHTML = `<tr><th>Rank</th><th class="lb-pro-col"></th><th>Writer</th><th class="lb-col-streak">Streak</th><th class="lb-col-words">Words</th><th class="lb-col-sessions">Sessions</th><th class="lb-col-time">Time</th><th class="lb-col-level">Level</th></tr>`;
    }

    // Podium for top 3
    const top3 = data.slice(0, 3);
    const podiumOrder = [top3[1], top3[0], top3[2]];
    const medals = ['&#x1F948;', '&#x1F947;', '&#x1F949;'];
    const podiumLabels = ['2nd', '1st', '3rd'];
    const heights = ['160px', '200px', '140px'];

    podium.innerHTML = podiumOrder.map((entry, i) => {
      if (!entry) return '<div class="podium-slot empty"></div>';
      const isFirst = podiumLabels[i] === '1st';
      const avatarContent = entry.avatar
        ? `<img src="${entry.avatar}?t=${entry.avatarUpdatedAt || ''}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
        : entry.name.charAt(0).toUpperCase();
      const statLine = isTime
        ? `${this._formatWritingTime(entry.minutesWritten)}`
        : `${entry.streak ? '&#x1F525; ' + entry.streak + ' day streak' : 'No streak'}`;
      return `
        <div class="podium-slot">
          ${isFirst ? '<div class="podium-crown">&#x1F451;</div>' : ''}
          <div class="podium-avatar">${avatarContent}</div>
          <div class="podium-name">${entry.plan === 'premium' ? '<span class="lb-pro-badge">PRO</span> ' : ''}${this.escapeHtml(entry.name)}</div>
          ${entry.username ? `<div class="podium-username"><a href="#user-profile/${this.escapeHtml(entry.username)}" class="profile-link" data-profile-username="${this.escapeHtml(entry.username)}">@${this.escapeHtml(entry.username)}</a></div>` : ''}
          <div class="podium-words">${statLine}</div>
          <div class="podium-pedestal" style="height:${heights[i]}">
            <span class="podium-medal">${medals[i]}</span>
            <span class="podium-rank">${podiumLabels[i]}</span>
          </div>
        </div>`;
    }).join('');

    // Full table
    tbody.innerHTML = data.map((entry, i) => {
      const rankEmoji = i === 0 ? '&#x1F947;' : i === 1 ? '&#x1F948;' : i === 2 ? '&#x1F949;' : `${i + 1}`;
      const isMe = this.user && (entry.id === this.user.id || entry.name === this.user.name);
      const timeStr = this._formatWritingTime(entry.minutesWritten);

      const nameCell = entry.username
        ? `<a href="#user-profile/${this.escapeHtml(entry.username)}" class="lb-name-link profile-link" data-profile-username="${this.escapeHtml(entry.username)}">${this.escapeHtml(entry.name)} <span class="lb-username">@${this.escapeHtml(entry.username)}</span></a>`
        : this.escapeHtml(entry.name);
      const youBadge = isMe ? ' <span class="lb-you">YOU</span>' : '';

      if (isTime) {
        return `
          <tr class="${isMe ? 'leaderboard-me' : ''}">
            <td class="lb-rank">${rankEmoji}</td>
            <td class="lb-pro-col">${entry.plan === 'premium' ? '<span class="lb-pro-badge">PRO</span>' : ''}</td>
            <td class="lb-name">${nameCell}${youBadge}</td>
            <td class="lb-col-time"><strong>${timeStr}</strong></td>
            <td class="lb-col-words">${(entry.totalWords || 0).toLocaleString()}</td>
            <td class="lb-col-streak">${entry.streak ? '&#x1F525; ' + entry.streak : '-'}</td>
            <td class="lb-col-sessions">${entry.totalSessions || 0}</td>
            <td class="lb-col-level"><span class="lb-level">Lv.${this.calcXPLevel(entry.xp || 0).level}</span></td>
          </tr>`;
      }
      return `
        <tr class="${isMe ? 'leaderboard-me' : ''}">
          <td class="lb-rank">${rankEmoji}</td>
          <td class="lb-pro-col">${entry.plan === 'premium' ? '<span class="lb-pro-badge">PRO</span>' : ''}</td>
          <td class="lb-name">${nameCell}${youBadge}</td>
          <td class="lb-col-streak">${entry.streak ? '&#x1F525; ' + entry.streak : '-'}</td>
          <td class="lb-col-words"><strong>${(entry.totalWords || 0).toLocaleString()}</strong></td>
          <td class="lb-col-sessions">${entry.totalSessions || 0}</td>
          <td class="lb-col-time">${timeStr}</td>
          <td class="lb-col-level"><span class="lb-level">Lv.${this.calcXPLevel(entry.xp || 0).level}</span></td>
        </tr>`;
    }).join('');

    if (data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:40px;color:var(--text-muted)">No writers yet. Be the first!</td></tr>';
      podium.innerHTML = '';
    }
  },

  _formatWritingTime(minutes) {
    if (!minutes) return '0m';
    if (minutes >= 60) {
      const h = Math.floor(minutes / 60);
      const m = Math.round(minutes % 60);
      return m > 0 ? `${h}h ${m}m` : `${h}h`;
    }
    return `${Math.round(minutes)}m`;
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

  async openDuelModal(preselectedId) {
    document.getElementById('duel-modal').classList.add('active');
    const select = document.getElementById('duel-friend-select');
    select.innerHTML = '<option value="">Loading friends...</option>';
    // Always fetch fresh friends list
    try {
      const friends = await API.getFriends();
      this.friends = friends;
    } catch {}
    select.innerHTML = '<option value="">Choose a friend...</option>';
    (this.friends || []).forEach(f => {
      select.innerHTML += `<option value="${f.id}">${this.escapeHtml(f.name)}</option>`;
    });
    if (preselectedId) {
      select.value = preselectedId;
      select.disabled = true;
    } else {
      select.disabled = false;
    }
  },

  closeDuelModal() {
    document.getElementById('duel-modal').classList.remove('active');
    document.getElementById('duel-friend-select').disabled = false;
  },

  async loadDuelsView() {
    try {
      const duelHistoryPage = this._duelHistoryPage || 1;
      const [requests, sentDuels, historyData] = await Promise.all([
        API.getDuelRequests(),
        API.getSentDuels(),
        API.getDuelHistory(duelHistoryPage, 10)
      ]);
      const history = historyData.items || [];
      const totalPages = historyData.totalPages || 1;
      const currentPage = historyData.page || 1;

      // Incoming requests
      const reqSection = document.getElementById('duel-requests-section');
      const reqList = document.getElementById('duel-requests-list');
      if (requests.length > 0) {
        reqSection.style.display = 'block';
        document.getElementById('duel-request-count').textContent = requests.length;
        reqList.innerHTML = requests.map(d => {
          const cPro = d.challengerPlan === 'premium' ? ' <span class="pro-inline-badge">PRO</span>' : '';
          return `
          <div class="duel-request-card">
            <div class="duel-request-info">
              <h4>${this.escapeHtml(d.challengerName)}${cPro} challenged you!</h4>
              <span>${d.duration} min duel</span>
            </div>
            <div class="duel-request-actions">
              <button class="btn btn-primary btn-small" onclick="App.acceptDuel('${d.id}')">Accept</button>
              <button class="btn btn-ghost btn-small" onclick="App.declineDuel('${d.id}')">Decline</button>
            </div>
          </div>`;
        }).join('');
      } else {
        reqSection.style.display = 'none';
      }

      // Sent (pending) challenges
      const sentSection = document.getElementById('duel-sent-section');
      if (sentSection) {
        if (sentDuels.length > 0) {
          sentSection.style.display = 'block';
          document.getElementById('duel-sent-list').innerHTML = sentDuels.map(d => {
            const oPro = d.opponentPlan === 'premium' ? ' <span class="pro-inline-badge">PRO</span>' : '';
            return `
            <div class="duel-request-card duel-sent-card">
              <div class="duel-request-info">
                <h4><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Waiting for ${this.escapeHtml(d.opponentName)}${oPro}</h4>
                <span>${d.duration} min duel</span>
              </div>
              <div class="duel-request-actions">
                <button class="btn btn-primary btn-small" onclick="App.enterDuelWaiting('${d.id}')">Join</button>
                <button class="btn btn-ghost btn-small" onclick="App.cancelDuelRequest('${d.id}')">Cancel</button>
              </div>
            </div>`;
          }).join('');
        } else {
          sentSection.style.display = 'none';
        }
      }

      // Hide active duels section — once you leave, you can't come back
      const activeSection = document.getElementById('duel-active-section');
      if (activeSection) activeSection.style.display = 'none';

      // History
      const historyContainer = document.getElementById('duel-history');
      if (history.length === 0 && currentPage === 1) {
        historyContainer.innerHTML = `<div class="empty-state"><p>Your completed duels will appear here.</p></div>`;
      } else {
        let html = history.map(d => {
          const isChallenger = d.challengerId === this.user.id;
          const oppName = isChallenger ? d.opponentName : d.challengerName;
          const oppUsername = isChallenger ? d.opponentUsername : d.challengerUsername;
          const oppPlan = isChallenger ? d.opponentPlan : d.challengerPlan;
          const oppPro = oppPlan === 'premium' ? ' <span class="pro-inline-badge">PRO</span>' : '';
          const won = d.winnerId === this.user.id;
          const tie = !d.winnerId;
          const resultClass = tie ? 'tie' : (won ? 'won' : 'lost');
          const iForfeited = d.forfeitedBy === this.user.id;
          const oppForfeited = d.forfeitedBy && d.forfeitedBy !== this.user.id;
          const myDocId = isChallenger ? d.challengerDocId : d.opponentDocId;
          const myWords = isChallenger ? (d.challengerWords || 0) : (d.opponentWords || 0);
          const oppWords = isChallenger ? (d.opponentWords || 0) : (d.challengerWords || 0);

          const endDate = d.endAt ? new Date(d.endAt) : new Date(d.createdAt);
          const dateStr = endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          const timeStr = endDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

          const docBtn = (myDocId && !iForfeited) ? `<button class="duel-history-doc-btn" onclick="App.openDocument('${myDocId}')">View Doc</button>` : '';

          const detailId = `dhc-detail-${d.id || Math.random().toString(36).slice(2)}`;
          const subtitleText = iForfeited ? 'You left the session'
            : oppForfeited ? `${this.escapeHtml(oppName)} left`
            : `${d.duration} min duel`;
          const resultLabel = tie ? 'TIE' : won ? 'WON' : 'LOST';

          return `
          <div class="duel-history-card ${resultClass}">
            <span class="dhc-badge ${resultClass}">${resultLabel}</span>
            <span class="dhc-vs">vs <strong>${this.escapeHtml(oppName)}</strong>${oppUsername ? ` <span class="dhc-handle">@${this.escapeHtml(oppUsername)}</span>` : ''}${oppPro}</span>
            <span class="dhc-score">${myWords} — ${oppWords}</span>
            <span class="dhc-date">${dateStr}</span>
            <button class="dhc-info-btn" onclick="(function(el){var d=document.getElementById('${detailId}');d.style.display=d.style.display==='none'?'flex':'none';el.classList.toggle('active')})(this)" title="Details">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="8"/><line x1="12" y1="12" x2="12" y2="16"/></svg>
            </button>
          </div>
          <div class="dhc-detail" id="${detailId}" style="display:none">
            <span>${subtitleText}</span>
            <span style="color:var(--text-muted)">${timeStr}</span>
            ${docBtn}
          </div>`;
        }).join('');

        // Pagination controls
        if (totalPages > 1) {
          html += `<div class="duel-history-pager">
            <button class="btn btn-ghost btn-small" ${currentPage <= 1 ? 'disabled' : ''} onclick="App._duelHistoryPage=${currentPage - 1};App.loadDuelsView()">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg> Prev
            </button>
            <span class="duel-history-pager-info">Page ${currentPage} of ${totalPages}</span>
            <button class="btn btn-ghost btn-small" ${currentPage >= totalPages ? 'disabled' : ''} onclick="App._duelHistoryPage=${currentPage + 1};App.loadDuelsView()">
              Next <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          </div>`;
        }

        historyContainer.innerHTML = html;
      }
    } catch {
      this.toast('Failed to load duels', 'error');
    }
  },

  async acceptDuel(duelId) {
    try {
      const duel = await API.acceptDuel(duelId);
      this.toast('Duel accepted! Get ready...', 'success');
      this.enterDuelCountdown(duel.id);
    } catch (err) {
      this.toast(err.message || 'Failed to accept duel', 'error');
    }
  },

  async declineDuel(duelId) {
    try {
      await API.declineDuel(duelId);
      this.toast('Challenge declined', '');
      this.loadDuelsView();
    } catch (err) {
      this.toast(err.message || 'Failed to decline', 'error');
    }
  },

  _duelWaitingInterval: null,
  _duelWaitingId: null,

  async enterDuelWaiting(duelId) {
    // Challenger sent the challenge — show waiting screen, poll for acceptance
    try {
      const duel = await API.getDuelStatus(duelId);
      const oppName = duel.opponentName;

      const overlay = document.getElementById('duel-countdown-overlay');
      const timerEl = document.getElementById('duel-countdown-timer');
      const titleEl = document.getElementById('duel-countdown-title');
      const skipRow = document.getElementById('duel-skip-row');
      const skipBtn = document.getElementById('duel-skip-btn');
      const leaveBtn = document.getElementById('duel-leave-btn');

      titleEl.textContent = 'WAITING FOR OPPONENT';
      timerEl.textContent = '60';
      timerEl.style.fontSize = '';
      document.getElementById('duel-countdown-vs').textContent = `You vs ${oppName}`;
      document.getElementById('duel-countdown-duration').textContent = `${duel.duration} minute duel`;
      skipRow.style.display = 'none';
      skipBtn.style.display = 'none';
      leaveBtn.style.display = '';
      leaveBtn.textContent = 'Leave';
      overlay.classList.add('active');

      this._duelWaitingId = duelId;
      const waitingStartTime = Date.now();
      let lastPoll = 0;

      // 1s interval for countdown display, API poll every 3s
      this._duelWaitingInterval = setInterval(async () => {
        // Update countdown
        const waited = Math.floor((Date.now() - waitingStartTime) / 1000);
        const waitRemaining = Math.max(0, 60 - waited);
        timerEl.textContent = waitRemaining;

        if (waitRemaining <= 0) {
          clearInterval(this._duelWaitingInterval);
          this._duelWaitingInterval = null;
          titleEl.textContent = 'NO ONE JOINED';
          timerEl.textContent = '😔';
          timerEl.style.fontSize = '48px';
          leaveBtn.textContent = 'Leave';
          // Cancel the duel
          API.cancelDuel(duelId).catch(() => {});
          this._duelWaitingId = null;
          return;
        }

        // Poll API every 3s
        const now = Date.now();
        if (now - lastPoll < 3000) return;
        lastPoll = now;

        try {
          const latest = await API.getDuelStatus(duelId);
          if (latest.status === 'countdown') {
            clearInterval(this._duelWaitingInterval);
            this._duelWaitingInterval = null;
            overlay.classList.remove('active');
            this.enterDuelCountdown(duelId);
          } else if (latest.status === 'active') {
            clearInterval(this._duelWaitingInterval);
            this._duelWaitingInterval = null;
            overlay.classList.remove('active');
            this.enterDuelMode(duelId);
          } else if (latest.status === 'declined' || latest.status === 'expired' || latest.status === 'cancelled') {
            clearInterval(this._duelWaitingInterval);
            this._duelWaitingInterval = null;
            overlay.classList.remove('active');
            this.toast(latest.status === 'declined' ? `${oppName} declined the duel` : 'Duel cancelled', '');
            this.loadDuelsView();
          }
        } catch {}
      }, 1000);
    } catch (err) {
      this.toast(err.message || 'Failed to start waiting', 'error');
    }
  },

  leaveDuelWaiting() {
    if (this._duelWaitingInterval) {
      clearInterval(this._duelWaitingInterval);
      this._duelWaitingInterval = null;
    }
    const overlay = document.getElementById('duel-countdown-overlay');
    const timerEl = document.getElementById('duel-countdown-timer');
    timerEl.style.fontSize = '';
    overlay.classList.remove('active');
    // Cancel the pending duel
    if (this._duelWaitingId) {
      API.cancelDuel(this._duelWaitingId).catch(() => {});
      this._duelWaitingId = null;
    }
    this.toast('Duel request cancelled', '');
    this.loadDuelsView();
  },

  async cancelDuelRequest(duelId) {
    try {
      await API.cancelDuel(duelId);
      this.toast('Duel request cancelled', '');
      this.loadDuelsView();
    } catch (err) {
      this.toast(err.message || 'Failed to cancel', 'error');
    }
  },

  async enterDuelCountdown(duelId) {
    try {
      const duel = await API.getDuelStatus(duelId);
      if (duel.status === 'active') {
        this.enterDuelMode(duelId);
        return;
      }
      if (duel.status !== 'countdown') {
        this.toast('Duel is not in countdown', 'error');
        return;
      }

      const overlay = document.getElementById('duel-countdown-overlay');
      const timerEl = document.getElementById('duel-countdown-timer');
      const titleEl = document.getElementById('duel-countdown-title');
      const leaveBtn = document.getElementById('duel-leave-btn');
      const isChallenger = duel.challengerId === this.user.id;
      const oppName = isChallenger ? duel.opponentName : duel.challengerName;

      // Restore countdown UI (may have been in waiting state)
      titleEl.textContent = 'DUEL STARTS IN';
      timerEl.style.fontSize = '';
      leaveBtn.style.display = 'none';

      document.getElementById('duel-countdown-vs').textContent = `You vs ${oppName}`;
      document.getElementById('duel-countdown-duration').textContent = `${duel.duration} minute duel`;

      // Reset skip UI
      const skipRow = document.getElementById('duel-skip-row');
      const skipMe = document.getElementById('duel-skip-me');
      const skipOpp = document.getElementById('duel-skip-opp');
      const skipBtn = document.getElementById('duel-skip-btn');
      skipRow.style.display = '';
      skipMe.textContent = 'Skip';
      skipMe.className = 'duel-skip-status';
      skipOpp.textContent = 'Skip';
      skipOpp.className = 'duel-skip-status';
      skipBtn.style.display = '';
      skipBtn.disabled = false;
      skipBtn.textContent = 'Skip Wait';

      overlay.classList.add('active');

      // Skip button handler
      this._duelSkipHandler = async () => {
        skipBtn.disabled = true;
        skipBtn.textContent = 'Ready!';
        skipMe.textContent = '✓';
        skipMe.classList.add('ready');
        try {
          const updated = await API.duelReady(duelId);
          if (updated.status === 'active') {
            clearInterval(countdownInterval);
            overlay.classList.remove('active');
            this.enterDuelMode(duelId);
          }
        } catch {}
      };
      skipBtn.onclick = this._duelSkipHandler;

      const countdownInterval = setInterval(async () => {
        // Poll duel status to check if opponent is ready
        try {
          const latest = await API.getDuelStatus(duelId);
          if (latest.status === 'active') {
            clearInterval(countdownInterval);
            overlay.classList.remove('active');
            this.enterDuelMode(duelId);
            return;
          }
          // Update opponent ready status
          const oppReady = isChallenger ? latest.opponentReady : latest.challengerReady;
          if (oppReady) {
            skipOpp.textContent = '✓';
            skipOpp.classList.add('ready');
          }
        } catch {}

        const remaining = Math.max(0, Math.ceil((new Date(duel.startAt) - Date.now()) / 1000));
        timerEl.textContent = remaining;
        if (remaining <= 0) {
          clearInterval(countdownInterval);
          overlay.classList.remove('active');
          this.enterDuelMode(duelId);
        }
      }, 1000);
    } catch (err) {
      this.toast(err.message || 'Failed to start countdown', 'error');
    }
  },

  _activeDuelId: null,
  _duelPollInterval: null,

  async enterDuelMode(duelId) {
    this._activeDuelId = duelId;
    try {
      const duel = await API.getDuelStatus(duelId);
      if (duel.status !== 'active') {
        if (duel.status === 'completed') {
          this._showDuelResults(duel);
          return;
        }
        this.toast('Duel is not active yet', 'error');
        return;
      }

      const isChallenger = duel.challengerId === this.user.id;
      const oppName = isChallenger ? duel.opponentName : duel.challengerName;

      // Store duel info for the editor
      sessionStorage.setItem('activeDuel', JSON.stringify({
        duelId: duel.id,
        endAt: duel.endAt,
        isChallenger,
        opponentName: oppName,
        duration: duel.duration
      }));

      // Start the editor directly with duel mode
      this.sessionDuration = duel.duration;
      this.sessionMode = 'standard';
      document.getElementById('editor-title').value = `Duel vs ${oppName}`;
      Editor.start(duel.duration, 'standard', { topic: '', targetWords: 0 });
    } catch (err) {
      this.toast(err.message || 'Failed to enter duel', 'error');
    }
  },

  _showDuelResults(duel) {
    const won = duel.winnerId === this.user.id;
    const tie = !duel.winnerId;
    const iForfeited = duel.forfeitedBy === this.user.id;

    document.getElementById('duel-results-emoji').textContent = iForfeited ? '😢' : (tie ? '🤝' : (won ? '🏆' : '😢'));
    document.getElementById('duel-results-title').textContent = iForfeited ? 'You Lost' : (tie ? 'It\'s a Tie!' : (won ? 'You Won!' : 'You Lost'));

    // Hide word counts — just show the result
    const scoresEl = document.getElementById('duel-results-scores');
    if (scoresEl) scoresEl.style.display = 'none';
    document.getElementById('duel-results-modal').classList.add('active');
  },

  async createDuel() {
    const friendId = document.getElementById('duel-friend-select').value;
    if (!friendId) {
      this.toast('Select a friend first', 'error');
      return;
    }
    const activePreset = document.querySelector('#duel-time-presets .time-preset.active');
    const customInput = document.getElementById('duel-custom-time-input');
    let duration;
    if (activePreset?.id === 'duel-custom-time-btn' && customInput.value) {
      duration = Math.min(Math.max(parseInt(customInput.value) || 10, 1), 60);
    } else {
      duration = parseInt(activePreset?.dataset.minutes || 10);
    }
    try {
      const duel = await API.sendDuelChallenge(friendId, duration);
      this.toast(`Duel challenge sent! Waiting for opponent...`, 'success');
      this.closeDuelModal();
      this.enterDuelWaiting(duel.id);
    } catch (err) {
      this.toast(err.message || 'Failed to send challenge', 'error');
    }
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

  async exportDocPDF(id) {
    try {
      const data = await API.exportDocument(id);
      // Create a printable HTML document and trigger browser print (Save as PDF)
      const printWin = window.open('', '_blank');
      printWin.document.write(`<!DOCTYPE html><html><head><title>${data.title || 'Document'}</title>
        <style>body{font-family:Georgia,serif;max-width:700px;margin:40px auto;padding:20px;color:#222;line-height:1.7}
        h1{font-size:28px;margin-bottom:8px}
        .meta{font-size:13px;color:#888;margin-bottom:24px;border-bottom:1px solid #eee;padding-bottom:12px}
        .content{font-size:16px}</style></head><body>
        <h1>${this.escapeHtml(data.title || 'Untitled')}</h1>
        <div class="meta">${data.wordCount || 0} words &middot; ${new Date(data.createdAt).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })} &middot; iWrite4.me</div>
        <div class="content">${data.content || ''}</div></body></html>`);
      printWin.document.close();
      setTimeout(() => printWin.print(), 500);
    } catch {
      this.toast('Failed to export document', 'error');
    }
  },

  async deleteDoc(id) {
    const ok = await this.showConfirm('Delete this document?');
    if (!ok) return;
    try {
      await API.deleteDocument(id);
      this._docsCacheDirty = true;
      if (this.currentView === 'dashboard') this.loadDashboard();
      else this.loadDocuments(true);
    } catch {
      this.toast('Failed to delete document', 'error');
    }
  },

  loadProfile() {
    const profNameEl = document.getElementById('profile-name');
    const profEmailEl = document.getElementById('profile-email');
    if (profNameEl) profNameEl.value = this.user.name;
    if (profEmailEl) profEmailEl.value = this.user.email;
    const usernameEl = document.getElementById('profile-username');
    if (usernameEl) usernameEl.value = this.user.username || '';
    // Bio
    const bioEl = document.getElementById('profile-bio');
    if (bioEl) {
      bioEl.value = this.user.bio || '';
      const countEl = document.getElementById('profile-bio-count');
      if (countEl) countEl.textContent = `${(this.user.bio || '').length}/160`;
      bioEl.oninput = () => { if (countEl) countEl.textContent = `${bioEl.value.length}/160`; };
    }
    // Banner
    const bannerPreview = document.getElementById('profile-banner-preview');
    const removeBannerBtn = document.getElementById('remove-banner-btn');
    if (bannerPreview) {
      const bannerPlaceholder = document.getElementById('profile-banner-placeholder');
      if (this.user.banner) {
        const bannerUrl = `url(${this.user.banner}?t=${this.user.bannerUpdatedAt || 0})`;
        if (bannerPreview.style.backgroundImage !== bannerUrl) bannerPreview.style.backgroundImage = bannerUrl;
        if (removeBannerBtn) removeBannerBtn.style.display = 'inline-flex';
        if (bannerPlaceholder) bannerPlaceholder.style.display = 'none';
      } else {
        bannerPreview.style.backgroundImage = '';
        if (removeBannerBtn) removeBannerBtn.style.display = 'none';
        if (bannerPlaceholder) bannerPlaceholder.style.display = '';
      }
    }
    // Banner upload handler
    const bannerInput = document.getElementById('banner-file-input');
    if (bannerInput && !bannerInput._bound) {
      bannerInput._bound = true;
      bannerInput.addEventListener('change', async () => {
        if (!bannerInput.files[0]) return;
        const fd = new FormData();
        fd.append('banner', bannerInput.files[0]);
        try {
          const res = await fetch('/api/auth/banner', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${API.getToken()}` },
            body: fd
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error);
          this.user = data;
          this.loadProfile();
          this.toast('Banner updated!', 'success');
        } catch (e) { this.toast(e.message || 'Failed to upload banner', 'error'); }
        bannerInput.value = '';
      });
    }
    if (removeBannerBtn && !removeBannerBtn._bound) {
      removeBannerBtn._bound = true;
      removeBannerBtn.addEventListener('click', async () => {
        try {
          const res = await fetch('/api/auth/banner', {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${API.getToken()}` }
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error);
          this.user = data;
          this.loadProfile();
          this.toast('Banner removed', 'success');
        } catch (e) { this.toast(e.message || 'Failed to remove banner', 'error'); }
      });
    }
    // Show username change info (Free: 1/30 days, Pro: 3/month)
    const usernameInfo = document.getElementById('profile-username-info');
    const isPro = this.user && this.user.plan === 'premium';
    if (usernameInfo) {
      if (isPro) {
        const currentMonth = new Date().toISOString().slice(0, 7);
        const changesUsed = (this.user.usernameChangesMonth === currentMonth) ? (this.user.usernameChangesCount || 0) : 0;
        if (changesUsed >= 3) {
          usernameInfo.textContent = 'Username change limit reached (3/month)';
          usernameInfo.style.display = 'block';
          usernameEl.disabled = true;
        } else {
          usernameInfo.textContent = `${3 - changesUsed} username changes left this month`;
          usernameInfo.style.display = 'block';
          usernameEl.disabled = false;
        }
      } else if (this.user.lastUsernameChange) {
        const lastChange = new Date(this.user.lastUsernameChange);
        const diffDays = Math.floor((Date.now() - lastChange.getTime()) / (1000 * 60 * 60 * 24));
        if (diffDays < 30) {
          usernameInfo.textContent = `Can change again in ${30 - diffDays} day${30 - diffDays !== 1 ? 's' : ''}`;
          usernameInfo.style.display = 'block';
          usernameEl.disabled = true;
        } else {
          usernameInfo.style.display = 'none';
          usernameEl.disabled = false;
        }
      }
    }
    const pwSection = document.getElementById('change-password-section');
    if (pwSection) pwSection.style.display = this.user.provider === 'google' ? 'none' : '';
    const sinceEl = document.getElementById('profile-since');
    if (sinceEl) sinceEl.value = new Date(this.user.createdAt).toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric'
    });

    // Avatar
    const letter = this.user.name.charAt(0).toUpperCase();
    const letterEl = document.getElementById('profile-avatar-letter');
    const imgEl = document.getElementById('profile-avatar-img');
    const nameEl = document.getElementById('profile-avatar-name');
    const removeBtn = document.getElementById('remove-avatar-btn');
    if (nameEl) nameEl.textContent = this.user.name;
    const avatarUsernameEl = document.getElementById('profile-avatar-username');
    if (avatarUsernameEl) avatarUsernameEl.textContent = `@${this.user.username || ''}`;

    // Plan info on right side
    const planInfoEl = document.getElementById('profile-plan-info');
    if (planInfoEl) {
      const isPro = this.user.plan === 'premium';
      if (isPro) {
        let expiryText = '';
        if (this.user.planExpiresAt === 'infinite') {
          expiryText = 'Lifetime';
        } else if (this.user.planExpiresAt) {
          expiryText = `Expires ${new Date(this.user.planExpiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
        }
        planInfoEl.innerHTML = `<span class="profile-plan-badge pro">PRO</span><span class="profile-plan-expiry">${expiryText}</span>`;
      } else {
        planInfoEl.innerHTML = `<span class="profile-plan-badge free">FREE</span><span class="profile-plan-expiry">Free forever</span>`;
      }
    }

    if (this.user.avatar && imgEl && letterEl) {
      const t = this.user.avatarUpdatedAt || 0;
      const newSrc = `${this.user.avatar}?t=${t}`;
      if (imgEl.src !== newSrc && !imgEl.src.endsWith(newSrc)) imgEl.src = newSrc;
      imgEl.style.display = 'block';
      if (letterEl) letterEl.style.display = 'none';
      if (removeBtn) removeBtn.style.display = '';
    } else {
      if (imgEl) imgEl.style.display = 'none';
      if (letterEl) { letterEl.style.display = ''; letterEl.textContent = letter; }
      if (removeBtn) removeBtn.style.display = 'none';
    }

    // Avatar file input
    const fileInput = document.getElementById('avatar-file-input');
    if (fileInput && !fileInput._bound) {
      fileInput._bound = true;
      fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const updated = await API.uploadAvatar(file);
          this.user = updated;
          this.updateUserUI();
          this.loadProfile();
          this.toast('Avatar updated!', 'success');
        } catch (err) {
          this.toast(err.message || 'Failed to upload avatar', 'error');
        }
        fileInput.value = '';
      });
    }
    if (removeBtn && !removeBtn._bound) {
      removeBtn._bound = true;
      removeBtn.addEventListener('click', async () => {
        try {
          const updated = await API.deleteAvatar();
          this.user = updated;
          this.updateUserUI();
          this.loadProfile();
          this.toast('Avatar removed', 'success');
        } catch (err) {
          this.toast(err.message || 'Failed to remove avatar', 'error');
        }
      });
    }

    // Referral section
    this._loadReferral();
  },

  async _loadReferral() {
    const wrap = document.getElementById('referral-section');
    if (!wrap) return;
    try {
      const data = await API.request('/auth/referral');
      const link = `${window.location.origin}/join/${data.referralCode}`;
      const progress = data.progress; // 0-4
      const dots = Array.from({length: 5}, (_, i) =>
        `<div class="referral-dot ${i < progress ? 'filled' : ''}"></div>`
      ).join('');

      wrap.innerHTML = `
        <h3 style="font-size:15px;font-weight:700;margin-bottom:12px">Invite Friends</h3>
        <p style="color:var(--text-secondary);font-size:13px;margin-bottom:12px">
          Invite 5 friends and get <strong style="color:var(--success)">1 month of Pro free</strong>. They just need to sign up through your link.
        </p>
        <div style="display:flex;gap:8px;margin-bottom:16px">
          <input type="text" value="${link}" readonly style="flex:1;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:8px 12px;color:var(--text-primary);font-size:13px;font-family:var(--font-mono)">
          <button onclick="navigator.clipboard.writeText('${link}').then(()=>App.toast('Link copied!','success'))" class="btn btn-small" style="white-space:nowrap">Copy</button>
        </div>
        <div style="display:flex;align-items:center;gap:12px">
          <div style="display:flex;gap:6px">${dots}</div>
          <span style="color:var(--text-secondary);font-size:13px">${data.referralCount} invited · ${5 - progress} more for Pro</span>
        </div>
        ${data.referredUsers.length ? `
          <div style="margin-top:12px;font-size:12px;color:var(--text-muted)">
            ${data.referredUsers.map(u => `<span style="margin-right:8px">✓ ${u.name}</span>`).join('')}
          </div>
        ` : ''}
      `;
    } catch (e) {
      wrap.innerHTML = '';
    }
  },

  // ===== MY PROFILE (own public profile view) =====
  async loadMyProfile() {
    if (!this.user || !this.user.username) {
      // No username set — redirect to settings to set one
      this.switchView('settings');
      this.toast('Set a username first to view your profile.', 'info');
      return;
    }
    const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const initialsFor = n => (n||'?').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2);

    try {
      const p = await API.request(`/profiles/${encodeURIComponent(this.user.username)}`);

      // Banner (skip re-render if src unchanged)
      const bannerEl = document.getElementById('mp-banner');
      if (p.banner) {
        const bannerUrl = `url(${p.banner}?t=${p.bannerUpdatedAt || 0})`;
        if (bannerEl.style.backgroundImage !== bannerUrl) {
          bannerEl.style.backgroundImage = bannerUrl;
          bannerEl.innerHTML = '';
        }
      } else {
        bannerEl.style.backgroundImage = '';
        bannerEl.innerHTML = '<span class="up-banner-placeholder">No banner yet</span>';
      }
      bannerEl.className = 'up-banner';

      // Avatar (skip re-render if src unchanged)
      const avatarEl = document.getElementById('mp-avatar');
      if (p.avatar) {
        const avatarSrc = `${esc(p.avatar)}?t=${p.avatarUpdatedAt || 0}`;
        const existingImg = avatarEl.querySelector('img');
        if (!existingImg || !existingImg.src.endsWith(avatarSrc)) {
          avatarEl.innerHTML = `<div class="up-avatar-circle"><img src="${avatarSrc}" alt="${esc(p.name)}'s photo"></div>`;
        }
      } else {
        avatarEl.innerHTML = `<div class="up-avatar-circle"><span>${esc(initialsFor(p.name))}</span></div>`;
      }

      // Name + badge
      document.getElementById('mp-name').textContent = p.name;
      document.getElementById('mp-pro-badge').style.display = p.plan === 'premium' ? 'inline-block' : 'none';

      // Username + bio
      document.getElementById('mp-username').textContent = `@${p.username}`;
      const bioEl = document.getElementById('mp-bio');
      bioEl.textContent = p.bio || '';
      bioEl.style.display = p.bio ? 'block' : 'none';

      // Stats
      document.getElementById('mp-stats').innerHTML = `
        <span><strong>${p.followerCount}</strong> followers</span>
        <span><strong>${p.followingCount}</strong> following</span>
        <span><strong>${p.storyCount}</strong> stories</span>
        <span>Joined ${new Date(p.createdAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}</span>
      `;

      // Tabs
      this._setupMyProfileTabs(p);
      this._renderProfileAbout(p, 'mp-about');
    } catch (err) {
      document.getElementById('mp-banner').className = 'up-banner';
      document.getElementById('mp-name').textContent = 'Error loading profile';
    }
  },

  _setupMyProfileTabs(profile) {
    document.querySelectorAll('[data-mptab]').forEach(tab => {
      tab.onclick = () => {
        document.querySelectorAll('[data-mptab]').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');
        document.getElementById('mp-posts').style.display = 'none';
        document.getElementById('mp-about').style.display = 'none';
        const t = tab.dataset.mptab;
        document.getElementById(`mp-${t}`).style.display = 'block';
        if (t === 'posts') this._renderProfilePosts(profile, 'mp-posts');
        if (t === 'about') this._renderProfileAbout(profile, 'mp-about');
      };
    });
  },

  // ===== PUBLIC USER PROFILE =====
  _profileCache: {},

  async loadUserProfile(username) {
    if (!username) return;
    const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

    // Show skeleton
    document.getElementById('up-banner').className = 'up-banner up-skeleton';
    document.getElementById('up-avatar').innerHTML = '<div class="up-avatar-circle up-skeleton-circle"></div>';
    document.getElementById('up-name').textContent = '';
    document.getElementById('up-username').textContent = '';
    document.getElementById('up-bio').textContent = '';
    document.getElementById('up-stats').textContent = '';
    document.getElementById('up-actions').innerHTML = '';
    document.getElementById('up-posts').innerHTML = '<div class="up-skeleton-cards"><div class="up-skeleton-card"></div><div class="up-skeleton-card"></div></div>';
    document.getElementById('up-about').innerHTML = '';

    try {
      const profile = await API.request(`/profiles/${encodeURIComponent(username)}`);
      this._profileCache[username] = profile;
      this._renderUserProfile(profile);
    } catch (err) {
      if (err.status === 404) {
        document.getElementById('up-banner').className = 'up-banner';
        document.getElementById('up-banner').style.backgroundImage = '';
        document.getElementById('up-avatar').innerHTML = '<div class="up-avatar-circle"><span style="font-size:40px;color:var(--text-muted)">?</span></div>';
        document.getElementById('up-name').textContent = 'Writer not found';
        document.getElementById('up-username').textContent = `@${username} doesn't exist`;
        document.getElementById('up-posts').innerHTML = '';
      } else {
        document.getElementById('up-name').textContent = 'Error loading profile';
        document.getElementById('up-posts').innerHTML = '<div class="up-empty">Couldn\'t load profile. <a href="javascript:void(0)" onclick="App.loadUserProfile(\'' + esc(username) + '\')">Try again</a></div>';
      }
    }
  },

  _renderUserProfile(p) {
    const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const initialsFor = n => (n||'?').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2);

    // Banner (skip re-render if src unchanged)
    const bannerEl = document.getElementById('up-banner');
    bannerEl.className = 'up-banner';
    if (p.banner) {
      const bannerUrl = `url(${p.banner}?t=${p.bannerUpdatedAt || 0})`;
      if (bannerEl.style.backgroundImage !== bannerUrl) {
        bannerEl.style.backgroundImage = bannerUrl;
        bannerEl.innerHTML = '';
      }
    } else {
      bannerEl.style.backgroundImage = '';
      bannerEl.innerHTML = '<span class="up-banner-placeholder">No banner yet</span>';
    }

    // Avatar (skip re-render if src unchanged)
    const avatarEl = document.getElementById('up-avatar');
    if (p.avatar) {
      const avatarSrc = `${esc(p.avatar)}?t=${p.avatarUpdatedAt || 0}`;
      const existingImg = avatarEl.querySelector('img');
      if (!existingImg || !existingImg.src.endsWith(avatarSrc)) {
        avatarEl.innerHTML = `<div class="up-avatar-circle"><img src="${avatarSrc}" alt="${esc(p.name)}'s photo"></div>`;
      }
    } else {
      avatarEl.innerHTML = `<div class="up-avatar-circle"><span>${esc(initialsFor(p.name))}</span></div>`;
    }

    // Name + badge
    document.getElementById('up-name').textContent = p.name;
    const proBadge = document.getElementById('up-pro-badge');
    proBadge.style.display = p.plan === 'premium' ? 'inline-block' : 'none';

    // Username + bio
    document.getElementById('up-username').textContent = `@${p.username}`;
    const bioEl = document.getElementById('up-bio');
    bioEl.textContent = p.bio || '';
    bioEl.style.display = p.bio ? 'block' : 'none';

    // Actions — follow button or edit profile
    const actionsEl = document.getElementById('up-actions');
    if (p.isOwnProfile) {
      actionsEl.innerHTML = `<button class="btn btn-ghost btn-small" onclick="App.switchView('settings')">Edit Profile</button>`;
    } else if (this.user) {
      const isFollowing = p.isFollowing;
      actionsEl.innerHTML = `<button class="up-follow-btn ${isFollowing ? 'following' : ''}" id="up-follow-btn" data-userid="${esc(p.id)}" data-following="${isFollowing}" aria-label="${isFollowing ? 'Unfollow' : 'Follow'} ${esc(p.name)}">${isFollowing ? 'Following' : 'Follow'}</button>`;
      document.getElementById('up-follow-btn').addEventListener('click', (e) => this._toggleFollow(e.target, p));
    } else {
      actionsEl.innerHTML = `<a href="/app#stories" class="btn btn-primary btn-small">Sign up to follow</a>`;
    }

    // Stats
    document.getElementById('up-stats').innerHTML = `
      <span><strong>${p.followerCount}</strong> followers</span>
      <span><strong>${p.followingCount}</strong> following</span>
      <span><strong>${p.storyCount}</strong> stories</span>
      <span>Joined ${new Date(p.createdAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}</span>
    `;

    // Tabs
    this._setupProfileTabs(p);

    // Default: render About tab
    this._renderProfileAbout(p);
  },

  _setupProfileTabs(profile) {
    document.querySelectorAll('.up-tab').forEach(tab => {
      tab.onclick = () => {
        document.querySelectorAll('.up-tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');
        document.getElementById('up-posts').style.display = 'none';
        document.getElementById('up-about').style.display = 'none';
        const t = tab.dataset.uptab;
        document.getElementById(`up-${t}`).style.display = 'block';
        if (t === 'posts') this._renderProfilePosts(profile);
        if (t === 'about') this._renderProfileAbout(profile);
      };
    });
  },

  _renderProfilePosts(p, targetId) {
    const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const el = document.getElementById(targetId || 'up-posts');
    if (!p.stories || p.stories.length === 0) {
      el.innerHTML = p.isOwnProfile
        ? '<div class="up-empty">You haven\'t published any stories yet. <a href="javascript:void(0)" onclick="App.switchView(\'stories\')">Write your first story →</a></div>'
        : '<div class="up-empty">No published stories yet.</div>';
      return;
    }
    el.innerHTML = p.stories.map(s => `
      <div class="up-story-card" onclick="window.location.hash='stories';setTimeout(()=>Stories.openStory&&Stories.openStory('${esc(s.id)}'),100)">
        <h3 class="up-story-title">${esc(s.title)}</h3>
        <p class="up-story-excerpt">${esc(s.excerpt || '')}</p>
        <div class="up-story-meta">
          <span>${new Date(s.publishedAt || s.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
          <span>${s.readTimeMinutes || 1} min read</span>
          <span>❤ ${s.likeCount || 0}</span>
          <span>💬 ${s.commentCount || 0}</span>
        </div>
      </div>
    `).join('');
  },

  async _renderProfileActivity(p, targetId) {
    const el = document.getElementById(targetId || 'up-activity');
    const { level, xpInLevel, xpForNextLevel } = this.calcXPLevel ? this.calcXPLevel(p.xp || 0) : { level: p.level || 0, xpInLevel: 0, xpForNextLevel: 100 };

    // Stats cards
    const prefix = targetId ? targetId.replace('-activity', '') : 'up';
    el.innerHTML = `
      <div class="up-activity-stats">
        <div class="up-stat-card"><div class="up-stat-value">${(p.totalWords || 0).toLocaleString()}</div><div class="up-stat-label">Total Words</div></div>
        <div class="up-stat-card"><div class="up-stat-value">${p.totalSessions || 0}</div><div class="up-stat-label">Sessions</div></div>
        <div class="up-stat-card"><div class="up-stat-value">${p.streak || 0}</div><div class="up-stat-label">Day Streak</div></div>
        <div class="up-stat-card"><div class="up-stat-value">${p.longestStreak || 0}</div><div class="up-stat-label">Best Streak</div></div>
        <div class="up-stat-card"><div class="up-stat-value">${level}</div><div class="up-stat-label">Level</div></div>
      </div>
      <div id="${prefix}-heatmap" style="margin-top:20px"></div>
      <div class="up-achievements-section" style="margin-top:20px">
        <h3 style="font-size:15px;font-weight:700;margin-bottom:12px;color:var(--text-secondary)">Achievements</h3>
        <div class="up-achievements-grid" id="${prefix}-achievements-grid"></div>
      </div>
    `;

    // Render heatmap
    this._renderProfileHeatmap(p.username, `${prefix}-heatmap`);

    // Render all achievements (earned + unearned) with descriptions
    const grid = document.getElementById(`${prefix}-achievements-grid`);
    if (grid) {
      const allAch = this._getProfileAchievements(p);
      grid.innerHTML = allAch.map(a => `
        <div class="achievement-card ${a.earned ? 'earned' : ''}">
          <div class="achievement-icon">${a.icon}</div>
          <h3>${a.name}</h3>
          <p>${a.description}</p>
        </div>
      `).join('');
    }
  },

  async _renderProfileHeatmap(username, containerId) {
    const container = document.getElementById(containerId || 'up-heatmap');
    if (!container) return;
    try {
      const activity = await API.request(`/profiles/${encodeURIComponent(username)}/activity`);
      if (!activity || activity.every(d => d.sessionCount === 0)) {
        container.innerHTML = '<div class="up-empty" style="padding:12px">No writing sessions in the last 60 days.</div>';
        return;
      }
      // Build day map
      const dayMap = {};
      activity.forEach(d => { dayMap[d.date] = d.sessionCount; });

      // Build GitHub-style grid: weeks as columns, days as rows
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const startDate = new Date(today);
      startDate.setDate(startDate.getDate() - 59);
      // Align to Monday
      const startDay = startDate.getDay();
      const mondayOffset = startDay === 0 ? -6 : 1 - startDay;
      startDate.setDate(startDate.getDate() + mondayOffset);

      const weeks = [];
      const d = new Date(startDate);
      while (d <= today) {
        const week = [];
        for (let dow = 0; dow < 7; dow++) {
          const key = d.toISOString().slice(0, 10);
          const count = dayMap[key] || 0;
          const isFuture = d > today;
          week.push({ key, count, level: count === 0 ? 0 : count === 1 ? 1 : 2, hide: isFuture });
          d.setDate(d.getDate() + 1);
        }
        weeks.push(week);
      }

      let html = '<div class="streak-heatmap"><div class="heatmap-grid" style="display:flex;gap:3px">';
      weeks.forEach(week => {
        html += '<div style="display:flex;flex-direction:column;gap:3px">';
        week.forEach(cell => {
          if (cell.hide) {
            html += '<div class="heatmap-cell" style="visibility:hidden"></div>';
          } else {
            const dt = new Date(cell.key);
            const title = `${dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} — ${cell.count} session${cell.count !== 1 ? 's' : ''}`;
            html += `<div class="heatmap-cell level-${cell.level}" title="${title}"></div>`;
          }
        });
        html += '</div>';
      });
      html += '</div>';
      html += '<div class="heatmap-legend"><span>Less</span><div class="heatmap-cell level-0"></div><div class="heatmap-cell level-1"></div><div class="heatmap-cell level-2"></div><span>More</span></div>';
      html += '</div>';
      container.innerHTML = html;
    } catch {
      container.innerHTML = '<div class="up-empty" style="padding:12px">Couldn\'t load activity.</div>';
    }
  },

  _renderProfileAbout(p, targetId) {
    const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const el = document.getElementById(targetId || 'up-about');
    const prefix = targetId ? targetId.replace('-about', '') : 'up';
    const bio = p.bio ? `<p class="up-about-bio">${esc(p.bio)}</p>` : (p.isOwnProfile ? '<p class="up-about-bio" style="color:var(--text-muted)">You haven\'t written a bio yet. <a href="javascript:void(0)" onclick="App.switchView(\'settings\')">Add a bio →</a></p>' : '<p class="up-about-bio" style="color:var(--text-muted)">This writer hasn\'t written a bio yet.</p>');
    const joinDate = new Date(p.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const { level } = this.calcXPLevel ? this.calcXPLevel(p.xp || 0) : { level: p.level || 0 };
    // Format total writing time
    const totalSecs = p.totalWritingTime || 0;
    const hrs = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const timeStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
    const achievements = this._getProfileAchievements(p);
    const earnedAch = achievements.filter(a => a.earned);
    const unearnedAch = achievements.filter(a => !a.earned);
    el.innerHTML = `
      ${bio}
      <div class="up-about-stats">
        <div class="up-about-detail"><strong>Member since</strong> ${joinDate}</div>
        <div class="up-about-detail"><strong>Level</strong> ${level}</div>
        <div class="up-about-detail"><strong>XP</strong> ${(p.xp || 0).toLocaleString()}</div>
        <div class="up-about-detail"><strong>Writing Time</strong> ${timeStr}</div>
      </div>
      <div class="up-activity-stats" style="margin-top:16px">
        <div class="up-stat-card"><div class="up-stat-emoji">&#x1F4DD;</div><div class="up-stat-value">${(p.totalWords || 0).toLocaleString()}</div><div class="up-stat-label">Total Words</div></div>
        <div class="up-stat-card"><div class="up-stat-emoji">&#x270D;&#xFE0F;</div><div class="up-stat-value">${p.totalSessions || 0}</div><div class="up-stat-label">Sessions</div></div>
        <div class="up-stat-card"><div class="up-stat-emoji">&#x1F525;</div><div class="up-stat-value">${p.streak || 0}</div><div class="up-stat-label">Day Streak</div></div>
        <div class="up-stat-card"><div class="up-stat-emoji">&#x1F3C6;</div><div class="up-stat-value">${p.longestStreak || 0}</div><div class="up-stat-label">Best Streak</div></div>
      </div>
      <div class="up-about-achievements">
        <h3 class="up-about-achievements-title">Achievements</h3>
        <div class="up-achievements-grid">
          ${earnedAch.map(a => `
            <div class="achievement-card earned">
              <div class="achievement-icon">${a.icon}</div>
              <h3>${a.name}</h3>
              <p>${a.description}</p>
            </div>
          `).join('')}
          ${unearnedAch.map(a => `
            <div class="achievement-card">
              <div class="achievement-icon">${a.icon}</div>
              <h3>${a.name}</h3>
              <p>${a.description}</p>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  },

  async _toggleFollow(btn, profile) {
    if (btn.disabled) return;
    btn.disabled = true;
    const isFollowing = btn.dataset.following === 'true';
    try {
      if (isFollowing) {
        await API.request(`/follow/${profile.id}`, { method: 'DELETE' });
        btn.dataset.following = 'false';
        btn.classList.remove('following');
        btn.textContent = 'Follow';
        btn.setAttribute('aria-label', `Follow ${profile.name}`);
        const countEl = document.querySelector('.up-stats strong');
        if (countEl) countEl.textContent = Math.max(0, parseInt(countEl.textContent) - 1);
      } else {
        const res = await API.request(`/follow/${profile.id}`, { method: 'POST' });
        btn.dataset.following = 'true';
        btn.classList.add('following');
        btn.textContent = 'Following';
        btn.setAttribute('aria-label', `Unfollow ${profile.name}`);
        const countEl = document.querySelector('.up-stats strong');
        if (countEl) countEl.textContent = res.followerCount;
      }
    } catch (err) {
      this.toast(err.message || 'Failed', 'error');
    }
    btn.disabled = false;
  },

  // ===== HOVER CARD =====
  _hoverCardEl: null,
  _hoverCardTimeout: null,

  _initHoverCards() {
    if (this._hoverCardEl) return;
    const card = document.createElement('div');
    card.className = 'profile-hover-card';
    card.style.display = 'none';
    document.body.appendChild(card);
    this._hoverCardEl = card;

    card.addEventListener('mouseenter', () => clearTimeout(this._hoverCardTimeout));
    card.addEventListener('mouseleave', () => {
      this._hoverCardTimeout = setTimeout(() => { card.style.display = 'none'; }, 200);
    });

    // Delegate hover events on username links
    document.addEventListener('mouseenter', async (e) => {
      const link = e.target.closest('.username-link');
      if (!link) return;
      const username = link.dataset.username;
      if (!username) return;
      clearTimeout(this._hoverCardTimeout);
      this._hoverCardTimeout = setTimeout(async () => {
        try {
          let data = this._profileCache[username];
          if (!data) {
            data = await API.request(`/profiles/${encodeURIComponent(username)}`);
            this._profileCache[username] = data;
          }
          this._showHoverCard(data, link);
        } catch {}
      }, 300);
    }, true);

    document.addEventListener('mouseleave', (e) => {
      const link = e.target.closest('.username-link');
      if (!link) return;
      this._hoverCardTimeout = setTimeout(() => { card.style.display = 'none'; }, 200);
    }, true);
  },

  _showHoverCard(profile, anchor) {
    const card = this._hoverCardEl;
    const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const initialsFor = n => (n||'?').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2);
    const avatar = profile.avatar
      ? `<img src="${esc(profile.avatar)}" alt="" class="hc-avatar-img">`
      : `<span class="hc-avatar-fallback">${esc(initialsFor(profile.name))}</span>`;

    card.innerHTML = `
      <div class="hc-header">
        <div class="hc-avatar">${avatar}</div>
        <div class="hc-info">
          <div style="display:flex;align-items:center;gap:6px"><strong>${esc(profile.name)}</strong>${profile.plan === 'premium' ? '<span class="pro-nav-badge" style="font-size:8px;padding:1px 4px">PRO</span>' : ''}</div>
          <div style="color:var(--text-muted);font-size:12px">@${esc(profile.username)}</div>
        </div>
      </div>
      <div class="hc-stats">
        <span>Lvl ${profile.level || 0}</span>
        <span>${profile.streak || 0}d streak</span>
        <span>${profile.storyCount || 0} stories</span>
        <span>${profile.followerCount || 0} followers</span>
      </div>
    `;

    // Position
    const rect = anchor.getBoundingClientRect();
    card.style.display = 'block';
    const cardRect = card.getBoundingClientRect();
    let top = rect.bottom + 8;
    let left = rect.left;
    if (top + cardRect.height > window.innerHeight) top = rect.top - cardRect.height - 8;
    if (left + cardRect.width > window.innerWidth) left = window.innerWidth - cardRect.width - 8;
    card.style.top = `${top}px`;
    card.style.left = `${Math.max(8, left)}px`;
  },

  // Stripe pricing data
  _stripePricing: {
    '1m': { price: '1.99', period: '/mo', uzs: '~25,000 UZS', savings: null },
    '3m': { price: '4.99', period: '/3 months', uzs: '~62,000 UZS', savings: 'Save 17% vs monthly' },
    '6m': { price: '8.99', period: '/6 months', uzs: '~112,000 UZS', savings: 'Save 25% vs monthly' }
  },
  _selectedDuration: '1m',

  loadUpgrade() {
    const el = document.getElementById('upgrade-plan-cards');
    if (!el) return;
    const isPro = this.user && this.user.plan === 'premium';
    const isStripe = this.user && (this.user.planSource === 'stripe' || this.user.planSource === 'trial');

    const freeFeatures = [
      'Timed sessions (30, 45 & 60 min)',
      'Dangerous mode (fixed timer)',
      'Streak tracking & tree growth',
      'XP / Level system',
      'Friends & duels',
      'Document sharing'
    ];
    const proFeatures = [
      'Everything in Free',
      'All timer options + custom',
      'Custom danger inactivity timer',
      'YouTube background music',
      'Larger word & editing limits',
      'Folders & pinned documents',
      'Export to PDF',
      'Full session analytics',
      'Username change 3x/month',
      'Pro badge on leaderboard',
      'Priority support'
    ];

    const expiryInfo = isPro && this.user.planExpiresAt && this.user.planExpiresAt !== 'infinite'
      ? ` · expires ${new Date(this.user.planExpiresAt).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'})}`
      : (isPro && this.user.planExpiresAt === 'infinite' ? ' · Lifetime' : '');

    const canTrial = !isPro && !this.user.trialUsed;
    const dur = this._stripePricing[this._selectedDuration];

    el.innerHTML = `
      <div class="upgrade-card${!isPro ? ' upgrade-card-current' : ''}" style="animation-delay:0.1s">
        <div class="upgrade-card-head">
          <h3 class="upgrade-card-name">Free</h3>
          <p class="upgrade-card-desc">Perfect for getting started with focused writing.</p>
          <div class="upgrade-card-price">
            <span class="upgrade-price-dollar">$</span><span class="upgrade-price-amount">0</span><span class="upgrade-price-period">/mo</span>
          </div>
          <div class="upgrade-price-spacer">Free forever</div>
        </div>
        <div class="upgrade-card-btn-wrap">
          ${!isPro ? '<button class="upgrade-card-btn" disabled>Current plan</button>' : '<button class="upgrade-card-btn" disabled>Free plan</button>'}
        </div>
        <div class="upgrade-card-divider"></div>
        <div class="upgrade-card-features">
          <h4>Features</h4>
          <ul>${freeFeatures.map(f => `<li>${f}</li>`).join('')}</ul>
        </div>
      </div>

      <div class="upgrade-card upgrade-card-featured${isPro ? ' upgrade-card-current' : ''}" style="animation-delay:0.2s">
        <div class="upgrade-card-head">
          <h3 class="upgrade-card-name">Pro</h3>
          <p class="upgrade-card-desc">Enhanced features for serious, dedicated writers.</p>
          ${isPro ? (() => {
            const u = this.user;
            const src = u.planSource === 'trial' ? 'Free Trial' : u.planSource === 'stripe' ? 'Stripe' : u.planSource === 'admin' ? 'Admin' : u.planSource === 'referral' ? 'Referral' : u.planSource || 'Unknown';
            const durLabel = u.planDuration === '6m' ? '6-month' : u.planDuration === '3m' ? '3-month' : u.planDuration === '1m' ? 'Monthly' : '';
            const renewsAt = u.planExpiresAt && u.planExpiresAt !== 'infinite' ? new Date(u.planExpiresAt).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'}) : null;
            const startedAt = u.planStartedAt ? new Date(u.planStartedAt).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'}) : null;
            return `
          <div class="upgrade-pro-status">
            <div class="upgrade-pro-status-row"><span class="upgrade-pro-label">Plan</span><span class="upgrade-pro-value">${durLabel ? durLabel + ' Pro' : 'Pro'}</span></div>
            <div class="upgrade-pro-status-row"><span class="upgrade-pro-label">Source</span><span class="upgrade-pro-value">${src}</span></div>
            ${startedAt ? `<div class="upgrade-pro-status-row"><span class="upgrade-pro-label">Started</span><span class="upgrade-pro-value">${startedAt}</span></div>` : ''}
            ${renewsAt ? `<div class="upgrade-pro-status-row"><span class="upgrade-pro-label">Renews</span><span class="upgrade-pro-value">${renewsAt}</span></div>` : ''}
            ${u.planExpiresAt === 'infinite' ? `<div class="upgrade-pro-status-row"><span class="upgrade-pro-label">Duration</span><span class="upgrade-pro-value">Lifetime</span></div>` : ''}
          </div>`;
          })() : `
          <div class="upgrade-duration-tabs">
            <button class="upgrade-duration-pill${this._selectedDuration === '1m' ? ' active' : ''}" data-duration="1m">1 Mo</button>
            <button class="upgrade-duration-pill${this._selectedDuration === '3m' ? ' active' : ''}" data-duration="3m">3 Mo<span class="upgrade-popular-label">Popular</span></button>
            <button class="upgrade-duration-pill${this._selectedDuration === '6m' ? ' active' : ''}" data-duration="6m">6 Mo</button>
          </div>
          <div class="upgrade-card-price" id="upgrade-price-display">
            <span class="upgrade-price-dollar">$</span><span class="upgrade-price-amount">${dur.price}</span><span class="upgrade-price-period">${dur.period}</span>
          </div>
          ${dur.savings ? `<div class="upgrade-price-savings">${dur.savings}</div>` : ''}
          <div class="upgrade-price-uzs">${dur.uzs}</div>
          `}
        </div>
        <div class="upgrade-card-btn-wrap">
          ${isPro
            ? `<button class="upgrade-card-btn upgrade-card-btn-primary" disabled>Current plan${expiryInfo}</button>
               ${isStripe ? '<button class="upgrade-card-btn upgrade-manage-billing-btn" id="manage-billing-btn" style="margin-top:8px">Manage Billing</button>' : ''}`
            : `<button class="upgrade-card-btn upgrade-card-btn-primary" id="purchase-plan-btn">Purchase plan</button>
               ${canTrial ? '<div class="upgrade-trial-link" id="start-trial-link">or Start 7-day free trial</div>' : ''}`
          }
        </div>
        <div class="upgrade-card-divider"></div>
        <div class="upgrade-card-features">
          <h4>Features</h4>
          <ul>${proFeatures.map(f => `<li>${f}</li>`).join('')}</ul>
        </div>
      </div>
    `;

    // Bind duration tab clicks — update price inline, don't re-render everything
    el.querySelectorAll('.upgrade-duration-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        this._selectedDuration = pill.dataset.duration;
        const d = this._stripePricing[this._selectedDuration];
        // Update active pill
        el.querySelectorAll('.upgrade-duration-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        // Update price display
        const priceDisplay = document.getElementById('upgrade-price-display');
        if (priceDisplay) {
          priceDisplay.innerHTML = `<span class="upgrade-price-dollar">$</span><span class="upgrade-price-amount">${d.price}</span><span class="upgrade-price-period">${d.period}</span>`;
        }
        // Update savings line
        const savingsEl = priceDisplay && priceDisplay.nextElementSibling;
        if (savingsEl && savingsEl.classList.contains('upgrade-price-savings')) {
          if (d.savings) { savingsEl.textContent = d.savings; savingsEl.style.display = ''; }
          else { savingsEl.style.display = 'none'; }
        } else if (d.savings && priceDisplay) {
          const s = document.createElement('div');
          s.className = 'upgrade-price-savings';
          s.textContent = d.savings;
          priceDisplay.insertAdjacentElement('afterend', s);
        }
        // Update UZS line
        const uzsEl = el.querySelector('.upgrade-price-uzs');
        if (uzsEl) uzsEl.textContent = d.uzs;
      });
    });

    // Bind purchase button
    const purchaseBtn = document.getElementById('purchase-plan-btn');
    if (purchaseBtn) {
      purchaseBtn.addEventListener('click', () => this._startCheckout(false));
    }

    // Bind trial link
    const trialLink = document.getElementById('start-trial-link');
    if (trialLink) {
      trialLink.addEventListener('click', () => this._startCheckout(true));
    }

    // Bind manage billing button
    const billingBtn = document.getElementById('manage-billing-btn');
    if (billingBtn) {
      billingBtn.addEventListener('click', () => this._openBillingPortal());
    }
  },

  async _startCheckout(isTrial) {
    try {
      const purchaseBtn = document.getElementById('purchase-plan-btn');
      const trialLink = document.getElementById('start-trial-link');
      if (purchaseBtn) { purchaseBtn.disabled = true; purchaseBtn.textContent = 'Opening checkout...'; }
      if (trialLink) { trialLink.style.pointerEvents = 'none'; trialLink.style.opacity = '0.5'; }

      const res = await fetch('/api/stripe/create-checkout-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API.getToken()}`
        },
        body: JSON.stringify({ duration: this._selectedDuration, trial: isTrial })
      });

      const data = await res.json();
      if (!res.ok) {
        this.toast(data.error || 'Failed to start checkout', 'error');
        if (purchaseBtn) { purchaseBtn.disabled = false; purchaseBtn.textContent = 'Purchase plan'; }
        if (trialLink) { trialLink.style.pointerEvents = ''; trialLink.style.opacity = ''; }
        return;
      }

      // Open Stripe checkout in new tab
      window.open(data.url, '_blank');

      // Update button to show waiting state
      if (purchaseBtn) { purchaseBtn.textContent = 'Waiting for payment...'; }
      this.toast('Complete your payment in the new tab. This page will update automatically.', 'info', 8000);

      // Poll for plan upgrade every 3s (stops after 10 min or when upgraded)
      this._checkoutPollCount = 0;
      this._checkoutPoller = setInterval(async () => {
        this._checkoutPollCount++;
        if (this._checkoutPollCount > 200) {
          clearInterval(this._checkoutPoller);
          if (purchaseBtn) { purchaseBtn.disabled = false; purchaseBtn.textContent = 'Purchase plan'; }
          return;
        }
        try {
          const me = await API.getMe();
          if (me.plan === 'premium' && (!this.user || this.user.plan !== 'premium')) {
            clearInterval(this._checkoutPoller);
            this.user = me;
            this.updateUserUI();
            this._applyProLocks();
            this._showProCelebration();
            this.loadUpgrade();
          }
        } catch {}
      }, 3000);
    } catch (err) {
      this.toast('Failed to start checkout. Please try again.', 'error');
      const purchaseBtn = document.getElementById('purchase-plan-btn');
      if (purchaseBtn) { purchaseBtn.disabled = false; purchaseBtn.textContent = 'Purchase plan'; }
    }
  },

  async _openBillingPortal() {
    try {
      const btn = document.getElementById('manage-billing-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Opening...'; }

      const res = await fetch('/api/stripe/create-portal-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API.getToken()}`
        }
      });

      const data = await res.json();
      if (!res.ok) {
        this.toast(data.error || 'Failed to open billing', 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Manage Billing'; }
        return;
      }

      window.location.href = data.url;
    } catch (err) {
      this.toast('Failed to open billing portal.', 'error');
      const btn = document.getElementById('manage-billing-btn');
      if (btn) { btn.disabled = false; btn.textContent = 'Manage Billing'; }
    }
  },

  async _verifyStripeSession(sessionId) {
    try {
      const res = await fetch(`/api/stripe/verify-session?session_id=${encodeURIComponent(sessionId)}`, {
        headers: { 'Authorization': `Bearer ${API.getToken()}` }
      });

      const data = await res.json();
      if (data.success) {
        // Refresh user data
        this.user = await API.getMe();
        this.updateUserUI();
        this._applyProLocks();

        // Show celebration overlay
        this._showProCelebration();
      }
    } catch (err) {
      console.error('Session verification failed:', err);
    }
    // Clean URL
    window.history.replaceState({}, document.title, '/app.html#upgrade');
  },

  _showProCelebration() {
    this.launchConfetti();

    const overlay = document.createElement('div');
    overlay.className = 'levelup-overlay pro-celebration-overlay';
    overlay.innerHTML = `
      <div class="levelup-modal">
        <div class="levelup-glow pro-glow"></div>
        <div class="pro-celebration-text">PRO</div>
        <h2 class="levelup-title pro-title">Welcome to Pro!</h2>
        <p class="levelup-sub">You just unlocked the full writing experience.</p>
        <button class="btn btn-primary levelup-btn" style="margin-top:30px">Start Writing</button>
      </div>
    `;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('active'));

    const dismiss = () => {
      overlay.classList.remove('active');
      setTimeout(() => overlay.remove(), 400);
      this.switchView('dashboard');
    };

    overlay.querySelector('.levelup-btn').onclick = dismiss;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) dismiss();
    });
    document.addEventListener('keydown', function escHandler(e) {
      if (e.key === 'Escape') {
        dismiss();
        document.removeEventListener('keydown', escHandler);
      }
    });
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
      { icon: '&#x1F480;', name: 'Danger Zone', description: 'Complete a Dangerous mode', earned: (u.achievements || []).includes('danger_zone') },
      { icon: '&#x1F333;', name: 'Forest', description: 'Grow your tree to max stage', earned: (u.treeStage || 0) >= 11 },
      { icon: '&#x1F91D;', name: 'Social Writer', description: 'Add your first friend', earned: (u.friends || []).length >= 1 },
      { icon: '&#x1F465;', name: 'Writing Circle', description: 'Have 5 friends', earned: (u.friends || []).length >= 5 },
    ];
  },

  _getProfileAchievements(p) {
    return [
      { icon: '&#x1F331;', name: 'First Seed', description: 'Complete your first session', earned: (p.totalSessions || 0) >= 1 },
      { icon: '&#x270D;&#xFE0F;', name: 'Getting Started', description: 'Complete 5 sessions', earned: (p.totalSessions || 0) >= 5 },
      { icon: '&#x1F4DD;', name: 'Regular Writer', description: 'Complete 25 sessions', earned: (p.totalSessions || 0) >= 25 },
      { icon: '&#x1F58B;&#xFE0F;', name: 'Session Master', description: 'Complete 100 sessions', earned: (p.totalSessions || 0) >= 100 },
      { icon: '&#x1F525;', name: 'On Fire', description: '3-day writing streak', earned: (p.longestStreak || 0) >= 3 },
      { icon: '&#x1F3AF;', name: 'Consistent', description: '7-day writing streak', earned: (p.longestStreak || 0) >= 7 },
      { icon: '&#x1F4AA;', name: 'Dedicated', description: '14-day writing streak', earned: (p.longestStreak || 0) >= 14 },
      { icon: '&#x1F3C6;', name: 'Legend', description: '30-day writing streak', earned: (p.longestStreak || 0) >= 30 },
      { icon: '&#x1F451;', name: 'Unstoppable', description: '60-day writing streak', earned: (p.longestStreak || 0) >= 60 },
      { icon: '&#x1F30D;', name: 'World Writer', description: '100-day writing streak', earned: (p.longestStreak || 0) >= 100 },
      { icon: '&#x26A1;', name: 'Speed Writer', description: 'Write 500 total words', earned: (p.totalWords || 0) >= 500 },
      { icon: '&#x1F4D6;', name: 'Storyteller', description: 'Write 2,500 total words', earned: (p.totalWords || 0) >= 2500 },
      { icon: '&#x1F4DA;', name: 'Prolific', description: 'Write 10,000 total words', earned: (p.totalWords || 0) >= 10000 },
      { icon: '&#x1F4D5;', name: 'Novelist', description: 'Write 50,000 total words', earned: (p.totalWords || 0) >= 50000 },
      { icon: '&#x1F3DB;&#xFE0F;', name: 'Epic Author', description: 'Write 100,000 total words', earned: (p.totalWords || 0) >= 100000 },
      { icon: '&#x2B50;', name: 'Rising Star', description: 'Reach Level 5', earned: (p.level || 0) >= 5 },
      { icon: '&#x1F31F;', name: 'Shining Bright', description: 'Reach Level 10', earned: (p.level || 0) >= 10 },
      { icon: '&#x1F48E;', name: 'Diamond Writer', description: 'Reach Level 25', earned: (p.level || 0) >= 25 },
      { icon: '&#x1F480;', name: 'Danger Zone', description: 'Complete a Dangerous mode', earned: (p.achievements || []).includes('danger_zone') },
      { icon: '&#x1F333;', name: 'Forest', description: 'Grow your tree to max stage', earned: (p.treeStage || 0) >= 11 },
      { icon: '&#x1F91D;', name: 'Social Writer', description: 'Add your first friend', earned: (p.friends || []).length >= 1 },
      { icon: '&#x1F465;', name: 'Writing Circle', description: 'Have 5 friends', earned: (p.friends || []).length >= 5 },
    ];
  },

  _friendsPage: 1,
  _friendsSort: 'added',
  _friendsTotalPages: 1,

  async loadFriends() {
    // Copy Invite Link button
    const copyInvBtn = document.getElementById('copy-invite-link-btn');
    if (copyInvBtn) {
      copyInvBtn.onclick = () => {
        const link = `${window.location.origin}/invite/${this.user.username || ''}`;
        navigator.clipboard.writeText(link).then(() => this.toast('Invite link copied!', 'success'));
      };
    }

    // Bind sort buttons (once)
    document.querySelectorAll('.friends-sort-btn').forEach(btn => {
      btn.onclick = () => {
        this._friendsSort = btn.dataset.sort;
        this._friendsPage = 1;
        document.querySelectorAll('.friends-sort-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._loadFriendsPage();
      };
    });

    const reqSection = document.getElementById('friend-requests-section');
    const sugSection = document.getElementById('friend-suggestions-section');

    try {
      const [requests, suggestions] = await Promise.all([
        API.getFriendRequests(),
        API.getFriendSuggestions()
      ]);

      // Friend requests
      if (requests.length > 0) {
        reqSection.style.display = 'block';
        document.getElementById('friend-requests-list').innerHTML = requests.map(r => `
          <div class="doc-card" style="margin-bottom:8px">
            <div class="doc-card-info">
              <h4>${this.escapeHtml(r.name)}</h4>
              <div class="doc-card-meta"><span>${r.email}</span><span>Level ${this.calcXPLevel(r.xp || 0).level}</span></div>
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
              <div class="doc-card-meta"><span>${s.mutualCount} mutual friend${s.mutualCount !== 1 ? 's' : ''}</span><span>Level ${this.calcXPLevel(s.xp || 0).level}</span></div>
            </div>
            <div class="doc-card-actions">
              <button class="btn btn-small btn-primary" onclick="App.addFriendById('${s.email}')" title="Send friend request">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
              </button>
            </div>
          </div>`).join('');
      } else {
        sugSection.style.display = 'none';
      }

      // Load first page of friends
      await this._loadFriendsPage();
      // Load activity feed (non-blocking)
      this.loadActivityFeed();
    } catch {
      document.getElementById('friends-list').innerHTML = `<div class="empty-state"><p>Failed to load friends.</p></div>`;
    }
  },

  async _loadFriendsPage() {
    const container = document.getElementById('friends-list');
    container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted)">Loading...</div>';

    try {
      const data = await API.getFriends(this._friendsPage, this._friendsSort);
      const friends = data.friends || [];
      this.friends = friends;
      this._friendsTotalPages = data.totalPages || 1;

      if (data.total === 0) {
        container.innerHTML = `<div class="empty-state"><p>Add friends by their email above to start challenging them to duels.</p></div>`;
        return;
      }

      const cards = friends.map(f => {
        const fl = this.calcXPLevel(f.xp || 0);
        const fPro = f.plan === 'premium' ? ' <span class="pro-inline-badge">PRO</span>' : '';
        const fHandle = f.username ? ` <a href="#user-profile/${this.escapeHtml(f.username)}" class="friend-handle profile-link" data-profile-username="${this.escapeHtml(f.username)}">@${this.escapeHtml(f.username)}</a>` : '';
        return `
        <div class="doc-card friend-card">
          <div class="doc-card-info">
            <h4>${this.escapeHtml(f.name)}${fHandle}${fPro}</h4>
            <div class="friend-stats">
              <span class="friend-stat" title="Total words"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>${(f.totalWords || 0).toLocaleString()}</span>
              <span class="friend-stat" title="Streak"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>${f.streak || 0}</span>
              <span class="friend-stat" title="Level"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/></svg>Lv${fl.level} (${(f.xp || 0).toLocaleString()} XP)</span>
            </div>
          </div>
          <div class="doc-card-actions">
            <button class="doc-action-btn" onclick="App.challengeFriend('${f.id}')" title="Challenge to duel">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 17.5L3 6V3h3l11.5 11.5"/><path d="M13 19l6-6"/><path d="M16 16l4 4"/><path d="M19 21l2-2"/></svg>
            </button>
            <button class="doc-action-btn delete" onclick="App.confirmRemoveFriend('${f.id}', '${this.escapeHtml(f.name)}')" title="Remove friend">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
            </button>
          </div>
        </div>`;
      }).join('');

      // Pagination controls
      let pager = '';
      if (this._friendsTotalPages > 1) {
        const pages = [];
        for (let i = 1; i <= this._friendsTotalPages; i++) {
          pages.push(`<button class="friends-page-btn${i === this._friendsPage ? ' active' : ''}" onclick="App._goFriendsPage(${i})">${i}</button>`);
        }
        pager = `<div class="friends-pager">${pages.join('')}</div>`;
      }

      container.innerHTML = cards + pager;
    } catch {
      container.innerHTML = `<div class="empty-state"><p>Failed to load friends.</p></div>`;
    }
  },

  _goFriendsPage(page) {
    this._friendsPage = page;
    this._loadFriendsPage();
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

  confirmRemoveFriend(id, name) {
    const modal = document.getElementById('confirm-remove-friend-modal');
    document.getElementById('confirm-remove-friend-name').textContent = name;
    modal.classList.add('active');
    this._removeFriendId = id;
  },

  async removeFriend(id) {
    const modal = document.getElementById('confirm-remove-friend-modal');
    modal.classList.remove('active');
    try {
      await API.removeFriend(id || this._removeFriendId);
      this.toast('Friend removed', '');
      this.loadFriends();
    } catch {
      this.toast('Failed to remove friend', 'error');
    }
  },

  async loadActivityFeed() {
    const container = document.getElementById('activity-feed');
    try {
      const activities = await API.getFriendsFeed();
      if (!activities || activities.length === 0) {
        container.innerHTML = `<div class="empty-state"><p>No activity yet. Your friends' milestones will appear here!</p></div>`;
        return;
      }
      container.innerHTML = activities.map(a => {
        const { icon, text } = this._formatActivity(a);
        return `
        <div class="activity-item">
          <div class="activity-icon">${icon}</div>
          <div class="activity-content">
            <div class="activity-text">${text}</div>
            <div class="activity-time">${this._timeAgo(a.createdAt)}</div>
          </div>
        </div>`;
      }).join('');
    } catch {
      container.innerHTML = `<div class="empty-state"><p>Failed to load activity.</p></div>`;
    }
  },

  _formatActivity(a) {
    const rawName = this.escapeHtml(a.data?.name || 'Someone');
    const proBadge = a.userPlan === 'premium' ? ' <span class="pro-inline-badge">PRO</span>' : '';
    const name = `<strong style="color:#d4a017">${rawName}</strong>${proBadge}`;
    switch (a.type) {
      case 'long_session': return { icon: '✍️', text: `${name} wrote for ${a.data.duration} minutes straight!` };
      case 'word_milestone': return { icon: '📚', text: `${name} just hit ${(a.data.words || 0).toLocaleString()} total words!` };
      case 'streak_milestone': return { icon: '🔥', text: `${name} reached a ${a.data.streak}-day streak!` };
      case 'level_up': return { icon: '⭐', text: `${name} reached Level ${a.data.level}!` };
      case 'duel_won': { const opp = `<strong style="color:#d4a017">${this.escapeHtml(a.data.opponentName || 'someone')}</strong>`; return { icon: '⚔️', text: `${name} won a duel vs ${opp}!` }; }
      case 'target_reached': return { icon: '🎯', text: `${name} hit their target of ${a.data.targetWords} words!` };
      default: return { icon: '📝', text: `${name} did something awesome!` };
    }
  },

  _timeAgo(dateStr) {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days}d ago`;
    return new Date(dateStr).toLocaleDateString();
  },


  _lastDuelRequestCount: -1, // -1 = not yet polled (skip first toast)

  async startNotifPolling() {
    const poll = async () => {
      try { await this.updateNotifBadge(); } catch {}
    };
    poll();
    this.notifInterval = setInterval(poll, 10000); // Poll every 10s for faster notifications
  },

  async updateNotifBadge() {
    try {
      const [friendRequests, duelRequests] = await Promise.all([
        API.getFriendRequests(),
        API.getDuelRequests()
      ]);

      // Friends badge
      const friendBadge = document.getElementById('friends-badge');
      if (friendBadge) {
        if (friendRequests.length > 0) {
          friendBadge.textContent = friendRequests.length;
          friendBadge.style.display = 'inline-flex';
        } else {
          friendBadge.style.display = 'none';
        }
      }

      // Duels badge
      const duelBadge = document.getElementById('duels-badge');
      if (duelBadge) {
        if (duelRequests.length > 0) {
          duelBadge.textContent = duelRequests.length;
          duelBadge.style.display = 'inline-flex';
        } else {
          duelBadge.style.display = 'none';
        }
      }

      // Detect new duel requests arriving
      if (this._lastDuelRequestCount >= 0 && duelRequests.length > this._lastDuelRequestCount) {
        // Auto-refresh duels view if currently viewing it
        if (this.currentView === 'duels') {
          this.loadDuelsView();
        }
        // Show toast notification (on any view)
        this.toast(`New duel challenge received! ⚔️`, 'info');
      }
      this._lastDuelRequestCount = duelRequests.length;

      // Notification badge (comment replies)
      try {
        const notifResult = await API.getUnreadNotifCount();
        const notifBadge = document.getElementById('notif-badge');
        if (notifBadge) {
          if (notifResult.count > 0) {
            notifBadge.textContent = notifResult.count;
            notifBadge.style.display = 'inline-flex';
          } else {
            notifBadge.style.display = 'none';
          }
        }
      } catch {}

      // Community new-story green dot
      try {
        const lastSeen = localStorage.getItem('iwrite_community_seen') || '1970-01-01T00:00:00.000Z';
        const latest = await API.getLatestPublished(lastSeen);
        const dot = document.getElementById('community-new-dot');
        if (dot) {
          if (latest.newCount > 0) {
            dot.style.display = 'inline-block';
          } else {
            dot.style.display = 'none';
          }
        }
      } catch {}
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
      this._docsCacheDirty = true;
      this.loadDocuments(true);
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
    const isPro = this.user && this.user.plan === 'premium';
    const menu = document.createElement('div');
    menu.className = 'folder-context-menu';
    menu.innerHTML = `
      ${isFailed ? '' : `<button data-action="move"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg> Move to folder</button>`}
      ${isFailed ? '' : `<button data-action="publish"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/><path d="M5 19h14"/></svg> Publish to Stories</button>`}
      ${isFailed ? '' : `<button data-action="pin"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v8"/><path d="M4.93 10.93l2.83 2.83"/><path d="M19.07 10.93l-2.83 2.83"/><path d="M8 16h8"/><path d="M12 16v6"/><circle cx="12" cy="10" r="2"/></svg> ${doc.pinned ? 'Unpin' : 'Pin to top'}${!isPro ? ' <span style="color:#f59e0b;font-size:10px">PRO</span>' : ''}</button>`}
      ${isFailed ? '' : `<button data-action="export"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg> Export PDF${!isPro ? ' <span style="color:#f59e0b;font-size:10px">PRO</span>' : ''}</button>`}
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
      menu.querySelector('[data-action="publish"]').onclick = (e) => { e.stopPropagation(); close(); this.createStoryFromDocument(doc.id); };
      menu.querySelector('[data-action="share"]').onclick = (e) => { e.stopPropagation(); close(); this.shareDoc(doc.id); };
      menu.querySelector('[data-action="pin"]').onclick = async (e) => {
        e.stopPropagation(); close();
        if (!isPro) { this.toast('Pin is a Pro feature. Upgrade to Pro!', 'warning'); this.openPricing(); return; }
        try {
          const result = await API.pinDocument(doc.id);
          doc.pinned = result.pinned;
          this.toast(result.pinned ? 'Document pinned' : 'Document unpinned', 'success');
          this._renderDocumentsView();
        } catch { this.toast('Failed to pin document', 'error'); }
      };
      menu.querySelector('[data-action="export"]').onclick = async (e) => {
        e.stopPropagation(); close();
        if (!isPro) { this.toast('Export is a Pro feature. Upgrade to Pro!', 'warning'); this.openPricing(); return; }
        this.exportDocPDF(doc.id);
      };
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
      this._docsCacheDirty = true;
      this.loadDocuments(true);
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
      this._docsCacheDirty = true;
      this.loadDocuments(true);
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
          this._docsCacheDirty = true;
          this.loadDocuments(true);
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
    this.openDuelModal(id);
  },

  async saveProfile() {
    const name = document.getElementById('profile-name').value;
    const updates = { name };

    // Username change (if field exists and value changed)
    const usernameEl = document.getElementById('profile-username');
    if (usernameEl && usernameEl.value !== (this.user.username || '')) {
      updates.username = usernameEl.value;
    }
    // Bio
    const bioEl = document.getElementById('profile-bio');
    if (bioEl) updates.bio = bioEl.value;

    try {
      const updated = await API.request('/auth/me', { method: 'PATCH', body: JSON.stringify(updates) });
      this.user = updated;
      this.updateUserUI();
      this.loadProfile();
      this.toast('Profile updated!', 'success');
    } catch (err) {
      this.toast(err.message || 'Failed to update profile', 'error');
    }
  },

  showProfileCompleteModal() {
    const overlay = document.getElementById('profile-complete-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    const nameInput = document.getElementById('profile-complete-name');
    const usernameInput = document.getElementById('profile-complete-username');
    if (nameInput) nameInput.value = this.user.name || '';

    const btn = document.getElementById('profile-complete-btn');
    if (btn && !btn._bound) {
      btn._bound = true;
      btn.addEventListener('click', async () => {
        const name = nameInput.value.trim();
        const username = usernameInput.value.trim();
        const errorEl = document.getElementById('profile-complete-error');

        if (!name) {
          errorEl.textContent = 'Name is required';
          errorEl.classList.add('visible');
          return;
        }
        if (!username || username.length < 3) {
          errorEl.textContent = 'Username must be at least 3 characters';
          errorEl.classList.add('visible');
          return;
        }
        if (username.length > 30) {
          errorEl.textContent = 'Username must be at most 30 characters';
          errorEl.classList.add('visible');
          return;
        }

        try {
          const updated = await API.request('/auth/me', {
            method: 'PATCH',
            body: JSON.stringify({ name, username, needsProfile: false })
          });
          this.user = updated;
          this.updateUserUI();
          overlay.style.display = 'none';
          this.toast('Welcome to iWrite!', 'success');
        } catch (err) {
          errorEl.textContent = err.message || 'Failed to save profile';
          errorEl.classList.add('visible');
        }
      });
    }
  },

  _planFeaturesHTML() {
    const isPro = this.user && this.user.plan === 'premium';
    const freeFeatures = [
      { label: 'Timed sessions (30, 45 & 60 min)', yes: true },
      { label: 'Dangerous mode (fixed timer)', yes: true },
      { label: 'Streak tracking & tree', yes: true },
      { label: 'XP / Level system', yes: true },
      { label: 'Friends & duels', yes: true },
      { label: 'Document sharing', yes: true },
      { label: 'All timer options + custom', yes: false },
      { label: 'Custom danger inactivity timer', yes: false },
      { label: 'YouTube background music', yes: false },
      { label: 'Larger word & editing limits', yes: false },
      { label: 'Folders & pinned documents', yes: false },
      { label: 'Export to PDF', yes: false },
      { label: 'Session analytics', yes: false },
      { label: 'Username change 3x/month', yes: false },
      { label: 'Pro badge on leaderboard', yes: false },
    ];
    const proFeatures = [
      { label: 'Everything in Free', yes: true },
      { label: 'All timer options + custom "+"', yes: true },
      { label: 'Custom danger inactivity timer', yes: true },
      { label: 'YouTube background music', yes: true },
      { label: 'Larger word & editing limits', yes: true },
      { label: 'Larger early complete & copy limits', yes: true },
      { label: 'Folders & pinned documents', yes: true },
      { label: 'Export to PDF', yes: true },
      { label: 'Session analytics', yes: true },
      { label: 'Username change 3x/month', yes: true },
      { label: 'Pro badge on leaderboard', yes: true },
      { label: 'Priority support', yes: true },
    ];
    const freeList = freeFeatures.map(f =>
      `<li class="${f.yes ? 'yes' : 'no'}">${f.label}</li>`
    ).join('');
    const proList = proFeatures.map(f =>
      `<li class="${f.yes ? 'yes' : 'no'}">${f.label}</li>`
    ).join('');
    return `
      <div class="pricing-card${!isPro ? ' current' : ''}" id="pricing-free">
        <div class="pricing-card-header">
          <h3>Free</h3>
          <div class="pricing-price"><span class="pricing-currency">$</span>0<span class="pricing-period">/mo</span></div>
        </div>
        <ul class="pricing-features">${freeList}</ul>
        ${!isPro ? '<div class="pricing-current-badge">Current Plan</div>' : ''}
      </div>
      <div class="pricing-card pro${isPro ? ' current' : ''}" id="pricing-pro">
        <div class="pricing-popular">Most Popular</div>
        <div class="pricing-card-header">
          <h3>Pro</h3>
          <div class="pricing-price"><span class="pricing-currency">$</span>1.99<span class="pricing-period">/mo</span><span class="pricing-original"><span class="pricing-original-dollar">$</span><span class="pricing-original-num">4</span></span></div>
          <div class="pricing-uzs">~25,000 UZS</div>
        </div>
        <ul class="pricing-features">${proList}</ul>
        ${isPro ? `<div class="pricing-current-badge">Current Plan${this.user.planExpiresAt && this.user.planExpiresAt !== 'infinite' ? ' · expires ' + new Date(this.user.planExpiresAt).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'}) : this.user.planExpiresAt === 'infinite' ? ' · ∞' : ''}</div>` : ''}
      </div>`;
  },

  openPricing() {
    this.switchView('upgrade');
  },

  closePricing() {
    document.getElementById('pricing-overlay').classList.remove('active');
  },

  // Unified Pro feature gating — applies blur/badge/peek to all lockable elements
  _applyProLocks() {
    const isPro = this.user && this.user.plan === 'premium';
    // Remove any existing pro-lock overlays from previous calls
    document.querySelectorAll('.pro-lock-dynamic').forEach(el => el.remove());

    if (isPro) {
      // Pro user: remove all locks, show pro-only sections
      document.querySelectorAll('.pro-lock-wrap.locked').forEach(w => w.classList.remove('locked'));
      return;
    }

    // --- Small element locks: badge overlay + click → pricing ---
    const smallLocks = [
      { id: 'create-folder-btn', label: 'Folders' },
      { id: 'time-preset-add-btn', label: 'Custom Timer' },
      { id: 'danger-custom-time-btn', label: 'Custom Timer' },
    ];
    smallLocks.forEach(({ id, label }) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.position = 'relative';
      el.style.overflow = 'visible';
      // Add small PRO badge
      if (!el.querySelector('.pro-lock-dynamic')) {
        const badge = document.createElement('span');
        badge.className = 'pro-lock-dynamic';
        badge.style.cssText = 'position:absolute;top:-6px;right:-6px;font-size:8px;font-weight:700;background:linear-gradient(135deg,#f59e0b,#d97706);color:#000;padding:1px 4px;border-radius:6px;pointer-events:none;z-index:2';
        badge.textContent = 'PRO';
        el.appendChild(badge);
      }
    });

    // --- YouTube Link Pro gate ---
    const ytBadge = document.getElementById('yt-pro-badge');
    const ytInput = document.getElementById('audio-yt-input');
    const ytSection = document.getElementById('audio-yt-section');
    if (ytBadge) ytBadge.style.display = isPro ? 'none' : 'inline';
    if (ytInput) {
      if (!isPro) {
        ytInput.disabled = true;
        ytInput.placeholder = 'Pro feature — Upgrade to use YouTube music';
        ytInput.style.opacity = '0.5';
      } else {
        ytInput.disabled = false;
        ytInput.placeholder = 'Paste YouTube URL...';
        ytInput.style.opacity = '';
      }
    }
    if (ytSection && !isPro) {
      ytSection.style.cursor = 'pointer';
      ytSection.onclick = (e) => {
        if (e.target.closest('.audio-play-btn')) return; // handled by editor.js
        this.toast('YouTube music is a Pro feature.', 'info');
        this.openPricing();
      };
    } else if (ytSection) {
      ytSection.style.cursor = '';
      ytSection.onclick = null;
    }

    // --- Analytics Pro gate: update button to open pricing modal ---
    const analyticsUpgradeBtn = document.querySelector('.btn-upgrade-analytics');
    if (analyticsUpgradeBtn) {
      analyticsUpgradeBtn.onclick = (e) => { e.preventDefault(); this.openPricing(); };
    }

    // Anti-tamper: re-enforce blur on pro-locked analytics sections
    // Even if user removes blur via DevTools, MutationObserver re-applies it
    // Disconnect and reconnect each time to handle SPA re-renders
    if (this._proBlurObserver) {
      this._proBlurObserver.disconnect();
      this._proBlurObserver = null;
    }
    if (!isPro) {
      this._proBlurObserver = new MutationObserver(() => {
        if (this.user && this.user.plan === 'premium') return;
        document.querySelectorAll('.analytics-pro-blur-content').forEach(el => {
          if (!el.style.filter || !el.style.filter.includes('blur')) {
            el.style.filter = 'blur(6px)';
            el.style.pointerEvents = 'none';
            el.style.userSelect = 'none';
          }
        });
      });
      document.querySelectorAll('.analytics-pro-blur-content').forEach(el => {
        this._proBlurObserver.observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
      });
    }

  },

  // Peek animation: briefly unblurs a Pro-locked element to tease content
  _proPeek(wrapEl) {
    if (wrapEl.classList.contains('pro-peeking')) return; // debounce
    wrapEl.classList.add('pro-peeking');
    setTimeout(() => {
      wrapEl.classList.remove('pro-peeking');
      // Show upgrade card near the element
      this._showProUpgradeCard(wrapEl);
    }, 1800);
  },

  _showProUpgradeCard(anchorEl) {
    // Remove any existing card
    document.querySelectorAll('.pro-upgrade-card').forEach(c => c.remove());
    const feature = anchorEl.dataset.proFeature || 'this feature';
    const card = document.createElement('div');
    card.className = 'pro-upgrade-card';
    card.innerHTML = `
      <h4>Unlock ${feature}</h4>
      <p>Upgrade to Pro to access ${feature} and more premium features.</p>
      <button>Unlock Pro</button>
    `;
    document.body.appendChild(card);
    const rect = anchorEl.getBoundingClientRect();
    card.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - card.offsetHeight - 16)}px`;
    card.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - card.offsetWidth - 16))}px`;
    card.querySelector('button').onclick = () => { card.remove(); this.openPricing(); };
    // Auto-dismiss on outside click
    const dismiss = (e) => { if (!card.contains(e.target)) { card.remove(); document.removeEventListener('click', dismiss); } };
    setTimeout(() => document.addEventListener('click', dismiss), 0);
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

  // ===== MAINTENANCE MODE POLLING =====
  _maintInterval: null,
  _maintTickInterval: null,
  _maintShutdownShown: false,
  _maintRemaining: 0,
  _maintShutdown: false,
  _maintActive: false,

  _startMaintenancePolling() {
    this._pollMaintenance();
    this._maintInterval = setInterval(() => this._pollMaintenance(), 10000);
    // Tick the countdown every second
    this._maintTickInterval = setInterval(() => this._tickMaintenanceBanner(), 1000);
  },

  async _pollMaintenance() {
    try {
      const res = await fetch('/api/maintenance-status');
      const data = await res.json();
      const wasActive = this._maintActive;
      this._maintActive = data.active;
      this._maintShutdown = data.shutdownReady;
      if (data.remaining !== undefined) this._maintRemaining = data.remaining;
      this._renderMaintenanceBanner();
      // Refresh copy & complete buttons when maintenance state changes
      if (wasActive !== data.active) this._refreshSessionButtons();
    } catch {}
  },

  // Refresh copy + complete button states based on maintenance
  _refreshSessionButtons() {
    if (typeof Editor === 'undefined' || !Editor.active) return;
    const copyBtn = document.getElementById('editor-copy-btn');
    const saveBtn = document.getElementById('editor-save-btn');
    if (this._maintActive) {
      // Maintenance ON — enable copy, enable complete
      if (copyBtn) { copyBtn.classList.remove('btn-disabled'); copyBtn.style.opacity = ''; copyBtn.style.cursor = ''; }
      if (saveBtn) { saveBtn.classList.remove('btn-disabled'); saveBtn.style.opacity = ''; }
    } else {
      // Maintenance OFF — disable copy, re-check complete limit
      if (copyBtn) { copyBtn.classList.add('btn-disabled'); copyBtn.style.opacity = '0.4'; copyBtn.style.cursor = 'not-allowed'; }
      if (saveBtn) {
        const currentMonth = new Date().toISOString().slice(0, 7);
        const earlyUsed = (this.user && this.user.earlyCompletesMonth === currentMonth) ? (this.user.earlyCompletes || 0) : 0;
        const earlyLimit = (this.user && this.user.plan === 'premium') ? 15 : 3;
        if (earlyUsed >= earlyLimit) {
          saveBtn.classList.add('btn-disabled'); saveBtn.style.opacity = '0.4';
        }
      }
    }
  },

  _tickMaintenanceBanner() {
    if (!this._maintActive || this._maintShutdown) return;
    if (this._maintRemaining > 0) this._maintRemaining--;
    this._renderMaintenanceBanner();
  },

  _renderMaintenanceBanner() {
    let banner = document.getElementById('maintenance-banner');
    if (!this._maintActive) {
      if (banner) { banner.remove(); document.body.style.paddingTop = ''; document.documentElement.style.setProperty('--maint-banner-h', '0px'); }
      this._maintShutdownShown = false;
      return;
    }

    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'maintenance-banner';
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:linear-gradient(135deg,#f59e0b,#d97706);color:#000;padding:12px 16px;text-align:center;font-size:13px;font-weight:600;display:flex;align-items:center;justify-content:center;gap:12px;box-shadow:0 2px 12px rgba(0,0,0,0.2)';
      document.body.prepend(banner);
    }

    if (this._maintShutdown) {
      banner.style.background = 'linear-gradient(135deg,#ef4444,#dc2626)';
      banner.style.color = '#fff';
      banner.innerHTML = '<span>Shutting down for maintenance. Please save your work now.</span>';
      if (!this._maintShutdownShown && typeof Editor !== 'undefined' && Editor.documentId) {
        Editor.autoSave && Editor.autoSave();
        this._maintShutdownShown = true;
      }
    } else {
      const mins = Math.floor(this._maintRemaining / 60);
      const secs = this._maintRemaining % 60;
      banner.style.background = 'linear-gradient(135deg,#f59e0b,#d97706)';
      banner.style.color = '#000';
      banner.innerHTML = `<span>Maintenance in <strong>${mins}:${secs.toString().padStart(2, '0')}</strong> — save your work. Unlimited saves/copies enabled.</span>`;
    }

    // Re-measure after content and push everything down
    requestAnimationFrame(() => {
      const h = banner.offsetHeight;
      document.documentElement.style.setProperty('--maint-banner-h', h + 'px');
      document.body.style.paddingTop = h + 'px';
    });
  },

  _applyTheme(theme) {
    const root = document.documentElement;
    // Remove all theme classes
    root.classList.remove('light', 'sepia');
    if (theme === 'light') root.classList.add('light');
    else if (theme === 'sepia') root.classList.add('sepia');
    localStorage.setItem('iwrite_theme', theme);
    const btn = document.getElementById('theme-toggle-btn');
    if (!btn) return;
    const labels = { dark: 'Light Mode', light: 'Sepia Mode', sepia: 'Dark Mode' };
    btn.querySelector('.theme-icon-dark').style.display = theme === 'dark' ? '' : 'none';
    btn.querySelector('.theme-icon-light').style.display = theme !== 'dark' ? '' : 'none';
    btn.querySelector('.theme-toggle-label').textContent = labels[theme] || 'Light Mode';
  },

  _cycleTheme() {
    const current = localStorage.getItem('iwrite_theme') || 'dark';
    // All users: dark → light → sepia → dark
    const next = current === 'dark' ? 'light' : current === 'light' ? 'sepia' : 'dark';
    this._applyTheme(next);
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

  toast(message, type = '', duration = 3000) {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    const el = document.getElementById('toast');
    // Replace "Pro" with styled orange gradient badge
    const styled = message.replace(/\bPro\b/g, '<span class="toast-pro-badge">PRO</span>');
    el.innerHTML = styled;
    el.className = `toast visible ${type}`;
    this.toastTimer = setTimeout(() => {
      el.className = 'toast';
      this.toastTimer = null;
    }, duration);
  },

  // ===== ANALYTICS =====
  _analyticsData: null,
  _analyticsRange: 30,

  async loadAnalytics() {
    const container = document.getElementById('analytics-content');
    container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)">Loading analytics...</div>';

    try {
      this._analyticsData = await API.getSessionAnalytics();
      this._renderAnalytics();
    } catch (err) {
      container.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-muted)">Failed to load analytics.</div>`;
    }
  },

  _fmtDuration(secs) {
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  },

  _fmtDate(dateStr) {
    if (!dateStr) return '\u2014';
    return new Date(dateStr).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
  },

  _pctArrow(pct) {
    if (pct > 0) return `<span style="color:var(--success)">\u25B2 ${pct}%</span>`;
    if (pct < 0) return `<span style="color:#f87171">\u25BC ${Math.abs(pct)}%</span>`;
    return `<span style="color:var(--text-muted)">\u2014 0%</span>`;
  },

  _renderAnalytics() {
    const container = document.getElementById('analytics-content');
    const data = this._analyticsData;
    if (!data) return;
    const range = this._analyticsRange;
    const isPro = data.isPro;

    let html = '';

    // ── PERSONAL RECORDS ──
    const pr = data.personalRecords;
    const longestMins = pr.longestSession ? Math.round((pr.longestSession.duration || 0) / 60) : 0;
    html += `<div class="analytics-chart-section">
      <div class="analytics-chart-title">Personal Records</div>
      <div class="analytics-records-grid">
        <div class="analytics-record">
          <div class="analytics-record-value">${this._fmtDuration(data.totalWritingTime || 0)}</div>
          <div class="analytics-record-label">Total Writing Time</div>
        </div>
        <div class="analytics-record">
          <div class="analytics-record-value">${longestMins}m</div>
          <div class="analytics-record-label">Longest Session</div>
          <div class="analytics-record-detail">${pr.longestSession.words} words \u2022 ${this._fmtDate(pr.longestSession.date)}</div>
        </div>
        <div class="analytics-record">
          <div class="analytics-record-value">${(pr.mostWordsDay.words || 0).toLocaleString()}</div>
          <div class="analytics-record-label">Most Words in a Day</div>
          <div class="analytics-record-detail">${this._fmtDate(pr.mostWordsDay.date)}</div>
        </div>
        <div class="analytics-record">
          <div class="analytics-record-value">${(pr.mostWordsWeek.words || 0).toLocaleString()}</div>
          <div class="analytics-record-label">Most Words in a Week</div>
          <div class="analytics-record-detail">${pr.mostWordsWeek.startDate ? this._fmtDate(pr.mostWordsWeek.startDate) + ' \u2013 ' + this._fmtDate(pr.mostWordsWeek.endDate) : '\u2014'}</div>
        </div>
        <div class="analytics-record">
          <div class="analytics-record-value">${pr.currentStreak} <span style="font-size:14px;color:var(--text-muted)">/ ${pr.bestStreak.days} best</span></div>
          <div class="analytics-record-label">Current Streak (days)</div>
        </div>
        <div class="analytics-record">
          <div class="analytics-record-value">${data.totalWords.toLocaleString()}</div>
          <div class="analytics-record-label">Total Words Written</div>
        </div>
      </div>
    </div>`;

    // ── 2. WRITING RHYTHM ──
    if (isPro && data.writingRhythm) {
      const wr = data.writingRhythm;
      const typeEmoji = wr.writerType === 'Night Writer' ? '\u{1F319}' : wr.writerType === 'Early Bird' ? '\u{1F305}' : '\u2600\uFE0F';
      const article = wr.writerType.match(/^[aeiou]/i) ? 'an' : 'a';
      html += `<div class="analytics-chart-section">
        <div class="analytics-chart-title">Writing Rhythm</div>
        <div class="analytics-rhythm-hero">
          <div class="analytics-rhythm-award">
            <span class="analytics-rhythm-emoji">${typeEmoji}</span>
            <span class="analytics-rhythm-type">You're ${article} <strong>${wr.writerType}</strong></span>
          </div>
        </div>
        <div class="analytics-records-grid">
          <div class="analytics-record">
            <div class="analytics-record-value">${wr.bestDay}</div>
            <div class="analytics-record-label">Best Day of Week</div>
            <div class="analytics-record-detail">${wr.bestDayPct > 0 ? wr.bestDayPct + '% above average' : 'Most sessions'}</div>
          </div>
          <div class="analytics-record">
            <div class="analytics-record-value">${this._fmtDuration(wr.avgSessionLength || 0)}</div>
            <div class="analytics-record-label">Avg Session Length</div>
          </div>
          <div class="analytics-record">
            <div class="analytics-record-value">${(wr.avgWordsPerDay || 0).toLocaleString()}</div>
            <div class="analytics-record-label">Avg Words / Day</div>
          </div>
          <div class="analytics-record">
            <div class="analytics-record-value">${(wr.avgWordsPerWeek || 0).toLocaleString()}</div>
            <div class="analytics-record-label">Avg Words / Week</div>
          </div>
        </div>`;
      const ms = wr.modeSplit;
      const totalMs = ms.normal + ms.dangerous;
      if (totalMs > 0) {
        const normalPct = Math.round((ms.normal / totalMs) * 100);
        const dangerPct = 100 - normalPct;
        html += `<div style="margin-top:16px">
          <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-muted);margin-bottom:6px">
            <span>Normal ${normalPct}%</span><span>Dangerous ${dangerPct}%</span>
          </div>
          <div style="display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--bg-elevated)">
            <div style="width:${normalPct}%;background:var(--accent)"></div>
            <div style="width:${dangerPct}%;background:#ef4444"></div>
          </div>
        </div>`;
      }
      html += `</div>`;
    } else if (!isPro) {
      // Decoy data — obviously fake/scrambled so removing blur reveals nothing useful
      html += `<div class="analytics-chart-section analytics-pro-locked" style="position:relative;overflow:hidden">
        <div class="analytics-pro-blur-content">
          <div class="analytics-chart-title">Writing Rhythm</div>
          <div class="analytics-rhythm-hero">
            <div class="analytics-rhythm-award">
              <span class="analytics-rhythm-emoji">\u{1F512}</span>
              <span class="analytics-rhythm-type">Upgrade to <strong>PRO</strong> to unlock</span>
            </div>
          </div>
          <div class="analytics-records-grid">
            <div class="analytics-record"><div class="analytics-record-value">\u2014</div><div class="analytics-record-label">Best Day of Week</div></div>
            <div class="analytics-record"><div class="analytics-record-value">\u2014</div><div class="analytics-record-label">Avg Session Length</div></div>
            <div class="analytics-record"><div class="analytics-record-value">\u2014</div><div class="analytics-record-label">Avg Words / Day</div></div>
            <div class="analytics-record"><div class="analytics-record-value">\u2014</div><div class="analytics-record-label">Avg Words / Week</div></div>
          </div>
          <div style="margin-top:16px">
            <div style="display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--bg-elevated)">
              <div style="width:50%;background:var(--bg-elevated)"></div>
              <div style="width:50%;background:var(--bg-elevated)"></div>
            </div>
          </div>
        </div>
        <div class="analytics-pro-gate-overlay" onclick="App.openPricing()">
          <span class="upgrade-label">Upgrade to</span><span class="analytics-pro-badge">PRO</span>
        </div>
      </div>`;
    }

    // ── 3. DAILY WORDS CHART ──
    if (data.dailyWords && Object.keys(data.dailyWords).length > 0) {
      const today = new Date();
      const days = [];
      for (let i = range - 1; i >= 0; i--) {
        const d = new Date(today); d.setDate(today.getDate() - i);
        const key = d.toISOString().split('T')[0];
        days.push({ date: key, words: data.dailyWords[key] || 0, day: d.getDate(), weekday: d.toLocaleDateString('en', { weekday: 'short' }) });
      }
      const maxWords = Math.max(...days.map(d => d.words), 1);
      const totalW = days.reduce((s, d) => s + d.words, 0);
      const activeDays = days.filter(d => d.words > 0).length;
      const bars = days.map(d => {
        const h = Math.max(Math.round((d.words / maxWords) * 72), d.words > 0 ? 4 : 0);
        return `<div class="analytics-bar-wrap" data-tooltip="${d.weekday} ${d.date}: ${d.words.toLocaleString()} words">
          <div class="analytics-bar" style="height:${h}px;background:${d.words > 0 ? 'var(--accent)' : 'var(--bg-elevated)'}"></div>
          <div class="analytics-bar-label">${d.day}</div>
        </div>`;
      }).join('');
      html += `<div class="analytics-chart-section">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:12px">
          <div class="analytics-chart-title" style="margin-bottom:0">Daily Words</div>
          <div class="analytics-range-btns">
            <button class="analytics-range-btn${range === 7 ? ' active' : ''}" data-range="7">7d</button>
            <button class="analytics-range-btn${range === 14 ? ' active' : ''}" data-range="14">14d</button>
            <button class="analytics-range-btn${range === 30 ? ' active' : ''}" data-range="30">30d</button>
          </div>
        </div>
        <div style="display:flex;gap:16px;font-size:12px;color:var(--text-muted);margin-bottom:8px">
          <span>${totalW.toLocaleString()} words</span>
          <span>${activeDays} active days</span>
          <span>Avg ${activeDays > 0 ? Math.round(totalW / activeDays).toLocaleString() : 0}/day</span>
        </div>
        <div class="analytics-bar-chart">${bars}</div>
      </div>`;
    }

    // ── 4. WRITING TIME DISTRIBUTION ──
    if (isPro && data.writingRhythm && data.writingRhythm.hourDistribution) {
      const hd = data.writingRhythm.hourDistribution;
      const maxH = Math.max(...hd, 1);
      const cells = hd.map((v, i) => {
        const pct = v > 0 ? 0.15 + (v / maxH) * 0.75 : 0;
        const bg = v > 0 ? `rgba(74,222,128,${pct.toFixed(2)})` : 'var(--bg-elevated)';
        return `<div class="analytics-hour-cell" style="background:${bg}" data-tooltip="${i}:00 \u2014 ${v} session(s)"></div>`;
      }).join('');
      html += `<div class="analytics-chart-section">
        <div class="analytics-chart-title">Writing Time Distribution</div>
        <div class="analytics-hour-grid">${cells}</div>
        <div class="analytics-hour-labels"><span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>11pm</span></div>
      </div>`;
    } else if (!isPro) {
      // Decoy data — all cells empty, no real data exposed
      const emptyCells = Array.from({length: 24}, () => {
        return `<div class="analytics-hour-cell" style="background:var(--bg-elevated)"></div>`;
      }).join('');
      html += `<div class="analytics-chart-section analytics-pro-locked" style="position:relative;overflow:hidden">
        <div class="analytics-pro-blur-content">
          <div class="analytics-chart-title">Writing Time Distribution</div>
          <div class="analytics-hour-grid">${emptyCells}</div>
          <div class="analytics-hour-labels"><span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>11pm</span></div>
        </div>
        <div class="analytics-pro-gate-overlay" onclick="App.openPricing()">
          <span class="upgrade-label">Upgrade to</span><span class="analytics-pro-badge">PRO</span>
        </div>
      </div>`;
    }

    // ── 5. WORD COUNT MILESTONES ──
    if (data.milestones) {
      html += `<div class="analytics-chart-section">
        <div class="analytics-chart-title">Word Count Milestones</div>
        <div class="analytics-milestones">`;
      data.milestones.forEach(m => {
        const label = m.target >= 1000 ? (m.target / 1000) + 'k' : m.target;
        const pct = Math.min(100, Math.round((m.current / m.target) * 100));
        html += `<div class="analytics-milestone ${m.unlocked ? 'unlocked' : ''}">
          <div class="analytics-milestone-icon">${m.unlocked ? '\u2705' : '\u{1F512}'}</div>
          <div class="analytics-milestone-info">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span style="font-weight:600;font-size:13px">${label} words</span>
              ${!m.unlocked ? `<span style="font-size:11px;color:var(--text-muted)">${pct}%</span>` : '<span style="font-size:11px;color:var(--success)">Unlocked!</span>'}
            </div>
            ${!m.unlocked ? `<div class="analytics-milestone-bar"><div class="analytics-milestone-fill" style="width:${pct}%"></div></div>` : ''}
          </div>
        </div>`;
      });
      html += `</div></div>`;
    }

    container.innerHTML = html;

    // Bind date range buttons
    container.querySelectorAll('.analytics-range-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this._analyticsRange = parseInt(btn.dataset.range);
        this._renderAnalytics();
      });
    });

    // Bind share dropdown
    const shareBtn = document.getElementById('btn-share-analytics-top');
    const shareDropdown = document.getElementById('share-dropdown');
    if (shareBtn && shareDropdown) {
      shareBtn.onclick = (e) => {
        e.stopPropagation();
        shareDropdown.style.display = shareDropdown.style.display === 'none' ? 'block' : 'none';
      };
      // Friend invite link (not referral code)
      const friendLink = () => `${window.location.origin}/invite/${this.user.username || ''}`;
      const shareText = () => `iWrite4.me — a distraction-free writing tool that keeps you focused. If you stop typing, it deletes your work.\n\nTry it: ${friendLink()}`;

      document.getElementById('share-download-card').onclick = () => {
        this._shareAnalyticsCard();
        shareDropdown.style.display = 'none';
      };
      document.getElementById('share-to-x').onclick = () => {
        window.open(`https://x.com/intent/tweet?text=${encodeURIComponent(shareText())}`, '_blank');
        shareDropdown.style.display = 'none';
      };
      document.getElementById('share-to-telegram').onclick = () => {
        window.open(`https://t.me/share/url?url=${encodeURIComponent(shareText())}`, '_blank');
        shareDropdown.style.display = 'none';
      };
      document.getElementById('share-to-instagram').onclick = () => {
        this._shareAnalyticsCard();
        navigator.clipboard.writeText(shareText()).then(() => {
          this.toast('Card downloaded & caption copied — paste in Instagram!', 'success');
        });
        shareDropdown.style.display = 'none';
      };
      // Close dropdown on outside click
      document.addEventListener('click', () => { shareDropdown.style.display = 'none'; });
    }

    // Bind interactive hover tooltips
    this._bindAnalyticsTooltips(container);

    // Reconnect anti-tamper MutationObserver on new DOM elements
    // _applyProLocks() only runs at init, but _renderAnalytics() replaces innerHTML,
    // creating new .analytics-pro-blur-content elements the old observer can't see.
    if (this._proBlurObserver) {
      this._proBlurObserver.disconnect();
      this._proBlurObserver = null;
    }
    if (!isPro) {
      this._proBlurObserver = new MutationObserver(() => {
        if (this.user && this.user.plan === 'premium') return;
        document.querySelectorAll('.analytics-pro-blur-content').forEach(el => {
          if (!el.style.filter || !el.style.filter.includes('blur')) {
            el.style.filter = 'blur(6px)';
            el.style.pointerEvents = 'none';
            el.style.userSelect = 'none';
          }
        });
      });
      document.querySelectorAll('.analytics-pro-blur-content').forEach(el => {
        this._proBlurObserver.observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
      });
    }
  },

  _bindAnalyticsTooltips(container) {
    let tooltip = document.getElementById('analytics-tooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.id = 'analytics-tooltip';
      tooltip.style.cssText = 'position:fixed;z-index:10000;background:var(--bg-elevated);color:var(--text-primary);border:1px solid var(--border-hover);border-radius:6px;padding:6px 10px;font-size:12px;pointer-events:none;opacity:0;transition:opacity 0.15s;white-space:nowrap;box-shadow:var(--shadow)';
      document.body.appendChild(tooltip);
    }
    container.querySelectorAll('[data-tooltip]').forEach(el => {
      el.addEventListener('mouseenter', (e) => {
        tooltip.textContent = el.dataset.tooltip;
        tooltip.style.opacity = '1';
        const rect = el.getBoundingClientRect();
        tooltip.style.left = `${Math.max(8, rect.left + rect.width / 2 - tooltip.offsetWidth / 2)}px`;
        tooltip.style.top = `${rect.top - tooltip.offsetHeight - 6}px`;
      });
      el.addEventListener('mouseleave', () => { tooltip.style.opacity = '0'; });
    });
  },

  _shareAnalyticsCard() {
    const data = this._analyticsData;
    if (!data) return;
    const isPro = data.isPro;
    const username = data.username || 'writer';
    const displayName = data.displayName || username;

    const W = 600, H = isPro ? 820 : 580;
    const canvas = document.createElement('canvas');
    canvas.width = W * 2; canvas.height = H * 2; // 2x for retina
    const ctx = canvas.getContext('2d');
    ctx.scale(2, 2);

    const pad = 24;
    const gap = 10;
    const r = 14; // border radius

    // Background
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, W, H);

    // Helper: rounded rect
    const rrect = (x, y, w, h, radius) => {
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + w - radius, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
      ctx.lineTo(x + w, y + h - radius);
      ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
      ctx.lineTo(x + radius, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
      ctx.closePath();
    };

    const drawCard = (x, y, w, h, color) => {
      rrect(x, y, w, h, r);
      ctx.fillStyle = color || '#1a1a1a';
      ctx.fill();
    };

    const drawText = (text, x, y, opts = {}) => {
      ctx.fillStyle = opts.color || '#fff';
      ctx.font = `${opts.weight || '600'} ${opts.size || 13}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.textAlign = opts.align || 'left';
      ctx.fillText(text, x, y);
    };

    // ── Dark-theme tree drawing (inline, adapted from TreeRenderer) ──
    const drawTreeDark = (ctx, centerX, groundY, stage, streak, areaW, areaH) => {
      // Ground - dark mossy ellipse
      ctx.fillStyle = 'rgba(74, 222, 128, 0.08)';
      ctx.beginPath();
      ctx.ellipse(centerX, groundY + 6, Math.min(areaW * 0.35, 80), 12, 0, 0, Math.PI * 2);
      ctx.fill();

      if (stage === 0) {
        // Seed
        ctx.fillStyle = '#8B6914';
        ctx.beginPath();
        ctx.ellipse(centerX, groundY - 6, 6, 8, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#654B0F';
        ctx.beginPath();
        ctx.moveTo(centerX - 2, groundY - 14);
        ctx.quadraticCurveTo(centerX + 2, groundY - 18, centerX + 1, groundY - 11);
        ctx.fill();
        return;
      }

      const trunkHeight = Math.min(20 + stage * 14, 140);
      const trunkWidth = Math.min(3 + stage * 1.5, 18);

      // Streak glow (behind tree)
      if (streak > 0) {
        const intensity = Math.min(streak * 0.04, 0.25);
        const glowR = 40 + streak * 3;
        const glow = ctx.createRadialGradient(centerX, groundY - trunkHeight / 2, 0, centerX, groundY - trunkHeight / 2, glowR);
        glow.addColorStop(0, `rgba(255, 183, 77, ${intensity})`);
        glow.addColorStop(1, 'rgba(255, 183, 77, 0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(centerX, groundY - trunkHeight / 2, glowR, 0, Math.PI * 2);
        ctx.fill();
      }

      // Trunk
      const trunkGrad = ctx.createLinearGradient(centerX - trunkWidth / 2, groundY, centerX + trunkWidth / 2, groundY);
      trunkGrad.addColorStop(0, '#4E342E');
      trunkGrad.addColorStop(0.5, '#6D4C41');
      trunkGrad.addColorStop(1, '#4E342E');
      ctx.fillStyle = trunkGrad;
      ctx.beginPath();
      ctx.moveTo(centerX - trunkWidth / 2, groundY);
      ctx.lineTo(centerX - trunkWidth / 3, groundY - trunkHeight);
      ctx.lineTo(centerX + trunkWidth / 3, groundY - trunkHeight);
      ctx.lineTo(centerX + trunkWidth / 2, groundY);
      ctx.fill();

      // Bark texture lines
      if (stage >= 4) {
        ctx.strokeStyle = 'rgba(62, 39, 35, 0.5)';
        ctx.lineWidth = 0.5;
        for (let i = 0; i < 3; i++) {
          const ly = groundY - trunkHeight * 0.3 - i * 14;
          ctx.beginPath();
          ctx.moveTo(centerX - trunkWidth / 3, ly);
          ctx.quadraticCurveTo(centerX, ly - 2, centerX + trunkWidth / 3, ly);
          ctx.stroke();
        }
      }

      // Roots
      ctx.fillStyle = '#4E342E';
      ctx.beginPath();
      ctx.moveTo(centerX - trunkWidth * 0.8, groundY);
      ctx.quadraticCurveTo(centerX - trunkWidth * 1.2, groundY + 5, centerX - trunkWidth * 0.4, groundY + 4);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(centerX + trunkWidth * 0.8, groundY);
      ctx.quadraticCurveTo(centerX + trunkWidth * 1.2, groundY + 5, centerX + trunkWidth * 0.4, groundY + 4);
      ctx.fill();

      // Branches
      if (stage >= 2) {
        const branchCount = Math.min(2 + stage, 7);
        ctx.strokeStyle = '#5D4037';
        ctx.lineCap = 'round';
        for (let i = 0; i < branchCount; i++) {
          const side = i % 2 === 0 ? -1 : 1;
          const yOff = 8 + i * 11;
          const len = 15 + stage * 4;
          ctx.lineWidth = Math.max(0.8, 3 - i * 0.3);
          ctx.beginPath();
          ctx.moveTo(centerX, groundY - trunkHeight + yOff);
          ctx.quadraticCurveTo(
            centerX + side * len * 0.6, groundY - trunkHeight + yOff - 10,
            centerX + side * len, groundY - trunkHeight + yOff - 14
          );
          ctx.stroke();
        }
      }

      // Leaves
      const topY = groundY - trunkHeight;
      const leafCount = stage * 10;
      const spread = 15 + stage * 10;
      const opacity = streak > 0 ? 1 : 0.7;
      // Use seeded pseudo-random for consistent rendering
      let seed = stage * 137 + 42;
      const seededRandom = () => { seed = (seed * 16807 + 0) % 2147483647; return seed / 2147483647; };
      for (let i = 0; i < leafCount; i++) {
        const angle = (i / leafCount) * Math.PI * 2;
        const rr = seededRandom() * spread;
        const lx = centerX + Math.cos(angle) * rr;
        const ly = topY - 8 + Math.sin(angle) * rr * 0.6 - seededRandom() * 16;
        const hue = 100 + seededRandom() * 40;
        const sat = 40 + stage * 5;
        const light = 30 + seededRandom() * 18;
        ctx.fillStyle = `hsla(${hue}, ${sat}%, ${light}%, ${opacity})`;
        const sz = 3 + seededRandom() * (stage * 0.7);
        ctx.beginPath();
        ctx.ellipse(lx, ly, sz, sz * 0.7, seededRandom() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }

      // Flowers (stage 5+)
      if (stage >= 5) {
        for (let i = 0; i < 4; i++) {
          const angle = (i / 4) * Math.PI * 2;
          const rr = spread * 0.5;
          const fx = centerX + Math.cos(angle) * rr;
          const fy = topY - 14 + Math.sin(angle) * rr * 0.4;
          ctx.fillStyle = `hsla(330, 60%, 80%, ${opacity})`;
          for (let p = 0; p < 5; p++) {
            const pa = (p / 5) * Math.PI * 2;
            ctx.beginPath();
            ctx.ellipse(fx + Math.cos(pa) * 2.5, fy + Math.sin(pa) * 2.5, 2.5, 1.8, pa, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      // Fruits (stage 7+)
      if (stage >= 7) {
        const fruitCount = stage - 6;
        for (let i = 0; i < fruitCount; i++) {
          const angle = (i / fruitCount) * Math.PI * 2 + 0.5;
          const rr = 20 + seededRandom() * 16;
          const fx = centerX + Math.cos(angle) * rr;
          const fy = topY + Math.sin(angle) * rr * 0.4 + 8;
          ctx.fillStyle = '#ef4444';
          ctx.beginPath();
          ctx.arc(fx, fy, 3.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.3)';
          ctx.beginPath();
          ctx.arc(fx - 1, fy - 1, 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };

    // ── Header ──
    drawText('iWrite4.me', pad, pad + 18, { size: 20, weight: '800', color: '#10b981' });
    drawText(`@${username}`, pad, pad + 38, { size: 13, weight: '400', color: '#888' });

    // PRO badge in header for Pro users
    if (isPro) {
      const badgeX = W - pad - 50;
      const badgeY = pad + 6;
      const grad = ctx.createLinearGradient(badgeX, badgeY, badgeX + 44, badgeY + 22);
      grad.addColorStop(0, '#f59e0b');
      grad.addColorStop(1, '#d97706');
      rrect(badgeX, badgeY, 44, 22, 6);
      ctx.fillStyle = grad;
      ctx.fill();
      drawText('PRO', badgeX + 22, badgeY + 16, { size: 12, weight: '800', color: '#000', align: 'center' });
    }

    const gridTop = pad + 56;
    const colW = (W - pad * 2 - gap) / 2; // 2 columns
    const cardH = 90;
    const pr = data.personalRecords;
    const treeStage = data.treeStage || 0;
    const treeNames = ['', 'Seed', 'Sprout', 'Seedling', 'Sapling', 'Young Tree', 'Growing Tree', 'Mature Tree', 'Strong Tree', 'Grand Tree', 'Ancient Tree', 'World Tree'];

    // ── Row 1: Total Writing Time + Sessions ──
    drawCard(pad, gridTop, colW, cardH, '#1a1a1a');
    const totalMins = Math.round((data.totalWritingTime || 0) / 60);
    const totalHrs = Math.floor(totalMins / 60);
    const remMins = totalMins % 60;
    drawText('\u23F1\uFE0F', pad + 14, gridTop + 50, { size: 28, weight: '400' });
    drawText(totalHrs > 0 ? `${totalHrs}h ${remMins}m` : `${totalMins}m`, pad + 48, gridTop + 48, { size: 32, weight: '800', color: '#10b981' });
    drawText('Total Writing Time', pad + 16, gridTop + 72, { size: 12, weight: '400', color: '#888' });

    drawCard(pad + colW + gap, gridTop, colW, cardH, '#1a1a1a');
    drawText('\u{1F4DD}', pad + colW + gap + 14, gridTop + 50, { size: 26, weight: '400' });
    drawText(`${data.totalSessions}`, pad + colW + gap + 48, gridTop + 48, { size: 28, weight: '800', color: '#fff' });
    drawText('Sessions', pad + colW + gap + 16, gridTop + 72, { size: 12, weight: '400', color: '#888' });

    // ── Rows 2-4 layout: Left stat cards + Right tall tree card ──
    const r2y = gridTop + cardH + gap;
    const treeSpanRows = 3; // tree spans rows 2, 3, 4
    const treeCardH = cardH * treeSpanRows + gap * (treeSpanRows - 1);
    const rightX = pad + colW + gap;

    // Draw tree card (tall, right side, rows 2-4) — always shown, even at stage 0 (seed)
    drawCard(rightX, r2y, colW, treeCardH, '#111');
    const treeCX = rightX + colW / 2;
    const treeGroundY = r2y + treeCardH - 20;
    const treeAreaH = treeCardH - 40;
    ctx.save();
    ctx.beginPath();
    rrect(rightX, r2y, colW, treeCardH, r);
    ctx.clip();
    drawTreeDark(ctx, treeCX, treeGroundY, treeStage, pr.currentStreak || 0, colW, treeAreaH);
    ctx.restore();

    // Row 2 left: Words Written (with relatable comparison)
    drawCard(pad, r2y, colW, cardH, '#1a1a1a');
    drawText('\u270D\uFE0F', pad + 14, r2y + 44, { size: 24, weight: '400' });
    drawText(data.totalWords.toLocaleString(), pad + 46, r2y + 42, { size: 28, weight: '800', color: '#fff' });
    const tw = data.totalWords || 0;
    let comparison = '';
    if (tw >= 100000) comparison = `\u2248 ${Math.round(tw / 250)} pages \u2022 a full novel`;
    else if (tw >= 50000) comparison = `\u2248 ${Math.round(tw / 250)} pages \u2022 a novel`;
    else if (tw >= 25000) comparison = `\u2248 ${Math.round(tw / 250)} pages \u2022 half a novel`;
    else if (tw >= 10000) comparison = `\u2248 ${Math.round(tw / 250)} pages \u2022 a novella`;
    else if (tw >= 5000) comparison = `\u2248 ${Math.round(tw / 250)} pages \u2022 a short story`;
    else if (tw >= 1000) comparison = `\u2248 ${Math.round(tw / 250)} pages`;
    else comparison = 'Words Written';
    if (tw >= 1000) {
      drawText('Words Written', pad + 16, r2y + 60, { size: 11, weight: '400', color: '#888' });
      drawText(comparison, pad + 16, r2y + 76, { size: 10, weight: '400', color: '#666' });
    } else {
      drawText(comparison, pad + 16, r2y + 72, { size: 12, weight: '400', color: '#888' });
    }

    // Row 3 left: Longest Session
    const r3y = r2y + cardH + gap;
    drawCard(pad, r3y, colW, cardH, '#1a1a1a');
    const longestMins = pr.longestSession ? Math.round((pr.longestSession.duration || 0) / 60) : 0;
    drawText('\u{1F3C6}', pad + 14, r3y + 50, { size: 26, weight: '400' });
    drawText(`${longestMins}m`, pad + 48, r3y + 48, { size: 28, weight: '800', color: '#8b5cf6' });
    drawText('Longest Session', pad + 16, r3y + 72, { size: 12, weight: '400', color: '#888' });

    // Row 4 left: Streak
    const r4y = r3y + cardH + gap;
    drawCard(pad, r4y, colW, cardH, '#1a1a1a');
    drawText('\u{1F525}', pad + 14, r4y + 50, { size: 30, weight: '400' });
    drawText(`${pr.currentStreak}`, pad + 50, r4y + 48, { size: 32, weight: '800', color: '#f59e0b' });
    drawText('day streak', pad + 16, r4y + 72, { size: 12, weight: '400', color: '#888' });
    drawText(`best: ${pr.bestStreak.days}`, pad + colW - 16, r4y + 72, { size: 11, weight: '400', color: '#666', align: 'right' });

    // ── Row 5: Focus Score + Tree name ──
    const r5y = r4y + cardH + gap;
    drawCard(pad, r5y, colW, cardH, '#1a1a1a');
    drawText('\u{1F3AF}', pad + 14, r5y + 50, { size: 26, weight: '400' });
    drawText(`${data.focusScore}%`, pad + 48, r5y + 48, { size: 28, weight: '800', color: '#06b6d4' });
    drawText('Focus Score', pad + 16, r5y + 72, { size: 12, weight: '400', color: '#888' });

    if (treeStage > 0) {
      drawCard(rightX, r5y, colW, cardH, '#1a1a1a');
      drawText(`${treeNames[treeStage] || 'Tree'}`, rightX + 16, r5y + 42, { size: 22, weight: '800', color: '#4ade80' });
      drawText(`Stage ${treeStage}`, rightX + 16, r5y + 66, { size: 13, weight: '400', color: '#888' });
    } else {
      drawCard(rightX, r5y, colW, cardH, '#1a1a1a');
      drawText('Plant your seed!', rightX + 16, r5y + 42, { size: 16, weight: '600', color: '#4ade80' });
      drawText('Start writing daily', rightX + 16, r5y + 66, { size: 13, weight: '400', color: '#888' });
    }

    let nextY = r5y + cardH + gap;

    // ── Pro-only rows ──
    if (isPro && data.writingRhythm) {
      const wr = data.writingRhythm;

      // Writer Type (full width)
      drawCard(pad, nextY, W - pad * 2, 70, '#1a2a1a');
      const typeEmoji = wr.writerType === 'Night Writer' ? '\u{1F319}' : wr.writerType === 'Early Bird' ? '\u{1F305}' : '\u2600\uFE0F';
      drawText(`${typeEmoji}  ${wr.writerType}`, pad + 16, nextY + 38, { size: 22, weight: '800', color: '#4ade80' });
      drawText(`${(wr.avgWordsPerDay || 0).toLocaleString()} words/day \u2022 ${(wr.avgWordsPerWeek || 0).toLocaleString()} words/week`, pad + 16, nextY + 58, { size: 12, weight: '400', color: '#888' });
      nextY += 77 + gap;

      // Danger survival / Best day + Writing Journey milestones
      if (data.dangerReport && data.dangerReport.total > 0) {
        drawCard(pad, nextY, colW, cardH, '#2a1a1a');
        drawText('\u{1F480}', pad + 14, nextY + 50, { size: 26, weight: '400' });
        drawText(`${data.dangerReport.survivalRate}%`, pad + 48, nextY + 48, { size: 28, weight: '800', color: data.dangerReport.survivalRate >= 50 ? '#4ade80' : '#f87171' });
        drawText('Danger Survival', pad + 16, nextY + 72, { size: 12, weight: '400', color: '#888' });
      } else {
        drawCard(pad, nextY, colW, cardH, '#1a1a1a');
        drawText('\u2728', pad + 14, nextY + 50, { size: 24, weight: '400' });
        drawText(wr.bestDay, pad + 46, nextY + 48, { size: 22, weight: '800', color: '#fff' });
        drawText('Most Inspired Day', pad + 16, nextY + 72, { size: 12, weight: '400', color: '#888' });
      }

      // Writing Journey milestones progress bar
      drawCard(rightX, nextY, colW, cardH, '#1a1a2a');
      const milestones = data.milestones || [];
      const unlocked = milestones.filter(m => m.unlocked).length;
      const milestoneLabels = ['1K', '5K', '10K', '25K', '50K', '100K'];
      const barX = rightX + 16;
      const barY = nextY + 44;
      const labeledW = colW - 52; // space for labeled milestones
      const tailW = 16; // extra tail after 100K to show "no limit"
      const barW = labeledW + tailW;
      const barH = 8;
      drawText('\u{1F4DA}  Writing Journey', barX, nextY + 24, { size: 11, weight: '600', color: '#818cf8' });
      // Background bar (full width including tail)
      rrect(barX, barY, barW, barH, 4);
      ctx.fillStyle = '#2a2a3a';
      ctx.fill();
      // Filled portion — extends past 100K if all unlocked
      if (unlocked > 0) {
        let fillW;
        if (unlocked >= milestones.length) {
          // All milestones complete — fill extends into the tail with fade
          fillW = labeledW + tailW * 0.7;
        } else {
          fillW = Math.max(barH, (unlocked / milestones.length) * labeledW);
        }
        rrect(barX, barY, fillW, barH, 4);
        const grad = ctx.createLinearGradient(barX, barY, barX + fillW, barY);
        grad.addColorStop(0, '#818cf8');
        grad.addColorStop(0.85, '#a78bfa');
        grad.addColorStop(1, unlocked >= milestones.length ? 'rgba(167,139,250,0.3)' : '#a78bfa');
        ctx.fillStyle = grad;
        ctx.fill();
      }
      // Tail fade dots (after 100K, showing infinity)
      for (let d = 0; d < 3; d++) {
        const dx = barX + labeledW + 4 + d * 5;
        ctx.beginPath();
        ctx.arc(dx, barY + barH / 2, 1.2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(129, 140, 248, ${0.4 - d * 0.12})`;
        ctx.fill();
      }
      // Milestone dots (on the labeled portion)
      for (let i = 0; i < milestones.length; i++) {
        const dotX = barX + ((i + 1) / milestones.length) * labeledW;
        ctx.beginPath();
        ctx.arc(dotX, barY + barH / 2, 3, 0, Math.PI * 2);
        ctx.fillStyle = milestones[i].unlocked ? '#86efac' : '#3a3a4a';
        ctx.fill();
      }
      // Milestone labels (only for the 6 labeled milestones)
      ctx.textAlign = 'center';
      for (let i = 0; i < milestoneLabels.length; i++) {
        const lx = barX + ((i + 1) / milestones.length) * labeledW;
        ctx.fillStyle = milestones[i] && milestones[i].unlocked ? '#a78bfa' : '#555';
        ctx.font = '400 8px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(milestoneLabels[i], lx, barY + barH + 14);
      }
      ctx.textAlign = 'left';
      // Next milestone text
      const nextMilestone = data.nextMilestone;
      if (nextMilestone) {
        const pct = Math.round((tw / nextMilestone.target) * 100);
        drawText(`${pct}% to ${nextMilestone.target >= 1000 ? (nextMilestone.target / 1000) + 'K' : nextMilestone.target} words`, barX, nextY + 78, { size: 10, weight: '400', color: '#666' });
      } else {
        drawText('All milestones complete! Keep going \u2192', barX, nextY + 78, { size: 10, weight: '400', color: '#a78bfa' });
      }

      nextY += cardH + gap;
    }

    // ── Footer: invite link ──
    const footerY = Math.max(nextY + 4, H - 40);
    const actualH = footerY + 30;

    // Resize canvas FIRST if content exceeds initial height, so footer draws inside bounds
    if (actualH !== H) {
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = W * 2; tempCanvas.height = actualH * 2;
      const tempCtx = tempCanvas.getContext('2d');
      tempCtx.fillStyle = '#0a0a0a';
      tempCtx.fillRect(0, 0, W * 2, actualH * 2);
      tempCtx.drawImage(canvas, 0, 0);
      canvas.width = W * 2;
      canvas.height = actualH * 2;
      ctx.drawImage(tempCanvas, 0, 0);
      ctx.scale(2, 2);
    }

    // Draw footer background + invite link text
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, footerY - 10, W, 50);
    drawText(`Add me on iWrite \u2192 iwrite4.me/invite/${username}`, W / 2, footerY + 8, { size: 12, weight: '500', color: '#fff', align: 'center' });

    // Copy invite link to clipboard
    const inviteLink = `https://iwrite4.me/invite/${username}`;
    navigator.clipboard.writeText(inviteLink).catch(() => {});

    // Convert to blob and download/share
    canvas.toBlob(blob => {
      if (navigator.share && navigator.canShare) {
        const file = new File([blob], 'iwrite-stats.png', { type: 'image/png' });
        if (navigator.canShare({ files: [file] })) {
          navigator.share({
            title: 'My iWrite Progress',
            text: `Check out my writing progress on iWrite! Add me: iwrite4.me/invite/${username}`,
            files: [file]
          }).catch(() => this._downloadBlob(blob, 'iwrite-stats.png'));
          return;
        }
      }
      this._downloadBlob(blob, 'iwrite-stats.png');
    }, 'image/png');
  },

  _downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    this.toast('Stats card downloaded! Your invite link was copied to clipboard.', 'success');
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
    'v2.3': {
      title: 'v2.3 — Community & Themes',
      html: `
        <p style="color:var(--text-muted);margin-bottom:16px">March 2026</p>
        <h4 style="margin-top:16px;margin-bottom:8px">Community (formerly Stories)</h4>
        <p>Share your writing with the community. Featured hero cards, editorial reader layout, floating selection toolbar for composing, and a format dropdown with Heading, Subheader, Blockquote, and Lists.</p>
        <h4 style="margin-top:16px;margin-bottom:8px">Three Theme Modes</h4>
        <p>Cycle between <strong>Dark</strong> (black + green), <strong>Light</strong> (white + green), and <strong>Sepia</strong> (warm parchment with paper texture) — now unlocked for all users, not just Pro.</p>
        <h4 style="margin-top:16px;margin-bottom:8px">Friends Pagination & Sorting</h4>
        <p>Friends list now loads in pages with sort options: newest, oldest, streak, and XP. Scales better for users with many friends.</p>
        <h4 style="margin-top:16px;margin-bottom:8px">UI Improvements</h4>
        <p>Challenge button visibility fix, PRO badge sepia styling, story title input cleanup, share progress button theming, and dozens of small polish fixes across all three themes.</p>`
    },
    'v2.2': {
      title: 'v2.2 — Share & Analytics',
      html: `
        <p style="color:var(--text-muted);margin-bottom:16px">March 2026</p>
        <h4 style="margin-top:16px;margin-bottom:8px">Share My Progress</h4>
        <p>Generate a beautiful shareable card showing your writing tree, stats, streak, and achievements. Share your writing journey on social media or with friends — your tree is always displayed, from tiny seed to mighty forest.</p>
        <h4 style="margin-top:16px;margin-bottom:8px">Writing Analytics</h4>
        <p>Deep insights into your writing habits — <strong>Writing Rhythm</strong> reveals your best writing patterns, and <strong>Time Distribution</strong> shows which hours of the day you're most productive. Understand yourself as a writer.</p>
        <h4 style="margin-top:16px;margin-bottom:8px">Security & Stability</h4>
        <p>Major under-the-hood improvements to app security, session handling, and overall stability.</p>`
    },
    'v2.0': {
      title: 'v2.0 — Usernames & Streaks',
      html: `
        <p style="color:var(--text-muted);margin-bottom:16px">March 2026</p>
        <h4 style="margin-top:16px;margin-bottom:8px">Usernames</h4>
        <p>Pick a unique username (3-30 characters) in your Profile. It appears on the leaderboard next to your name. You can change it once per month.</p>
        <h4 style="margin-top:16px;margin-bottom:8px">Streak Leaderboard</h4>
        <p>The leaderboard now ranks by <strong>writing streak</strong> first. The podium highlights each writer's current streak.</p>
        <h4 style="margin-top:16px;margin-bottom:8px">Smart Document Search</h4>
        <p>Filter your documents with <code>status=active</code>, <code>mode=dangerous</code>, <code>words=500</code>, or just type to search by title.</p>
        <h4 style="margin-top:16px;margin-bottom:8px">Session Word Limits</h4>
        <p>Free accounts have a <strong>1,500 word</strong> limit per session. Pro users get up to <strong>10,000 words</strong> per session and <strong>20,000 words</strong> when editing. A counter appears near the limit.</p>
        <h4 style="margin-top:16px;margin-bottom:8px">Dangerous Mode</h4>
        <p>Cleaner visuals — text stays normal color, only screen edges glow red. Auto-enters fullscreen to keep you focused.</p>
        <h4 style="margin-top:16px;margin-bottom:8px">Version Indicator</h4>
        <p>Current app version now shown below the logo in the sidebar.</p>`
    },
    'v1.2': {
      title: 'v1.2 — Polish & Limits',
      html: `
        <p style="color:var(--text-muted);margin-bottom:16px">March 2026</p>
        <h4 style="margin-top:16px;margin-bottom:8px">Early Complete Limit</h4>
        <p>Free accounts can end sessions early up to 5 times per month. Pro users get a larger limit.</p>
        <h4 style="margin-top:16px;margin-bottom:8px">Online Writers</h4>
        <p>See how many writers are online right now on your dashboard.</p>
        <h4 style="margin-top:16px;margin-bottom:8px">Mobile Improvements</h4>
        <p>Better toolbar layout, timer visibility, and modal alignment on small screens.</p>`
    },
    'v1.1': {
      title: 'v1.1 — Friends & Duels',
      html: `
        <p style="color:var(--text-muted);margin-bottom:16px">February 2026</p>
        <h4 style="margin-top:16px;margin-bottom:8px">Writing Duels</h4>
        <p>Challenge your friends to timed head-to-head writing battles. Most words wins.</p>
        <h4 style="margin-top:16px;margin-bottom:8px">Friends System</h4>
        <p>Add friends by email, see friend suggestions, and track their activity.</p>
        <h4 style="margin-top:16px;margin-bottom:8px">Document Sharing</h4>
        <p>Share completed documents with view, comment, or edit permissions via unique links.</p>
        <h4 style="margin-top:16px;margin-bottom:8px">Session History</h4>
        <p>View your past sessions with stats — total words, time spent, dangerous completions.</p>`
    },
    'v1.0': {
      title: 'v1.0 — Launch',
      html: `
        <p style="color:var(--text-muted);margin-bottom:16px">February 2026</p>
        <h4 style="margin-top:16px;margin-bottom:8px">Write It or Lose It</h4>
        <p>Timed writing sessions with tab-lock. Leave the tab and your work gets a 10-second countdown before it's gone.</p>
        <h4 style="margin-top:16px;margin-bottom:8px">Dangerous Mode</h4>
        <p>Stop typing for 5 seconds and your session fails. No exceptions.</p>
        <h4 style="margin-top:16px;margin-bottom:8px">XP & Levels</h4>
        <p>Earn XP for every session based on words written and time spent. Level up with increasing thresholds.</p>
        <h4 style="margin-top:16px;margin-bottom:8px">Streaks & Writing Tree</h4>
        <p>Write every day to grow your streak and watch your tree evolve through 12 stages — from seed to forest over 30 days.</p>
        <h4 style="margin-top:16px;margin-bottom:8px">Leaderboard</h4>
        <p>Top 10 writers displayed with a podium for the top 3. See where you rank.</p>
        <h4 style="margin-top:16px;margin-bottom:8px">Google Sign-In</h4>
        <p>One-click sign-in with your Google account.</p>`
    },
    'how-it-works': {
      title: 'How It Works',
      html: `<p>iWrite4.me is a distraction-free writing tool built on one rule: <strong>write it or lose it</strong>.</p>
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
      html: `<p>Your tree is a visual reflection of your consistency. It evolves as your streak grows — reaching full Forest at 30 days.</p>
        <ul><li>12 stages: Seed → Sprout (1d) → Seedling (3d) → Sapling (5d) → Young Tree (8d) → Growing Tree (11d) → Mature Tree (14d) → Strong Tree (17d) → Grand Tree (20d) → Ancient Tree (23d) → World Tree (27d) → <strong>Forest (30d)</strong></li><li>Break your streak and your tree <strong>resets back to a seed</strong>.</li><li>Active streaks give your tree a warm golden glow.</li></ul>`
    },
    'leaderboard': {
      title: 'Leaderboard',
      html: `<p>The leaderboard ranks writers by <strong>writing streak</strong> first, then total words.</p>
        <ul><li>The podium shows the top 3 writers with their current streak.</li><li>Usernames are displayed below names.</li><li>Your row is highlighted so you can see where you stand.</li><li>Keep your streak alive to climb the ranks!</li></ul>`
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
