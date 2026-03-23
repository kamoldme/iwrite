(function () {
  if (typeof App === 'undefined') return;

  const esc = (value) => App.escapeHtml ? App.escapeHtml(value || '') : (value || '');

  const STORY_STATUS = {
    draft: { label: 'Draft', tone: 'muted' },
    pending_review: { label: 'Under Review', tone: 'warning' },
    changes_requested: { label: 'Changes Requested', tone: 'warning' },
    rejected: { label: 'Rejected', tone: 'danger' },
    published: { label: 'Published', tone: 'success' },
    hidden: { label: 'Hidden', tone: 'muted' }
  };

  const STORY_FILTER_META = {
    recent: {
      kicker: 'Community Feed',
      title: 'Most Recent',
      description: 'Freshly approved stories from the iWrite community, ordered by publication time.',
      note: 'Tip: publish any finished session from the session card menu or start an untimed article from here.'
    },
    popular: {
      kicker: 'Community Feed',
      title: 'Most Popular',
      description: 'Stories that are earning attention through likes, comments, and recent momentum.',
      note: 'Popular combines likes, comments, and freshness so older hits do not crowd out new voices.'
    },
    drafts: {
      kicker: 'Writer Workspace',
      title: 'My Drafts',
      description: 'Untimed article drafts. Shape session writing into something publishable, then send it for review.',
      note: 'Drafts stay private to you and admins until they are approved.'
    },
    review: {
      kicker: 'Writer Workspace',
      title: 'Under Review',
      description: 'Submitted stories waiting for moderation. You can read them here while the team reviews them.',
      note: 'Admins can approve, hide, reject, or request changes before anything goes live.'
    },
    published: {
      kicker: 'Writer Workspace',
      title: 'My Published',
      description: 'Your approved stories and anything currently hidden by moderation.',
      note: 'Published stories can still be liked and commented on if comments remain open.'
    }
  };

  function formatStoryDate(value) {
    if (!value) return 'Unscheduled';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Unscheduled';
    return date.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    });
  }

  function initialsFor(name) {
    const words = String(name || '').trim().split(/\s+/).filter(Boolean);
    return (words[0]?.[0] || 'I') + (words[1]?.[0] || '');
  }

  Object.assign(App, {
    storyFilter: 'recent',
    storyMode: 'feed',
    storyList: [],
    storyDetail: null,
    storyComments: [],
    storySelectedId: null,
    storyEditingId: null,

    getStoryFilterMeta() {
      return STORY_FILTER_META[this.storyFilter] || STORY_FILTER_META.recent;
    },

    setStoriesMode(mode) {
      this.storyMode = mode;
      const viewEl = document.getElementById('view-stories');
      if (viewEl) {
        viewEl.classList.remove('stories-mode-feed', 'stories-mode-read', 'stories-mode-compose');
        viewEl.classList.add(`stories-mode-${mode}`);
      }
      this.updateStoriesToolbarNote();
    },

    updateStoriesToolbarNote() {
      const noteEl = document.getElementById('stories-toolbar-note');
      if (!noteEl) return;
      const meta = this.getStoryFilterMeta();
      if (this.storyMode === 'compose') {
        noteEl.textContent = 'This editor is untimed. Publish-ready stories go through moderation before they appear in the community feed.';
        return;
      }
      if (this.storyMode === 'read') {
        noteEl.textContent = 'Stories live inside iWrite, but this reading view is intentionally calmer than the session dashboard.';
        return;
      }
      noteEl.textContent = meta.note;
    },

    renderStoryAuthor(story, variant = 'compact') {
      const avatar = story.authorAvatar
        ? `<img src="${esc(story.authorAvatar)}" alt="${esc(story.authorName || 'Writer')}" class="story-author-avatar-img">`
        : `<span class="story-author-avatar-fallback">${esc(initialsFor(story.authorName || 'Writer'))}</span>`;
      const username = story.authorUsername ? `@${esc(story.authorUsername)}` : 'Writer';
      const plan = story.authorPlan === 'premium' ? '<span class="story-author-plan">Pro</span>' : '';

      return `
        <div class="story-author story-author-${variant}">
          <span class="story-author-avatar">${avatar}</span>
          <span class="story-author-copy">
            <strong>${esc(story.authorName || 'Unknown')}</strong>
            <span>${username}${plan}</span>
          </span>
        </div>
      `;
    },

    renderStoryStatus(story) {
      const meta = STORY_STATUS[story.status] || STORY_STATUS.draft;
      return `<span class="story-status-badge ${meta.tone}">${meta.label}</span>`;
    },

    renderStoryFeatured(story) {
      return `
        <article class="story-feature-card" data-story-id="${story.id}">
          <div class="story-feature-main">
            <div class="story-feature-kicker">Featured Story</div>
            <h3>${esc(story.title)}</h3>
            <p class="story-feature-excerpt">${esc(story.excerpt || 'No summary yet.')}</p>
            <div class="story-feature-author-row">
              ${this.renderStoryAuthor(story, 'featured')}
            </div>
          </div>
          <div class="story-feature-side">
            <div class="story-feature-metrics">
              <span>${formatStoryDate(story.publishedAt || story.updatedAt || story.createdAt)}</span>
              <span>${story.readTimeMinutes || 1} min read</span>
              <span>${story.likeCount || 0} likes</span>
              <span>${story.commentCount || 0} comments</span>
            </div>
            <button class="btn btn-primary btn-small story-feature-read-btn" data-story-id="${story.id}">Read Story</button>
          </div>
        </article>
      `;
    },

    renderStoryCard(story) {
      const showStatus = this.storyFilter !== 'recent' && this.storyFilter !== 'popular';
      const showModerationNote = story.moderationNote && story.userId === this.user.id;
      return `
        <article class="story-feed-card" data-story-id="${story.id}">
          <div class="story-feed-card-top">
            <div class="story-feed-badges">
              ${showStatus ? this.renderStoryStatus(story) : '<span class="story-feed-label">Story</span>'}
              ${story.commentsLocked ? '<span class="story-feed-label">Comments closed</span>' : ''}
            </div>
            <span class="story-feed-date">${formatStoryDate(story.publishedAt || story.updatedAt || story.createdAt)}</span>
          </div>
          <h3>${esc(story.title)}</h3>
          <p class="story-feed-excerpt">${esc(story.excerpt || 'No summary yet.')}</p>
          <div class="story-feed-meta">
            ${this.renderStoryAuthor(story)}
            <span>${story.readTimeMinutes || 1} min read</span>
            <span>${story.likeCount || 0} likes</span>
            <span>${story.commentCount || 0} comments</span>
          </div>
          ${showModerationNote ? `<div class="story-feed-note">${esc(story.moderationNote)}</div>` : ''}
        </article>
      `;
    },

    renderStoriesFeed() {
      const feedEl = document.getElementById('stories-feed');
      if (!feedEl) return;

      const meta = this.getStoryFilterMeta();

      if (!this.storyList.length) {
        const copy = this.storyFilter === 'drafts'
          ? { title: 'No drafts yet', sub: 'Start a new story or publish an old session into Stories.' }
          : this.storyFilter === 'review'
          ? { title: 'Nothing under review', sub: 'Submitted stories will wait here while admins moderate them.' }
          : this.storyFilter === 'published'
          ? { title: 'No published stories yet', sub: 'Once a story is approved, it will appear here.' }
          : { title: 'No stories yet', sub: 'Be the first to publish something thoughtful.' };

        feedEl.innerHTML = `
          <div class="stories-feed-shell">
            <div class="stories-feed-lead">
              <div class="stories-feed-copy">
                <span class="stories-kicker">${meta.kicker}</span>
                <h2>${meta.title}</h2>
                <p>${meta.description}</p>
              </div>
            </div>
            <div class="empty-state story-empty-state">
              <h3>${copy.title}</h3>
              <p>${copy.sub}</p>
              <button class="btn btn-primary btn-small" id="stories-empty-create">New Story</button>
            </div>
          </div>
        `;
        const createBtn = document.getElementById('stories-empty-create');
        if (createBtn) createBtn.onclick = () => this.createStoryDraft();
        return;
      }

      const featured = ['recent', 'popular'].includes(this.storyFilter) ? this.storyList[0] : null;
      const cards = featured ? this.storyList.slice(1) : this.storyList;

      feedEl.innerHTML = `
        <div class="stories-feed-shell">
          <section class="stories-feed-lead">
            <div class="stories-feed-copy">
              <span class="stories-kicker">${meta.kicker}</span>
              <h2>${meta.title}</h2>
              <p>${meta.description}</p>
            </div>
            ${featured ? this.renderStoryFeatured(featured) : ''}
          </section>

          <section class="stories-feed-stream">
            <div class="stories-feed-section-head">
              <div>
                <h3>${featured ? 'More Stories' : 'Stories'}</h3>
                <p>${cards.length || this.storyList.length} available in this view</p>
              </div>
              ${['drafts', 'review', 'published'].includes(this.storyFilter) ? '<button class="btn btn-ghost btn-small" id="stories-create-inline">+ New Story</button>' : ''}
            </div>
            <div class="stories-card-list">
              ${(cards.length ? cards : featured ? [featured] : this.storyList).map(story => this.renderStoryCard(story)).join('')}
            </div>
          </section>
        </div>
      `;

      feedEl.querySelectorAll('[data-story-id]').forEach(card => {
        card.addEventListener('click', (event) => {
          const storyId = event.currentTarget.dataset.storyId;
          if (storyId) this.selectStory(storyId);
        });
      });

      const inlineCreateBtn = document.getElementById('stories-create-inline');
      if (inlineCreateBtn) inlineCreateBtn.onclick = () => this.createStoryDraft();
    },

    async loadStories() {
      const feedEl = document.getElementById('stories-feed');
      const detailEl = document.getElementById('story-detail');
      if (feedEl) feedEl.innerHTML = '<div class="empty-state"><div class="spinner" style="margin:8px auto 18px"></div><p>Loading stories...</p></div>';
      if (detailEl && this.storyMode !== 'feed') detailEl.innerHTML = '<div class="empty-state"><p>Loading story…</p></div>';

      try {
        this.storyList = await API.getStories(this.storyFilter);
        this.renderStoriesFeed();

        if (this.storyEditingId) {
          const editingStory = this.storyList.find(story => story.id === this.storyEditingId);
          if (editingStory) {
            await this.selectStory(editingStory.id, { openEditor: true });
            return;
          }
          this.storyEditingId = null;
        }

        if (this.storySelectedId && this.storyMode !== 'feed') {
          const selectedStory = this.storyList.find(story => story.id === this.storySelectedId);
          if (selectedStory) {
            await this.selectStory(selectedStory.id);
            return;
          }
          this.storySelectedId = null;
        }

        this.storyDetail = null;
        this.storyComments = [];
        this.setStoriesMode('feed');
        if (detailEl) detailEl.innerHTML = '';
      } catch (err) {
        if (feedEl) feedEl.innerHTML = `<div class="empty-state"><h3>Stories are unavailable</h3><p>${esc(err.message || 'Failed to load stories.')}</p></div>`;
        if (detailEl) detailEl.innerHTML = '<div class="empty-state"><p>Try refreshing in a moment.</p></div>';
      }
    },

    openStoriesFeed() {
      this.storySelectedId = null;
      this.storyEditingId = null;
      this.storyDetail = null;
      this.storyComments = [];
      this.setStoriesMode('feed');
      this.renderStoriesFeed();
      const detailEl = document.getElementById('story-detail');
      if (detailEl) detailEl.innerHTML = '';
    },

    async selectStory(id, options = {}) {
      this.storySelectedId = id;
      this.storyEditingId = options.openEditor ? id : null;
      this.setStoriesMode(options.openEditor ? 'compose' : 'read');

      const detailEl = document.getElementById('story-detail');
      if (detailEl) detailEl.innerHTML = '<div class="empty-state"><div class="spinner" style="margin:8px auto 18px"></div><p>Loading story…</p></div>';

      try {
        this.storyDetail = await API.getStory(id);
        const includePending = this.storyDetail.userId === this.user.id || this.user.role === 'admin';
        this.storyComments = await API.getStoryComments(id, includePending);
      } catch (err) {
        this.storyDetail = null;
        this.storyComments = [];
        this.setStoriesMode('feed');
        if (detailEl) detailEl.innerHTML = `<div class="empty-state"><h3>Story unavailable</h3><p>${esc(err.message || 'Failed to load story.')}</p></div>`;
        return;
      }

      if (options.openEditor) {
        this.renderStoryComposer();
        return;
      }
      this.renderStoryDetail();
    },

    renderStoryDetail() {
      const detailEl = document.getElementById('story-detail');
      if (!detailEl || !this.storyDetail) return;

      const story = this.storyDetail;
      const pendingComments = this.storyComments.filter(comment => comment.status === 'pending').length;
      const approvedComments = this.storyComments.filter(comment => comment.status === 'approved');
      const ownerOrAdmin = story.userId === this.user.id || this.user.role === 'admin';
      const commentsOpen = story.status === 'published' && story.allowComments !== false && !story.commentsLocked;

      this.setStoriesMode('read');
      detailEl.innerHTML = `
        <div class="story-reader-shell">
          <div class="story-reader-topbar">
            <button class="btn btn-ghost btn-small" id="story-back-feed">Back to Feed</button>
            <div class="story-detail-actions">
              ${story.status === 'published' ? `<button class="btn btn-ghost btn-small" id="story-like-btn">${story.likedByMe ? '&#x2665;' : '&#x2661;'} ${story.likeCount || 0}</button>` : ''}
              ${story.userId === this.user.id && ['draft', 'changes_requested', 'rejected'].includes(story.status) ? '<button class="btn btn-primary btn-small" id="story-edit-btn">Edit Draft</button>' : ''}
              ${story.userId === this.user.id && story.status === 'pending_review' ? '<button class="btn btn-ghost btn-small" disabled>Waiting for Review</button>' : ''}
            </div>
          </div>

          <article class="story-reader-article">
            <div class="story-detail-badges">
              ${this.renderStoryStatus(story)}
              ${story.commentsLocked ? '<span class="story-status-badge muted">Comments locked</span>' : ''}
              ${story.allowComments === false ? '<span class="story-status-badge muted">Comments off</span>' : ''}
            </div>

            <h1 class="story-detail-title">${esc(story.title)}</h1>
            ${story.excerpt ? `<p class="story-detail-dek">${esc(story.excerpt)}</p>` : ''}

            <div class="story-reader-meta-bar">
              ${this.renderStoryAuthor(story, 'featured')}
              <div class="story-reader-meta-pills">
                <span>${formatStoryDate(story.publishedAt || story.updatedAt || story.createdAt)}</span>
                <span>${story.readTimeMinutes || 1} min read</span>
                <span>${story.commentCount || 0} comments</span>
              </div>
            </div>

            ${ownerOrAdmin && story.moderationNote ? `<div class="story-moderation-note"><strong>Moderation note:</strong> ${esc(story.moderationNote)}</div>` : ''}

            <div class="story-detail-content shared-content">${story.content || '<p style="color:var(--text-muted)">No content yet.</p>'}</div>
          </article>

          <section class="story-comments-panel">
            <div class="story-comments-head">
              <div>
                <h3>Comments</h3>
                <p>Readers can react after moderation.</p>
              </div>
              ${pendingComments > 0 && ownerOrAdmin ? `<span class="story-comment-pending-pill">${pendingComments} pending</span>` : ''}
            </div>

            ${commentsOpen ? `
              <div class="story-comment-form">
                <textarea id="story-comment-input" placeholder="Add a thoughtful response..."></textarea>
                <div class="story-comment-form-actions">
                  <span>Comments are moderated before they appear publicly.</span>
                  <button class="btn btn-primary btn-small" id="story-comment-submit">Post Comment</button>
                </div>
              </div>
            ` : `<div class="story-comment-locked">${story.status !== 'published' ? 'Comments open after publication.' : 'Comments are closed for this story.'}</div>`}

            <div class="story-comment-list">
              ${approvedComments.length ? approvedComments.map(comment => `
                <div class="story-comment-card">
                  <div class="story-comment-card-head">
                    <strong>${esc(comment.authorName)}</strong>
                    <span>${formatStoryDate(comment.createdAt)}</span>
                  </div>
                  <p>${esc(comment.text)}</p>
                </div>
              `).join('') : '<div class="empty-state" style="padding:24px 16px"><p>No approved comments yet.</p></div>'}
            </div>
          </section>
        </div>
      `;

      const backBtn = document.getElementById('story-back-feed');
      if (backBtn) backBtn.onclick = () => this.openStoriesFeed();

      const likeBtn = document.getElementById('story-like-btn');
      if (likeBtn) likeBtn.onclick = () => this.toggleStoryLike(story.id);

      const editBtn = document.getElementById('story-edit-btn');
      if (editBtn) editBtn.onclick = () => {
        this.storyEditingId = story.id;
        this.renderStoryComposer();
      };

      const submitCommentBtn = document.getElementById('story-comment-submit');
      if (submitCommentBtn) submitCommentBtn.onclick = () => this.submitStoryComment(story.id);
    },

    renderStoryComposer() {
      const detailEl = document.getElementById('story-detail');
      const story = this.storyDetail;
      if (!detailEl || !story) return;

      this.setStoriesMode('compose');
      detailEl.innerHTML = `
        <div class="story-composer-shell">
          <div class="story-composer-topbar">
            <button class="btn btn-ghost btn-small" id="story-back-feed">Back to Feed</button>
            <div class="story-composer-top-actions">
              <button class="btn btn-ghost btn-small" id="story-preview-draft">Preview</button>
            </div>
          </div>

          <div class="story-composer-card">
            <div class="story-composer-head">
              <div>
                <span class="stories-kicker">${story.sourceDocumentId ? 'Session to Story' : 'Untimed Writing'}</span>
                <h2>${story.sourceDocumentId ? 'Shape this session into a publishable story' : 'Write an article for the community feed'}</h2>
                <p>This editor is untimed, calmer, and built for publishing instead of session pressure.</p>
              </div>
              <label class="story-comments-toggle">
                <input type="checkbox" id="story-comments-toggle" ${story.allowComments !== false ? 'checked' : ''}>
                <span>Allow comments after publish</span>
              </label>
            </div>

            <div class="story-composer-fields">
              <input type="text" id="story-title-input" class="story-title-input" placeholder="Story title" value="${esc(story.title)}">
              <textarea id="story-excerpt-input" class="story-excerpt-input" placeholder="Short summary or dek to pull readers in">${esc(story.excerpt || '')}</textarea>
            </div>

            <div class="story-toolbar" id="story-toolbar">
              <button type="button" data-command="formatBlock" data-value="h1">H1</button>
              <button type="button" data-command="formatBlock" data-value="h2">H2</button>
              <button type="button" data-command="bold">Bold</button>
              <button type="button" data-command="italic">Italic</button>
              <button type="button" data-command="insertUnorderedList">Bullets</button>
              <button type="button" data-command="insertOrderedList">Numbers</button>
              <button type="button" data-command="formatBlock" data-value="blockquote">Quote</button>
              <button type="button" data-command="createLink">Link</button>
              <button type="button" data-command="removeFormat">Clear</button>
            </div>

            <div id="story-editor" class="story-editor" contenteditable="true"></div>

            <div class="story-composer-footer">
              <div class="story-composer-note">
                ${story.sourceDocumentId ? 'This draft was created from one of your sessions. The original session remains untouched.' : 'You can come back later, keep revising, and only submit when it feels ready.'}
              </div>
              <div class="story-composer-actions">
                <button class="btn btn-ghost" id="story-save-draft">Save Draft</button>
                <button class="btn btn-primary" id="story-submit-review">Submit for Review</button>
              </div>
            </div>
          </div>
        </div>
      `;

      const editor = document.getElementById('story-editor');
      editor.innerHTML = story.content || '<p></p>';
      editor.focus();

      document.querySelectorAll('#story-toolbar button').forEach(button => {
        button.addEventListener('click', () => {
          const command = button.dataset.command;
          const value = button.dataset.value || null;
          if (command === 'createLink') {
            const url = window.prompt('Enter the link URL');
            if (url) document.execCommand('createLink', false, url);
            editor.focus();
            return;
          }
          document.execCommand(command, false, value);
          editor.focus();
        });
      });

      const backBtn = document.getElementById('story-back-feed');
      if (backBtn) backBtn.onclick = () => this.openStoriesFeed();

      const previewBtn = document.getElementById('story-preview-draft');
      if (previewBtn) previewBtn.onclick = () => {
        this.storyEditingId = null;
        this.renderStoryDetail();
      };

      document.getElementById('story-save-draft').onclick = () => this.saveStoryDraft(false);
      document.getElementById('story-submit-review').onclick = () => this.saveStoryDraft(true);
    },

    async saveStoryDraft(submitAfterSave) {
      if (!this.storyDetail) return;
      const titleInput = document.getElementById('story-title-input');
      const excerptInput = document.getElementById('story-excerpt-input');
      const editor = document.getElementById('story-editor');
      const commentsToggle = document.getElementById('story-comments-toggle');
      const title = titleInput ? titleInput.value.trim() : this.storyDetail.title;
      const excerpt = excerptInput ? excerptInput.value.trim() : this.storyDetail.excerpt;
      const content = editor ? editor.innerHTML : this.storyDetail.content;
      const allowComments = commentsToggle ? commentsToggle.checked : true;

      try {
        const updated = await API.updateStory(this.storyDetail.id, { title, excerpt, content, allowComments });
        this.storyDetail = updated;
        this.storySelectedId = updated.id;
        this.storyEditingId = updated.id;
        App.toast('Story draft saved', 'success');

        if (submitAfterSave) {
          const submitted = await API.submitStory(updated.id);
          this.storyDetail = submitted;
          this.storyEditingId = null;
          this.storyFilter = 'review';
          this.syncStoryFilters();
          this.storySelectedId = submitted.id;
          App.toast('Story sent for moderation', 'success');
        }

        await this.loadStories();
      } catch (err) {
        App.toast(err.message || 'Failed to save story', 'error');
      }
    },

    async createStoryDraft() {
      try {
        const story = await API.createStory({
          title: 'Untitled Story',
          excerpt: '',
          content: '<p></p>',
          allowComments: true
        });
        this.storyFilter = 'drafts';
        this.syncStoryFilters();
        this.storySelectedId = story.id;
        this.storyEditingId = story.id;
        await this.loadStories();
      } catch (err) {
        App.toast(err.message || 'Failed to create story', 'error');
      }
    },

    async createStoryFromDocument(documentId) {
      try {
        this.storyFilter = 'drafts';
        this.syncStoryFilters();
        this.switchView('stories');
        const story = await API.createStoryFromDocument(documentId);
        this.storySelectedId = story.id;
        this.storyEditingId = story.id;
        await this.loadStories();
        App.toast('Session copied into Stories draft', 'success');
      } catch (err) {
        App.toast(err.message || 'Failed to create story from session', 'error');
      }
    },

    async toggleStoryLike(storyId) {
      try {
        await API.toggleStoryLike(storyId);
        this.storySelectedId = storyId;
        await this.loadStories();
      } catch (err) {
        App.toast(err.message || 'Failed to update like', 'error');
      }
    },

    async submitStoryComment(storyId) {
      const input = document.getElementById('story-comment-input');
      const text = input ? input.value.trim() : '';
      if (!text) return;

      try {
        await API.addStoryComment(storyId, text);
        if (input) input.value = '';
        App.toast('Comment sent for moderation', 'success');
        this.storySelectedId = storyId;
        await this.loadStories();
      } catch (err) {
        App.toast(err.message || 'Failed to add comment', 'error');
      }
    },

    syncStoryFilters() {
      document.querySelectorAll('.stories-filter-btn[data-story-filter]').forEach(button => {
        button.classList.toggle('active', button.dataset.storyFilter === this.storyFilter);
      });
      this.updateStoriesToolbarNote();
    }
  });

  const baseBindAppEvents = App.bindAppEvents.bind(App);
  App.bindAppEvents = function () {
    baseBindAppEvents();

    const newStoryBtn = document.getElementById('new-story-btn');
    if (newStoryBtn) newStoryBtn.addEventListener('click', () => this.createStoryDraft());

    const refreshStoriesBtn = document.getElementById('story-refresh-btn');
    if (refreshStoriesBtn) refreshStoriesBtn.addEventListener('click', () => this.loadStories());

    document.querySelectorAll('.stories-filter-btn[data-story-filter]').forEach(button => {
      button.addEventListener('click', () => {
        this.storyFilter = button.dataset.storyFilter;
        this.storySelectedId = null;
        this.storyEditingId = null;
        this.setStoriesMode('feed');
        this.syncStoryFilters();
        this.loadStories();
      });
    });
  };

  const baseSwitchView = App.switchView.bind(App);
  App.switchView = function (view) {
    baseSwitchView(view);
    if (view === 'stories') {
      this.syncStoryFilters();
      this.loadStories();
    }
  };
})();
