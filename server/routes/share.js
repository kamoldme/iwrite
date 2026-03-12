const express = require('express');
const { findOne, findMany, insertOne, updateOne } = require('../utils/storage');
const { authenticate } = require('../middleware/auth');
const { v4: uuid } = require('uuid');

const router = express.Router();

router.get('/:token', (req, res) => {
  const docs = findMany('documents.json');
  const doc = docs.find(d =>
    d.shareLinks && d.shareLinks.some(s => s.token === req.params.token)
  );
  if (!doc || doc.deleted) {
    return res.status(404).json({ error: 'Document not found or no longer available' });
  }

  const link = doc.shareLinks.find(s => s.token === req.params.token);
  const owner = findOne('users.json', u => u.id === doc.userId);

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

router.post('/:token/comment', authenticate, (req, res) => {
  const { text, highlightedText, startOffset, endOffset } = req.body;
  if (!text) return res.status(400).json({ error: 'Comment text is required' });

  const docs = findMany('documents.json');
  const doc = docs.find(d =>
    d.shareLinks && d.shareLinks.some(s => s.token === req.params.token && ['comment', 'edit'].includes(s.type))
  );
  if (!doc) return res.status(404).json({ error: 'Document not found or commenting not allowed' });

  const user = findOne('users.json', u => u.id === req.user.id);

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

  insertOne('comments.json', comment);
  res.status(201).json(comment);
});

router.get('/:token/comments', (req, res) => {
  const docs = findMany('documents.json');
  const doc = docs.find(d =>
    d.shareLinks && d.shareLinks.some(s => s.token === req.params.token)
  );
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const comments = findMany('comments.json', c => c.documentId === doc.id && c.status !== 'rejected' && c.status !== 'accepted');
  res.json(comments);
});

router.patch('/:token/comments/:commentId/resolve', authenticate, (req, res) => {
  const { status } = req.body;
  if (!['accepted', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Status must be accepted or rejected' });
  }

  const docs = findMany('documents.json');
  const doc = docs.find(d =>
    d.shareLinks && d.shareLinks.some(s => s.token === req.params.token)
  );
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  if (doc.userId !== req.user.id) {
    return res.status(403).json({ error: 'Only the document owner can resolve comments' });
  }

  const updated = updateOne('comments.json', c => c.id === req.params.commentId, {
    status,
    resolvedAt: new Date().toISOString()
  });
  if (!updated) return res.status(404).json({ error: 'Comment not found' });

  res.json(updated);
});

module.exports = router;
