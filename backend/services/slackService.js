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
  let enabled = 1;

  try {
    const [rows] = await pool.query("SELECT * FROM slack_config WHERE id = 'global_slack'");
    if (rows.length > 0) {
      if (rows[0].dev_webhook_url) devUrl = rows[0].dev_webhook_url;
      if (rows[0].ops_webhook_url) opsUrl = rows[0].ops_webhook_url;
      if (rows[0].enabled !== undefined) enabled = rows[0].enabled;
    }
  } catch (err) {
    console.error("Error fetching slack config:", err.message);
  }

  return {
    dev_webhook_url: devUrl,
    ops_webhook_url: opsUrl,
    enabled
  };
}

/**
 * Get any active Slack Bot/OAuth token
 */
async function getAnySlackToken() {
  if (process.env.SLACK_BOT_TOKEN) return process.env.SLACK_BOT_TOKEN;
  try {
    const [rows] = await pool.query(
      "SELECT username FROM repo_credentials WHERE LOWER(provider) = 'slack' AND username != 'undefined' ORDER BY created_at DESC LIMIT 1"
    );
    if (rows.length > 0) {
      const cred = await credManager.getCredential(rows[0].username, 'slack');
      if (cred) return cred;
    }
    const [anyRows] = await pool.query(
      "SELECT encrypted_token, token_iv, token_tag FROM repo_credentials WHERE LOWER(provider) = 'slack' LIMIT 1"
    );
    if (anyRows.length > 0) {
      return credManager.decrypt(anyRows[0].encrypted_token, anyRows[0].token_iv, anyRows[0].token_tag);
    }
  } catch (err) {
    console.error("Error fetching Slack token:", err.message);
  }
  return null;
}

/**
 * Update global Slack Webhook configuration
 */
async function saveSlackConfig({ devWebhookUrl, opsWebhookUrl, enabled = 1 }) {
  const [existing] = await pool.query("SELECT id FROM slack_config WHERE id = 'global_slack'");
  if (existing.length > 0) {
    await pool.query(
      `UPDATE slack_config SET dev_webhook_url = ?, ops_webhook_url = ?, enabled = ? WHERE id = 'global_slack'`,
      [devWebhookUrl || null, opsWebhookUrl || null, enabled ? 1 : 0]
    );
  } else {
    await pool.query(
      `INSERT INTO slack_config (id, dev_webhook_url, ops_webhook_url, enabled) VALUES ('global_slack', ?, ?, ?)`,
      [devWebhookUrl || null, opsWebhookUrl || null, enabled ? 1 : 0]
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
 * Automatically invite a user's Slack account into a Slack channel
 */
async function autoJoinSlackChannel(channelId, username) {
  const creds = await getUserSlackCreds(username);
  const botToken = await getAnySlackToken();
  if (!botToken || !channelId) return false;

  // Default fallback for amruth/admin to U0BMKQJTTQU if user-specific cred not present
  const targetUserId = (creds && creds.slackUserId) ? creds.slackUserId : 'U0BMKQJTTQU';

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
    if (data.ok) {
      console.log(`✔ Successfully invited human user (@${username} / ${targetUserId}) to Slack channel ${channelId}`);
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
 * Ingest a Slack message tagged with @change, @channel change, !change, #change, or change:
 */
async function ingestSlackMessageAsChangeRequest({ slackChannelId, slackUserId, username, text }) {
  if (!text) return null;

  const isChangeMsg = /(@change|@changerequest|@channel\s+change|!change|#change|^change:)/i.test(text);
  if (!isChangeMsg) return null;

  try {
    // 1. Flexible Project Lookup: By channel_id, channel_name, active project, or latest project
    let projectId = null;
    let projectName = null;
    const [projRows] = await pool.query(
      "SELECT id, name FROM projects WHERE slack_channel_id = ? OR slack_channel_name = ? OR slack_channel_name LIKE ? OR is_active = 1 LIMIT 1",
      [slackChannelId, slackChannelId, `%${slackChannelId}%`]
    );
    if (projRows.length > 0) {
      projectId = projRows[0].id;
      projectName = projRows[0].name;
    } else {
      const [allProjs] = await pool.query("SELECT id, name FROM projects ORDER BY created_at ASC LIMIT 1");
      if (allProjs.length > 0) {
        projectId = allProjs[0].id;
        projectName = allProjs[0].name;
      }
    }

    if (!projectId) return null;

    // 2. Resolve repositoryId for project
    const repoStore = require("../stores/repositoryStore");
    const repos = await repoStore.listRepositories(projectId).catch(() => []);
    const repositoryId = repos.length > 0 ? repos[0].id : projectId;

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
    const existing = await crStore.listChangeRequests({ repositoryId, limit: 20 });
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

    console.log(`✔ Ingested Slack change request #${cr.id}: "${title}"`);
    return cr;
  } catch (err) {
    console.error("Error ingesting Slack message as Change Request:", err.message);
    return null;
  }
}

/**
 * Fetch recent messages from project Slack channels and backfill any @change tags
 */
async function syncSlackChannelMessages() {
  const token = await getAnySlackToken();
  if (!token) return { ok: false, error: "No Slack token available" };

  try {
    const [projects] = await pool.query(
      "SELECT id, name, slack_channel_id FROM projects WHERE slack_channel_id IS NOT NULL AND slack_channel_id != ''"
    );

    let channelIds = projects.map(p => p.slack_channel_id);
    try {
      const listRes = await fetch("https://slack.com/api/conversations.list?types=public_channel,private_channel", {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const listData = await listRes.json();
      if (listData.ok && Array.isArray(listData.channels)) {
        listData.channels.forEach(c => {
          if (!channelIds.includes(c.id)) channelIds.push(c.id);
        });
      }
    } catch (_) {}

    let ingestedCount = 0;

    for (const channelId of channelIds) {
      const historyRes = await fetch(`https://slack.com/api/conversations.history?channel=${channelId}&limit=50`, {
        headers: { "Authorization": `Bearer ${token}` }
      });
      const historyData = await historyRes.json();

      if (historyData.ok && Array.isArray(historyData.messages)) {
        for (const msg of historyData.messages) {
          if (msg.text && /(@change|@changerequest|@channel\s+change|!change|#change|^change:)/i.test(msg.text)) {
            const ingested = await ingestSlackMessageAsChangeRequest({
              slackChannelId: channelId,
              slackUserId: msg.user,
              username: msg.username || msg.user,
              text: msg.text
            });
            if (ingested) ingestedCount++;
          }
        }
      }
    }

    return { ok: true, count: ingestedCount };
  } catch (err) {
    console.error("Error syncing Slack channel messages:", err.message);
    return { ok: false, error: err.message };
  }
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

async function notifyPipelineExecution({ projectName, status, triggeredBy, branch = 'main', customWebhookUrl = null }) {
  const isSuccess = status.toLowerCase().includes('success') || status.toLowerCase().includes('complete');
  return sendSlackNotification({
    channelType: 'dev',
    customWebhookUrl,
    title: isSuccess ? '✅ Pipeline Succeeded' : '❌ Pipeline Alert',
    message: `Pipeline execution for *${projectName}* completed with status *${status}*.`,
    fields: [
      { title: "Project", value: projectName },
      { title: "Triggered By", value: `@${triggeredBy}` },
      { title: "Status", value: status },
      { title: "Branch", value: branch }
    ],
    color: isSuccess ? '#10b981' : '#ef4444'
  });
}

module.exports = {
  getSlackConfig,
  saveSlackConfig,
  getUserSlackCreds,
  sendSlackNotification,
  sendSlackDM,
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
  notifyPipelineExecution
};
