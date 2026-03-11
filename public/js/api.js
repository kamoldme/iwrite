const API = {
  base: '/api',

  getToken() {
    return localStorage.getItem('iwrite_token');
  },

  setToken(token) {
    localStorage.setItem('iwrite_token', token);
  },

  clearToken() {
    localStorage.removeItem('iwrite_token');
  },

  async request(path, options = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const token = this.getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${this.base}${path}`, {
      ...options,
      headers: { ...headers, ...options.headers }
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  },

  async register(name, email, password) {
    const data = await this.request('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name, email, password })
    });
    this.setToken(data.token);
    return data;
  },

  async login(email, password) {
    const data = await this.request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    this.setToken(data.token);
    return data;
  },

  async getMe() {
    return this.request('/auth/me');
  },

  async getDocuments() {
    return this.request('/documents');
  },

  async createDocument(title, content, mode) {
    return this.request('/documents', {
      method: 'POST',
      body: JSON.stringify({ title, content, mode })
    });
  },

  async updateDocument(id, updates) {
    return this.request(`/documents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates)
    });
  },

  async deleteDocument(id) {
    return this.request(`/documents/${id}`, { method: 'DELETE' });
  },

  async completeSession(id, data) {
    return this.request(`/documents/${id}/complete`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  async abandonDocument(id) {
    return this.request(`/documents/${id}/abandon`, { method: 'POST' });
  },

  async shareDocument(id, type) {
    return this.request(`/documents/${id}/share`, {
      method: 'POST',
      body: JSON.stringify({ type })
    });
  },

  async getShared(token) {
    return this.request(`/share/${token}`);
  },

  async addComment(token, author, text) {
    return this.request(`/share/${token}/comment`, {
      method: 'POST',
      body: JSON.stringify({ author, text })
    });
  },

  async getComments(token) {
    return this.request(`/share/${token}/comments`);
  },

  async getFriends() {
    return this.request('/friends');
  },

  async getFriendRequests() {
    return this.request('/friends/requests');
  },

  async getFriendSuggestions() {
    return this.request('/friends/suggestions');
  },

  async sendFriendRequest(email) {
    return this.request('/friends/request', {
      method: 'POST',
      body: JSON.stringify({ email })
    });
  },

  async acceptFriendRequest(fromId) {
    return this.request(`/friends/accept/${fromId}`, { method: 'POST' });
  },

  async rejectFriendRequest(fromId) {
    return this.request(`/friends/reject/${fromId}`, { method: 'POST' });
  },

  async removeFriend(friendId) {
    return this.request(`/friends/${friendId}`, { method: 'DELETE' });
  },

  async sendDuelChallenge(friendId, duration) {
    return this.request('/duels/challenge', {
      method: 'POST',
      body: JSON.stringify({ friendId, duration })
    });
  },

  async getDuels() {
    return this.request('/duels');
  },

  async changePassword(currentPassword, newPassword, confirmPassword) {
    return this.request('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword, confirmPassword })
    });
  },

  async getLeaderboard() {
    return this.request('/leaderboard');
  },

  logout() {
    this.clearToken();
    window.location.href = '/app';
  }
};
