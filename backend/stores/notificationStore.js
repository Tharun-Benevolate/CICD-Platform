// stores/notificationStore.js — In-app notification inbox operations.

const { pool } = require("../config/db");
const crypto = require("crypto");

async function create({ recipient, type, title, body, link, changeRequestId }) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO notifications (id, recipient, type, title, body, link, change_request_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, recipient, type, title, body || null, link || null, changeRequestId || null]
  );
  return { id, recipient, type, title, body, link, changeRequestId, isRead: false };
}

async function list(username, { unreadOnly = false, limit = 50 } = {}) {
  const where = unreadOnly ? "WHERE recipient = ? AND is_read = 0" : "WHERE recipient = ?";
  const [rows] = await pool.query(
    `SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT ?`,
    [username, parseInt(limit)]
  );
  return rows;
}

async function markRead(notificationId) {
  await pool.query("UPDATE notifications SET is_read = 1 WHERE id = ?", [notificationId]);
  return true;
}

async function markAllRead(username) {
  await pool.query("UPDATE notifications SET is_read = 1 WHERE recipient = ?", [username]);
  return true;
}

async function unreadCount(username) {
  const [rows] = await pool.query(
    "SELECT COUNT(*) AS cnt FROM notifications WHERE recipient = ? AND is_read = 0",
    [username]
  );
  return rows[0]?.cnt || 0;
}

module.exports = { create, list, markRead, markAllRead, unreadCount };
