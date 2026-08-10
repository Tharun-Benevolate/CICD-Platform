// config/db.js — MySQL connection pool with automatic primary/fallback switching.
//
// PRIMARY  → DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
//            (local Docker MySQL when running locally)
//
// FALLBACK → DB_FALLBACK_HOST / ... / DB_FALLBACK_NAME
//            (Aurora) — used automatically if primary is unreachable.
//
// How it works:
//   1. verifyConnection() tries the PRIMARY pool first.
//   2. If that fails (ETIMEDOUT, ECONNREFUSED, etc.), it switches the
//      exported `pool` to the FALLBACK pool transparently — no restart needed.
//   3. All stores import { pool } from this file — they automatically use
//      whichever pool is active.

require("dotenv").config();
const mysql = require("mysql2/promise");

function makePool(config) {
  return mysql.createPool({
    host:               config.host,
    port:               parseInt(config.port || "3306", 10),
    user:               config.user,
    password:           config.password,
    database:           config.database,
    waitForConnections: true,
    connectionLimit:    10,
    queueLimit:         0,
    dateStrings:        false,
    connectTimeout:     8000  // 8s — fail fast so fallback kicks in quickly
  });
}

// ── Primary pool ──────────────────────────────────────────────────────────
const primaryPool = makePool({
  host:     process.env.DB_HOST     || "127.0.0.1",
  port:     process.env.DB_PORT     || "3306",
  user:     process.env.DB_USER     || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME     || "cicd_admin"
});

// ── Fallback pool (Aurora) — only created if env vars present ─────────────
const hasFallback = !!process.env.DB_FALLBACK_HOST;
const fallbackPool = hasFallback
  ? makePool({
      host:     process.env.DB_FALLBACK_HOST,
      port:     process.env.DB_FALLBACK_PORT || "3306",
      user:     process.env.DB_FALLBACK_USER,
      password: process.env.DB_FALLBACK_PASSWORD,
      database: process.env.DB_FALLBACK_NAME
    })
  : null;

// Proxy so all stores always use the currently-active pool
let activePool  = primaryPool;
let activeLabel = `${process.env.DB_HOST || "127.0.0.1"}:${process.env.DB_PORT || "3306"}`;

const pool = new Proxy({}, {
  get(_target, prop) {
    return typeof activePool[prop] === "function"
      ? activePool[prop].bind(activePool)
      : activePool[prop];
  }
});

async function verifyConnection() {
  try {
    const conn = await primaryPool.getConnection();
    await conn.query("SELECT 1");
    conn.release();
    activePool  = primaryPool;
    activeLabel = `${process.env.DB_HOST || "127.0.0.1"}:${process.env.DB_PORT || "3306"}`;
    console.log(`✔  DB connected  [PRIMARY]  → ${activeLabel}/${process.env.DB_NAME || "cicd_admin"}`);
    return;
  } catch (primaryErr) {
    const isFallback = ["ETIMEDOUT","ECONNREFUSED","ENOTFOUND","ER_ACCESS_DENIED_ERROR"]
      .includes(primaryErr.code);

    if (!hasFallback || !isFallback) throw primaryErr;

    console.warn(`⚠   Primary DB unreachable (${primaryErr.code}) — switching to FALLBACK (Aurora)...`);

    try {
      const conn = await fallbackPool.getConnection();
      await conn.query("SELECT 1");
      conn.release();
      activePool  = fallbackPool;
      activeLabel = `${process.env.DB_FALLBACK_HOST}:${process.env.DB_FALLBACK_PORT || "3306"}`;
      console.log(`✔  DB connected  [FALLBACK] → ${activeLabel}/${process.env.DB_FALLBACK_NAME}`);
    } catch (fallbackErr) {
      console.error("✘  Both primary AND fallback DB are unreachable.");
      throw new Error(
        `Cannot connect to any database.\n` +
        `  Primary  (${activeLabel}): ${primaryErr.message}\n` +
        `  Fallback (${process.env.DB_FALLBACK_HOST}): ${fallbackErr.message}`
      );
    }
  }
}

function getActiveLabel() { return activeLabel; }

module.exports = { pool, verifyConnection, getActiveLabel };
