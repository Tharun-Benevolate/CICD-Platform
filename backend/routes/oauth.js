// routes/oauth.js — GitHub OAuth App + Slack OAuth flow.
//
// GitHub OAuth: allows each user to connect their own GitHub account.
// Stores the access token encrypted in repo_credentials table.
//
// Slack OAuth: allows users to connect a Slack channel for notifications.
// Stores bot_token + channel_id per user.

const router       = require("express").Router();
const auth         = require("../middleware/auth");
const credManager  = require("../services/credentialManager");
const auditStore   = require("../stores/auditStore");

const GITHUB_CLIENT_ID     = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const GITHUB_CALLBACK_URL  = process.env.GITHUB_CALLBACK_URL || "http://localhost:3000/api/oauth/github/callback";

const SLACK_CLIENT_ID     = process.env.SLACK_CLIENT_ID;
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
const SLACK_REDIRECT_URI  = process.env.SLACK_REDIRECT_URI  || "http://localhost:3000/api/oauth/slack/callback";

const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";

// ── GitHub OAuth ──────────────────────────────────────────────────────────

// GET /api/oauth/github — Redirect user to GitHub authorization page
router.get("/oauth/github", auth.requireAuth, (req, res) => {
  if (!GITHUB_CLIENT_ID) {
    return res.status(503).json({ ok: false, error: "GitHub OAuth not configured. Set GITHUB_CLIENT_ID in .env" });
  }
  const params = new URLSearchParams({
    client_id:    GITHUB_CLIENT_ID,
    redirect_uri: GITHUB_CALLBACK_URL,
    scope:        "repo read:user read:org",
    state:        req.user.username, // used to associate callback with user
    prompt:       "consent" // Forces GitHub authorization & account consent screen every time!
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

// GET /api/oauth/github/callback — GitHub redirects here after user authorizes
router.get("/oauth/github/callback", auth.requireAuth, async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`/settings/integrations?oauth_error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    return res.redirect(`/settings/integrations?oauth_error=no_code`);
  }

  try {
    // Exchange code for access token
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id:     GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri:  GITHUB_CALLBACK_URL,
      }),
    });
    const tokenData = await tokenRes.json();

    if (tokenData.error || !tokenData.access_token) {
      return res.redirect(`/settings/integrations?oauth_error=${encodeURIComponent(tokenData.error_description || "token_exchange_failed")}`);
    }

    // Get GitHub identity
    const userRes = await fetch("https://api.github.com/user", {
      headers: { "Authorization": `Bearer ${tokenData.access_token}`, "Accept": "application/vnd.github+json" },
    });
    const ghUser = await userRes.json();

    // Store encrypted credential
    const username = (req.user?.username || state || "").toLowerCase().trim();
    await credManager.storeCredential(username, {
      provider:  "github",
      label:     `GitHub (@${ghUser.login})`,
      token:     tokenData.access_token,
      expiresAt: null, // GitHub OAuth tokens don't expire unless revoked
    });

    // Update user profile in users table with GitHub handle and avatar
    const userStore = require("../stores/userStore");
    if (username) {
      await userStore.updateGithubProfile(username, ghUser.login, ghUser.avatar_url || null);
      const freshUser = await userStore.getUser(username);
      if (freshUser) {
        const freshToken = auth.issueAuthToken(freshUser);
        res.cookie("auth_token", freshToken, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
        res.cookie("token", freshToken, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
      }
    }

    auditStore.logAction(username, "Connected GitHub account via OAuth", `@${ghUser.login}`, "Success");
    res.redirect(`/settings/integrations?github_connected=1`);
  } catch (err) {
    console.error("[oauth/github/callback]", err.message);
    res.redirect(`/settings/integrations?oauth_error=${encodeURIComponent(err.message)}`);
  }
});

// DELETE /api/oauth/github/disconnect
router.delete("/oauth/github/disconnect", auth.requireAuth, async (req, res) => {
  try {
    const { pool } = require("../config/db");
    const username = (req.user?.username || "").toLowerCase().trim();

    // 1. Delete from repo_credentials
    const [delRes] = await pool.query(
      "DELETE FROM repo_credentials WHERE LOWER(username) = ? AND (LOWER(provider) = 'github' OR LOWER(label) LIKE '%github%')",
      [username]
    );

    // 2. Reset github_username in users table
    await pool.query("UPDATE users SET github_username = NULL WHERE LOWER(username) = ?", [username]).catch(() => {});

    // 3. Refresh auth cookie session
    const userStore = require("../stores/userStore");
    const freshUser = await userStore.getUser(username);
    if (freshUser) {
      const freshToken = auth.issueAuthToken(freshUser);
      res.cookie("auth_token", freshToken, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
      res.cookie("token", freshToken, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
    }

    auditStore.logAction(username, "Disconnected GitHub OAuth", "", "Success");

    if (delRes.affectedRows === 0) {
      return res.status(404).json({ ok: false, error: "No active GitHub OAuth connection found to disconnect." });
    }

    res.json({ ok: true, message: "GitHub account disconnected successfully." });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Slack OAuth ───────────────────────────────────────────────────────────

// GET /api/oauth/slack — Redirect user to Slack authorization page
router.get("/oauth/slack", auth.requireAuth, (req, res) => {
  const clientId = process.env.SLACK_CLIENT_ID || SLACK_CLIENT_ID;
  const redirectUri = process.env.SLACK_REDIRECT_URI || SLACK_REDIRECT_URI;
  if (!clientId) {
    return res.status(503).json({ ok: false, error: "Slack OAuth not configured. Set SLACK_CLIENT_ID in .env" });
  }
  const username = auth.getLoggedInUser(req) || req.user?.username || "admin";
  const params = new URLSearchParams({
    client_id:    clientId,
    scope:        "chat:write,channels:read,channels:manage,groups:write,users:read,users:read.email",
    user_scope:   "channels:write,groups:write,channels:read,chat:write",
    redirect_uri: redirectUri,
    state:        username,
  });
  res.redirect(`https://slack.com/oauth/v2/authorize?${params}`);
});

// GET /api/oauth/slack/callback — Slack redirects here after user authorizes
router.get("/oauth/slack/callback", auth.requireAuth, async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.redirect(`/settings/integrations?slack_error=${encodeURIComponent(error)}`);
  if (!code)  return res.redirect("/settings/integrations?slack_error=no_code");

  const clientId = process.env.SLACK_CLIENT_ID || SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET || SLACK_CLIENT_SECRET;
  const redirectUri = process.env.SLACK_REDIRECT_URI || SLACK_REDIRECT_URI;

  try {
    const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id:     clientId,
        client_secret: clientSecret,
        code,
        redirect_uri:  redirectUri,
      }),
    });
    const tokenData = await tokenRes.json();

    if (!tokenData.ok) {
      return res.redirect(`/settings/integrations?slack_error=${encodeURIComponent(tokenData.error)}`);
    }

    const loggedInUser = auth.getLoggedInUser(req) || req.user?.username;
    const username = (loggedInUser || (state && state !== "undefined" ? state : "admin")).toLowerCase().trim();
    const botToken   = tokenData.access_token;
    const userToken  = tokenData.authed_user?.access_token || null;
    const slackUserId = tokenData.authed_user?.id || tokenData.user_id || null;
    const channelId  = tokenData.incoming_webhook?.channel_id || slackUserId || null;
    const channelName= tokenData.incoming_webhook?.channel    || "slack";

    await credManager.storeCredential(username, {
      provider:  "slack",
      label:     `Slack (@${username})`,
      token:     userToken || botToken,
      meta:      JSON.stringify({ slackUserId, channelId, channelName, botToken, userToken }),
      expiresAt: null,
    });

    const { pool } = require("../config/db");
    await pool.query("UPDATE users SET slack_id = ? WHERE LOWER(username) = ?", [slackUserId || channelId, username]).catch(() => {});

    // Refresh auth cookie session
    const userStore = require("../stores/userStore");
    const freshUser = await userStore.getUser(username);
    if (freshUser) {
      const freshToken = auth.issueAuthToken(freshUser);
      res.cookie("auth_token", freshToken, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
      res.cookie("token", freshToken, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
    }

    auditStore.logAction(username, "Connected Slack Account", channelName, "Success");

    // Automatically sync and backfill user into all existing project Slack channels
    const slackService = require("../services/slackService");
    slackService.syncUserToAllProjectSlackChannels(username).catch(() => {});

    res.redirect("/settings/integrations?slack_connected=1");
  } catch (err) {
    console.error("[oauth/slack/callback]", err.message);
    res.redirect(`/settings/integrations?slack_error=${encodeURIComponent(err.message)}`);
  }
});

// DELETE /api/oauth/slack/disconnect — Disconnect Slack integration
router.delete("/oauth/slack/disconnect", auth.requireAuth, async (req, res) => {
  try {
    const { pool } = require("../config/db");
    const username = (req.user?.username || "").toLowerCase().trim();

    // 1. Delete from repo_credentials
    const [delRes] = await pool.query(
      "DELETE FROM repo_credentials WHERE LOWER(username) = ? AND (LOWER(provider) = 'slack' OR LOWER(label) LIKE '%slack%')",
      [username]
    );

    // 2. Reset slack_id in users table
    await pool.query("UPDATE users SET slack_id = NULL WHERE LOWER(username) = ?", [username]).catch(() => {});

    // 3. Reset slack_webhook_url in notification_settings
    await pool.query("UPDATE notification_settings SET slack_webhook_url = NULL WHERE LOWER(user) = ?", [username]).catch(() => {});

    // 4. Refresh auth cookie session
    const userStore = require("../stores/userStore");
    const freshUser = await userStore.getUser(username);
    if (freshUser) {
      const freshToken = auth.issueAuthToken(freshUser);
      res.cookie("auth_token", freshToken, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
      res.cookie("token", freshToken, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
    }

    auditStore.logAction(username, "Disconnected Slack OAuth", "", "Success");

    if (delRes.affectedRows === 0) {
      return res.status(404).json({ ok: false, error: "No active Slack OAuth connection found to disconnect." });
    }

    res.json({ ok: true, message: "Slack workspace disconnected successfully." });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/slack/test — Send a test notification
router.post("/slack/test", auth.requireAuth, async (req, res) => {
  try {
    const cred = await credManager.getCredentialByProvider(req.user.username, "slack");
    if (!cred) return res.status(404).json({ ok: false, error: "No Slack connection found. Connect Slack first." });

    const meta = JSON.parse(cred.meta || "{}");
    const slackRes = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Authorization": `Bearer ${cred.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: meta.channelId || "#general",
        text:    `✅ Benevolate test notification from *${req.user.username}* — Slack integration is working!`,
      }),
    });
    const result = await slackRes.json();
    if (!result.ok) return res.status(500).json({ ok: false, error: result.error });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
