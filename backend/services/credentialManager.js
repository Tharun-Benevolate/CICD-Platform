// services/credentialManager.js — AES-256-GCM encryption/decryption of developer
// git credentials. All tokens are encrypted before hitting the database.
//
// Required .env: CREDENTIAL_ENCRYPTION_KEY=<32-byte hex string>
// Generate with: openssl rand -hex 32

const crypto = require("crypto");
const { pool } = require("../config/db");

function getKey() {
  const hex = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!hex || hex.length < 64) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY is not set or is too short. Generate with: openssl rand -hex 32");
  }
  return Buffer.from(hex, "hex");
}

function encrypt(plaintext) {
  const KEY = getKey();
  const iv = crypto.randomBytes(12); // 96-bit nonce for GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  return {
    encrypted,
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex")
  };
}

function decrypt(encryptedHex, ivHex, tagHex) {
  const KEY = getKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  let text = decipher.update(encryptedHex, "hex", "utf8");
  text += decipher.final("utf8");
  return text;
}

// Store an encrypted credential for a user.
async function storeCredential(username, { provider, repositoryId, credentialType, token, label, meta, expiresAt }) {
  const normUser = (username || "").toLowerCase().trim();
  const normProvider = (provider || "").toLowerCase().trim();
  const { encrypted, iv, tag } = encrypt(token);
  const metaStr = typeof meta === "string" ? meta : JSON.stringify(meta || {});

  const [existing] = await pool.query(
    `SELECT id FROM repo_credentials WHERE LOWER(username) = LOWER(?) AND LOWER(provider) = LOWER(?) AND (repository_id = ? OR repository_id IS NULL)`,
    [normUser, normProvider, repositoryId || null]
  );

  if (existing.length > 0) {
    const id = existing[0].id;
    await pool.query(
      `UPDATE repo_credentials
       SET username = ?, provider = ?, encrypted_token = ?, token_iv = ?, token_tag = ?, label = ?, meta = ?, expires_at = ?
       WHERE id = ?`,
      [normUser, normProvider, encrypted, iv, tag, label || null, metaStr, expiresAt || null, id]
    );
    return { id, username: normUser, provider: normProvider, credentialType: credentialType || "pat", label, repositoryId };
  } else {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO repo_credentials
         (id, username, repository_id, provider, credential_type, encrypted_token, token_iv, token_tag, label, meta, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, normUser, repositoryId || null, normProvider, credentialType || "pat", encrypted, iv, tag, label || null, metaStr, expiresAt || null]
    );
    return { id, username: normUser, provider: normProvider, credentialType: credentialType || "pat", label, repositoryId };
  }
}

// Retrieve and decrypt a credential. Returns the plaintext token.
// repositoryId is optional — if null, returns the user's credential for the provider (any repo).
async function getCredential(username, provider, repositoryId) {
  const normUser = (username || "").toLowerCase().trim();
  const normProvider = (provider || "").toLowerCase().trim();
  const [rows] = await pool.query(
    `SELECT * FROM repo_credentials
      WHERE LOWER(username) = LOWER(?) AND LOWER(provider) = LOWER(?)
        AND (repository_id = ? OR repository_id IS NULL)
      ORDER BY repository_id DESC, created_at DESC LIMIT 1`,
    [normUser, normProvider, repositoryId || null]
  );
  if (!rows.length) return null;
  const row = rows[0];
  try {
    return decrypt(row.encrypted_token, row.token_iv, row.token_tag);
  } catch (e) {
    console.error("Failed to decrypt credential:", e.message);
    return null;
  }
}

// List a user's credentials — labels, providers, types only — NEVER the token.
async function listCredentials(username) {
  const normUser = (username || "").toLowerCase().trim();
  const [rows] = await pool.query(
    `SELECT id, username, provider, credential_type, label, repository_id, expires_at, created_at
       FROM repo_credentials
      WHERE LOWER(username) = LOWER(?) AND (label IS NULL OR label NOT LIKE 'Temp CLI%')
      ORDER BY created_at DESC`,
    [normUser]
  );
  return rows;
}

// Delete a credential — verifies ownership first.
async function deleteCredential(credentialId, username) {
  const normUser = (username || "").toLowerCase().trim();
  const [rows] = await pool.query(
    "SELECT id FROM repo_credentials WHERE id = ? AND LOWER(username) = LOWER(?)",
    [credentialId, normUser]
  );
  if (!rows.length) throw new Error("Credential not found or not owned by you");
  await pool.query("DELETE FROM repo_credentials WHERE id = ?", [credentialId]);
  return true;
}

// Test a credential by making a lightweight API call.
async function testCredential(credentialId, username) {
  const normUser = (username || "").toLowerCase().trim();
  const [rows] = await pool.query(
    "SELECT * FROM repo_credentials WHERE id = ? AND LOWER(username) = LOWER(?)",
    [credentialId, normUser]
  );
  if (!rows.length) throw new Error("Credential not found");
  const row = rows[0];
  let token;
  try {
    token = decrypt(row.encrypted_token, row.token_iv, row.token_tag);
  } catch {
    return { valid: false, error: "Failed to decrypt stored token" };
  }

  // Provider-specific test calls
  try {
    if (row.provider === "github") {
      let authHeader = `token ${token}`;
      let res = await fetch("https://api.github.com/user", {
        headers: { "Authorization": authHeader, "User-Agent": "Benevolate-App", "Accept": "application/vnd.github+json" }
      });
      if (!res.ok && res.status === 401) {
        authHeader = `Bearer ${token}`;
        res = await fetch("https://api.github.com/user", {
          headers: { "Authorization": authHeader, "User-Agent": "Benevolate-App", "Accept": "application/vnd.github+json" }
        });
      }
      if (res.ok) {
        const data = await res.json();
        let repos = [];
        try {
          const repoRes = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member", {
            headers: { 
              "Authorization": authHeader, 
              "User-Agent": "Benevolate-App",
              "Accept": "application/vnd.github+json" 
            }
          });
          if (repoRes.ok) {
            const repoData = await repoRes.json();
            // Filter to only include repositories where PAT has explicit access (pull/push/admin)
            repos = repoData
              .filter(r => r.permissions && (r.permissions.pull || r.permissions.push || r.permissions.admin))
              .map(r => ({
                id: r.id,
                name: r.name,
                full_name: r.full_name,
                private: r.private,
                default_branch: r.default_branch || "main"
              }));
          }
        } catch {}
        return { valid: true, identity: { login: data.login, name: data.name }, repos };
      }
      return { valid: false, error: `GitHub returned ${res.status}` };
    }
    if (row.provider === "gitlab") {
      const res = await fetch("https://gitlab.com/api/v4/user", {
        headers: { "Authorization": `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        return { valid: true, identity: { username: data.username, name: data.name } };
      }
      return { valid: false, error: `GitLab returned ${res.status}` };
    }
    return { valid: true, error: "Test not available for this provider" };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

async function getCredentialByProvider(username, provider) {
  const normUser = (username || "").toLowerCase().trim();
  const normProvider = (provider || "").toLowerCase().trim();
  const [rows] = await pool.query(
    `SELECT * FROM repo_credentials WHERE LOWER(username) = LOWER(?) AND LOWER(provider) = LOWER(?) ORDER BY created_at DESC LIMIT 1`,
    [normUser, normProvider]
  );
  if (!rows.length) return null;
  const row = rows[0];
  try {
    const token = decrypt(row.encrypted_token, row.token_iv, row.token_tag);
    return { ...row, token };
  } catch (e) {
    return null;
  }
}

async function deleteCredentialByProvider(username, provider) {
  const normUser = (username || "").toLowerCase().trim();
  const normProvider = (provider || "").toLowerCase().trim();
  await pool.query("DELETE FROM repo_credentials WHERE LOWER(username) = LOWER(?) AND LOWER(provider) = LOWER(?)", [normUser, normProvider]);
  return true;
}

// Resolve GitHub token for workspace operations:
// 1. User's personal stored token
// 2. Any system/admin stored GitHub PAT in repo_credentials
// 3. process.env.GITHUB_TOKEN
async function resolveGithubToken(username) {
  const normUser = (username || "").toLowerCase().trim();
  if (normUser) {
    try {
      const tok = await getCredential(normUser, "github");
      if (tok) return tok;
    } catch (_) {}
  }

  try {
    const [rows] = await pool.query(
      `SELECT encrypted_token, token_iv, token_tag FROM repo_credentials WHERE LOWER(provider) = 'github' ORDER BY created_at ASC LIMIT 1`
    );
    if (rows.length > 0) {
      const tok = decrypt(rows[0].encrypted_token, rows[0].token_iv, rows[0].token_tag);
      if (tok) return tok;
    }
  } catch (_) {}

  return process.env.GITHUB_TOKEN || "";
}

module.exports = {
  encrypt, decrypt, storeCredential, getCredential, getCredentialByProvider,
  listCredentials, deleteCredential, deleteCredentialByProvider, testCredential,
  resolveGithubToken
};

