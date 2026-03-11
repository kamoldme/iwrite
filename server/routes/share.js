const express = require('express');
const { findOne, findMany, insertOne } = require('../utils/storage');
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
    permission: link.type,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  });
});

router.post('/:token/comment', (req, res) => {
  const { author, text } = req.body;
  if (!text) return res.status(400).json({ error: 'Comment text is required' });

  const docs = findMany('documents.json');
  const doc = docs.find(d =>
    d.shareLinks && d.shareLinks.some(s => s.token === req.params.token && ['comment', 'edit'].includes(s.type))
  );
  if (!doc) return res.status(404).json({ error: 'Document not found or commenting not allowed' });

  const comment = {
    id: uuid(),
    author: author || 'Anonymous',
    text,
    createdAt: new Date().toISOString()
  };

  const comments = findMany('comments.json');
  insertOne('comments.json', { ...comment, documentId: doc.id });
  res.status(201).json(comment);
});

router.get('/:token/comments', (req, res) => {
  const docs = findMany('documents.json');
  const doc = docs.find(d =>
    d.shareLinks && d.shareLinks.some(s => s.token === req.params.token)
  );
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const comments = findMany('comments.json', c => c.documentId === doc.id);
  res.json(comments);
});

module.exports = router;
