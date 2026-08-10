// db.js — MySQL connection pool with automatic primary/fallback switching.
//
// PRIMARY  → DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
//            (local Docker MySQL when running .env.local)
//
// FALLBACK → DB_FALLBACK_HOST / ... / DB_FALLBACK_NAME
//            (Aurora) — used automatically if primary is unreachable.
//
// How it works:
//   1. verifyConnection() tries the PRIMARY pool first.
//   2. If that fails (ETIMEDOUT, ECONNREFUSED, etc.), it switches the
//      exported `pool` to the FALLBACK pool transparently — no restart needed.
//   3. All stores (userStore, projectStore, auditStore) import { pool } from
//      this file, so they automatically use whichever pool is active.

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
    connectTimeout:     8000  // 8 s — fail fast so fallback kicks in quickly
  });
}

// ── Primary pool (local Docker by default when .env.local is active) ──────
const primaryPool = makePool({
  host:     process.env.DB_HOST     || "127.0.0.1",
  port:     process.env.DB_PORT     || "3306",
  user:     process.env.DB_USER     || "admin",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME     || "cicd_admin"
});

// ── Fallback pool (Aurora) — only created if env vars are present ─────────
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

// This is what every store imports. Starts as primary, may be swapped to fallback.
let activePool = primaryPool;
let activeLabel = `${process.env.DB_HOST || "127.0.0.1"}:${process.env.DB_PORT || "3306"}`;

// Named export so stores can do:  const { pool } = require("../db")
// The proxy below makes `pool.query(...)` always call the CURRENT activePool.
const pool = new Proxy({}, {
  get(_target, prop) {
    return typeof activePool[prop] === "function"
      ? activePool[prop].bind(activePool)
      : activePool[prop];
  }
});

// ── Connection verification with automatic fallback ───────────────────────
async function verifyConnection() {
  // Try primary first
  try {
    const conn = await primaryPool.getConnection();
    await conn.query("SELECT 1");
    conn.release();
    activePool  = primaryPool;
    activeLabel = `${process.env.DB_HOST || "127.0.0.1"}:${process.env.DB_PORT || "3306"}`;
    console.log(`✔  DB connected  [PRIMARY]  → ${activeLabel}/${process.env.DB_NAME || "cicd_admin"}`);
    return;
  } catch (primaryErr) {
    const isFallback = primaryErr.code === "ETIMEDOUT" ||
                       primaryErr.code === "ECONNREFUSED" ||
                       primaryErr.code === "ENOTFOUND"   ||
                       primaryErr.code === "ER_ACCESS_DENIED_ERROR";

    if (!hasFallback || !isFallback) {
      // No fallback configured, or it's a real error (bad password, etc.)
      throw primaryErr;
    }

    console.warn(`⚠   Primary DB unreachable (${primaryErr.code}) — switching to FALLBACK (Aurora)...`);

    // Try fallback
    try {
      const conn = await fallbackPool.getConnection();
      await conn.query("SELECT 1");
      conn.release();
      activePool  = fallbackPool;
      activeLabel = `${process.env.DB_FALLBACK_HOST}:${process.env.DB_FALLBACK_PORT || "3306"}`;
      console.log(`✔  DB connected  [FALLBACK] → ${activeLabel}/${process.env.DB_FALLBACK_NAME}`);
      console.log("   ⚡ Running against Aurora. Start Docker MySQL to switch back to local.");
    } catch (fallbackErr) {
      console.error("✘  Both primary AND fallback DB are unreachable.");
      console.error(`   Primary  error: ${primaryErr.message}`);
      console.error(`   Fallback error: ${fallbackErr.message}`);
      throw new Error(
        `Cannot connect to any database.\n` +
        `  Primary  (${activeLabel}): ${primaryErr.message}\n` +
        `  Fallback (${process.env.DB_FALLBACK_HOST}): ${fallbackErr.message}`
      );
    }
  }
}

// Which DB is currently in use — useful for /api/health
function getActiveLabel() { return activeLabel; }

module.exports = { pool, verifyConnection, getActiveLabel };
