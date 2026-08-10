// routes/credentials.js — Per-user git credential management routes.
// Any authenticated user can manage their own credentials.

const router = require("express").Router();
const credentialManager = require("../services/credentialManager");

// GET /api/my/credentials — list saved credentials (labels only, never the token)
router.get("/my/credentials", async (req, res) => {
  try {
    const creds = await credentialManager.listCredentials(req.user.username);
    res.json({ ok: true, credentials: creds });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/my/credentials/check-expiry — validate credentials & check expiration
router.get("/my/credentials/check-expiry", async (req, res) => {
  try {
    const creds = await credentialManager.listCredentials(req.user.username);
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

const activeTempCredentials = new Map(); // id -> { id, username, iamUsername, repositoryId, repoName, cloneUrl, oneClickCmd, clientIp, expiresAt, timer }

// POST /api/codecommit/create-temp-credentials
router.post("/codecommit/create-temp-credentials", async (req, res) => {
  try {
    const { repositoryId, durationMinutes } = req.body;
    // repositoryId is optional — when omitted we create CodeCommit IAM credentials
    // without a specific repo clone URL (they work for any repo in the account).

    const repoStore = require("../stores/repositoryStore");
    const projectStore = require("../stores/projectStore");
    const aws = require("../config/aws");
    const crypto = require("crypto");

    let repo = null;
    let region = process.env.AWS_REGION || "us-east-1";

    if (repositoryId) {
      repo = await repoStore.getRepository(repositoryId);

      if (!repo) {
        // Lookup by repo_name across active project or database
        const [allDbRepos] = await require("../config/db").pool.query(
          "SELECT * FROM repositories WHERE id = ? OR repo_name = ? OR owner = ?",
          [repositoryId, repositoryId, repositoryId]
        );
        if (allDbRepos && allDbRepos.length > 0) {
          repo = allDbRepos[0];
        }
      }

      // Handle synthesized project repository (e.g. p-<projectId>)
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

    const duration = Math.min(Math.max(parseInt(durationMinutes) || 60, 5), 480); // 5m to 8h
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

      // Resolve the actual GitHub token for this user
      let githubToken = process.env.GITHUB_TOKEN || "";
      try {
        const userToken = await credentialManager.getCredential(req.user.username, "github");
        if (userToken) githubToken = userToken;
      } catch (_) {}

      if (!githubToken) {
        return res.status(400).json({ ok: false, error: "No GitHub token found for this user. Please save a PAT in Settings → Git Credentials." });
      }

      gitUsername = "x-access-token";
      // Show only first 8 chars to the client — full token stored server-side for revocation
      gitPassword = githubToken;

      const cleanGhRepo = repoName.endsWith(".git") ? repoName : `${repoName}.git`;
      const ghPath = cleanGhRepo.includes("/") ? cleanGhRepo : `${repo.owner || "repo"}/${cleanGhRepo}`;
      const cloneUrlWithToken = `https://x-access-token:${githubToken}@github.com/${ghPath}`;
      oneClickCmd = `git clone ${cloneUrlWithToken}`;

      const sessionObj = {
        id: credId,
        username: req.user.username,
        provider: "github",
        repositoryId,
        repoName,
        repoOwner: repo.owner || ghPath.split("/")[0],
        region: "github.com",
        clientIp: userIp,
        gitUsername,
        gitPassword,
        rawGithubToken: githubToken,  // stored server-side only — used for revocation
        oneClickCmd,
        durationMinutes: duration,
        createdAt: new Date().toISOString(),
        expiresAt: expiresAt.toISOString()
      };

      // Auto-expire temp CLI credential session
      const timer = setTimeout(() => {
        console.log(`[GitHub temp-cred] Expired session ${credId} for ${repoName}`);
        activeTempCredentials.delete(credId);
      }, duration * 60 * 1000);

      sessionObj.timer = timer;
      activeTempCredentials.set(credId, sessionObj);

      return res.json({
        ok: true,
        credential: {
          id: credId,
          repoName,
          provider: "github",
          region: "github.com",
          gitUsername,
          gitPassword,
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
      if (!iamUsername) iamUsername = req.user.username;

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
        username: req.user.username,
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

// GET /api/codecommit/temp-credentials — list active temporary credentials
router.get("/codecommit/temp-credentials", async (req, res) => {
  const now = Date.now();
  const list = [];

  for (const [id, cred] of activeTempCredentials.entries()) {
    if (new Date(cred.expiresAt).getTime() <= now) {
      clearTimeout(cred.timer);
      try {
        const awsClient = require("../config/aws");
        await awsClient.deleteServiceSpecificGitCredential(cred.region, cred.iamUsername, cred.id);
      } catch {}
      activeTempCredentials.delete(id);
    } else if (cred.username === req.user.username || req.user.user_type === "super_admin") {
      list.push({
        id: cred.id,
        repoName: cred.repoName,
        region: cred.region,
        gitUsername: cred.gitUsername,
        oneClickCmd: cred.oneClickCmd,
        clientIp: cred.clientIp,
        durationMinutes: cred.durationMinutes,
        expiresAt: cred.expiresAt,
        createdAt: cred.createdAt
      });
    }
  }

  res.json({ ok: true, credentials: list });
});

// ── GitHub OAuth token revocation helper ─────────────────────────────────────
// Uses GitHub OAuth Apps API: DELETE /applications/{client_id}/token
// Requires GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET (HTTP Basic auth).
async function revokeGithubToken(token) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET not configured in .env — cannot revoke GitHub token.");
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(`https://api.github.com/applications/${clientId}/token`, {
    method: "DELETE",
    headers: {
      "Authorization": `Basic ${basicAuth}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ access_token: token })
  });

  // 204 = successfully revoked, 404 = already revoked / token unknown
  if (res.status !== 204 && res.status !== 404) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`GitHub revocation failed (${res.status}): ${body.message || "unknown error"}`);
  }
  return { revoked: true };
}

// DELETE /api/codecommit/temp-credentials/:id — revoke/destroy temp credential immediately
router.delete("/codecommit/temp-credentials/:id", async (req, res) => {
  const cred = activeTempCredentials.get(req.params.id);
  if (!cred) return res.status(404).json({ ok: false, error: "Credential session not found or already expired" });

  clearTimeout(cred.timer);

  if (cred.provider === "github") {
    // Destroy temporary CLI session only — do NOT revoke the user's primary OAuth connection
    console.log(`[GitHub temp-cred] Destroyed temp CLI session for ${cred.repoName}`);
  } else {
    // CodeCommit: delete IAM service-specific git credential
    if (cred.iamUsername) {
      const aws = require("../config/aws");
      await aws.deleteServiceSpecificGitCredential(cred.region || "us-east-1", cred.iamUsername, cred.id).catch(() => {});
    }
  }

  activeTempCredentials.delete(req.params.id);
  res.json({ ok: true, message: "Temporary credential destroyed and access revoked." });
});

module.exports = router;
