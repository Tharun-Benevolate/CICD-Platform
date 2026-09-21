// server/services/slackService.js
// Handles rich Slack notifications, DMs, automated project private channel creation, member invitations, and Ops sync.

const { pool } = require("../config/db");
const credManager = require("./credentialManager");

/**
 * Retrieve active Slack Webhook URLs from database or environment.
 */
async function getSlackConfig() {
  let devUrl = process.env.SLACK_DEV_WEBHOOK_URL || null;
  let opsUrl = process.env.SLACK_OPS_WEBHOOK_URL || null;
  let opsChannelId = null;
  let opsChannelName = null;
  let securityChannelId = null;
  let securityChannelName = null;
  let enabled = 1;

  try {
    const [rows] = await pool.query("SELECT * FROM slack_config WHERE id = 'global_slack'");
    if (rows.length > 0) {
      if (rows[0].dev_webhook_url) devUrl = rows[0].dev_webhook_url;
      if (rows[0].ops_webhook_url) opsUrl = rows[0].ops_webhook_url;
      if (rows[0].ops_channel_id) opsChannelId = rows[0].ops_channel_id;
      if (rows[0].ops_channel_name) opsChannelName = rows[0].ops_channel_name;
      if (rows[0].security_channel_id) securityChannelId = rows[0].security_channel_id;
      if (rows[0].security_channel_name) securityChannelName = rows[0].security_channel_name;
      if (rows[0].enabled !== undefined) enabled = rows[0].enabled;
    }
  } catch (err) {
    console.error("Error fetching slack config:", err.message);
  }

  return {
    dev_webhook_url: devUrl,
    ops_webhook_url: opsUrl,
    ops_channel_id: opsChannelId,
    ops_channel_name: opsChannelName,
    security_channel_id: securityChannelId,
    security_channel_name: securityChannelName,
    enabled
  };
}

/**
 * Get any active Slack Bot/OAuth token (prioritizes botToken for chat:write and channel management)
 */
async function getAnySlackToken() {
  if (process.env.SLACK_BOT_TOKEN) return process.env.SLACK_BOT_TOKEN;
  try {
    const [rows] = await pool.query(
      "SELECT username, meta FROM repo_credentials WHERE LOWER(provider) = 'slack' AND username != 'undefined' ORDER BY created_at DESC LIMIT 1"
    );
    if (rows.length > 0) {
      try {
        const meta = JSON.parse(rows[0].meta || "{}");
        if (meta.botToken) return meta.botToken;
      } catch (_) {}
      const cred = await credManager.getCredentialByProvider(rows[0].username, 'slack');
      if (cred && cred.token) return cred.token;
    }
    const [anyRows] = await pool.query(
      "SELECT encrypted_token, token_iv, token_tag, meta FROM repo_credentials WHERE LOWER(provider) = 'slack' LIMIT 1"
    );
    if (anyRows.length > 0) {
      try {
        const meta = JSON.parse(anyRows[0].meta || "{}");
        if (meta.botToken) return meta.botToken;
      } catch (_) {}
      return credManager.decrypt(anyRows[0].encrypted_token, anyRows[0].token_iv, anyRows[0].token_tag);
    }
  } catch (err) {
    console.error("Error fetching Slack token:", err.message);
  }
  return null;
}

/**
 * Update global Slack Webhook and System Channels configuration
 */
async function saveSlackConfig({
  devWebhookUrl,
  opsWebhookUrl,
  opsChannelId,
  opsChannelName,
  securityChannelId,
  securityChannelName,
  enabled = 1
}) {
  const [existing] = await pool.query("SELECT id FROM slack_config WHERE id = 'global_slack'");
  if (existing.length > 0) {
    await pool.query(
      `UPDATE slack_config 
       SET dev_webhook_url = ?, 
           ops_webhook_url = ?, 
           ops_channel_id = ?, 
           ops_channel_name = ?, 
           security_channel_id = ?, 
           security_channel_name = ?, 
           enabled = ? 
       WHERE id = 'global_slack'`,
      [
        devWebhookUrl || null,
        opsWebhookUrl || null,
        opsChannelId || null,
        opsChannelName || null,
        securityChannelId || null,
        securityChannelName || null,
        enabled ? 1 : 0
      ]
    );
  } else {
    await pool.query(
      `INSERT INTO slack_config (
        id, dev_webhook_url, ops_webhook_url, ops_channel_id, ops_channel_name, security_channel_id, security_channel_name, enabled
      ) VALUES ('global_slack', ?, ?, ?, ?, ?, ?, ?)`,
      [
        devWebhookUrl || null,
        opsWebhookUrl || null,
        opsChannelId || null,
        opsChannelName || null,
        securityChannelId || null,
        securityChannelName || null,
        enabled ? 1 : 0
      ]
    );
  }
  return true;
}

/**
 * Lookup Slack user credentials for direct messaging (DMs) & joining channels
 */
async function getUserSlackCreds(username) {
  if (!username) return null;
  const normUser = (username || "").toLowerCase().trim();
  try {
    const [rows] = await pool.query(
      `SELECT username, meta FROM repo_credentials WHERE LOWER(username) = ? AND LOWER(provider) = 'slack' LIMIT 1`,
      [normUser]
    );
    if (rows.length > 0) {
      const token = await credManager.getCredential(rows[0].username, 'slack');
      const meta = JSON.parse(rows[0].meta || "{}");
      return { 
        token, 
        userToken: meta.userToken || token, 
        botToken: meta.botToken || token, 
        channelId: meta.channelId, 
        slackUserId: meta.slackUserId || meta.channelId 
      };
    }

    // Fallback: check users table for slack_id
    const [userRows] = await pool.query(
      `SELECT slack_id FROM users WHERE LOWER(username) = ? LIMIT 1`,
      [normUser]
    );
    if (userRows.length > 0 && userRows[0].slack_id) {
      return { token: null, slackUserId: userRows[0].slack_id };
    }
  } catch (err) {
    console.error("Error fetching user Slack creds:", err.message);
  }
  return null;
}

/**
 * Dispatch a formatted Slack Block Kit message to a Webhook URL
 */
async function postToSlack(webhookUrl, payload) {
  if (!webhookUrl || !webhookUrl.startsWith("http")) return false;
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return response.ok;
  } catch (err) {
    console.error("Slack posting error:", err.message);
    return false;
  }
}

/**
 * Resolve external or local URL for direct quick actions and deep-linking
 */
function getAppUrl() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, "");
  if (process.env.SLACK_REDIRECT_URI) {
    try {
      return new URL(process.env.SLACK_REDIRECT_URI).origin;
    } catch (_) {}
  }
  return "http://localhost:3000";
}

/**
 * Dispatch formatted payload to either Slack Channel ID via Bot API or fallback to Webhook URL
 * Note: Never duplicates header text above attachments if rich card attachments are provided.
 */
async function postToSlackChannelOrWebhook({ channelId, webhookUrl, payload }) {
  const token = await getAnySlackToken();
  if (token && channelId) {
    try {
      const body = {
        channel: channelId,
        attachments: payload.attachments,
        blocks: payload.blocks
      };
      // Only include top-level text if there are NO attachments/blocks, or if explicitly provided non-empty
      if (payload.text && payload.text.trim().length > 0) {
        body.text = payload.text;
      }
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (data.ok) return true;
      console.warn(`[Slack postMessage to ${channelId} notice]:`, data.error);
    } catch (err) {
      console.error(`[Slack postMessage to ${channelId} error]:`, err.message);
    }
  }

  // Fallback to webhook
  if (webhookUrl) {
    return postToSlack(webhookUrl, payload);
  }
  return false;
}

/**
 * Post a Block Kit payload directly to a Slack channel by channel ID (e.g. C0123ABCDEF)
 * using the bot token via chat.postMessage — works for private project channels.
 */
async function postToSlackChannelById(channelId, payload) {
  if (!channelId) return false;
  const token = await getAnySlackToken();
  if (!token) {
    console.error("[Slack] No bot token available to post to channel:", channelId);
    return false;
  }
  try {
    const body = {
      channel: channelId,
      text: typeof payload === "string" ? payload : (payload.text || " "),
      attachments: payload.attachments || []
    };
    if (payload.blocks) body.blocks = payload.blocks;
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    return !!data.ok;
  } catch (err) {
    console.error("[Slack] postToSlackChannelById error:", err.message);
    return false;
  }
}

/**
 * Automatically invite a user's Slack account into a Slack channel
 */
async function autoJoinSlackChannel(channelId, username) {
  const creds = await getUserSlackCreds(username);
  const botToken = await getAnySlackToken();
  if (!botToken || !channelId) return false;

  let targetUserId = (creds && creds.slackUserId) ? creds.slackUserId : null;

  if (!targetUserId && username) {
    try {
      const [userRows] = await pool.query(
        `SELECT email, slack_id FROM users WHERE LOWER(username) = ? LIMIT 1`,
        [username.toLowerCase().trim()]
      );
      if (userRows.length > 0) {
        targetUserId = userRows[0].slack_id;
        if (!targetUserId && userRows[0].email) {
          const lookupRes = await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(userRows[0].email)}`, {
            headers: { "Authorization": `Bearer ${botToken}` }
          });
          const lookupData = await lookupRes.json();
          if (lookupData.ok && lookupData.user?.id) {
            targetUserId = lookupData.user.id;
            await pool.query("UPDATE users SET slack_id = ? WHERE LOWER(username) = ?", [targetUserId, username.toLowerCase().trim()]).catch(() => {});
          }
        }
      }
    } catch (_) {}
  }

  // Fallback for default test user
  if (!targetUserId && (username === "admin" || username === "amruth")) {
    targetUserId = 'U0BMKQJTTQU';
  }

  if (!targetUserId) return false;

  try {
    const res = await fetch("https://slack.com/api/conversations.invite", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${botToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ channel: channelId, users: targetUserId })
    });
    const data = await res.json();
    if (data.ok || data.error === "already_in_channel") {
      console.log(`✔ User (@${username} / ${targetUserId}) active in Slack channel ${channelId}`);
      return true;
    } else {
      console.log(`Notice inviting ${targetUserId} to channel ${channelId}:`, data.error);
    }
  } catch (err) {
    console.error("autoJoinSlackChannel error:", err.message);
  }
  return false;
}

/**
 * Send a Direct Message (DM) to a specific user's connected Slack account
 */
async function sendSlackDM(username, { title, message, fields = [], color = '#6366f1' }) {
  const creds = await getUserSlackCreds(username);
  const token = (creds && creds.token) || (await getAnySlackToken());
  const targetUserId = (creds && creds.slackUserId) ? creds.slackUserId : 'U0BMKQJTTQU';

  if (!token || !targetUserId) return false;

  try {
    const payload = {
      channel: targetUserId,
      text: `${title}: ${message}`,
      attachments: [
        {
          color,
          blocks: [
            { type: "header", text: { type: "plain_text", text: title, emoji: true } },
            { type: "section", text: { type: "mrkdwn", text: message } },
            ...(fields.length ? [{
              type: "section",
              fields: fields.map(f => ({ type: "mrkdwn", text: `*${f.title}:*\n${f.value}` }))
            }] : [])
          ]
        }
      ]
    };

    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (data.ok) {
      console.log(`✔ Direct DM successfully sent to @${username} (${targetUserId})`);
    } else {
      console.log(`Notice sending DM to @${username}:`, data.error);
    }
    return data.ok;
  } catch (err) {
    console.error(`Failed to send Slack DM to ${username}:`, err.message);
    return false;
  }
}

/**
 * Core notification dispatcher for targeted channels ('dev' | 'ops' | 'both' | custom project webhook)
 */
async function sendSlackNotification({ channelType = 'both', customWebhookUrl = null, title, message, fields = [], color = '#6366f1', link = null }) {
  const config = await getSlackConfig();
  if (!config || !config.enabled) return false;

  const blocks = [
    { type: "header", text: { type: "plain_text", text: title, emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: message } }
  ];

  if (fields.length > 0) {
    blocks.push({
      type: "section",
      fields: fields.map(f => ({ type: "mrkdwn", text: `*${f.title}:*\n${f.value}` }))
    });
  }

  if (link) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View in Benevolate Platform", emoji: true },
          url: link,
          style: "primary"
        }
      ]
    });
  }

  const payload = { attachments: [{ color, blocks }] };

  if (customWebhookUrl) {
    await postToSlack(customWebhookUrl, payload);
  }

  let successDev = false;
  let successOps = false;

  if ((channelType === 'dev' || channelType === 'both') && config.dev_webhook_url) {
    successDev = await postToSlack(config.dev_webhook_url, payload);
  }

  if ((channelType === 'ops' || channelType === 'both') && config.ops_webhook_url) {
    successOps = await postToSlack(config.ops_webhook_url, payload);
  }

  return successDev || successOps;
}

/**
 * Automatically sync and backfill user into all existing project Slack channels
 */
async function syncUserToAllProjectSlackChannels(username) {
  if (!username) return;
  try {
    const [projects] = await pool.query(
      "SELECT slack_channel_id FROM projects WHERE slack_channel_id IS NOT NULL AND slack_channel_id != ''"
    );
    for (const proj of projects) {
      await autoJoinSlackChannel(proj.slack_channel_id, username);
    }
  } catch (err) {
    console.error("Error syncing user to project Slack channels:", err.message);
  }
}

/**
 * Auto-invite all Admins and DevOps engineers into a Slack channel
 */
async function inviteAdminsAndDevOpsToChannel(channelId) {
  const token = await getAnySlackToken();
  if (!channelId) return;

  try {
    const [users] = await pool.query(
      "SELECT username FROM users WHERE user_type IN ('admin', 'super_admin', 'devops')"
    );

    for (const u of users) {
      await autoJoinSlackChannel(channelId, u.username);
    }
  } catch (err) {
    console.error("Notice inviting Admins/DevOps to Slack channel:", err.message);
  }
}

/**
 * 🤖 AUTOMATIC SLACK PRIVATE CHANNEL PROVISIONING
 * Automatically creates a Private Slack Channel for a newly created project (e.g. #proj-trading-app)
 * and automatically invites the creator, Admins, DevOps engineers, and assigned team members.
 */
async function autoProvisionProjectSlackChannel({ projectId, projectName, creator }) {
  // First attempt to use creator's connected Slack token, then any Slack token, then env SLACK_BOT_TOKEN
  const creatorCreds = creator ? await getUserSlackCreds(creator) : null;
  const token = (creatorCreds && (creatorCreds.userToken || creatorCreds.token)) || (await getAnySlackToken());

  if (!token) {
    console.log(`[Slack] Notice: No Slack token available to create channel for creator: @${creator}`);
    return null;
  }

  const sanitized = projectName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70);
  const channelName = `proj-${sanitized}`;
  let channelId = null;

  try {
    // 1. First, check if channel already exists in workspace
    try {
      const listRes = await fetch("https://slack.com/api/conversations.list?types=private_channel,public_channel", {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const listData = await listRes.json();
      if (listData.ok && Array.isArray(listData.channels)) {
        const match = listData.channels.find(c => c.name === channelName);
        if (match) {
          channelId = match.id;
          console.log(`✔ Found existing Slack channel #${channelName} (${channelId})`);
        }
      }
    } catch (_) {}

    // 2. If channel does not exist, create it as a STRICT PRIVATE channel (is_private: true)
    if (!channelId) {
      const response = await fetch("https://slack.com/api/conversations.create", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ name: channelName, is_private: true })
      });
      const data = await response.json();

      if (data.ok && data.channel) {
        channelId = data.channel.id;
        console.log(`✔ Successfully created Private Slack Channel #${channelName} (${channelId})`);
      } else if (data.error === 'name_taken') {
        try {
          const listRes = await fetch("https://slack.com/api/conversations.list?types=private_channel,public_channel", {
            headers: { "Authorization": `Bearer ${token}` }
          });
          const listData = await listRes.json();
          if (listData.ok && Array.isArray(listData.channels)) {
            const match = listData.channels.find(c => c.name === channelName);
            if (match) channelId = match.id;
          }
        } catch (_) {}
      } else {
        console.error(`[Slack Error] Failed to create private channel #${channelName}:`, data.error, data);
      }
    }

    if (channelId) {
      // Update both database columns AND project data JSON blob
      await pool.query(
        "UPDATE projects SET slack_channel_id = ?, slack_channel_name = ? WHERE id = ?",
        [channelId, channelName, projectId]
      );

      try {
        const projectStore = require("../stores/projectStore");
        await projectStore.updateProject(projectId, {
          slack_channel_id: channelId,
          slack_channel_name: channelName,
          slackChannelId: channelId,
          slackChannelName: channelName
        });
      } catch (_) {}

      console.log(`✔ Linked Private Slack channel #${channelName} (${channelId}) to project ${projectName}`);

      // Auto-invite creator immediately and send DM notification!
      if (creator) {
        await autoJoinSlackChannel(channelId, creator);
        await sendSlackDM(creator, {
          title: `🔒 Private Slack Channel #${channelName} Linked`,
          message: `Project *${projectName}* is linked to Private Channel *#${channelName}*. You have been added.`,
          fields: [
            { title: "Project Name", value: projectName },
            { title: "Slack Channel", value: `#${channelName}` }
          ],
          color: "#10b981"
        }).catch(() => {});
      }

      // Auto-invite all Admins & DevOps engineers into the private channel immediately
      await inviteAdminsAndDevOpsToChannel(channelId);

      sendSlackNotification({
        channelType: 'dev',
        title: `🚀 Project Private Slack Channel #${channelName} Active`,
        message: `Project *${projectName}* is linked to Private Slack channel *#${channelName}*.`,
        color: '#10b981'
      }).catch(() => {});

      return { channelId, channelName };
    } else {
      console.log("Slack channel provisioning notice: Channel ID could not be resolved");
    }
  } catch (err) {
    console.error("Failed to provision Private Slack channel:", err.message);
  }
  return null;
}

/**
 * 🛠️ SUPER ADMIN UTILITY: List all Slack workspace channels (public & private)
 * Cross-referenced with linked local projects and system alert channels.
 */
async function listAllSlackChannels() {
  const token = await getAnySlackToken();
  if (!token) return { ok: false, error: "No Slack token available. Please ensure Slack integration is connected." };

  try {
    const res = await fetch("https://slack.com/api/conversations.list?types=public_channel,private_channel&exclude_archived=false&limit=1000", {
      headers: { "Authorization": `Bearer ${token}` }
    });
    const data = await res.json();
    if (!data.ok) {
      return { ok: false, error: data.error || "Failed to retrieve Slack channels from workspace." };
    }

    // Cross-reference with database
    const [projects] = await pool.query("SELECT id, name, slack_channel_id, slack_channel_name FROM projects");
    const [configRows] = await pool.query("SELECT ops_channel_id, ops_channel_name, security_channel_id, security_channel_name FROM slack_config WHERE id = 'global_slack'");
    const config = configRows[0] || {};

    const enriched = (data.channels || []).map(ch => {
      let linked = [];
      if (ch.id === config.ops_channel_id) linked.push("DevOps Alerts (#integrate-devops-alerts)");
      if (ch.id === config.security_channel_id) linked.push("Security Alerts (#integrate-security-alerts)");
      const matchedProj = projects.find(p => p.slack_channel_id === ch.id);
      if (matchedProj) linked.push(`Project: ${matchedProj.name}`);

      return {
        id: ch.id,
        name: ch.name,
        is_private: !!ch.is_private,
        is_archived: !!ch.is_archived,
        num_members: ch.num_members || 0,
        topic: ch.topic ? ch.topic.value : "",
        purpose: ch.purpose ? ch.purpose.value : "",
        created: ch.created,
        linked: linked.length > 0 ? linked.join(", ") : "None"
      };
    });

    return { ok: true, channels: enriched };
  } catch (err) {
    console.error("[listAllSlackChannels]", err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * 🛠️ SUPER ADMIN UTILITY: Delete or archive a Slack workspace channel and unlink from platform
 */
async function deleteOrArchiveSlackChannel(channelId) {
  if (!channelId) return { ok: false, error: "Channel ID is required." };
  const token = await getAnySlackToken();
  if (!token) return { ok: false, error: "No Slack token available." };

  try {
    let mode = "deleted";
    // 1. Attempt hard permanent deletion via admin.conversations.delete
    const delRes = await fetch("https://slack.com/api/admin.conversations.delete", {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel_id: channelId })
    });
    const delData = await delRes.json();

    if (!delData.ok) {
      // Slack API blocks hard deletion on non-Enterprise workspaces; fallback to conversations.archive
      const archRes = await fetch("https://slack.com/api/conversations.archive", {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ channel: channelId })
      });
      const archData = await archRes.json();
      if (!archData.ok && archData.error !== "already_archived") {
        return { ok: false, error: `Slack API error: ${archData.error || delData.error}` };
      }
      mode = archData.error === "already_archived" ? "already_archived" : "archived";
    }

    // 2. Clean up local project mappings
    await pool.query(
      "UPDATE projects SET slack_channel_id = NULL, slack_channel_name = NULL WHERE slack_channel_id = ?",
      [channelId]
    );

    try {
      const projectStore = require("../stores/projectStore");
      const allProjects = await projectStore.listProjects();
      for (const p of allProjects) {
        if (p.slack_channel_id === channelId || p.slackChannelId === channelId) {
          await projectStore.updateProject(p.id, {
            slack_channel_id: null,
            slack_channel_name: null,
            slackChannelId: null,
            slackChannelName: null
          });
        }
      }
    } catch (_) {}

    // 3. Clean up global system alert mappings if linked
    const [configRows] = await pool.query("SELECT ops_channel_id, security_channel_id FROM slack_config WHERE id = 'global_slack'");
    if (configRows.length > 0) {
      const updates = [];
      if (configRows[0].ops_channel_id === channelId) {
        updates.push("ops_channel_id = NULL, ops_channel_name = NULL");
      }
      if (configRows[0].security_channel_id === channelId) {
        updates.push("security_channel_id = NULL, security_channel_name = NULL");
      }
      if (updates.length > 0) {
        await pool.query(`UPDATE slack_config SET ${updates.join(", ")} WHERE id = 'global_slack'`);
      }
    }

    const message = mode === "deleted"
      ? `Channel ${channelId} permanently deleted from Slack workspace.`
      : mode === "already_archived"
        ? `Channel ${channelId} was already archived. Local platform links have been purged.`
        : `Channel ${channelId} successfully archived and deactivated on Slack. Local platform links purged. (Note: Slack API reserves permanent deletion for Enterprise Grid Org Admin; channel is fully closed).`;

    return { ok: true, mode, message };
  } catch (err) {
    console.error("[deleteOrArchiveSlackChannel]", err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * 🤖 AUTOMATIC MEMBER INVITATION & AUTO-JOIN TO SLACK CHANNEL
 */
async function syncProjectMembersToSlackChannel({ projectId, assignedMembers = [] }) {
  if (!assignedMembers.length) return;

  const [rows] = await pool.query("SELECT slack_channel_id, slack_channel_name FROM projects WHERE id = ?", [projectId]);
  if (!rows.length || !rows[0].slack_channel_id) return;

  const channelId = rows[0].slack_channel_id;

  for (const username of assignedMembers) {
    await autoJoinSlackChannel(channelId, username);
  }
}

/**
 * 🤖 LATE-JOINER SLACK SYNC & BACKFILL
 */
async function syncUserToAllProjectSlackChannels(username) {
  const token = await getAnySlackToken();
  if (!token) return;

  try {
    const [userRows] = await pool.query("SELECT user_type FROM users WHERE username = ?", [username]);
    const userType = userRows.length ? userRows[0].user_type : 'developer';
    const isAdminOrDevops = ['admin', 'super_admin', 'devops'].includes(userType);

    let channelRows = [];
    if (isAdminOrDevops) {
      [channelRows] = await pool.query("SELECT slack_channel_id, slack_channel_name FROM projects WHERE slack_channel_id IS NOT NULL");
    } else {
      [channelRows] = await pool.query(
        `SELECT p.slack_channel_id, p.slack_channel_name
         FROM projects p
         JOIN developer_access da ON p.id = da.project_id
         WHERE da.username = ? AND p.slack_channel_id IS NOT NULL`,
        [username]
      );
    }

    for (const row of channelRows) {
      if (row.slack_channel_id) {
        await autoJoinSlackChannel(row.slack_channel_id, username);
      }
    }
    console.log(`✔ Backfilled and auto-joined user @${username} (${userType}) to ${channelRows.length} Slack project channels.`);
  } catch (err) {
    console.error(`Error backfilling Slack channels for ${username}:`, err.message);
  }
}

/**
 * Gather all available Slack OAuth tokens (User tokens + Bot tokens)
 */
async function getAllSlackTokens(preferredUsername = null) {
  const tokens = [];
  try {
    if (preferredUsername) {
      const userCreds = await getUserSlackCreds(preferredUsername);
      if (userCreds && (userCreds.userToken || userCreds.token)) {
        tokens.push(userCreds.userToken || userCreds.token);
      }
    }

    const [rows] = await pool.query(
      "SELECT username, meta FROM repo_credentials WHERE LOWER(provider) = 'slack'"
    );
    for (const r of rows) {
      const tok = await credManager.getCredential(r.username, 'slack');
      const meta = JSON.parse(r.meta || "{}");
      const uTok = meta.userToken || tok;
      const bTok = meta.botToken || tok;
      if (uTok && !tokens.includes(uTok)) tokens.push(uTok);
      if (bTok && !tokens.includes(bTok)) tokens.push(bTok);
    }
  } catch (e) {
    console.error("Error gathering Slack tokens:", e.message);
  }

  if (process.env.SLACK_BOT_TOKEN && !tokens.includes(process.env.SLACK_BOT_TOKEN)) {
    tokens.push(process.env.SLACK_BOT_TOKEN);
  }

  return tokens;
}

/**
 * Ingest a Slack message tagged with @change, @channel change, !change, #change, or change:
 */
async function ingestSlackMessageAsChangeRequest({ slackChannelId, slackUserId, username, text }) {
  if (!text) return null;

  const isChangeMsg = /(@change|@changerequest|@channel\s+change|!change|#change|^change:)/i.test(text);
  if (!isChangeMsg) return null;

  try {
    // 1. Flexible Project Lookup: By channel_id, channel_name, active project, or latest project
    let projectId = null;
    const [projRows] = await pool.query(
      "SELECT id, name FROM projects WHERE slack_channel_id = ? OR slack_channel_name = ? OR is_active = 1 ORDER BY is_active DESC LIMIT 1",
      [slackChannelId, slackChannelId]
    );
    if (projRows.length > 0) {
      projectId = projRows[0].id;
    } else {
      const [allProjs] = await pool.query("SELECT id FROM projects ORDER BY created_at ASC LIMIT 1");
      if (allProjs.length > 0) projectId = allProjs[0].id;
    }

    if (!projectId) return null;

    // 2. Resolve repositoryId for project
    const repoStore = require("../stores/repositoryStore");
    const repos = await repoStore.listRepositories(projectId).catch(() => []);
    let repositoryId = repos.length > 0 ? repos[0].id : null;
    if (!repositoryId) {
      const [anyRepo] = await pool.query("SELECT id FROM repositories LIMIT 1");
      if (anyRepo.length > 0) repositoryId = anyRepo[0].id;
      else repositoryId = projectId;
    }

    // 3. Clean message text (strip tags like @change, @channel, etc.)
    const cleanText = text
      .replace(/<@[A-Z0-9]+>/g, "")
      .replace(/@change(request)?/gi, "")
      .replace(/@channel\s+change/gi, "")
      .replace(/!change/gi, "")
      .replace(/#change/gi, "")
      .replace(/^change:/gi, "")
      .trim();

    if (!cleanText) return null;

    const firstLine = cleanText.split("\n")[0].trim();
    const title = firstLine.length > 60 ? firstLine.slice(0, 57) + "..." : (firstLine || "Slack Change Request");
    const description = cleanText;

    const authorName = username || (slackUserId ? `slack-${slackUserId}` : "slack-user");

    // 4. Prevent duplicate ingestion of same message
    const crStore = require("../stores/changeRequestStore");
    const existing = await crStore.listChangeRequests({ limit: 50 });
    const duplicate = existing.find(c => c.description && c.description.includes(description));
    if (duplicate) return duplicate;

    // 5. Create Change Request
    const cr = await crStore.createChangeRequest({
      repositoryId,
      branchId: null,
      title: `[Slack] ${title}`,
      description: `Submitted via Slack (@${authorName}):\n\n${description}`,
      author: authorName,
      baseBranch: "main",
      headBranch: `slack/cr-${Date.now().toString(36)}`,
      isQuickEdit: false
    });

    // Mark status as 'open' immediately
    await crStore.updateChangeRequest(cr.id, { status: "open" });

    console.log(`✔ Ingested Slack change request #${cr.id}: "${title}" for repository ${repositoryId}`);
    return cr;
  } catch (err) {
    console.error("Error ingesting Slack message as Change Request:", err.message);
    return null;
  }
}

/**
 * Fetch recent messages from project Slack channels using all connected user OAuth tokens
 */
async function syncSlackChannelMessages(loggedInUsername = null) {
  const tokens = await getAllSlackTokens(loggedInUsername);
  if (!tokens || tokens.length === 0) {
    return { ok: false, error: "No connected Slack OAuth tokens found" };
  }

  let totalIngested = 0;
  const processedMsgKeys = new Set();

  for (const token of tokens) {
    try {
      // List all public & private channels accessible by this token
      const listRes = await fetch("https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=100", {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const listData = await listRes.json();
      if (!listData.ok || !Array.isArray(listData.channels)) continue;

      for (const channel of listData.channels) {
        const channelId = channel.id;
        const historyRes = await fetch(`https://slack.com/api/conversations.history?channel=${channelId}&limit=50`, {
          headers: { "Authorization": `Bearer ${token}` }
        });
        const historyData = await historyRes.json();
        if (!historyData.ok || !Array.isArray(historyData.messages)) continue;

        for (const msg of historyData.messages) {
          const msgKey = `${channelId}:${msg.ts}:${msg.user}`;
          if (processedMsgKeys.has(msgKey)) continue;
          processedMsgKeys.add(msgKey);

          if (msg.text && /(@change|@changerequest|@channel\s+change|!change|#change|^change:)/i.test(msg.text)) {
            // Resolve real author name
            let authorName = msg.username || null;
            if (!authorName && msg.user) {
              try {
                const uRes = await fetch(`https://slack.com/api/users.info?user=${msg.user}`, {
                  headers: { "Authorization": `Bearer ${token}` }
                });
                const uData = await uRes.json();
                if (uData.ok && uData.user) {
                  authorName = uData.user.real_name || uData.user.name || uData.user.profile?.real_name || msg.user;
                }
              } catch (_) {}
            }

            const ingested = await ingestSlackMessageAsChangeRequest({
              slackChannelId: channelId,
              slackUserId: msg.user,
              username: authorName || msg.user,
              text: msg.text
            });
            if (ingested) totalIngested++;
          }
        }
      }
    } catch (tokenErr) {
      console.error("[Slack Sync Token Error]:", tokenErr.message);
    }
  }

  return { ok: true, count: totalIngested };
}

// ── Event Specific Notification Helpers ─────────────────────────────

async function notifyProjectAssignment({ projectName, creator, assignedMembers = [] }) {
  const formattedTags = assignedMembers.map(m => `@${m}`).join(', ');

  for (const member of assignedMembers) {
    sendSlackDM(member, {
      title: "🚀 New Project Assignment",
      message: `@${creator} assigned you to project *${projectName}*.`,
      fields: [
        { title: "Project Name", value: projectName },
        { title: "Assigned By", value: `@${creator}` }
      ],
      color: "#10b981"
    }).catch(() => {});
  }

  return sendSlackNotification({
    channelType: 'both',
    title: '🚀 New Project Assignment',
    message: `*@${creator}* created/updated project *${projectName}* and assigned members: ${formattedTags || 'None'}`,
    fields: [
      { title: "Project Name", value: projectName },
      { title: "Created By", value: `@${creator}` },
      { title: "Assigned Members", value: formattedTags || 'None' }
    ],
    color: '#10b981'
  });
}

async function notifyCodePush({ projectName, committer, branch = 'main', commitMsg, commitHash, customWebhookUrl = null }) {
  return sendSlackNotification({
    channelType: 'dev',
    customWebhookUrl,
    title: '💻 Code Pushed to Repository',
    message: `*@${committer}* committed code to *${projectName}* [${branch}].`,
    fields: [
      { title: "Project", value: projectName },
      { title: "Committer", value: `@${committer}` },
      { title: "Commit Message", value: commitMsg || "Code update" },
      { title: "Branch", value: branch }
    ],
    color: '#3b82f6'
  });
}

async function notifyChangeRequestSubmitted({ crId, title, requester, projectName, customWebhookUrl = null }) {
  return sendSlackNotification({
    channelType: 'both',
    customWebhookUrl,
    title: '📝 New Change Request Submitted',
    message: `*@${requester}* submitted Change Request *${title}* for review on project *${projectName}*.`,
    fields: [
      { title: "Change Request ID", value: `#${crId}` },
      { title: "Project", value: projectName || "N/A" },
      { title: "Submitted By", value: `@${requester}` },
      { title: "Action Needed", value: "Admins & DevOps Engineers Review Needed" }
    ],
    color: '#f59e0b'
  });
}

async function notifyChangeRequestApproved({ crId, title, approvedBy, requester, projectName, customWebhookUrl = null }) {
  if (requester) {
    sendSlackDM(requester, {
      title: "✅ Change Request Approved!",
      message: `@${approvedBy} approved your Change Request *${title}* on project *${projectName}*.`,
      fields: [
        { title: "Change Request", value: title },
        { title: "Approved By", value: `@${approvedBy}` }
      ],
      color: "#10b981"
    }).catch(() => {});
  }

  return sendSlackNotification({
    channelType: 'both',
    customWebhookUrl,
    title: '✅ Change Request Approved & Merged',
    message: `*@${approvedBy}* approved Change Request *${title}* submitted by *@${requester}*.`,
    fields: [
      { title: "Change Request", value: title },
      { title: "Project", value: projectName || "N/A" },
      { title: "Approved By", value: `@${approvedBy}` },
      { title: "Author", value: `@${requester}` }
    ],
    color: '#10b981'
  });
}

async function notifyPipelineExecution({ projectName, status, triggeredBy, branch = 'main', buildNumber = 'N/A', executionCode = 'N/A', errorMsg = null, customWebhookUrl = null }) {
  const isSuccess = status.toLowerCase().includes('success') || status.toLowerCase().includes('complete');
  
  const title = isSuccess ? '✅ Pipeline Succeeded' : '🚨 Pipeline Alert: Build Failed';
  const color = isSuccess ? '#10b981' : '#ef4444';
  
  let message = `Pipeline execution for *${projectName}* completed with status *${status}*.`;
  
  if (!isSuccess && errorMsg) {
    message = `Pipeline execution for *${projectName}* failed with status *${status}*.\n\n*Error Details:*\n\`\`\`\n${errorMsg}\n\`\`\``;
  }

  return sendSlackNotification({
    channelType: 'dev',
    customWebhookUrl,
    title: title,
    message: message,
    fields: [
      { title: "Project", value: projectName },
      { title: "Triggered By", value: `@${triggeredBy}` },
      { title: "Build Number", value: buildNumber },
      { title: "Branch", value: branch },
      { title: "Execution Code", value: executionCode }
    ],
    color: color
  });
}


/**
 * 🛡️ SYSTEM CHANNELS PROVISIONING
 * Automatically ensures dedicated private channels exist for:
 * 1. #integrate-security-alerts (Super Admin only)
 * 2. #integrate-devops-alerts (DevOps & Super Admin only)
 * Follows strict Slack naming standards (lowercase, hyphenated).
 */
async function ensureSystemSlackChannels() {
  const token = await getAnySlackToken();
  if (!token) {
    console.log("[Slack] Notice: No Slack bot token available yet to provision system channels.");
    return null;
  }

  const channelsToEnsure = [
    {
      name: "integrate-security-alerts",
      type: "security",
      allowedRoles: ["super_admin"],
      topic: "Benevolate Integrate — Security breach, 403 access violations & auth alerts"
    },
    {
      name: "integrate-devops-alerts",
      type: "ops",
      allowedRoles: ["super_admin", "devops"],
      topic: "Benevolate Integrate — Infrastructure, deployment gates & hourly telemetry digests"
    }
  ];

  let existingChannels = [];
  try {
    const listRes = await fetch("https://slack.com/api/conversations.list?types=private_channel,public_channel&limit=500", {
      headers: { "Authorization": `Bearer ${token}` }
    });
    const listData = await listRes.json();
    if (listData.ok && Array.isArray(listData.channels)) {
      existingChannels = listData.channels;
    }
  } catch (err) {
    console.warn("[Slack] Warning listing conversations:", err.message);
  }

  const resolved = {};

  for (const item of channelsToEnsure) {
    let channelId = null;
    const match = existingChannels.find(c => c.name === item.name);
    if (match) {
      channelId = match.id;
      console.log(`✔ Found existing Slack channel #${item.name} (${channelId})`);
    } else {
      try {
        const createRes = await fetch("https://slack.com/api/conversations.create", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ name: item.name, is_private: true })
        });
        const createData = await createRes.json();
        if (createData.ok && createData.channel) {
          channelId = createData.channel.id;
          console.log(`✔ Created private Slack channel #${item.name} (${channelId})`);
          await fetch("https://slack.com/api/conversations.setTopic", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${token}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ channel: channelId, topic: item.topic })
          }).catch(() => {});
        } else if (createData.error === "name_taken") {
          try {
            const retryList = await fetch("https://slack.com/api/conversations.list?types=private_channel,public_channel&limit=500", {
              headers: { "Authorization": `Bearer ${token}` }
            });
            const d = await retryList.json();
            const found = (d.channels || []).find(c => c.name === item.name);
            if (found) channelId = found.id;
          } catch (_) {}
        } else {
          console.warn(`[Slack] Could not create channel #${item.name}:`, createData.error);
        }
      } catch (err) {
        console.error(`[Slack] Error creating channel #${item.name}:`, err.message);
      }
    }

    if (channelId) {
      resolved[item.type] = { id: channelId, name: item.name };
      try {
        const placeholders = item.allowedRoles.map(() => "?").join(",");
        const [users] = await pool.query(
          `SELECT username, email, slack_id FROM users WHERE user_type IN (${placeholders})`,
          item.allowedRoles
        );
        for (const u of users) {
          await autoJoinSlackChannel(channelId, u.username);
        }
      } catch (err) {
        console.error(`[Slack] Error inviting users to #${item.name}:`, err.message);
      }
    }
  }

  // Persist into slack_config table
  if (resolved.ops?.id || resolved.security?.id) {
    const config = await getSlackConfig();
    await saveSlackConfig({
      devWebhookUrl: config.dev_webhook_url,
      opsWebhookUrl: config.ops_webhook_url,
      opsChannelId: resolved.ops?.id || config.ops_channel_id,
      opsChannelName: resolved.ops?.name || config.ops_channel_name,
      securityChannelId: resolved.security?.id || config.security_channel_id,
      securityChannelName: resolved.security?.name || config.security_channel_name,
      enabled: config.enabled
    });
  }

  return resolved;
}

/**
 * 🚨 SEND SECURITY ALERT
 * Dispatches critical security breach and access violation events
 * to #integrate-security-alerts (Super Admin only).
 */
async function sendSecurityAlert({ 
  actor = "Unknown", 
  action, 
  ip = "Unknown IP", 
  details = "", 
  severity = "critical", 
  link = null,
  endpoint = null,
  method = null,
  actionTaken = null
}) {
  const config = await getSlackConfig();
  if (!config || !config.enabled) return false;

  const appUrl = getAppUrl();
  const sevColors = {
    critical: "#dc2626",
    high:     "#ea580c",
    medium:   "#f59e0b",
    low:      "#3b82f6"
  };
  const sevEmojis = {
    critical: "🚨",
    high:     "⚠️",
    medium:   "🛡️",
    low:      "ℹ️"
  };

  const color = sevColors[severity.toLowerCase()] || "#dc2626";
  const emoji = sevEmojis[severity.toLowerCase()] || "🚨";

  const fields = [
    { type: "mrkdwn", text: `*Actor:*\n\`@${actor}\`` },
    { type: "mrkdwn", text: `*Severity:*\n*${severity.toUpperCase()}*` },
    { type: "mrkdwn", text: `*Client IP:*\n\`${ip}\`` },
    { type: "mrkdwn", text: `*Timestamp:*\n\`${new Date().toUTCString()}\`` }
  ];

  if (endpoint) {
    fields.push({
      type: "mrkdwn",
      text: `*Target URL / Action:*\n\`${method ? method + " " : ""}${endpoint}\``
    });
  }

  if (actionTaken) {
    fields.push({
      type: "mrkdwn",
      text: `*Enforcement Status:*\n*${actionTaken}*`
    });
  }

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: `${emoji} Security Alert: ${action}`, emoji: true }
    },
    {
      type: "section",
      fields
    }
  ];

  if (details) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Incident Details:*\n> ${details}` }
    });
  }

  const investigationUrl = link || `${appUrl}/audit-logs?search=${encodeURIComponent(actor)}`;

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "🔍 Investigate in Audit Logs", emoji: true },
        url: investigationUrl,
        style: "danger"
      }
    ]
  });

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `*Security Scope:* Benevolate Integrate Platform • Dedicated Super Admin Alert`
      }
    ]
  });

  const payload = {
    text: "",
    attachments: [{ color, blocks }]
  };

  return postToSlackChannelOrWebhook({
    channelId: config.security_channel_id,
    webhookUrl: config.ops_webhook_url || config.dev_webhook_url,
    payload
  });
}

/**
 * 🛠️ SEND DEVOPS / INFRA ALERT
 * Dispatches infrastructure state, pipeline gates, and ops notifications
 * to #integrate-devops-alerts (DevOps & Super Admin only).
 */
async function sendOpsAlert({ 
  project = null,
  projectName = null,
  title, 
  message, 
  fields = [], 
  level = "info", 
  link = null, 
  environment = null,
  customWebhookUrl = null 
}) {
  const config = await getSlackConfig();
  if (!config || !config.enabled) return false;

  const appUrl = getAppUrl();
  const resolvedProject = project || projectName || (fields.find(f => f.title?.toLowerCase() === "project")?.value) || "Platform / Global";
  const resolvedEnv = environment || (fields.find(f => f.title?.toLowerCase() === "environment")?.value) || "production";

  const levelColors = {
    info:    "#3b82f6",
    success: "#10b981",
    warn:    "#f59e0b",
    error:   "#ef4444"
  };
  const levelEmojis = {
    info:    "ℹ️",
    success: "✅",
    warn:    "⚠️",
    error:   "❌"
  };

  const color = levelColors[level.toLowerCase()] || "#3b82f6";
  const emoji = levelEmojis[level.toLowerCase()] || "🛠️";

  const defaultFields = [
    { type: "mrkdwn", text: `*Project Scope:*\n\`${resolvedProject}\`` },
    { type: "mrkdwn", text: `*Environment:*\n\`${resolvedEnv}\`` }
  ];

  // Add remaining caller fields that aren't already project/environment
  const extraFields = fields
    .filter(f => !["project", "environment"].includes(f.title?.toLowerCase()))
    .map(f => ({ type: "mrkdwn", text: `*${f.title}:*\n${f.value}` }));

  const allFields = defaultFields.concat(extraFields);

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: `${emoji} ${title}`, emoji: true }
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: message }
    },
    {
      type: "section",
      fields: allFields.slice(0, 10)
    }
  ];

  const projectUrl = link || `${appUrl}/pipelines?project=${encodeURIComponent(resolvedProject)}`;

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: `🚀 Open ${resolvedProject} in App`, emoji: true },
        url: projectUrl,
        style: level === "error" ? "danger" : "primary"
      },
      {
        type: "button",
        text: { type: "plain_text", text: "📊 Monitor App Metrics & Logs", emoji: true },
        url: `${appUrl}/monitoring?project=${encodeURIComponent(resolvedProject)}`
      }
    ]
  });

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `*DevOps Scope:* Benevolate Integrate • Dedicated DevOps & Super Admin Channel`
      }
    ]
  });

  const payload = {
    text: "",
    attachments: [{ color, blocks }]
  };

  return postToSlackChannelOrWebhook({
    channelId: config.ops_channel_id,
    webhookUrl: customWebhookUrl || config.ops_webhook_url,
    payload
  });
}

/**
 * ⏱️ SEND HOURLY TELEMETRY DIGEST
 * Queries the last 1 hour of platform activity from audit_log and posts a clean
 * summary card with CloudWatch deep-links instead of dumping raw file attachments.
 */
async function sendHourlyOpsDigest() {
  const config = await getSlackConfig();
  if (!config || !config.enabled) return false;

  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const [auditRows] = await pool.query(
      `SELECT category, result, action, project_name, username, timestamp
       FROM audit_log 
       WHERE timestamp >= ? 
       ORDER BY timestamp DESC`,
      [oneHourAgo]
    );

    const totalEvents = auditRows.length;
    const pipelines = auditRows.filter(r => r.category === "Pipeline Executions");
    const terraform = auditRows.filter(r => r.category === "Terraform");
    const securityDenials = auditRows.filter(r => r.category === "Access Control" || r.result === "Denied" || r.result === "Failed");
    const failedPipelines = pipelines.filter(r => r.result === "Failed" || (r.action && r.action.toLowerCase().includes("failed")));

    const recentFailures = auditRows.filter(r => r.result === "Failed" || r.result === "Denied").slice(0, 3);
    let failureSummary = "• None — all systems operating cleanly.";
    if (recentFailures.length > 0) {
      failureSummary = recentFailures.map(f => `• *[${f.category}]* ${f.action} (${f.project_name}) by @${f.username}`).join("\n");
    }

    const blocks = [
      {
        type: "header",
        text: { type: "plain_text", text: "⏱️ Benevolate Integrate — Hourly Operations Digest", emoji: true }
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `Summary of platform activity over the last 60 minutes (*${oneHourAgo.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}* - *${new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}*):` }
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Total Activity:* ${totalEvents} events` },
          { type: "mrkdwn", text: `*Pipeline Runs:* ${pipelines.length} (${failedPipelines.length} failed)` },
          { type: "mrkdwn", text: `*Terraform Operations:* ${terraform.length}` },
          { type: "mrkdwn", text: `*Security Denials / Warnings:* ${securityDenials.length}` }
        ]
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Recent Failure / Warning Signatures:*\n${failureSummary}` }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "View Live CloudWatch / ECS Logs", emoji: true },
            url: "https://devops.benevolaite.com/monitoring",
            style: failedPipelines.length > 0 ? "danger" : "primary"
          },
          {
            type: "button",
            text: { type: "plain_text", text: "View Audit Trail", emoji: true },
            url: "https://devops.benevolaite.com/audit-logs"
          }
        ]
      }
    ];

    const payload = {
      text: `⏱️ Hourly Operations Digest: ${totalEvents} events, ${failedPipelines.length} failures, ${securityDenials.length} warnings.`,
      attachments: [{
        color: failedPipelines.length > 0 ? "#ef4444" : (securityDenials.length > 0 ? "#f59e0b" : "#10b981"),
        blocks
      }]
    };

    return postToSlackChannelOrWebhook({
      channelId: config.ops_channel_id,
      webhookUrl: config.ops_webhook_url,
      payload
    });
  } catch (err) {
    console.error("[sendHourlyOpsDigest] Error generating digest:", err.message);
    return false;
  }
}

let _digestInterval = null;
function startHourlyDigestTimer() {
  if (_digestInterval) return;
  _digestInterval = setInterval(() => {
    sendHourlyOpsDigest().catch(err => console.error("[HourlyOpsDigest Timer Error]:", err.message));
  }, 60 * 60 * 1000);
}

/**
 * 🚀 NOTIFY PROJECT DEPLOYED LIVE
 * Dispatches live application URL to:
 * 1. Assigned project Slack channel (#proj-<name>)
 * 2. Direct Messages (DMs) to all assigned developers
 * 3. In-app notification table for every assigned developer
 */
async function notifyProjectDeployedLive({ projectName, environment = "dev", liveUrl = null, triggeredBy = "system" }) {
  if (!projectName) return false;
  const envLabel = environment.toUpperCase();
  const appUrl = getAppUrl();

  try {
    const [projRows] = await pool.query(
      `SELECT id, name, data, slack_channel_id, slack_channel_name FROM projects WHERE LOWER(name) = ? OR id = ? LIMIT 1`,
      [projectName.toLowerCase().trim(), projectName]
    );

    let resolvedLiveUrl = liveUrl;
    let projId = projectName;
    let projectChannelId = null;

    if (projRows.length > 0) {
      const p = projRows[0];
      projId = p.id;
      projectChannelId = p.slack_channel_id;
      const data = typeof p.data === "object" && p.data !== null ? p.data : JSON.parse(p.data || "{}");
      if (!resolvedLiveUrl) {
        resolvedLiveUrl = data[`${environment}Url`] || data.devUrl || (data.albDnsName ? `http://${data.albDnsName}/${environment}` : null) || `https://${environment}.${projectName.toLowerCase()}.benevolate.com`;
      }
    }

    if (!resolvedLiveUrl) {
      resolvedLiveUrl = `https://${environment}.${projectName.toLowerCase()}.benevolate.com`;
    }

    // Query all assigned developers / members for this project
    const [devRows] = await pool.query(
      `SELECT DISTINCT da.username, u.email, u.slack_id 
       FROM developer_access da 
       JOIN users u ON LOWER(da.username) = LOWER(u.username) 
       WHERE da.project_id = ? OR da.project_id = ?`,
      [projId, projectName]
    );

    let targetUsers = devRows;
    if (targetUsers.length === 0) {
      const [allDevs] = await pool.query(
        `SELECT username, email, slack_id FROM users WHERE user_type IN ('developer', 'devops')`
      );
      targetUsers = allDevs;
    }

    // Post to Project Slack Channel
    const blocks = [
      {
        type: "header",
        text: { type: "plain_text", text: `🎉 ${projectName} Deployed Live to ${envLabel}!`, emoji: true }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Your project *${projectName}* has been deployed and is actively listening for traffic in *${envLabel}*.\n\n🌐 *Live Application URL:*\n<${resolvedLiveUrl}|${resolvedLiveUrl}>`
        }
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Project Scope:*\n\`${projectName}\`` },
          { type: "mrkdwn", text: `*Environment:*\n\`${envLabel}\`` },
          { type: "mrkdwn", text: `*Triggered By:*\n\`@${triggeredBy}\`` },
          { type: "mrkdwn", text: `*Health Status:*\n*Active & Listening*` }
        ]
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "🚀 Open Live App", emoji: true },
            url: resolvedLiveUrl,
            style: "primary"
          },
          {
            type: "button",
            text: { type: "plain_text", text: "📊 Monitor App Metrics & Logs", emoji: true },
            url: `${appUrl}/monitoring?project=${encodeURIComponent(projectName)}`
          }
        ]
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `*Project Deployment Notification:* Benevolate Integrate • Team Alert`
          }
        ]
      }
    ];

    if (projectChannelId) {
      await postToSlackChannelOrWebhook({
        channelId: projectChannelId,
        payload: { text: "", attachments: [{ color: "#10b981", blocks }] }
      }).catch(() => {});
    }

    // In-App Notifications and Slack DMs for each assigned developer
    for (const dev of targetUsers) {
      const extId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO notifications (ext_id, recipient, type, title, body, link, is_read)
         VALUES (?, ?, 'deploy_completed', ?, ?, ?, 0)`,
        [
          extId,
          dev.username,
          `Project ${projectName} is Live (${envLabel})`,
          `Your assigned project ${projectName} was successfully deployed to ${envLabel} and is listening live at ${resolvedLiveUrl}`,
          resolvedLiveUrl
        ]
      ).catch(err => console.error("[notifyProjectDeployedLive Notif Error]:", err.message));

      await sendSlackDM(dev.username, {
        title: `🚀 ${projectName} is Live (${envLabel})`,
        message: `Your assigned project *${projectName}* has been successfully deployed to *${envLabel}*.\n\n🔗 *Live URL:* <${resolvedLiveUrl}|${resolvedLiveUrl}>`,
        fields: [
          { title: "Project", value: projectName },
          { title: "Environment", value: envLabel },
          { title: "Live URL", value: resolvedLiveUrl }
        ],
        color: "#10b981"
      }).catch(() => {});
    }

    return true;
  } catch (err) {
    console.error("[notifyProjectDeployedLive]", err.message);
    return false;
  }
}

module.exports = {
  getSlackConfig,
  saveSlackConfig,
  getUserSlackCreds,
  sendSlackNotification,
  sendSlackDM,
  postToSlackChannelById,
  autoJoinSlackChannel,
  autoProvisionProjectSlackChannel,
  syncProjectMembersToSlackChannel,
  syncUserToAllProjectSlackChannels,
  ingestSlackMessageAsChangeRequest,
  syncSlackChannelMessages,
  notifyProjectAssignment,
  notifyCodePush,
  notifyChangeRequestSubmitted,
  notifyChangeRequestApproved,
  notifyPipelineExecution,
  notifyProjectDeployedLive,
  ensureSystemSlackChannels,
  sendSecurityAlert,
  sendOpsAlert,
  sendHourlyOpsDigest,
  startHourlyDigestTimer,
  listAllSlackChannels,
  deleteOrArchiveSlackChannel
};
