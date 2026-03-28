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

  const STORY_FONT_CLASSES = ['font-serif', 'font-mono', 'font-georgia', 'font-garamond', 'font-courier'];

  const STORY_AUDIO_SOURCES = {
    lofi1: 'https://archive.org/download/chill-lofi-music-relax-study/Leavv%20-%20Cloud%20Shapes.mp3',
    lofi2: 'https://archive.org/download/chill-lofi-music-relax-study/Tom%20Doolie%20-%20Land%20of%20Calm.mp3',
    brown: 'https://archive.org/download/brownnoise_202103/Smoothed%20Brown%20Noise.mp3',
    hz40: 'https://archive.org/download/heightened-awareness-pure-gamma-waves-40-hz-mp-3-160-k/Heightened%20Awareness%20Pure%20Gamma%20Waves%20-%2040%20Hz%28MP3_160K%29.mp3',
    rain: 'https://archive.org/download/relaxingsounds/Rain%207%20%28Lightest%29%208h%20DripsOnTrees-no%20thunder.mp3',
    wind: 'https://archive.org/download/relaxingsounds/Wind%201%208h%20%28or%20Rapids%29%20Gentle%2CLowPitch%2CBrownNoise.mp3'
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

  function renderMetaLine(items) {
    return items.map(item => `<span>${item}</span>`).join('<span class="story-meta-divider">&middot;</span>');
  }

  function renderIcon(icon, options = {}) {
    const filled = !!options.filled;
    if (icon === 'back') {
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>';
    }
    if (icon === 'refresh') {
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.13-3.36L23 10"/><path d="M20.49 15a9 9 0 01-14.13 3.36L1 14"/></svg>';
    }
    if (icon === 'heart') {
      return filled
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54z"/></svg>'
        : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 000-7.78z"/></svg>';
    }
    if (icon === 'comment') {
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>';
    }
    if (icon === 'share') {
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>';
    }
    if (icon === 'view') {
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
    }
    if (icon === 'copy') {
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
    }
    if (icon === 'edit') {
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 113 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
    }
    if (icon === 'audio') {
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
    }
    if (icon === 'fullscreen') {
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
    }
    if (icon === 'delete') {
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>';
    }
    return '';
  }

  Object.assign(App, {
    storyTab: 'feed',
    storySort: 'newest',
    storyMineFilter: 'drafts',
    storyMode: 'feed',
    storyList: [],
    storyDetail: null,
    storyComments: [],
    storySelectedId: null,
    _storyHasMore: false,
    _storyTotal: 0,
    _storyLoadingMore: false,
    _featuredStory: null,
    storyEditingId: null,
    _storyAudioElement: null,
    _storyAudioKey: null,
    _storyAudioOutsideHandler: null,

    setStoriesMode(mode) {
      this.storyMode = mode;
      const viewEl = document.getElementById('view-stories');
      if (viewEl) {
        viewEl.classList.remove('stories-mode-feed', 'stories-mode-read', 'stories-mode-compose');
        viewEl.classList.add(`stories-mode-${mode}`);
      }

      // Swap mobile hamburger → back arrow when inside a story
      const toggle = document.getElementById('mobile-sidebar-toggle');
      if (toggle) {
        if (mode === 'read' || mode === 'compose') {
          toggle.classList.add('story-back-mode');
          toggle.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>';
          toggle._storyBackHandler = (e) => {
            e.stopPropagation();
            this.openStoriesFeed();
          };
          toggle.onclick = toggle._storyBackHandler;
        } else {
          toggle.classList.remove('story-back-mode');
          toggle.innerHTML = '<span></span><span></span><span></span>';
          toggle.onclick = null;
          toggle._storyBackHandler = null;
        }
      }
    },

    syncStoryControls() {
      document.querySelectorAll('.stories-filter-btn[data-story-tab]').forEach(button => {
        button.classList.toggle('active', button.dataset.storyTab === this.storyTab);
      });
      document.querySelectorAll('.stories-filter-btn[data-story-sort]').forEach(button => {
        button.classList.toggle('active', button.dataset.storySort === this.storySort);
      });
      document.querySelectorAll('.stories-filter-btn[data-story-mine-filter]').forEach(button => {
        button.classList.toggle('active', button.dataset.storyMineFilter === this.storyMineFilter);
      });

      const feedSortRow = document.getElementById('stories-feed-sort-row');
      const mineFilterRow = document.getElementById('stories-mine-filter-row');
      if (feedSortRow) feedSortRow.style.display = this.storyTab === 'feed' ? 'flex' : 'none';
      if (mineFilterRow) mineFilterRow.style.display = this.storyTab === 'mine' ? 'flex' : 'none';
    },

    renderStoryStatus(story) {
      const meta = STORY_STATUS[story.status] || STORY_STATUS.draft;
      return `<span class="story-status-badge ${meta.tone}">${meta.label}</span>`;
    },

    renderStoryAuthor(story) {
      const avatar = story.authorAvatar
        ? `<img src="${esc(story.authorAvatar)}?t=${story.authorAvatarUpdatedAt || 0}" alt="${esc(story.authorName || 'Writer')}" class="story-author-avatar-img">`
        : `<span class="story-author-avatar-fallback">${esc(initialsFor(story.authorName || 'Writer'))}</span>`;
      const usernameText = story.authorUsername ? `@${esc(story.authorUsername)}` : 'Writer';
      const usernameHtml = story.authorUsername
        ? `<a href="/app/profile/${encodeURIComponent(story.authorUsername)}" class="username-link" data-username="${esc(story.authorUsername)}" onclick="event.stopPropagation()">${usernameText}</a>`
        : usernameText;
      const plan = story.authorPlan === 'premium'
        ? '<span class="pro-nav-badge">PRO</span>'
        : '';

      return `
        <div class="story-author">
          <span class="story-author-avatar">${avatar}</span>
          <span class="story-author-copy">
            <strong>${esc(story.authorName || 'Unknown')}</strong>
            <span>${usernameHtml}</span>
          </span>
          ${plan}
        </div>
      `;
    },

    renderMetric(icon, count, options = {}) {
      const active = !!options.active;
      const extraClass = options.className || '';
      return `
        <span class="story-metric ${active ? 'active' : ''} ${extraClass}">
          ${renderIcon(icon, { filled: active })}
          <span>${count || 0}</span>
        </span>
      `;
    },

    getMineStories() {
      const mine = this.storyList.filter(story => story.userId === this.user.id);
      if (this.storyMineFilter === 'review') {
        return mine.filter(story => story.status === 'pending_review');
      }
      if (this.storyMineFilter === 'published') {
        return mine.filter(story => ['published', 'hidden'].includes(story.status));
      }
      return mine.filter(story => ['draft', 'changes_requested', 'rejected'].includes(story.status));
    },

    renderFeedStoryCard(story, isHero) {
      const tag = isHero ? 'article class="story-hero-card"' : 'article class="story-feed-item"';
      const closeTag = 'article';
      return `
        <${tag} data-story-id="${story.id}">
          <div class="story-feed-item-head">
            ${this.renderStoryAuthor(story)}
          </div>
          <h3>${esc(story.title)}</h3>
          ${story.excerpt ? `<p class="story-feed-excerpt">${esc(story.excerpt)}</p>` : ''}
          <div class="story-feed-footer">
            ${renderMetaLine([
              formatStoryDate(story.publishedAt || story.updatedAt || story.createdAt),
              `${story.readTimeMinutes || 1} min read`
            ])}
            ${this.renderMetric('heart', story.likeCount, { active: story.likedByMe })}
            ${this.renderMetric('comment', story.commentCount)}
          </div>
        </${closeTag}>
      `;
    },

    renderMyStoryCard(story) {
      const canDelete = story.userId === this.user.id;
      const canEdit = ['draft', 'changes_requested', 'rejected'].includes(story.status);
      const canShare = ['published', 'hidden'].includes(story.status);
      return `
        <div class="doc-card story-doc-card" data-story-id="${story.id}">
          <div class="doc-card-info">
            <div class="doc-icon doc-icon-draft">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
            </div>
            <div class="doc-card-text">
              <h4>${esc(story.title)}</h4>
              <div class="doc-card-meta">
                <span>${story.readTimeMinutes || 1} min read</span>
                <span>${formatStoryDate(story.publishedAt || story.updatedAt || story.createdAt)}</span>
                <span>${story.commentCount || 0} comments</span>
                ${story.likeCount ? `<span>${story.likeCount} likes</span>` : ''}
              </div>
              ${story.moderationNote ? `<div class="story-card-note">${esc(story.moderationNote)}</div>` : ''}
            </div>
          </div>
          <div class="story-card-right">
            ${this.renderStoryStatus(story)}
            <div class="doc-card-actions story-card-actions">
              ${canEdit ? `<button class="doc-action-btn" data-story-action="edit" data-story-id="${story.id}" title="Edit">${renderIcon('edit')}</button>` : `<button class="doc-action-btn" data-story-action="open" data-story-id="${story.id}" title="Open">${renderIcon('view')}</button>`}
              ${canShare ? `<button class="doc-action-btn" data-story-action="share" data-story-id="${story.id}" title="Copy story link">${renderIcon('share')}</button>` : ''}
              ${canDelete ? `<button class="doc-action-btn delete" data-story-action="delete" data-story-id="${story.id}" title="Delete draft">${renderIcon('delete')}</button>` : ''}
            </div>
          </div>
        </div>
      `;
    },

    renderStoriesFeed() {
      const feedEl = document.getElementById('stories-feed');
      if (!feedEl) return;

      const list = this.storyTab === 'feed' ? this.storyList : this.getMineStories();

      if (!list.length) {
        const emptyTitle = this.storyTab === 'feed' ? 'No stories yet' : 'Nothing in this section yet';
        const emptyText = this.storyTab === 'feed'
          ? 'Approved stories appear here.'
          : this.storyMineFilter === 'drafts'
          ? 'Start a new story or publish one of your sessions.'
          : this.storyMineFilter === 'review'
          ? 'Stories waiting for approval appear here.'
          : 'Published stories appear here.';

        feedEl.innerHTML = `
          <div class="empty-state story-empty-state">
            <h3>${emptyTitle}</h3>
            <p>${emptyText}</p>
            <button class="btn btn-primary stories-primary-btn" id="stories-empty-create">+ New Story</button>
          </div>
        `;
        const createBtn = document.getElementById('stories-empty-create');
        if (createBtn) createBtn.onclick = () => this.createStoryDraft();
        return;
      }

      if (this.storyTab === 'feed') {
        // Hero = featured story (admin pick or auto), else most popular recent story
        const feat = this._featuredStory;
        let hero, rest;

        if (feat) {
          hero = list.find(s => s.id === feat.storyId);
          if (!hero) {
            // Featured story not in current page — synthesize a card-compatible object
            hero = {
              id: feat.storyId, title: feat.title, excerpt: feat.excerpt,
              readTimeMinutes: feat.readTimeMinutes, likeCount: feat.likeCount,
              viewCount: feat.viewCount, authorName: feat.authorName,
              authorUsername: feat.authorUsername, authorAvatar: feat.authorAvatar,
              authorAvatarUpdatedAt: feat.authorAvatarUpdatedAt,
              authorPlan: feat.authorPlan, publishedAt: feat.featuredAt
            };
          }
          rest = list.filter(s => s.id !== feat.storyId);
        } else {
          const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
          const recentStories = list.filter(s => {
            const d = new Date(s.publishedAt || s.updatedAt || s.createdAt);
            return d.getTime() >= sevenDaysAgo;
          });
          const heroPool = recentStories.length ? recentStories : list;
          hero = heroPool.reduce((best, s) => (s.popularityScore || 0) > (best.popularityScore || 0) ? s : best, heroPool[0]);
          rest = list.filter(s => s.id !== hero.id);
        }

        const readMoreBtn = this._storyHasMore
          ? `<button id="stories-read-more" class="btn stories-read-more-btn">Read more stories (${this._storyTotal - this.storyList.length} remaining)</button>`
          : '';
        feedEl.innerHTML = `<div class="stories-list">${this.renderFeedStoryCard(hero, true)}${rest.map(s => this.renderFeedStoryCard(s, false)).join('')}</div>${readMoreBtn}`;
      } else {
        feedEl.innerHTML = `<div class="stories-mine-list">${list.map(story => this.renderMyStoryCard(story)).join('')}</div>`;
      }

      feedEl.querySelectorAll('.story-feed-item[data-story-id], .story-hero-card[data-story-id], .story-doc-card[data-story-id]').forEach(card => {
        card.addEventListener('click', (event) => {
          const actionButton = event.target.closest('[data-story-action]');
          if (actionButton) return;
          const storyId = card.dataset.storyId;
          if (storyId) this.selectStory(storyId);
        });
      });

      feedEl.querySelectorAll('[data-story-action]').forEach(button => {
        button.addEventListener('click', async (event) => {
          event.stopPropagation();
          const storyId = button.dataset.storyId;
          const action = button.dataset.storyAction;
          if (!storyId || !action) return;
          if (action === 'edit') {
            await this.selectStory(storyId, { openEditor: true });
            return;
          }
          if (action === 'open') {
            await this.selectStory(storyId);
            return;
          }
          if (action === 'share') {
            await this.copyStoryLink({ id: storyId });
            return;
          }
          if (action === 'delete') {
            await this.deleteStoryDraft(storyId);
          }
        });
      });

      // (Featured story is now rendered as the hero card — no separate click handler needed)

      // Read more button
      const readMoreBtn = document.getElementById('stories-read-more');
      if (readMoreBtn) {
        readMoreBtn.addEventListener('click', () => this.loadMoreStories());
      }
    },

    async loadStories() {
      const feedEl = document.getElementById('stories-feed');
      if (feedEl) {
        const skeletonCard = `<div class="story-skeleton-card"><div class="story-skeleton-line skeleton-author"></div><div class="story-skeleton-line skeleton-title"></div><div class="story-skeleton-line skeleton-excerpt"></div><div class="story-skeleton-line skeleton-excerpt-short"></div><div class="story-skeleton-line skeleton-meta"></div></div>`;
        feedEl.innerHTML = `<div class="story-skeleton-list">${skeletonCard}${skeletonCard}${skeletonCard}</div>`;
      }

      try {
        // Fetch featured story for feed tab
        if (this.storyTab === 'feed') {
          try { this._featuredStory = (await API.getFeaturedStory()).featured; } catch (_) { this._featuredStory = null; }
        }

        const isFeed = this.storyTab === 'feed';
        const result = await API.getStories(this.storyTab, this.storySort, isFeed ? { limit: 8, offset: 0 } : {});

        // Handle both paginated { stories, total, hasMore } and legacy array
        if (Array.isArray(result)) {
          this.storyList = result;
          this._storyHasMore = false;
          this._storyTotal = result.length;
        } else {
          this.storyList = result.stories;
          this._storyHasMore = result.hasMore;
          this._storyTotal = result.total;
        }

        this.renderStoriesFeed();
        if (this.storyMode === 'feed') {
          const detailEl = document.getElementById('story-detail');
          if (detailEl) detailEl.innerHTML = '';
        }
      } catch (err) {
        if (feedEl) {
          feedEl.innerHTML = `<div class="empty-state"><h3>Stories are unavailable</h3><p>${esc(err.message || 'Failed to load stories.')}</p></div>`;
        }
      }
    },

    async loadMoreStories() {
      if (this._storyLoadingMore || !this._storyHasMore) return;
      this._storyLoadingMore = true;

      const btn = document.getElementById('stories-read-more');
      if (btn) btn.innerHTML = '<div class="spinner" style="width:16px;height:16px;margin:0 auto"></div>';

      try {
        const result = await API.getStories(this.storyTab, this.storySort, { limit: 5, offset: this.storyList.length });
        const newStories = Array.isArray(result) ? result : result.stories;
        this._storyHasMore = Array.isArray(result) ? false : result.hasMore;
        this._storyTotal = Array.isArray(result) ? this.storyList.length + newStories.length : result.total;

        this.storyList = this.storyList.concat(newStories);
        this.renderStoriesFeed();
      } catch (err) {
        if (btn) btn.textContent = 'Failed to load. Try again';
      } finally {
        this._storyLoadingMore = false;
      }
    },

    openStoriesFeed() {
      this.cleanupFloatingToolbar();
      this.storySelectedId = null;
      this.storyEditingId = null;
      this.storyDetail = null;
      this.storyComments = [];
      this.stopStoryAudio();
      this.closeStoryAudioDropdown();
      this.setStoriesMode('feed');
      const detailEl = document.getElementById('story-detail');
      if (detailEl) detailEl.innerHTML = '';
      this.renderStoriesFeed();
    },

    async selectStory(id, options = {}) {
      const detailEl = document.getElementById('story-detail');
      this.storySelectedId = id;
      this.storyEditingId = options.openEditor ? id : null;
      this.setStoriesMode(options.openEditor ? 'compose' : 'read');

      if (detailEl) {
        detailEl.innerHTML = '<div class="empty-state"><div class="spinner" style="margin:8px auto 18px"></div><p>Loading story...</p></div>';
      }

      try {
        this.storyDetail = await API.getStory(id);
        this.storyComments = await API.getStoryComments(id);
      } catch (err) {
        this.storyDetail = null;
        this.storyComments = [];
        this.setStoriesMode('feed');
        if (detailEl) {
          detailEl.innerHTML = `<div class="empty-state"><h3>Story unavailable</h3><p>${esc(err.message || 'Failed to load story.')}</p></div>`;
        }
        return;
      }

      if (options.openEditor) {
        this.renderStoryComposer();
      } else {
        this.renderStoryDetail();
      }
    },

    renderStoryComment(comment, options = {}) {
      const depth = comment.depth || 0;
      const maxDepth = 3;
      const canReply = options.commentsOpen && depth < maxDepth;
      const canDelete = options.ownerOrAdmin || comment.userId === this.user.id;
      const deleteButton = canDelete
        ? `<button class="story-comment-delete" data-story-comment-delete="${comment.id}">Delete</button>`
        : '';

      const replyingTo = comment.parentCommentId && comment._parentAuthor
        ? `<span class="comment-replying-to">↳ Replying to @${esc(comment._parentAuthor)}</span>`
        : '';

      const replies = (comment.replies || []).map(reply => {
        reply._parentAuthor = comment.authorUsername || comment.authorName;
        return this.renderStoryComment(reply, options);
      }).join('');

      const hasReplies = (comment.replies || []).length > 0;
      const replyCount = this._countReplies(comment);

      return `
        <div class="story-comment-thread${depth > 0 ? ' story-comment-nested' : ''}" data-comment-id="${comment.id}" data-depth="${depth}">
          <div class="story-comment-card">
            ${replyingTo}
            <div class="story-comment-card-head">
              <div class="story-comment-author-wrap">
                <strong>${esc(comment.authorName || 'Unknown')}</strong>
                ${comment.authorUsername ? `<a href="/app/profile/${encodeURIComponent(comment.authorUsername)}" class="username-link" data-username="${esc(comment.authorUsername)}" onclick="event.stopPropagation()">@${esc(comment.authorUsername)}</a>` : ''}
              </div>
              <div class="story-comment-meta">
                <span>${formatStoryDate(comment.createdAt)}</span>
                ${deleteButton}
              </div>
            </div>
            <p>${esc(comment.text)}</p>
            <div class="story-comment-action-row">
              <button class="comment-like-btn${comment.likedByMe ? ' liked' : ''}" data-comment-like="${comment.id}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="${comment.likedByMe ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                ${comment.likeCount ? `<span>${comment.likeCount}</span>` : ''}
              </button>
              ${canReply ? `<button class="comment-reply-btn" data-comment-reply="${comment.id}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                Reply
              </button>` : ''}
            </div>
          </div>
          <div class="comment-reply-form-slot" id="reply-form-${comment.id}"></div>
          ${hasReplies ? `
            <div class="comment-thread-controls">
              <button class="comment-collapse-btn" data-collapse-thread="${comment.id}" aria-expanded="true" title="Collapse thread">
                <span class="collapse-icon">−</span> ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}
              </button>
            </div>
            <div class="comment-replies" id="replies-${comment.id}">
              ${replies}
            </div>
            <div class="comment-collapsed-indicator" id="collapsed-${comment.id}" style="display:none">
              <button class="comment-expand-btn" data-expand-thread="${comment.id}">[+] ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}</button>
            </div>
          ` : `<div class="comment-replies" id="replies-${comment.id}"></div>`}
        </div>
      `;
    },

    _countReplies(comment) {
      let count = (comment.replies || []).length;
      for (const r of (comment.replies || [])) {
        count += this._countReplies(r);
      }
      return count;
    },

    async copyStoryLink(story) {
      const url = `${window.location.origin}/story/${story.id}`;
      try {
        await navigator.clipboard.writeText(url);
        App.toast('Story link copied', 'success');
      } catch {
        App.toast('Failed to copy link', 'error');
      }
    },

    scrollToStoryComments() {
      const commentsEl = document.getElementById('story-comments-anchor');
      if (commentsEl) commentsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },

    renderStoryDetail() {
      const detailEl = document.getElementById('story-detail');
      const story = this.storyDetail;
      if (!detailEl || !story) return;

      const ownerOrAdmin = story.userId === this.user.id || this.user.role === 'admin';
      const commentsOpen = story.status === 'published' && story.allowComments !== false && !story.commentsLocked;
      const canEdit = story.userId === this.user.id && ['draft', 'changes_requested', 'rejected'].includes(story.status);

      this.stopStoryAudio();
      this.closeStoryAudioDropdown();
      this.setStoriesMode('read');

      detailEl.innerHTML = `
        <div class="story-reader-shell">
          <div class="story-reader-topbar">
            <button class="stories-icon-btn stories-back-btn" id="story-back-feed" title="Back" aria-label="Back">${renderIcon('back')}</button>
            <div class="story-detail-top-actions">
              ${canEdit ? '<button class="stories-inline-btn" id="story-edit-btn">Edit</button>' : ''}
            </div>
          </div>

          <article class="story-reader-article">
            ${story.status !== 'published' ? `<div class="story-detail-status-row">${this.renderStoryStatus(story)}</div>` : ''}
            <h1 class="story-detail-title">${esc(story.title)}</h1>

            <div class="story-reader-author-row">
              ${this.renderStoryAuthor(story)}
              <div class="story-reader-author-meta">
                ${renderMetaLine([
                  `${story.readTimeMinutes || 1} min read`,
                  formatStoryDate(story.publishedAt || story.updatedAt || story.createdAt)
                ])}
              </div>
            </div>

            ${story.status === 'published' ? `<div class="story-reader-action-row">
              <button class="story-action-btn ${story.likedByMe ? 'liked' : ''}" id="story-like-btn">${renderIcon('heart', { filled: story.likedByMe })}<span>${story.likeCount || 0}</span></button>
              <button class="story-action-btn" id="story-comments-btn">${renderIcon('comment')}<span>${story.commentCount || 0}</span></button>
              <button class="story-action-btn" id="story-share-btn">${renderIcon('share')}<span>Share Link</span></button>
              ${ownerOrAdmin ? `<button class="story-comment-switch ${commentsOpen ? 'active' : ''}" id="story-toggle-comments-btn">${renderIcon('comment')}<span>${commentsOpen ? 'Comments On' : 'Comments Off'}</span></button>` : ''}
            </div>` : ''}

            ${ownerOrAdmin && story.moderationNote ? `<div class="story-card-note story-reader-note">${esc(story.moderationNote)}</div>` : ''}
            <div class="story-detail-content shared-content">${story.content || '<p style="color:var(--text-muted)">No content yet.</p>'}</div>
          </article>

          ${story.status === 'published' ? `<div class="story-bottom-action-bar">
            <button class="story-action-btn ${story.likedByMe ? 'liked' : ''}" id="story-bottom-like-btn">${renderIcon('heart', { filled: story.likedByMe })}<span>${story.likeCount || 0}</span></button>
            <button class="story-action-btn" id="story-bottom-comments-btn">${renderIcon('comment')}<span>${story.commentCount || 0}</span></button>
            <button class="story-action-btn" id="story-bottom-share-btn">${renderIcon('share')}<span>Share Link</span></button>
          </div>` : ''}

          <section class="story-comments-panel" id="story-comments-anchor">
            <div class="story-comments-head">
              <h3>Comments</h3>
              <span>${story.commentCount || 0}</span>
            </div>

            ${commentsOpen ? `
              <div class="story-comment-form">
                <textarea id="story-comment-input" placeholder="Add a response..."></textarea>
                <div class="story-comment-form-actions">
                  <button class="btn btn-primary stories-submit-btn" id="story-comment-submit">Post Comment</button>
                </div>
              </div>
            ` : `<div class="story-comment-locked">${story.status === 'published' ? 'Comments are turned off for this story.' : 'Comments open after publication.'}</div>`}

            <div class="story-comment-list">
              ${this.storyComments.length
                ? this.storyComments.map(comment => this.renderStoryComment(comment, {
                    commentsOpen: commentsOpen,
                    ownerOrAdmin
                  })).join('')
                : '<div class="story-empty-inline">No comments yet. Be the first to share your thoughts.</div>'}
            </div>
          </section>
        </div>
      `;

      const backBtn = document.getElementById('story-back-feed');
      if (backBtn) backBtn.onclick = () => this.openStoriesFeed();

      const editBtn = document.getElementById('story-edit-btn');
      if (editBtn) editBtn.onclick = () => this.selectStory(story.id, { openEditor: true });

      const likeBtn = document.getElementById('story-like-btn');
      if (likeBtn) likeBtn.onclick = () => this.toggleStoryLike(story.id);

      const commentsBtn = document.getElementById('story-comments-btn');
      if (commentsBtn) commentsBtn.onclick = () => this.scrollToStoryComments();

      const shareBtn = document.getElementById('story-share-btn');
      if (shareBtn) shareBtn.onclick = () => this.copyStoryLink(story);

      const toggleCommentsBtn = document.getElementById('story-toggle-comments-btn');
      if (toggleCommentsBtn) toggleCommentsBtn.onclick = () => this.toggleStoryCommentsSetting(story.id, !commentsOpen);

      const submitCommentBtn = document.getElementById('story-comment-submit');
      if (submitCommentBtn) submitCommentBtn.onclick = () => this.submitStoryComment(story.id);

      const bottomLikeBtn = document.getElementById('story-bottom-like-btn');
      if (bottomLikeBtn) bottomLikeBtn.onclick = () => this.toggleStoryLike(story.id);
      const bottomCommentsBtn = document.getElementById('story-bottom-comments-btn');
      if (bottomCommentsBtn) bottomCommentsBtn.onclick = () => this.scrollToStoryComments();
      const bottomShareBtn = document.getElementById('story-bottom-share-btn');
      if (bottomShareBtn) bottomShareBtn.onclick = () => this.copyStoryLink(story);

      detailEl.querySelectorAll('[data-story-comment-delete]').forEach(button => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          const commentId = button.dataset.storyCommentDelete;
          if (commentId) this.deleteStoryComment(story.id, commentId);
        });
      });

      // Comment likes
      detailEl.querySelectorAll('[data-comment-like]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggleCommentLike(story.id, btn.dataset.commentLike, btn);
        });
      });

      // Reply buttons
      detailEl.querySelectorAll('[data-comment-reply]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.openReplyForm(story.id, btn.dataset.commentReply);
        });
      });

      // Collapse thread
      detailEl.querySelectorAll('[data-collapse-thread]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.collapseThread(btn.dataset.collapseThread);
        });
      });

      // Expand thread
      detailEl.querySelectorAll('[data-expand-thread]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.expandThread(btn.dataset.expandThread);
        });
      });
    },

    buildStoryAudioDropdown() {
      const tracks = [
        ['lofi1', 'Lofi Chill'],
        ['lofi2', 'Lofi Study'],
        ['brown', 'Brown Noise'],
        ['hz40', '40Hz Gamma'],
        ['rain', 'Rain'],
        ['wind', 'Wind']
      ];

      return `
        <div class="story-audio-dropdown" id="story-audio-dropdown" style="display:none">
          ${tracks.map(([key, label]) => `
            <div class="story-audio-track" data-audio="${key}">
              <button class="audio-play-btn" type="button" data-story-audio-play="${key}" title="Play">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
              </button>
              <span class="story-audio-track-name">${label}</span>
              <input type="range" class="audio-track-vol" data-story-audio-vol="${key}" min="0" max="100" value="50" title="Volume">
            </div>
          `).join('')}
        </div>
      `;
    },

    updateComposerCommentsToggle() {
      const input = document.getElementById('story-comments-toggle');
      const button = document.getElementById('story-comments-toggle-btn');
      if (!input || !button) return;
      button.classList.toggle('active', input.checked);
      button.querySelector('.story-comment-switch-label').textContent = input.checked ? 'Comments On' : 'Comments Off';
    },

    applyStoryEditorFont(font) {
      const editor = document.getElementById('story-editor');
      if (!editor) return;
      STORY_FONT_CLASSES.forEach(className => editor.classList.remove(className));
      if (font && font !== 'sans') editor.classList.add(`font-${font}`);
      localStorage.setItem('iwrite_editor_font', font || 'sans');
    },

    bindStoryAudioControls() {
      const audioBtn = document.getElementById('story-audio-btn');
      const audioDrop = document.getElementById('story-audio-dropdown');
      if (!audioBtn || !audioDrop) return;

      audioBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        audioDrop.style.display = audioDrop.style.display === 'none' ? 'block' : 'none';
      });

      audioDrop.addEventListener('click', (event) => event.stopPropagation());

      if (this._storyAudioOutsideHandler) {
        document.removeEventListener('click', this._storyAudioOutsideHandler);
      }
      this._storyAudioOutsideHandler = () => this.closeStoryAudioDropdown();
      document.addEventListener('click', this._storyAudioOutsideHandler);

      audioDrop.querySelectorAll('[data-story-audio-play]').forEach(button => {
        button.addEventListener('click', () => this.playStoryAudio(button.dataset.storyAudioPlay));
      });

      audioDrop.querySelectorAll('[data-story-audio-vol]').forEach(input => {
        input.addEventListener('input', () => {
          if (this._storyAudioKey === input.dataset.storyAudioVol && this._storyAudioElement) {
            this._storyAudioElement.volume = Number(input.value || 50) / 100;
          }
        });
      });
    },

    playStoryAudio(key) {
      if (this._storyAudioKey === key && this._storyAudioElement) {
        if (this._storyAudioElement.paused) {
          this._storyAudioElement.play().catch(() => {});
        } else {
          this._storyAudioElement.pause();
        }
        this.updateStoryAudioUI();
        return;
      }

      this.stopStoryAudio();

      const src = STORY_AUDIO_SOURCES[key];
      if (!src) return;
      const volumeInput = document.querySelector(`[data-story-audio-vol="${key}"]`);
      this._storyAudioElement = new Audio(src);
      this._storyAudioElement.loop = true;
      this._storyAudioElement.crossOrigin = 'anonymous';
      this._storyAudioElement.volume = Number(volumeInput?.value || 50) / 100;
      this._storyAudioKey = key;
      this._storyAudioElement.play().catch(() => {});
      this.updateStoryAudioUI();
    },

    stopStoryAudio() {
      if (this._storyAudioElement) {
        this._storyAudioElement.pause();
        this._storyAudioElement.currentTime = 0;
        this._storyAudioElement = null;
      }
      this._storyAudioKey = null;
      this.updateStoryAudioUI();
    },

    updateStoryAudioUI() {
      document.querySelectorAll('.story-audio-track').forEach(track => {
        track.classList.toggle('active', track.dataset.audio === this._storyAudioKey && !!this._storyAudioElement && !this._storyAudioElement.paused);
      });
    },

    closeStoryAudioDropdown() {
      const audioDrop = document.getElementById('story-audio-dropdown');
      if (audioDrop) audioDrop.style.display = 'none';
      if (this._storyAudioOutsideHandler) {
        document.removeEventListener('click', this._storyAudioOutsideHandler);
        this._storyAudioOutsideHandler = null;
      }
    },

    cleanupFloatingToolbar() {
      if (this._floatToolbarCleanup) {
        this._floatToolbarCleanup();
        this._floatToolbarCleanup = null;
      }
      if (this._floatDropdownHandler) {
        document.removeEventListener('mousedown', this._floatDropdownHandler);
        this._floatDropdownHandler = null;
      }
    },

    renderStoryComposer() {
      const detailEl = document.getElementById('story-detail');
      const story = this.storyDetail;
      if (!detailEl || !story) return;

      this.cleanupFloatingToolbar();
      this.closeStoryAudioDropdown();
      this.setStoriesMode('compose');
      detailEl.innerHTML = `
        <div class="story-composer-shell">
          <div class="story-composer-topbar">
            <button class="stories-icon-btn stories-back-btn" id="story-back-feed" title="Back" aria-label="Back">${renderIcon('back')}</button>
            <div class="story-composer-top-actions">
              <input type="checkbox" id="story-comments-toggle" ${story.allowComments !== false ? 'checked' : ''} hidden>
              <button class="story-comment-switch ${story.allowComments !== false ? 'active' : ''}" id="story-comments-toggle-btn" type="button">
                ${renderIcon('comment')}
                <span class="story-comment-switch-label">${story.allowComments !== false ? 'Comments On' : 'Comments Off'}</span>
              </button>
              <button class="doc-action-btn" id="story-fullscreen-btn" title="Toggle fullscreen" type="button">${renderIcon('fullscreen')}</button>
              <div class="story-audio-wrap">
                <button class="doc-action-btn" id="story-audio-btn" title="Background audio" type="button">${renderIcon('audio')}</button>
                ${this.buildStoryAudioDropdown()}
              </div>
              <button class="doc-action-btn" id="story-copy-btn" title="Copy story" type="button">${renderIcon('copy')}</button>
            </div>
          </div>

          <div id="story-float-toolbar" class="story-float-toolbar">
            <button type="button" data-float-cmd="bold"><strong>B</strong></button>
            <button type="button" data-float-cmd="italic"><em>I</em></button>
            <span class="float-separator"></span>
            <button type="button" data-float-cmd="createLink" id="float-link-btn">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
            </button>
            <div class="story-float-link-input" id="float-link-input-wrap">
              <input type="text" id="float-link-url" placeholder="Paste URL...">
              <button type="button" id="float-link-apply">✓</button>
              <button type="button" id="float-link-cancel">✕</button>
            </div>
            <span class="float-separator"></span>
            <div class="story-format-dropdown-wrap">
              <button type="button" class="story-format-dropdown-btn" id="float-format-toggle">
                <span id="float-format-label">Normal</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
              <div class="story-format-dropdown" id="float-format-dropdown">
                <button type="button" data-float-block="p">Normal text</button>
                <button type="button" data-float-block="h1">Heading 1</button>
                <button type="button" data-float-block="h2">Heading 2</button>
                <button type="button" data-float-block="h3">Heading 3</button>
                <button type="button" data-float-block="h4">Subheader</button>
                <button type="button" data-float-block="blockquote">Blockquote</button>
                <button type="button" data-float-block="ul">Bulleted list</button>
                <button type="button" data-float-block="ol">Numbered list</button>
              </div>
            </div>
          </div>

          <div class="story-compose-canvas">
            <input type="text" id="story-title-input" class="story-title-input story-title-input-plain" placeholder="Give your story a title..." value="${esc(story.title)}">
            <div id="story-editor" class="story-editor" contenteditable="true"></div>
          </div>

          <div class="story-composer-footer">
            <button class="btn btn-ghost stories-save-btn" id="story-save-draft">Save Draft</button>
            <button class="btn btn-primary stories-submit-btn" id="story-submit-review">Submit for Review</button>
          </div>
        </div>
      `;

      const editor = document.getElementById('story-editor');
      editor.innerHTML = story.content || '<p></p>';
      editor.focus();

      this.initFloatingToolbar(editor);

      const backBtn = document.getElementById('story-back-feed');
      if (backBtn) backBtn.onclick = () => this.openStoriesFeed();

      const toggleBtn = document.getElementById('story-comments-toggle-btn');
      const toggleInput = document.getElementById('story-comments-toggle');
      if (toggleBtn && toggleInput) {
        toggleBtn.onclick = () => {
          toggleInput.checked = !toggleInput.checked;
          this.updateComposerCommentsToggle();
        };
        this.updateComposerCommentsToggle();
      }

      const fullscreenBtn = document.getElementById('story-fullscreen-btn');
      if (fullscreenBtn) fullscreenBtn.onclick = () => {
        if (typeof Editor !== 'undefined' && Editor.toggleFullscreen) Editor.toggleFullscreen();
      };

      const copyBtn = document.getElementById('story-copy-btn');
      if (copyBtn) {
        copyBtn.onclick = async () => {
          try {
            if (typeof App._doCopy === 'function') {
              await App._doCopy(editor);
            } else {
              await navigator.clipboard.writeText(editor.innerText);
            }
            App.toast('Copied to clipboard!', 'success');
          } catch {
            App.toast('Copy failed', 'error');
          }
        };
      }

      this.bindStoryAudioControls();

      document.getElementById('story-save-draft').onclick = () => this.saveStoryDraft(false);
      document.getElementById('story-submit-review').onclick = () => this.saveStoryDraft(true);
    },

    initFloatingToolbar(editor) {
      const toolbar = document.getElementById('story-float-toolbar');
      if (!toolbar) return;

      let savedRange = null;
      let debounceTimer = null;

      const positionToolbar = () => {
        if (!editor.isConnected) {
          toolbar.classList.remove('visible');
          return;
        }
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) {
          toolbar.classList.remove('visible');
          return;
        }
        const range = sel.getRangeAt(0);
        if (!editor.contains(range.commonAncestorContainer)) {
          toolbar.classList.remove('visible');
          return;
        }
        const rect = range.getBoundingClientRect();
        const editorRect = editor.closest('.story-composer-shell').getBoundingClientRect();
        let top = rect.top - editorRect.top - toolbar.offsetHeight - 8;
        if (top < 0) top = rect.bottom - editorRect.top + 8;
        const left = rect.left - editorRect.left + (rect.width / 2) - (toolbar.offsetWidth / 2);
        toolbar.style.top = `${top}px`;
        toolbar.style.left = `${Math.max(0, left)}px`;
        toolbar.classList.add('visible');
      };

      const onSelectionChange = () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(positionToolbar, 100);
      };

      document.addEventListener('selectionchange', onSelectionChange);
      this._floatToolbarCleanup = () => document.removeEventListener('selectionchange', onSelectionChange);

      // Bold & Italic
      toolbar.querySelectorAll('[data-float-cmd]').forEach(btn => {
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const cmd = btn.dataset.floatCmd;
          if (cmd === 'createLink') {
            const sel = window.getSelection();
            if (sel.rangeCount) savedRange = sel.getRangeAt(0).cloneRange();
            document.getElementById('float-link-input-wrap').classList.add('visible');
            document.getElementById('float-link-url').focus();
            return;
          }
          document.execCommand(cmd, false, null);
          editor.focus();
        });
      });

      // Link input
      const linkApply = document.getElementById('float-link-apply');
      const linkCancel = document.getElementById('float-link-cancel');
      const linkUrl = document.getElementById('float-link-url');
      const linkWrap = document.getElementById('float-link-input-wrap');

      const applyLink = () => {
        const url = linkUrl.value.trim();
        if (url && savedRange) {
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(savedRange);
          document.execCommand('createLink', false, url);
        }
        linkUrl.value = '';
        linkWrap.classList.remove('visible');
        savedRange = null;
        editor.focus();
      };

      linkApply.addEventListener('mousedown', (e) => { e.preventDefault(); applyLink(); });
      linkUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyLink(); } });
      linkCancel.addEventListener('mousedown', (e) => {
        e.preventDefault();
        linkUrl.value = '';
        linkWrap.classList.remove('visible');
        savedRange = null;
        editor.focus();
      });

      // Format dropdown
      const formatToggle = document.getElementById('float-format-toggle');
      const formatDropdown = document.getElementById('float-format-dropdown');
      const formatLabel = document.getElementById('float-format-label');

      formatToggle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        formatDropdown.classList.toggle('open');
      });

      const blockLabels = { p: 'Normal', h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', h4: 'Subheader', blockquote: 'Quote', ul: 'Bullets', ol: 'Numbers' };

      formatDropdown.querySelectorAll('[data-float-block]').forEach(btn => {
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const block = btn.dataset.floatBlock;
          if (block === 'ul') {
            document.execCommand('insertUnorderedList', false, null);
          } else if (block === 'ol') {
            document.execCommand('insertOrderedList', false, null);
          } else {
            document.execCommand('formatBlock', false, `<${block}>`);
          }
          formatLabel.textContent = blockLabels[block] || 'Normal';
          formatDropdown.classList.remove('open');
          editor.focus();
        });
      });

      // Close dropdown on outside click (stored for cleanup)
      this._floatDropdownHandler = (e) => {
        if (!formatDropdown.contains(e.target) && !formatToggle.contains(e.target)) {
          formatDropdown.classList.remove('open');
        }
      };
      document.addEventListener('mousedown', this._floatDropdownHandler);
    },

    async saveStoryDraft(submitAfterSave) {
      if (!this.storyDetail) return;
      const titleInput = document.getElementById('story-title-input');
      const editor = document.getElementById('story-editor');
      const commentsToggle = document.getElementById('story-comments-toggle');
      const title = titleInput ? titleInput.value.trim() : this.storyDetail.title;
      const content = editor ? editor.innerHTML : this.storyDetail.content;
      const allowComments = commentsToggle ? commentsToggle.checked : true;

      if (!title) {
        if (titleInput) {
          titleInput.focus();
          titleInput.classList.add('shake');
          setTimeout(() => titleInput.classList.remove('shake'), 500);
        }
        App.toast('Please add a title to your story', 'error');
        return;
      }

      try {
        const updated = await API.updateStory(this.storyDetail.id, { title, content, allowComments });
        this.storyDetail = updated;
        App.toast('Story draft saved', 'success');

        if (submitAfterSave) {
          const submitted = await API.submitStory(updated.id);
          this.storyTab = 'mine';
          this.storyMineFilter = 'review';
          this.syncStoryControls();
          await this.loadStories();
          await this.selectStory(submitted.id);
          App.toast('Story sent for approval', 'success');
          return;
        }

        await this.loadStories();
        await this.selectStory(updated.id, { openEditor: true });
      } catch (err) {
        App.toast(err.message || 'Failed to save story', 'error');
      }
    },

    async createStoryDraft() {
      try {
        const story = await API.createStory({
          title: '',
          content: '<p></p>',
          allowComments: true
        });
        this.storyTab = 'mine';
        this.storyMineFilter = 'drafts';
        this.syncStoryControls();
        await this.loadStories();
        await this.selectStory(story.id, { openEditor: true });
      } catch (err) {
        App.toast(err.message || 'Failed to create story', 'error');
      }
    },

    async createStoryFromDocument(documentId) {
      try {
        this.storyTab = 'mine';
        this.storyMineFilter = 'drafts';
        this.syncStoryControls();
        this.switchView('stories');
        const story = await API.createStoryFromDocument(documentId);
        await this.loadStories();
        await this.selectStory(story.id, { openEditor: true });
        App.toast('Session copied into Stories', 'success');
      } catch (err) {
        App.toast(err.message || 'Failed to create story from session', 'error');
      }
    },

    showStoryDeleteConfirm(story) {
      return new Promise((resolve) => {
        const overlay = document.getElementById('confirm-overlay');
        const dialog = overlay.querySelector('.confirm-dialog');
        const isDraft = ['draft', 'changes_requested', 'rejected'].includes(story.status);

        if (isDraft) {
          document.getElementById('confirm-message').textContent = 'Delete this draft?';
          overlay.classList.add('active');
          document.getElementById('confirm-ok').onclick = () => { overlay.classList.remove('active'); resolve(true); };
          document.getElementById('confirm-cancel').onclick = () => { overlay.classList.remove('active'); resolve(false); };
          return;
        }

        const title = story.title || 'Untitled';
        dialog.innerHTML = `
          <p class="confirm-message" style="margin-bottom:12px">To permanently delete <strong>"${esc(title)}"</strong>, type the full title below, then type <strong>delete</strong> to confirm.</p>
          <input type="text" id="delete-title-input" placeholder="Type story title..." style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:transparent;color:var(--text-primary);font:inherit;font-size:13px;margin-bottom:8px;box-sizing:border-box">
          <input type="text" id="delete-confirm-input" placeholder='Type "delete" to confirm' style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:transparent;color:var(--text-primary);font:inherit;font-size:13px;margin-bottom:14px;box-sizing:border-box">
          <div class="confirm-actions">
            <button class="btn btn-ghost btn-small" id="confirm-cancel">Cancel</button>
            <button class="btn btn-small" id="confirm-ok" style="background:var(--danger);color:#fff;opacity:0.4;pointer-events:none">Delete Story</button>
          </div>
        `;
        overlay.classList.add('active');

        const titleInput = document.getElementById('delete-title-input');
        const confirmInput = document.getElementById('delete-confirm-input');
        const okBtn = document.getElementById('confirm-ok');

        const checkInputs = () => {
          const titleMatch = titleInput.value.trim() === title;
          const confirmMatch = confirmInput.value.trim().toLowerCase() === 'delete';
          if (titleMatch && confirmMatch) {
            okBtn.style.opacity = '1';
            okBtn.style.pointerEvents = 'auto';
          } else {
            okBtn.style.opacity = '0.4';
            okBtn.style.pointerEvents = 'none';
          }
        };
        titleInput.addEventListener('input', checkInputs);
        confirmInput.addEventListener('input', checkInputs);

        okBtn.onclick = () => {
          overlay.classList.remove('active');
          dialog.innerHTML = '<p class="confirm-message" id="confirm-message"></p><div class="confirm-actions"><button class="btn btn-ghost btn-small" id="confirm-cancel">Cancel</button><button class="btn btn-primary btn-small" id="confirm-ok">OK</button></div>';
          resolve(true);
        };
        document.getElementById('confirm-cancel').onclick = () => {
          overlay.classList.remove('active');
          dialog.innerHTML = '<p class="confirm-message" id="confirm-message"></p><div class="confirm-actions"><button class="btn btn-ghost btn-small" id="confirm-cancel">Cancel</button><button class="btn btn-primary btn-small" id="confirm-ok">OK</button></div>';
          resolve(false);
        };
      });
    },

    async deleteStory(storyId) {
      const story = this.storyList.find(s => s.id === storyId) || this.storyDetail;
      if (!story) return;
      const ok = await this.showStoryDeleteConfirm(story);
      if (!ok) return;
      try {
        await API.deleteStory(storyId);
        if (this.storySelectedId === storyId) this.openStoriesFeed();
        await this.loadStories();
        App.toast('Story deleted', 'success');
      } catch (err) {
        App.toast(err.message || 'Failed to delete story', 'error');
      }
    },

    async deleteStoryDraft(storyId) {
      await this.deleteStory(storyId);
    },

    async toggleStoryLike(storyId) {
      try {
        const result = await API.toggleStoryLike(storyId);
        const liked = result.liked;
        const count = result.likeCount || 0;
        const heartSvg = renderIcon('heart', { filled: liked });

        // Update both top and bottom like buttons in place
        for (const id of ['story-like-btn', 'story-bottom-like-btn']) {
          const btn = document.getElementById(id);
          if (!btn) continue;
          btn.classList.toggle('liked', liked);
          btn.innerHTML = `${heartSvg}<span>${count}</span>`;
        }

        // Update the feed card metric too if visible
        const story = this.storyList.find(s => s.id === storyId);
        if (story) {
          story.likedByMe = liked;
          story.likeCount = count;
        }
      } catch (err) {
        App.toast(err.message || 'Failed to update like', 'error');
      }
    },

    async submitStoryComment(storyId, parentCommentId = null) {
      const inputId = parentCommentId ? `reply-input-${parentCommentId}` : 'story-comment-input';
      const input = document.getElementById(inputId);
      const text = input ? input.value.trim() : '';
      if (!text) return;

      try {
        await API.addStoryComment(storyId, text, parentCommentId);
        if (input) input.value = '';
        await this.selectStory(storyId);
        App.toast(parentCommentId ? 'Reply posted' : 'Comment posted', 'success');
      } catch (err) {
        App.toast(err.message || 'Failed to add comment', 'error');
      }
    },

    async deleteStoryComment(storyId, commentId) {
      const ok = await this.showConfirm('Delete this comment and all its replies?');
      if (!ok) return;
      try {
        await API.deleteStoryComment(storyId, commentId);
        await this.selectStory(storyId);
        App.toast('Comment deleted', 'success');
      } catch (err) {
        App.toast(err.message || 'Failed to delete comment', 'error');
      }
    },

    async toggleCommentLike(storyId, commentId, btn) {
      try {
        const result = await API.toggleCommentLike(storyId, commentId);
        // Update button in-place without re-rendering the whole page
        const svg = btn.querySelector('svg');
        const countSpan = btn.querySelector('span');
        if (result.liked) {
          btn.classList.add('liked');
          if (svg) svg.setAttribute('fill', 'currentColor');
        } else {
          btn.classList.remove('liked');
          if (svg) svg.setAttribute('fill', 'none');
        }
        if (result.likeCount > 0) {
          if (countSpan) {
            countSpan.textContent = result.likeCount;
          } else {
            btn.insertAdjacentHTML('beforeend', `<span>${result.likeCount}</span>`);
          }
        } else if (countSpan) {
          countSpan.remove();
        }
      } catch (err) {
        App.toast(err.message || 'Failed to like comment', 'error');
      }
    },

    openReplyForm(storyId, commentId) {
      // Close any existing reply forms
      document.querySelectorAll('.comment-reply-form-active').forEach(el => {
        el.innerHTML = '';
        el.classList.remove('comment-reply-form-active');
      });

      const slot = document.getElementById(`reply-form-${commentId}`);
      if (!slot) return;

      slot.classList.add('comment-reply-form-active');
      slot.innerHTML = `
        <div class="story-comment-reply-form">
          <textarea id="reply-input-${commentId}" placeholder="Write a reply..." rows="2"></textarea>
          <div class="reply-form-actions">
            <button class="reply-cancel-btn" type="button">Cancel</button>
            <button class="btn btn-primary reply-submit-btn" type="button">Reply</button>
          </div>
        </div>
      `;

      const textarea = document.getElementById(`reply-input-${commentId}`);
      if (textarea) textarea.focus();

      slot.querySelector('.reply-cancel-btn').onclick = () => {
        slot.innerHTML = '';
        slot.classList.remove('comment-reply-form-active');
      };

      slot.querySelector('.reply-submit-btn').onclick = () => {
        this.submitStoryComment(storyId, commentId);
      };

      // Submit on Ctrl+Enter
      if (textarea) {
        textarea.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            this.submitStoryComment(storyId, commentId);
          }
          if (e.key === 'Escape') {
            slot.innerHTML = '';
            slot.classList.remove('comment-reply-form-active');
          }
        });
      }
    },

    collapseThread(commentId) {
      const replies = document.getElementById(`replies-${commentId}`);
      const collapsed = document.getElementById(`collapsed-${commentId}`);
      const thread = document.querySelector(`[data-comment-id="${commentId}"]`);
      const collapseBtn = thread?.querySelector('.comment-collapse-btn');
      const controls = thread?.querySelector('.comment-thread-controls');

      if (replies) replies.style.display = 'none';
      if (collapsed) collapsed.style.display = 'block';
      if (controls) controls.style.display = 'none';
    },

    expandThread(commentId) {
      const replies = document.getElementById(`replies-${commentId}`);
      const collapsed = document.getElementById(`collapsed-${commentId}`);
      const thread = document.querySelector(`[data-comment-id="${commentId}"]`);
      const controls = thread?.querySelector('.comment-thread-controls');

      if (replies) replies.style.display = '';
      if (collapsed) collapsed.style.display = 'none';
      if (controls) controls.style.display = '';
    },

    async toggleStoryCommentsSetting(storyId, nextState) {
      try {
        await API.updateStorySettings(storyId, { allowComments: !!nextState });
        await this.selectStory(storyId);
        App.toast(nextState ? 'Comments turned on' : 'Comments turned off', 'success');
      } catch (err) {
        App.toast(err.message || 'Failed to update comments', 'error');
      }
    }
  });

  const baseBindAppEvents = App.bindAppEvents.bind(App);
  App.bindAppEvents = function () {
    baseBindAppEvents();

    const newStoryBtn = document.getElementById('new-story-btn');
    if (newStoryBtn) newStoryBtn.addEventListener('click', () => this.createStoryDraft());

    const refreshStoriesBtn = document.getElementById('story-refresh-btn');
    if (refreshStoriesBtn) refreshStoriesBtn.addEventListener('click', () => this.loadStories());

    document.querySelectorAll('.stories-filter-btn[data-story-tab]').forEach(button => {
      button.addEventListener('click', () => {
        this.storyTab = button.dataset.storyTab;
        this.storySelectedId = null;
        this.storyEditingId = null;
        this.storyDetail = null;
        this.storyComments = [];
        this.setStoriesMode('feed');
        this.syncStoryControls();
        this.loadStories();
      });
    });

    document.querySelectorAll('.stories-filter-btn[data-story-sort]').forEach(button => {
      button.addEventListener('click', () => {
        this.storySort = button.dataset.storySort;
        this.syncStoryControls();
        if (this.storyTab === 'feed') this.loadStories();
      });
    });

    document.querySelectorAll('.stories-filter-btn[data-story-mine-filter]').forEach(button => {
      button.addEventListener('click', () => {
        this.storyMineFilter = button.dataset.storyMineFilter;
        this.syncStoryControls();
        this.renderStoriesFeed();
      });
    });
  };

  const baseSwitchView = App.switchView.bind(App);
  App.switchView = function (view, opts) {
    baseSwitchView(view, opts);
    if (view === 'stories') {
      this.syncStoryControls();
      this.loadStories();
      // Mark community as seen — hide the green dot
      localStorage.setItem('iwrite_community_seen', new Date().toISOString());
      const dot = document.getElementById('community-new-dot');
      if (dot) dot.style.display = 'none';
    }
  };
})();
