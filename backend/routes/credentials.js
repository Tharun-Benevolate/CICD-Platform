// routes/credentials.js — Per-user git credential management routes.
// Any authenticated user can manage their own credentials.

const router = require("express").Router();
const credentialManager = require("../services/credentialManager");
const auth = require("../middleware/auth");

// GET /api/my/credentials — list saved credentials (labels only, never the token)
router.get("/my/credentials", async (req, res) => {
  try {
    const username = auth.getLoggedInUser(req) || req.user?.username;
    if (!username) return res.json({ ok: true, credentials: [] });
    const creds = await credentialManager.listCredentials(username);
    res.json({ ok: true, credentials: creds });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/my/credentials/check-expiry — validate credentials & check expiration
router.get("/my/credentials/check-expiry", async (req, res) => {
  try {
    const username = auth.getLoggedInUser(req) || req.user?.username;
    if (!username) return res.json({ ok: true, credentialsCheck: [] });
    const creds = await credentialManager.listCredentials(username);
    const results = [];
    const now = Date.now();

    for (const cred of creds) {
      let isExpiringSoon = false;
      let isUrgentExpiry = false; // < 24h
      let daysLeft = null;

      if (cred.expires_at) {
        const expTime = new Date(cred.expires_at).getTime();
        const diffMs = expTime - now;
        daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
        if (diffMs <= 24 * 60 * 60 * 1000) {
          isUrgentExpiry = true;
          isExpiringSoon = true;
        } else if (diffMs <= 7 * 24 * 60 * 60 * 1000) {
          isExpiringSoon = true;
        }
      }

      // Test validity lightweight call if provider is github
      let testRes = { valid: true };
      if (cred.provider === "github") {
        testRes = await credentialManager.testCredential(cred.id, req.user.username).catch(() => ({ valid: false }));
      }

      results.push({
        id: cred.id,
        provider: cred.provider,
        label: cred.label,
        expiresAt: cred.expires_at,
        daysLeft,
        isExpiringSoon,
        isUrgentExpiry,
        valid: testRes.valid,
        identity: testRes.identity || null,
        repos: testRes.repos || []
      });
    }

    res.json({ ok: true, credentialsCheck: results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/my/credentials — save a new credential
router.post("/my/credentials", async (req, res) => {
  try {
    const { provider, token, credentialType, label, repositoryId, expiresAt } = req.body;
    if (!provider) return res.status(400).json({ ok: false, error: "provider is required" });
    if (!token)    return res.status(400).json({ ok: false, error: "token is required" });
    const VALID_PROVIDERS = ["github", "gitlab", "codecommit", "bitbucket", "azure_devops"];
    if (!VALID_PROVIDERS.includes(provider)) {
      return res.status(400).json({ ok: false, error: `provider must be one of: ${VALID_PROVIDERS.join(", ")}` });
    }
    const cred = await credentialManager.storeCredential(req.user.username, {
      provider, token, credentialType, label, repositoryId, expiresAt
    });
    res.json({ ok: true, credential: cred });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/my/credentials/:id — delete a credential (ownership verified)
router.delete("/my/credentials/:id", async (req, res) => {
  try {
    await credentialManager.deleteCredential(req.params.id, req.user.username);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.message.includes("not found") ? 404 : 500).json({ ok: false, error: err.message });
  }
});

// POST /api/my/credentials/:id/test — test a credential against the provider API
router.post("/my/credentials/:id/test", async (req, res) => {
  try {
    const result = await credentialManager.testCredential(req.params.id, req.user.username);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CLI Setup: CodeCommit Temporary Git Credentials & One-Click Clone Command
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// CLI Setup: CodeCommit / GitHub Temporary Git Credentials & One-Click Clone Command
// ─────────────────────────────────────────────────────────────────────────────

const activeTempCredentials = new Map(); // id -> sessionObj

// Helper to save temp CLI credential to DB for persistence across restarts/reloads
async function persistTempCredToDb(username, credObj) {
  try {
    const { pool } = require("../config/db");
    const normUser = (username || "").toLowerCase().trim();
    // Delete any existing temp CLI session for this user
    await pool.query(
      "DELETE FROM repo_credentials WHERE LOWER(username) = LOWER(?) AND label = 'Temp CLI Credential'",
      [normUser]
    ).catch(() => {});

    const metaStr = JSON.stringify({
      credId: credObj.id,
      repoName: credObj.repoName,
      provider: credObj.provider,
      region: credObj.region,
      gitUsername: credObj.gitUsername,
      gitPassword: credObj.gitPassword,
      rawGithubToken: credObj.rawGithubToken || null,
      oneClickCmd: credObj.oneClickCmd,
      iamUsername: credObj.iamUsername || null,
      clientIp: credObj.clientIp,
      durationMinutes: credObj.durationMinutes,
      expiresAt: credObj.expiresAt,
      createdAt: credObj.createdAt
    });

    const { encrypted, iv, tag } = credentialManager.encrypt(credObj.gitPassword || "temp");

    await pool.query(
      `INSERT INTO repo_credentials (id, username, provider, credential_type, encrypted_token, token_iv, token_tag, label, meta, expires_at)
       VALUES (?, ?, ?, 'pat', ?, ?, ?, 'Temp CLI Credential', ?, ?)`,
      [credObj.id, normUser, credObj.provider === 'github' ? 'github' : 'codecommit', encrypted, iv, tag, metaStr, new Date(credObj.expiresAt)]
    );
  } catch (e) {
    console.error("Notice persisting temp cred to DB:", e.message);
  }
}

// POST /api/codecommit/create-temp-credentials
router.post("/codecommit/create-temp-credentials", auth.requireAuth, async (req, res) => {
  try {
    const { repositoryId, durationMinutes } = req.body;
    const username = (auth.getLoggedInUser(req) || req.user?.username || "").toLowerCase().trim();
    if (!username) return res.status(401).json({ ok: false, error: "Authentication required" });

    const repoStore = require("../stores/repositoryStore");
    const projectStore = require("../stores/projectStore");
    const aws = require("../config/aws");
    const crypto = require("crypto");

    // Clean up any existing active temp credential for this user to prevent stacking multiple sessions
    for (const [existingId, existingCred] of activeTempCredentials.entries()) {
      if ((existingCred.username || "").toLowerCase() === username) {
        clearTimeout(existingCred.timer);
        if (existingCred.provider === "codecommit" && existingCred.iamUsername) {
          try {
            await aws.deleteServiceSpecificGitCredential(existingCred.region || "us-east-1", existingCred.iamUsername, existingCred.id);
          } catch (_) {}
        }
        activeTempCredentials.delete(existingId);
      }
    }

    let repo = null;
    let region = process.env.AWS_REGION || "us-east-1";

    if (repositoryId) {
      repo = await repoStore.getRepository(repositoryId);

      if (!repo) {
        const [allDbRepos] = await require("../config/db").pool.query(
          "SELECT * FROM repositories WHERE id = ? OR repo_name = ? OR owner = ?",
          [repositoryId, repositoryId, repositoryId]
        );
        if (allDbRepos && allDbRepos.length > 0) {
          repo = allDbRepos[0];
        }
      }

      if (!repo && (repositoryId.startsWith("p-") || req.body.projectId)) {
        const projId = repositoryId.startsWith("p-") ? repositoryId.replace(/^p-/, "") : req.body.projectId;
        const project = await projectStore.getProject(projId);
        if (project) {
          region = project.region || region;
          const isGh = !!project.githubRepo;
          repo = {
            id: repositoryId,
            repo_name: project.githubRepo || project.repoName || project.name,
            provider: isGh ? "github" : (project.sourceType || "codecommit"),
            clone_url: isGh ? `https://github.com/${project.githubRepo}.git` : `https://git-codecommit.${region}.amazonaws.com/v1/repos/${project.repoName || project.name}`
          };
        }
      } else if (repo) {
        const project = await projectStore.getProject(repo.project_id);
        if (project && project.region) region = project.region;
      }

      if (!repo) {
        return res.status(404).json({ ok: false, error: "Repository not found" });
      }
    }

    const duration = Math.min(Math.max(parseInt(durationMinutes) || 60, 5), 480);
    const userIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || req.socket.remoteAddress || "Unknown";
    const expiresAt = new Date(Date.now() + duration * 60 * 1000);
    const repoName = repo ? (repo.repo_name || repo.repoName || "repo") : "";
    const provider = repo ? (repo.provider || "codecommit") : "codecommit";

    let gitUsername = "";
    let gitPassword = "";
    let credId = "";
    let oneClickCmd = "";
    let iamUsername = "";

    if (provider === "github") {
      credId = "gh-" + crypto.randomUUID();
      const ephemeralToken = "ghtemp_" + crypto.randomBytes(16).toString("hex");

      const reposRouter = require("./repos");
      const { token: githubToken, source: tokenSource } = await reposRouter.resolveGithubTokenForRepo(req, repo);

      if (!githubToken) {
        return res.status(400).json({ ok: false, error: "No GitHub token found. Please authorize GitHub in Settings → Integrations." });
      }

      gitUsername = "x-access-token";
      gitPassword = ephemeralToken;

      const cleanGhRepo = repoName.endsWith(".git") ? repoName : `${repoName}.git`;
      const ghPath = cleanGhRepo.includes("/") ? cleanGhRepo : `${repo.owner || "repo"}/${cleanGhRepo}`;
      const hostHeader = req.headers["host"] || "beta.devops.benevolaite.com";
      const protocol = req.headers["x-forwarded-proto"] || "https";
      const cloneUrlWithToken = `${protocol}://${gitUsername}:${ephemeralToken}@${hostHeader}/git/${ghPath}`;
      oneClickCmd = `git clone ${cloneUrlWithToken}`;

      const sessionObj = {
        id: credId,
        username,
        provider: "github",
        repositoryId,
        repoName,
        repoOwner: repo.owner || ghPath.split("/")[0],
        region: "github.com",
        clientIp: userIp,
        gitUsername,
        gitPassword,
        rawGithubToken: githubToken,
        cloneUrl: cloneUrlWithToken,
        oneClickCmd,
        durationMinutes: duration,
        createdAt: new Date().toISOString(),
        expiresAt: expiresAt.toISOString()
      };

      const timer = setTimeout(() => {
        console.log(`[GitHub temp-cred] Expired session ${credId} for ${repoName}`);
        activeTempCredentials.delete(credId);
      }, duration * 60 * 1000);

      sessionObj.timer = timer;
      activeTempCredentials.set(credId, sessionObj);
      await persistTempCredToDb(username, sessionObj);

      return res.json({
        ok: true,
        credential: {
          id: credId,
          repoName,
          provider: "github",
          region: "github.com",
          gitUsername,
          gitPassword,
          cloneUrl: cloneUrlWithToken,
          oneClickCmd,
          clientIp: userIp,
          durationMinutes: duration,
          expiresAt: expiresAt.toISOString()
        }
      });

    } else {
      // CodeCommit Provider
      iamUsername = process.env.IAM_USERNAME || "";
      if (!iamUsername) {
        try {
          const { STSClient, GetCallerIdentityCommand } = require("@aws-sdk/client-sts");
          const sts = new STSClient({ region });
          const identity = await sts.send(new GetCallerIdentityCommand({}));
          if (identity && identity.Arn) {
            iamUsername = identity.Arn.split("/").pop();
          }
        } catch {}
      }
      if (!iamUsername) iamUsername = username;

      try {
        const cred = await aws.createServiceSpecificGitCredential(region, iamUsername);
        gitUsername = cred.gitUsername;
        gitPassword = cred.gitPassword;
        credId = cred.credentialId;
      } catch (awsErr) {
        if (awsErr.name === "LimitExceededException" || awsErr.Code === "LimitExceeded") {
          try {
            const { IAMClient, ListServiceSpecificCredentialsCommand, DeleteServiceSpecificCredentialCommand } = require("@aws-sdk/client-iam");
            const iam = new IAMClient({ region });
            const list = await iam.send(new ListServiceSpecificCredentialsCommand({ UserName: iamUsername, ServiceName: "codecommit.amazonaws.com" }));
            const sorted = (list.ServiceSpecificCredentials || []).sort((a, b) => new Date(a.CreateDate) - new Date(b.CreateDate));
            if (sorted.length > 0) {
              await iam.send(new DeleteServiceSpecificCredentialCommand({ UserName: iamUsername, ServiceSpecificCredentialId: sorted[0].ServiceSpecificCredentialId }));
              const retryCred = await aws.createServiceSpecificGitCredential(region, iamUsername);
              gitUsername = retryCred.gitUsername;
              gitPassword = retryCred.gitPassword;
              credId = retryCred.credentialId;
            } else {
              throw awsErr;
            }
          } catch (retryErr) {
            return res.status(500).json({ ok: false, error: "AWS IAM Git Credential Quota Exceeded: " + retryErr.message });
          }
        } else {
          return res.status(500).json({ ok: false, error: "Failed to generate AWS IAM Git Credentials: " + awsErr.message });
        }
      }

      const rawCloneUrl = (repo && repo.clone_url)
        || (repoName ? `https://git-codecommit.${region}.amazonaws.com/v1/repos/${repoName}` : null);
      if (rawCloneUrl) {
        const cleanUrl = rawCloneUrl.replace(/^https:\/\//i, "");
        const encodedUsername = encodeURIComponent(gitUsername);
        const encodedPassword = encodeURIComponent(gitPassword);
        const fullAuthenticatedUrl = `https://${encodedUsername}:${encodedPassword}@${cleanUrl}`;
        oneClickCmd = `git clone ${fullAuthenticatedUrl}`;
      }

      const sessionObj = {
        id: credId,
        username,
        provider: "codecommit",
        iamUsername,
        repositoryId,
        repoName,
        region,
        clientIp: userIp,
        gitUsername,
        gitPassword,
        oneClickCmd,
        rawCloneUrl,
        durationMinutes: duration,
        createdAt: new Date().toISOString(),
        expiresAt: expiresAt.toISOString()
      };

      const timer = setTimeout(async () => {
        try {
          const awsClient = require("../config/aws");
          await awsClient.deleteServiceSpecificGitCredential(region, iamUsername, credId);
        } catch (err) {
          console.error("Failed auto-destroying IAM credential:", err);
        }
        activeTempCredentials.delete(credId);
      }, duration * 60 * 1000);

      sessionObj.timer = timer;
      activeTempCredentials.set(credId, sessionObj);
      await persistTempCredToDb(username, sessionObj);

      return res.json({
        ok: true,
        credential: {
          id: credId,
          repoName,
          provider: "codecommit",
          region,
          gitUsername,
          gitPassword,
          oneClickCmd,
          clientIp: userIp,
          durationMinutes: duration,
          expiresAt: expiresAt.toISOString()
        }
      });
    }

  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/codecommit/temp-credentials — list active temporary credentials (memory + MySQL fallback)
router.get("/codecommit/temp-credentials", auth.requireAuth, async (req, res) => {
  try {
    const username = (auth.getLoggedInUser(req) || req.user?.username || "").toLowerCase().trim();
    if (!username) return res.json({ ok: true, credentials: [] });

    const nowMs = Date.now();
    const list = [];
    const seenIds = new Set();

    // 1. Check in-memory active temp credentials first
    for (const [id, cred] of activeTempCredentials.entries()) {
      if (new Date(cred.expiresAt).getTime() <= nowMs) {
        clearTimeout(cred.timer);
        if (cred.provider === "codecommit" && cred.iamUsername) {
          try {
            const awsClient = require("../config/aws");
            await awsClient.deleteServiceSpecificGitCredential(cred.region, cred.iamUsername, cred.id);
          } catch {}
        }
        activeTempCredentials.delete(id);
      } else if ((cred.username || "").toLowerCase() === username || req.user.user_type === "super_admin") {
        seenIds.add(cred.id);
        list.push({
          id: cred.id,
          repoName: cred.repoName,
          provider: cred.provider,
          region: cred.region,
          gitUsername: cred.gitUsername,
          gitPassword: cred.gitPassword,
          oneClickCmd: cred.oneClickCmd,
          clientIp: cred.clientIp,
          durationMinutes: cred.durationMinutes,
          expiresAt: cred.expiresAt,
          createdAt: cred.createdAt
        });
      }
    }

    // 2. Query MySQL database fallback for persistence across reloads/restarts
    const { pool } = require("../config/db");
    const [rows] = await pool.query(
      `SELECT id, username, meta, expires_at FROM repo_credentials
       WHERE LOWER(username) = LOWER(?) AND label = 'Temp CLI Credential' AND expires_at > NOW()
       ORDER BY created_at DESC`,
      [username]
    );

    for (const row of rows) {
      if (seenIds.has(row.id)) continue;
      try {
        const meta = JSON.parse(row.meta || "{}");
        seenIds.add(row.id);
        list.push({
          id: row.id,
          repoName: meta.repoName,
          provider: meta.provider,
          region: meta.region,
          gitUsername: meta.gitUsername,
          gitPassword: meta.gitPassword,
          oneClickCmd: meta.oneClickCmd,
          clientIp: meta.clientIp,
          durationMinutes: meta.durationMinutes,
          expiresAt: meta.expiresAt || (row.expires_at ? new Date(row.expires_at).toISOString() : null),
          createdAt: meta.createdAt
        });
      } catch (_) {}
    }

    res.json({ ok: true, credentials: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/codecommit/temp-credentials/:id — revoke/destroy temp credential immediately
router.delete("/codecommit/temp-credentials/:id", auth.requireAuth, async (req, res) => {
  try {
    const username = (auth.getLoggedInUser(req) || req.user?.username || "").toLowerCase().trim();
    const id = req.params.id;
    const { pool } = require("../config/db");

    // Fetch meta from DB first to get IAM info if CodeCommit
    const [rows] = await pool.query(
      "SELECT meta FROM repo_credentials WHERE id = ? AND LOWER(username) = LOWER(?)",
      [id, username]
    );

    if (rows.length > 0) {
      try {
        const meta = JSON.parse(rows[0].meta || "{}");
        if (meta.provider === "codecommit" && meta.iamUsername) {
          const aws = require("../config/aws");
          await aws.deleteServiceSpecificGitCredential(meta.region || "us-east-1", meta.iamUsername, id).catch(() => {});
        }
      } catch (_) {}
    }

    // Delete from DB and memory
    await pool.query("DELETE FROM repo_credentials WHERE id = ? AND LOWER(username) = LOWER(?)", [id, username]);

    const memCred = activeTempCredentials.get(id);
    if (memCred) {
      clearTimeout(memCred.timer);
      activeTempCredentials.delete(id);
    }

    res.json({ ok: true, message: "Temporary credential destroyed and access revoked." });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ALL /git/* — Ephemeral Git Smart HTTP Proxy for revocable temporary CLI credentials
router.all("/git/*", async (req, res) => {
  try {
    let token = "";
    const authHeader = req.headers["authorization"] || "";
    if (authHeader.startsWith("Basic ")) {
      const creds = Buffer.from(authHeader.split(" ")[1], "base64").toString("utf8");
      token = creds.split(":")[1] || creds.split(":")[0];
    } else if (req.query.token) {
      token = req.query.token;
    }

    let activeCred = null;
    if (token) {
      for (const [id, cred] of activeTempCredentials.entries()) {
        if (cred.gitPassword === token || cred.id === token) {
          if (new Date(cred.expiresAt).getTime() > Date.now()) {
            activeCred = cred;
          }
          break;
        }
      }
    }

    if (!activeCred) {
      const { pool } = require("../config/db");
      const [rows] = await pool.query(
        `SELECT meta FROM repo_credentials WHERE label = 'Temp CLI Credential' AND expires_at > NOW()`
      );
      for (const row of rows) {
        try {
          const meta = JSON.parse(row.meta || "{}");
          if (meta.gitPassword === token || meta.credId === token || meta.id === token) {
            if (new Date(meta.expiresAt).getTime() > Date.now()) {
              activeCred = meta;
            }
            break;
          }
        } catch (_) {}
      }
    }

    // Self-healing fallback: if activeCred exists but rawGithubToken was omitted from DB payload
    if (activeCred && !activeCred.rawGithubToken) {
      try {
        const reposRouter = require("./repos");
        const resolved = await reposRouter.resolveGithubTokenForRepo(null, { repo_name: activeCred.repoName, owner: activeCred.repoOwner });
        if (resolved && resolved.token) {
          activeCred.rawGithubToken = resolved.token;
        }
      } catch (_) {}
    }

    if (!activeCred || !activeCred.rawGithubToken) {
      return res.status(401).send("401 Unauthorized: Temporary CLI credential has been revoked or expired.");
    }

    const fetch = require("node-fetch");
    const subPath = req.url.replace(/^\/git/, "");
    const targetUrl = `https://github.com${subPath}`;

    const headers = { ...req.headers };
    delete headers.host;
    delete headers.authorization;

    const tok = activeCred.rawGithubToken;
    const initialAuth = tok.startsWith("gho_")
      ? Buffer.from(`${tok}:x-oauth-basic`).toString("base64")
      : Buffer.from(`x-access-token:${tok}`).toString("base64");

    headers["authorization"] = `Basic ${initialAuth}`;
    headers["user-agent"] = headers["user-agent"] || "git/2.40.0";

    const fetchOpts = {
      method: req.method,
      headers: headers
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
      fetchOpts.body = req;
    }

    let response = await fetch(targetUrl, fetchOpts);

    // Fallback retry if upstream GitHub rejects initial Auth format
    if (response.status === 401) {
      const altAuth = tok.startsWith("gho_")
        ? Buffer.from(`x-access-token:${tok}`).toString("base64")
        : Buffer.from(`${tok}:x-oauth-basic`).toString("base64");
      
      headers["authorization"] = `Basic ${altAuth}`;
      response = await fetch(targetUrl, {
        method: req.method,
        headers: headers,
        body: (req.method !== "GET" && req.method !== "HEAD") ? req : undefined
      });
    }

    res.status(response.status);
    response.headers.forEach((val, key) => res.setHeader(key, val));
    response.body.pipe(res);
  } catch (err) {
    res.status(500).send("500 Internal Server Error: " + err.message);
  }
});

module.exports = router;
