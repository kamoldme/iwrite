const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { findOne, findMany, insertOne, updateOne, deleteOne } = require('../utils/storage');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
const ALLOWED_STORY_TAGS = new Set(['p', 'br', 'h1', 'h2', 'h3', 'blockquote', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'u', 'a', 'code', 'pre']);
const NORMALIZED_BLOCK_TAGS = new Set(['div']);

function decodeBasicEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'');
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(text) {
  return escapeHtml(text).replace(/`/g, '&#96;');
}

function sanitizeHref(value) {
  const href = decodeBasicEntities(value).trim();
  if (!href) return '';
  return /^(https?:|mailto:|tel:|\/|#)/i.test(href) ? href : '';
}

function sanitizeStoryTag(fullTag, rawTagName, rawAttrs = '') {
  const isClosing = fullTag.startsWith('</');
  let tagName = String(rawTagName || '').toLowerCase();

  if (NORMALIZED_BLOCK_TAGS.has(tagName)) tagName = 'p';
  if (!ALLOWED_STORY_TAGS.has(tagName)) return '';

  if (isClosing) return `</${tagName}>`;
  if (tagName === 'br') return '<br>';

  if (tagName === 'a') {
    const hrefMatch = rawAttrs.match(/\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const href = sanitizeHref(hrefMatch ? (hrefMatch[1] || hrefMatch[2] || hrefMatch[3] || '') : '');
    if (!href) return '<a>';
    return `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer nofollow">`;
  }

  return `<${tagName}>`;
}

function sanitizeStoryContent(html) {
  const source = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed|svg|math|form|input|button|textarea|select|option|meta|link|base)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|style|iframe|object|embed|svg|math|form|input|button|textarea|select|option|meta|link|base)\b[^>]*\/?>/gi, '');
  const tagRegex = /<\/?([a-z0-9-]+)([^>]*)>/gi;
  let output = '';
  let lastIndex = 0;
  let match;

  while ((match = tagRegex.exec(source))) {
    output += escapeHtml(decodeBasicEntities(source.slice(lastIndex, match.index)));
    output += sanitizeStoryTag(match[0], match[1], match[2]);
    lastIndex = match.index + match[0].length;
  }

  output += escapeHtml(decodeBasicEntities(source.slice(lastIndex)));
  output = output
    .replace(/(?:&nbsp;|&#160;)+/g, ' ')
    .replace(/\s{3,}/g, '  ')
    .trim();

  return output || '<p></p>';
}

function stripHtml(html) {
  return (html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordCountFromHtml(html) {
  const text = stripHtml(html);
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function readTimeMinutes(html) {
  return Math.max(1, Math.ceil(wordCountFromHtml(html) / 220));
}

function buildExcerpt(story) {
  const text = stripHtml(story.content);
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const excerptWords = words.slice(0, 30).join(' ');
  return excerptWords + (words.length > 30 ? '...' : '');
}

function canEditStory(story, userId, isAdmin) {
  if (isAdmin) return true;
  return story.userId === userId && ['draft', 'changes_requested', 'rejected'].includes(story.status);
}

function canViewStory(story, userId, isAdmin) {
  if (!story) return false;
  if (isAdmin) return true;
  if (story.status === 'published') return true;
  return story.userId === userId;
}

function storyScore(story) {
  return (story.viewCount || 0) + ((story.likeCount || 0) * 4) + ((story.commentCount || 0) * 3);
}

function canManageStoryComments(story, userId, isAdmin) {
  if (isAdmin) return true;
  return story.userId === userId;
}

function getOptionalViewer(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET || 'iwrite-dev-secret-change-in-production');
  } catch {
    return null;
  }
}

async function loadStoryComments(story, options = {}) {
  const includePending = !!options.includePending;
  const users = await findMany('users.json');
  const userMap = new Map(users.map(u => [u.id, u]));
  const comments = await findMany('story-comments.json', c => {
    if (c.storyId !== story.id) return false;
    if (c.status === 'approved') return true;
    return includePending && c.status === 'pending';
  });

  return comments
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .map(comment => {
      const author = userMap.get(comment.userId);
      return {
        ...comment,
        authorName: author ? author.name : comment.authorName || 'Unknown',
        authorUsername: author ? (author.username || null) : null
      };
    });
}

async function hydrateStories(stories, currentUserId) {
  const users = await findMany('users.json');
  const likes = await findMany('story-likes.json');
  const comments = await findMany('story-comments.json');
  const userMap = new Map(users.map(u => [u.id, u]));
  const likesByStory = new Map();
  const approvedCommentsByStory = new Map();

  for (const like of likes) {
    if (!likesByStory.has(like.storyId)) likesByStory.set(like.storyId, []);
    likesByStory.get(like.storyId).push(like);
  }

  for (const comment of comments) {
    if (comment.status !== 'approved') continue;
    approvedCommentsByStory.set(comment.storyId, (approvedCommentsByStory.get(comment.storyId) || 0) + 1);
  }

  return stories.map(story => {
    const storyLikes = likesByStory.get(story.id) || [];
    const author = userMap.get(story.userId);
    const likedByMe = !!storyLikes.find(l => l.userId === currentUserId);
    const likeCount = storyLikes.length;
    const commentCount = approvedCommentsByStory.get(story.id) || 0;
    const safeContent = sanitizeStoryContent(story.content);

    return {
      ...story,
      content: safeContent,
      excerpt: buildExcerpt(story),
      readTimeMinutes: story.readTimeMinutes || readTimeMinutes(safeContent),
      viewCount: story.viewCount || 0,
      likeCount,
      commentCount,
      likedByMe,
      popularityScore: storyScore({ ...story, likeCount, commentCount }),
      authorName: author ? author.name : 'Unknown',
      authorUsername: author ? (author.username || null) : null,
      authorAvatar: author ? (author.avatar || null) : null,
      authorPlan: author ? (author.plan || 'free') : 'free'
    };
  });
}

router.get('/public/:id', async (req, res) => {
  try {
    const viewer = getOptionalViewer(req);
    let story = await findOne('stories.json', s => s.id === req.params.id);
    if (!story || story.status !== 'published') {
      return res.status(404).json({ error: 'Published story not found' });
    }

    if (!viewer || (viewer.id && viewer.id !== story.userId && viewer.role !== 'admin')) {
      story = await updateOne('stories.json', s => s.id === req.params.id, {
        viewCount: (story.viewCount || 0) + 1,
        lastViewedAt: new Date().toISOString()
      }) || story;
    }

    const [hydrated] = await hydrateStories([story], viewer ? viewer.id : null);
    res.json(hydrated);
  } catch (err) {
    console.error('Public story detail error:', err);
    res.status(500).json({ error: 'Failed to load story' });
  }
});

router.get('/public/:id/comments', async (req, res) => {
  try {
    const story = await findOne('stories.json', s => s.id === req.params.id);
    if (!story || story.status !== 'published') {
      return res.status(404).json({ error: 'Published story not found' });
    }

    const comments = await loadStoryComments(story);
    res.json(comments);
  } catch (err) {
    console.error('Public story comments error:', err);
    res.status(500).json({ error: 'Failed to load story comments' });
  }
});

router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const filter = (req.query.filter || 'feed').toLowerCase();
    const sort = (req.query.sort || 'newest').toLowerCase();
    const stories = await findMany('stories.json');
    const hydrated = await hydrateStories(stories, req.user.id);

    let filtered = hydrated;
    if (filter === 'mine') {
      filtered = hydrated
        .filter(s => s.userId === req.user.id)
        .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
    } else {
      filtered = hydrated.filter(s => s.status === 'published');

      if (sort === 'oldest') {
        filtered.sort((a, b) => new Date(a.publishedAt || a.createdAt) - new Date(b.publishedAt || b.createdAt));
      } else if (sort === 'popular') {
        filtered.sort((a, b) => b.popularityScore - a.popularityScore || new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
      } else {
        filtered.sort((a, b) => new Date(b.publishedAt || b.createdAt) - new Date(a.publishedAt || a.createdAt));
      }
    }

    res.json(filtered);
  } catch (err) {
    console.error('Stories list error:', err);
    res.status(500).json({ error: 'Failed to load stories' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    let story = await findOne('stories.json', s => s.id === req.params.id);
    if (!story) return res.status(404).json({ error: 'Story not found' });
    if (!canViewStory(story, req.user.id, req.user.role === 'admin')) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (story.status === 'published' && story.userId !== req.user.id && req.user.role !== 'admin') {
      story = await updateOne('stories.json', s => s.id === req.params.id, {
        viewCount: (story.viewCount || 0) + 1,
        lastViewedAt: new Date().toISOString()
      }) || story;
    }

    const [hydrated] = await hydrateStories([story], req.user.id);
    res.json(hydrated);
  } catch (err) {
    console.error('Story detail error:', err);
    res.status(500).json({ error: 'Failed to load story' });
  }
});

router.post('/', async (req, res) => {
  try {
    const title = (req.body.title || '').trim() || 'Untitled Story';
    const content = sanitizeStoryContent(req.body.content || '');
    const allowComments = req.body.allowComments !== false;
    const now = new Date().toISOString();

    const story = {
      id: uuid(),
      userId: req.user.id,
      sourceDocumentId: null,
      title,
      excerpt: buildExcerpt({ content }),
      content,
      status: 'draft',
      allowComments,
      commentsLocked: !allowComments,
      moderationNote: '',
      viewCount: 0,
      createdAt: now,
      updatedAt: now,
      submittedAt: null,
      publishedAt: null,
      reviewedAt: null
    };

    await insertOne('stories.json', story);
    const [hydrated] = await hydrateStories([story], req.user.id);
    res.status(201).json(hydrated);
  } catch (err) {
    console.error('Create story error:', err);
    res.status(500).json({ error: 'Failed to create story draft' });
  }
});

router.post('/from-document/:documentId', async (req, res) => {
  try {
    const doc = await findOne('documents.json', d => d.id === req.params.documentId && d.userId === req.user.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const now = new Date().toISOString();
    const story = {
      id: uuid(),
      userId: req.user.id,
      sourceDocumentId: doc.id,
      title: doc.title || 'Untitled Story',
      excerpt: buildExcerpt({ content: doc.content }),
      content: sanitizeStoryContent(doc.content || ''),
      status: 'draft',
      allowComments: true,
      commentsLocked: false,
      moderationNote: '',
      viewCount: 0,
      createdAt: now,
      updatedAt: now,
      submittedAt: null,
      publishedAt: null,
      reviewedAt: null
    };

    await insertOne('stories.json', story);
    const [hydrated] = await hydrateStories([story], req.user.id);
    res.status(201).json(hydrated);
  } catch (err) {
    console.error('Publish from document error:', err);
    res.status(500).json({ error: 'Failed to create story from session' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const story = await findOne('stories.json', s => s.id === req.params.id);
    if (!story) return res.status(404).json({ error: 'Story not found' });
    if (!canEditStory(story, req.user.id, req.user.role === 'admin')) {
      return res.status(403).json({ error: 'This story cannot be edited right now' });
    }

    const updates = {
      updatedAt: new Date().toISOString()
    };
    if (req.body.title !== undefined) updates.title = (req.body.title || '').trim() || 'Untitled Story';
    if (req.body.content !== undefined) updates.content = sanitizeStoryContent(req.body.content || '');
    if (req.body.allowComments !== undefined) {
      updates.allowComments = !!req.body.allowComments;
      updates.commentsLocked = !req.body.allowComments;
    }
    if (updates.content !== undefined) {
      updates.excerpt = buildExcerpt({ content: updates.content });
      updates.readTimeMinutes = readTimeMinutes(updates.content);
    }

    const updated = await updateOne('stories.json', s => s.id === req.params.id, updates);
    const [hydrated] = await hydrateStories([updated], req.user.id);
    res.json(hydrated);
  } catch (err) {
    console.error('Update story error:', err);
    res.status(500).json({ error: 'Failed to update story' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const story = await findOne('stories.json', s => s.id === req.params.id);
    if (!story) return res.status(404).json({ error: 'Story not found' });

    const isAdmin = req.user.role === 'admin';
    const isOwner = story.userId === req.user.id;
    if (!isAdmin && !isOwner) {
      return res.status(403).json({ error: 'You do not have permission to delete this story' });
    }

    await deleteOne('stories.json', s => s.id === req.params.id);
    const storyComments = await findMany('story-comments.json', c => c.storyId === req.params.id);
    const storyLikes = await findMany('story-likes.json', l => l.storyId === req.params.id);
    for (const comment of storyComments) {
      await deleteOne('story-comments.json', c => c.id === comment.id);
    }
    for (const like of storyLikes) {
      await deleteOne('story-likes.json', l => l.id === like.id);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Delete story error:', err);
    res.status(500).json({ error: 'Failed to delete story' });
  }
});

router.post('/:id/submit', async (req, res) => {
  try {
    const story = await findOne('stories.json', s => s.id === req.params.id && s.userId === req.user.id);
    if (!story) return res.status(404).json({ error: 'Story not found' });
    if (!['draft', 'changes_requested', 'rejected'].includes(story.status)) {
      return res.status(400).json({ error: 'Story cannot be submitted from its current status' });
    }
    if (!story.title || !story.title.trim()) return res.status(400).json({ error: 'Story title is required' });
    if (wordCountFromHtml(story.content) < 30) {
      return res.status(400).json({ error: 'Stories need at least 30 words before submission' });
    }

    const updated = await updateOne('stories.json', s => s.id === req.params.id, {
      status: 'pending_review',
      excerpt: buildExcerpt(story),
      readTimeMinutes: readTimeMinutes(story.content),
      moderationNote: '',
      submittedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    const [hydrated] = await hydrateStories([updated], req.user.id);
    res.json(hydrated);
  } catch (err) {
    console.error('Submit story error:', err);
    res.status(500).json({ error: 'Failed to submit story for review' });
  }
});

router.post('/:id/like', async (req, res) => {
  try {
    const story = await findOne('stories.json', s => s.id === req.params.id);
    if (!story || story.status !== 'published') {
      return res.status(404).json({ error: 'Published story not found' });
    }

    const existing = await findOne('story-likes.json', l => l.storyId === story.id && l.userId === req.user.id);
    if (existing) {
      await deleteOne('story-likes.json', l => l.id === existing.id);
    } else {
      await insertOne('story-likes.json', {
        id: uuid(),
        storyId: story.id,
        userId: req.user.id,
        createdAt: new Date().toISOString()
      });
    }

    const [hydrated] = await hydrateStories([story], req.user.id);
    res.json({ liked: !existing, likeCount: hydrated.likeCount });
  } catch (err) {
    console.error('Like story error:', err);
    res.status(500).json({ error: 'Failed to update like' });
  }
});

router.patch('/:id/settings', async (req, res) => {
  try {
    const story = await findOne('stories.json', s => s.id === req.params.id);
    if (!story) return res.status(404).json({ error: 'Story not found' });
    if (!canManageStoryComments(story, req.user.id, req.user.role === 'admin')) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const updates = {
      updatedAt: new Date().toISOString()
    };

    if (req.body.allowComments !== undefined) {
      updates.allowComments = !!req.body.allowComments;
      updates.commentsLocked = !req.body.allowComments;
    }

    const updated = await updateOne('stories.json', s => s.id === req.params.id, updates);
    const [hydrated] = await hydrateStories([updated], req.user.id);
    res.json(hydrated);
  } catch (err) {
    console.error('Story settings error:', err);
    res.status(500).json({ error: 'Failed to update story settings' });
  }
});

router.get('/:id/comments', async (req, res) => {
  try {
    const story = await findOne('stories.json', s => s.id === req.params.id);
    if (!story) return res.status(404).json({ error: 'Story not found' });
    if (!canViewStory(story, req.user.id, req.user.role === 'admin')) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const includePending = req.query.include_pending === '1' && (req.user.role === 'admin' || story.userId === req.user.id);
    const comments = await loadStoryComments(story, { includePending });
    res.json(comments);
  } catch (err) {
    console.error('Story comments error:', err);
    res.status(500).json({ error: 'Failed to load story comments' });
  }
});

router.post('/:id/comments', async (req, res) => {
  try {
    const story = await findOne('stories.json', s => s.id === req.params.id);
    if (!story || story.status !== 'published') {
      return res.status(404).json({ error: 'Published story not found' });
    }
    if (story.commentsLocked || story.allowComments === false) {
      return res.status(403).json({ error: 'Comments are disabled for this story' });
    }

    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Comment text is required' });
    if (text.length > 1000) return res.status(400).json({ error: 'Comment is too long' });

    const user = await findOne('users.json', u => u.id === req.user.id);
    const comment = {
      id: uuid(),
      storyId: story.id,
      userId: req.user.id,
      authorName: user ? user.name : 'Unknown',
      text,
      status: 'approved',
      createdAt: new Date().toISOString(),
      moderatedAt: null,
      moderatedBy: null
    };

    await insertOne('story-comments.json', comment);
    res.status(201).json({ ok: true, status: 'approved' });
  } catch (err) {
    console.error('Create story comment error:', err);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

router.delete('/:id/comments/:commentId', async (req, res) => {
  try {
    const story = await findOne('stories.json', s => s.id === req.params.id);
    if (!story) return res.status(404).json({ error: 'Story not found' });

    const comment = await findOne('story-comments.json', c => c.id === req.params.commentId && c.storyId === story.id);
    if (!comment) return res.status(404).json({ error: 'Comment not found' });

    const isAdmin = req.user.role === 'admin';
    const canDelete = isAdmin || story.userId === req.user.id || comment.userId === req.user.id;
    if (!canDelete) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await deleteOne('story-comments.json', c => c.id === comment.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete story comment error:', err);
    res.status(500).json({ error: 'Failed to delete comment' });
  }
});

module.exports = router;
