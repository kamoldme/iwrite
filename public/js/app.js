const App = {
  user: null,
  documents: [],
  friends: [],
  currentView: 'dashboard',
  sessionDuration: 15,
  sessionMode: 'normal',
  toastTimer: null,
  notifInterval: null,

  calcXPLevel(totalXP) {
    let level = 1;
    let xpUsed = 0;
    let threshold = 100;
    while (totalXP >= xpUsed + threshold) {
      xpUsed += threshold;
      level++;
      threshold = Math.round(100 * Math.pow(1.15, level - 1));
    }
    return { level, xpInLevel: totalXP - xpUsed, xpForNextLevel: threshold };
  },

  async init() {
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
    Monsters.init();
  },

  showApp() {
    Monsters.destroy();
    document.getElementById('auth-view').style.display = 'none';
    document.getElementById('app-view').style.display = 'block';
    this.updateUserUI();
    this.loadDashboard();
    this.bindAppEvents();
    this.startNotifPolling();
  },

  bindAuthEvents() {
    document.getElementById('show-register').addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('login-form').style.display = 'none';
      document.getElementById('register-form').style.display = 'block';
    });

    document.getElementById('show-login').addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('register-form').style.display = 'none';
      document.getElementById('login-form').style.display = 'block';
    });

    document.getElementById('login-btn').addEventListener('click', async () => {
      const email = document.getElementById('login-email').value;
      const password = document.getElementById('login-password').value;
      const errorEl = document.getElementById('login-error');
      try {
        const data = await API.login(email, password);
        this.user = data.user;
        this.showApp();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.classList.add('visible');
      }
    });

    document.getElementById('register-btn').addEventListener('click', async () => {
      const name = document.getElementById('register-name').value;
      const email = document.getElementById('register-email').value;
      const password = document.getElementById('register-password').value;
      const errorEl = document.getElementById('register-error');
      try {
        const data = await API.register(name, email, password);
        this.user = data.user;
        this.showApp();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.classList.add('visible');
      }
    });

    document.querySelectorAll('.auth-field input').forEach(input => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const form = input.closest('[id$="-form"]');
          form.querySelector('button').click();
        }
      });
    });

    ['login-pw-eye', 'register-pw-eye'].forEach(btnId => {
      const btn = document.getElementById(btnId);
      if (!btn) return;
      btn.addEventListener('click', () => {
        const input = btn.closest('.auth-pw-wrap').querySelector('input');
        const isHiding = input.type === 'text';
        input.type = isHiding ? 'password' : 'text';
        btn.querySelector('.eye-open').style.display = isHiding ? '' : 'none';
        btn.querySelector('.eye-closed').style.display = isHiding ? 'none' : '';
        Monsters.setLookAway(!isHiding);
      });
    });
  },

  bindAppEvents() {
    document.querySelectorAll('.sidebar-nav-item[data-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.switchView(btn.dataset.view);
      });
    });

    document.getElementById('logout-btn').addEventListener('click', () => API.logout());

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
      document.getElementById('time-preset-add-btn').textContent = `${val}m`;
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
      });
    });

    document.getElementById('editor-back').addEventListener('click', () => Editor.abort());
    document.getElementById('editor-save-btn').addEventListener('click', () => Editor.completeSession());

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

    document.getElementById('history-btn').addEventListener('click', () => this.openHistoryModal());
    document.getElementById('history-close').addEventListener('click', () => {
      document.getElementById('history-modal').classList.remove('active');
    });
  },

  switchView(view) {
    this.currentView = view;
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
    // help view is static, no loading needed
  },

  updateUserUI() {
    if (!this.user) return;
    document.getElementById('user-name').textContent = this.user.name;
    document.getElementById('user-level').textContent = `Level ${this.user.level}`;
    document.getElementById('user-avatar').textContent = this.user.name.charAt(0).toUpperCase();

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
    document.getElementById('xp-progress-text').textContent = `${xpInLevel} / ${xpForNextLevel} XP`;
    document.getElementById('xp-bar-fill').style.width = `${Math.min(100, (xpInLevel / xpForNextLevel) * 100)}%`;

    const canvas = document.getElementById('tree-canvas');
    const stage = this.user.treeStage || 0;
    TreeRenderer.draw(canvas, stage, this.user.streak || 0);
    document.getElementById('tree-stage-text').textContent = TreeRenderer.stages[stage] || 'Seed';

    try {
      this.documents = await API.getDocuments();
    } catch {
      this.documents = [];
    }
    this.renderDocumentList('recent-docs', this.documents.slice(0, 5));
  },

  async loadDocuments() {
    try {
      this.documents = await API.getDocuments();
    } catch {
      this.documents = [];
    }
    this.renderDocumentList('all-docs', this.documents);
  },

  renderDocumentList(containerId, docs) {
    const container = document.getElementById(containerId);
    if (docs.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <h3>No documents yet</h3>
          <p>Start a new writing session to create your first document.</p>
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
        <div class="doc-card-actions">
          ${isFailed ? '' : `
          <button class="doc-action-btn" onclick="event.stopPropagation();App.shareDoc('${doc.id}')" title="Share">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/><polyline points="16,6 12,2 8,6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
          </button>`}
          <button class="doc-action-btn delete" onclick="event.stopPropagation();App.deleteDoc('${doc.id}')" title="Delete">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        </div>
      </div>`;
    }).join('');

    container.querySelectorAll('.doc-card').forEach(card => {
      card.addEventListener('click', () => {
        if (!card.classList.contains('doc-failed')) {
          this.openDocument(card.dataset.id);
        }
      });
    });
  },

  async openDocument(id) {
    try {
      const doc = await API.request(`/documents/${id}`);
      document.getElementById('editor-title').value = doc.title;
      document.getElementById('editor-textarea').value = doc.content || '';
      Editor.documentId = id;
      Editor.active = false;
      document.getElementById('editor-container').classList.add('active');
      document.getElementById('editor-timer').textContent = 'View';
      document.getElementById('editor-mode-badge').textContent = 'Viewing';
      document.getElementById('editor-mode-badge').className = 'editor-mode-badge normal';
      document.getElementById('danger-progress').style.display = 'none';
      Editor.updateWordCount();
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
  },

  closeSessionModal() {
    document.getElementById('session-modal').classList.remove('active');
  },

  startSession() {
    this.closeSessionModal();
    document.getElementById('editor-title').value = 'Untitled';
    Editor.start(this.sessionDuration, this.sessionMode);
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
            <td><span class="lb-level">Lv.${entry.level || 1}</span></td>
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
    try {
      const link = await API.shareDocument(id, 'view');
      const url = `${window.location.origin}/shared/${link.token}`;
      await navigator.clipboard.writeText(url);
      this.toast('Share link copied to clipboard!', 'success');
    } catch {
      this.toast('Failed to create share link', 'error');
    }
  },

  async deleteDoc(id) {
    if (!confirm('Delete this document?')) return;
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
      { icon: '&#x1F331;', name: 'First Seed', description: 'Complete your first session', earned: (u.totalSessions || 0) >= 1 },
      { icon: '&#x1F525;', name: 'On Fire', description: '3-day writing streak', earned: (u.longestStreak || 0) >= 3 },
      { icon: '&#x26A1;', name: 'Speed Writer', description: 'Write 500 words in one session', earned: (u.totalWords || 0) >= 500 },
      { icon: '&#x1F3AF;', name: 'Consistent', description: '7-day writing streak', earned: (u.longestStreak || 0) >= 7 },
      { icon: '&#x1F4DA;', name: 'Prolific', description: 'Write 10,000 total words', earned: (u.totalWords || 0) >= 10000 },
      { icon: '&#x1F480;', name: 'Danger Zone', description: 'Complete a Dangerous mode session', earned: false },
      { icon: '&#x1F333;', name: 'World Tree', description: 'Grow your tree to max stage', earned: (u.treeStage || 0) >= 10 },
      { icon: '&#x1F3C6;', name: 'Legend', description: '30-day writing streak', earned: (u.longestStreak || 0) >= 30 },
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
              <div class="doc-card-meta"><span>${r.email}</span><span>Level ${r.level || 1}</span></div>
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
              <div class="doc-card-meta"><span>${s.mutualCount} mutual friend${s.mutualCount !== 1 ? 's' : ''}</span><span>Level ${s.level || 1}</span></div>
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
              <div class="doc-card-meta"><span>${f.email}</span><span>Level ${f.level || 1}</span></div>
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

  openHistoryModal() {
    const docs = this.documents.filter(d => !d.deleted && d.duration > 0);
    const totalWords = docs.reduce((s, d) => s + (d.wordCount || 0), 0);
    const totalSessions = docs.length;
    const totalMinutes = Math.round(docs.reduce((s, d) => s + (d.duration || 0), 0) / 60);
    const dangerousSessions = docs.filter(d => d.mode === 'dangerous').length;

    document.getElementById('history-stats').innerHTML = `
      <div class="history-stat"><div class="history-stat-val">${totalSessions}</div><div class="history-stat-label">Sessions</div></div>
      <div class="history-stat"><div class="history-stat-val">${totalWords.toLocaleString()}</div><div class="history-stat-label">Words</div></div>
      <div class="history-stat"><div class="history-stat-val">${totalMinutes}m</div><div class="history-stat-label">Time Written</div></div>
      <div class="history-stat"><div class="history-stat-val">${dangerousSessions}</div><div class="history-stat-label">Dangerous</div></div>`;

    document.getElementById('history-sessions').innerHTML = docs.length === 0
      ? '<p style="text-align:center;color:var(--text-muted);padding:20px">No sessions yet</p>'
      : docs.slice(0, 30).map(d => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border-light);font-size:13px">
          <div>
            <div style="font-weight:600;color:var(--text-primary)">${this.escapeHtml(d.title)}</div>
            <div style="color:var(--text-muted);font-size:11px;margin-top:2px">${this.formatDate(d.updatedAt)} · ${d.mode === 'dangerous' ? '⚡ Dangerous' : 'Normal'}</div>
          </div>
          <div style="text-align:right">
            <div style="font-weight:600">${(d.wordCount || 0).toLocaleString()} words</div>
            <div style="color:var(--xp-color);font-size:11px">+${d.xpEarned || 0} XP</div>
          </div>
        </div>`).join('');

    document.getElementById('history-modal').classList.add('active');
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

  toast(message, type = '') {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    const el = document.getElementById('toast');
    el.textContent = message;
    el.className = `toast visible ${type}`;
    this.toastTimer = setTimeout(() => {
      el.className = 'toast';
      this.toastTimer = null;
    }, 3000);
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());
