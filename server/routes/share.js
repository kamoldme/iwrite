const express = require('express');
const { findOne, findMany, insertOne, updateOne } = require('../utils/storage');
const { authenticate } = require('../middleware/auth');
const { v4: uuid } = require('uuid');

const router = express.Router();

router.get('/:token', async (req, res) => {
  const docs = await findMany('documents.json');
  const doc = docs.find(d =>
    d.shareLinks && d.shareLinks.some(s => s.token === req.params.token)
  );
  if (!doc || doc.deleted) {
    return res.status(404).json({ error: 'Document not found or no longer available' });
  }

  const link = doc.shareLinks.find(s => s.token === req.params.token);
  const owner = await findOne('users.json', u => u.id === doc.userId);

  res.json({
    id: doc.id,
    title: doc.title,
    content: doc.content,
    wordCount: doc.wordCount,
    ownerName: owner ? owner.name : 'Unknown',
    ownerId: doc.userId,
    permission: link.type,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  });
});

router.post('/:token/comment', authenticate, async (req, res) => {
  const { text, highlightedText, startOffset, endOffset } = req.body;
  if (!text) return res.status(400).json({ error: 'Comment text is required' });

  const docs = await findMany('documents.json');
  const doc = docs.find(d =>
    d.shareLinks && d.shareLinks.some(s => s.token === req.params.token && ['comment', 'edit'].includes(s.type))
  );
  if (!doc) return res.status(404).json({ error: 'Document not found or commenting not allowed' });

  const user = await findOne('users.json', u => u.id === req.user.id);

  const comment = {
    id: uuid(),
    userId: req.user.id,
    author: user ? user.name : 'Unknown',
    text,
    highlightedText: highlightedText || null,
    startOffset: startOffset !== undefined ? startOffset : null,
    endOffset: endOffset !== undefined ? endOffset : null,
    status: 'pending',
    documentId: doc.id,
    createdAt: new Date().toISOString()
  };

  await insertOne('comments.json', comment);
  res.status(201).json(comment);
});

router.get('/:token/comments', async (req, res) => {
  const docs = await findMany('documents.json');
  const doc = docs.find(d =>
    d.shareLinks && d.shareLinks.some(s => s.token === req.params.token)
  );
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const comments = await findMany('comments.json', c => c.documentId === doc.id && c.status === 'pending');
  res.json(comments);
});

router.patch('/:token/comments/:commentId/resolve', authenticate, async (req, res) => {
  const { status } = req.body;
  if (!['done', 'accepted', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Status must be done, accepted or rejected' });
  }

  const docs = await findMany('documents.json');
  const doc = docs.find(d =>
    d.shareLinks && d.shareLinks.some(s => s.token === req.params.token)
  );
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  if (doc.userId !== req.user.id) {
    return res.status(403).json({ error: 'Only the document owner can resolve comments' });
  }

  const updated = await updateOne('comments.json', c => c.id === req.params.commentId, {
    status,
    resolvedAt: new Date().toISOString()
  });
  if (!updated) return res.status(404).json({ error: 'Comment not found' });

  res.json(updated);
});

// Register that a logged-in user has accessed a shared document (saves token to their profile)
router.post('/:token/register', authenticate, async (req, res) => {
  const docs = await findMany('documents.json');
  const doc = docs.find(d => d.shareLinks && d.shareLinks.some(s => s.token === req.params.token));
  if (!doc || doc.deleted) return res.status(404).json({ error: 'Not found' });

  // Don't register own documents
  if (doc.userId === req.user.id) return res.json({ ok: true });

  const user = await findOne('users.json', u => u.id === req.user.id);
  const sharedTokens = user.sharedTokens || [];
  if (!sharedTokens.find(t => t.token === req.params.token)) {
    const link = doc.shareLinks.find(s => s.token === req.params.token);
    await updateOne('users.json', u => u.id === req.user.id, {
      sharedTokens: [...sharedTokens, {
        token: req.params.token,
        docId: doc.id,
        permission: link.type,
        addedAt: new Date().toISOString()
      }]
    });
  }
  res.json({ ok: true });
});

module.exports = router;
