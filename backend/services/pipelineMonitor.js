// backend/services/pipelineMonitor.js
//
// Background service that polls ALL projects' AWS CodePipeline executions
// every 60 seconds. When a pipeline transitions to Succeeded or Failed,
// it fires a Slack notification via slackService.notifyPipelineExecution().
//
// Design notes:
//   - Keeps a lastSeenStatus map in memory (per executionId) so notifications
//     fire only ONCE per state change — no duplicate Slack messages.
//   - Extracts the failed stage name + error detail from getPipelineState()
//     so the Slack message contains a useful error message, not just "Failed".
//   - Resolves the human "triggered by" name from the execution trigger field.
//   - Safe to restart: it simply re-learns the current state on startup and
//     only alerts on NEW transitions.

const aws          = require("../config/aws");
const projectStore = require("../stores/projectStore");
const slackService = require("./slackService");

// Map of executionId → last known status so we don't fire duplicate alerts
const _seenStatuses = new Map();

// How often to poll (ms)
const POLL_INTERVAL_MS = 60 * 1000; // 60 seconds

/**
 * Extract a human-readable error message from the pipeline's stageStates.
 * Walks every stage and action looking for a Failed status and an error message.
 * Returns a string like:  "[Build > CodeBuild] Error: COMMAND_EXECUTION_ERROR ..."
 */
function extractErrorMessage(stageStates) {
  if (!Array.isArray(stageStates)) return null;

  const lines = [];
  for (const stage of stageStates) {
    for (const action of (stage.actionStates || [])) {
      const exec = action.latestExecution || {};
      if (exec.status === "Failed") {
        const stageName  = stage.stageName  || "Unknown Stage";
        const actionName = action.actionName || "Unknown Action";
        const errorMsg   = exec.errorDetails?.message || exec.summary || "No error details available";
        lines.push(`[${stageName} › ${actionName}] ${errorMsg}`);
      }
    }
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Resolve a friendly "triggered by" name from the execution's trigger metadata.
 * AWS returns values like:  { triggerType: "Webhook", triggerDetail: "arn:..." }
 * or                        { triggerType: "StartPipelineExecution", triggerDetail: "user@email" }
 */
function resolveTrigger(execution) {
  if (!execution) return "AWS CodePipeline";

  const trigger = execution.trigger || {};
  const detail  = trigger.triggerDetail || "";

  // Webhook triggers often carry the git committer email / GitHub actor in the detail
  if (detail && !detail.startsWith("arn:")) return detail;

  // Fall back to triggerType
  if (trigger.triggerType) return trigger.triggerType;

  return "AWS CodePipeline";
}

/**
 * Poll a single project's pipeline and send a Slack alert on status change.
 */
async function pollProject(project) {
  if (!project.pipelineName || !project.region) return;

  try {
    const [executions, stageStates] = await Promise.all([
      aws.listPipelineExecutions(project.region, project.pipelineName),
      aws.getPipelineState(project.region, project.pipelineName).catch(() => [])
    ]);

    if (!Array.isArray(executions) || executions.length === 0) return;

    // We only care about the most recent execution
    const latest = executions[0];
    const execId  = latest.pipelineExecutionId;
    const status  = latest.status; // "InProgress" | "Succeeded" | "Failed" | "Stopped" | "Superseded"

    // Skip non-terminal states — we don't notify for InProgress
    if (!["Succeeded", "Failed", "Stopped"].includes(status)) {
      // Still record it so we can detect transition later
      _seenStatuses.set(execId, status);
      return;
    }

    // Already notified for this exact execution + status combo
    if (_seenStatuses.get(execId) === status) return;

    // Record the new status before firing to prevent double-send on error
    _seenStatuses.set(execId, status);

    // Resolve triggered-by from the full execution details
    let triggeredBy = "AWS CodePipeline";
    try {
      const fullExec = await aws.getPipelineExecution(project.region, project.pipelineName, execId);
      triggeredBy    = resolveTrigger(fullExec);
    } catch (_) { /* non-fatal — use default */ }

    // Pull error message from stage states (only relevant on failure)
    const errorMsg = (status === "Failed" || status === "Stopped")
      ? extractErrorMessage(stageStates)
      : null;

    // Short build number: last 8 chars of executionId for readability
    const buildNumber = execId ? `#${execId.slice(-8)}` : "N/A";

    console.log(`[PipelineMonitor] ${project.name} | execution ${execId} → ${status}`);

    // ── Routing: project private channel → global #dev webhook (fallback) ──
    //
    // If the project has a provisioned Slack channel (e.g. #proj-boa-979),
    // post directly there using the bot token via chat.postMessage.
    // If not, fall back to the global SLACK_DEV_WEBHOOK_URL.
    const privateChannelId = project.slack_channel_id || project.slackChannelId || null;

    if (privateChannelId) {
      // Build the Block Kit payload manually so we can post via channel ID
      const isSuccess = status === "Succeeded";
      const title     = isSuccess ? "✅ Pipeline Succeeded" : "🚨 Pipeline Alert: Build Failed";
      const color     = isSuccess ? "#10b981" : "#ef4444";

      let messageText = `Pipeline execution for *${project.name}* completed with status *${status}*.`;
      if (!isSuccess && errorMsg) {
        messageText += `\n\n*Error Details:*\n\`\`\`\n${errorMsg}\n\`\`\``;
      }

      const fields = [
        { title: "Project",        value: project.name },
        { title: "Triggered By",   value: `@${triggeredBy}` },
        { title: "Build Number",   value: buildNumber },
        { title: "Branch",         value: project.githubBranch || "main" },
        { title: "Execution Code", value: execId || "N/A" }
      ];

      const payload = {
        text: title,
        attachments: [{
          color,
          blocks: [
            { type: "header",  text: { type: "plain_text", text: title, emoji: true } },
            { type: "section", text: { type: "mrkdwn", text: messageText } },
            {
              type: "section",
              fields: fields.map(f => ({ type: "mrkdwn", text: `*${f.title}:*\n${f.value}` }))
            }
          ]
        }]
      };

      await slackService.postToSlackChannelById(privateChannelId, payload);
      console.log(`[PipelineMonitor] Sent to private channel ${privateChannelId} (#${project.slack_channel_name || "project-channel"})`);
    } else {
      // No private channel — use global dev webhook via notifyPipelineExecution
      await slackService.notifyPipelineExecution({
        projectName:   project.name,
        status,
        triggeredBy,
        branch:        project.githubBranch || "main",
        buildNumber,
        executionCode: execId || "N/A",
        errorMsg
      });
      console.log(`[PipelineMonitor] Sent to global #dev webhook (no private channel for ${project.name})`);
    }

  } catch (err) {
    // Non-fatal — log and continue polling other projects
    console.error(`[PipelineMonitor] Error polling ${project.name}:`, err.message);
  }
}

/**
 * Main poll loop: fetches all projects and polls each one that has a pipeline.
 */
async function pollAllProjects() {
  try {
    const projects = await projectStore.listProjects();
    const withPipeline = projects.filter(p => p.pipelineName && p.region);

    if (withPipeline.length === 0) return;

    // Poll all projects concurrently but don't let one failure block others
    await Promise.allSettled(withPipeline.map(pollProject));
  } catch (err) {
    console.error("[PipelineMonitor] Failed to list projects:", err.message);
  }
}

/**
 * Start the background monitor.
 * Call this once from server.js after the app has started.
 */
function start() {
  console.log(`[PipelineMonitor] 🚀 Starting — polling every ${POLL_INTERVAL_MS / 1000}s`);

  // First poll after a short delay to allow server to fully boot
  setTimeout(pollAllProjects, 10 * 1000);

  // Then poll on the regular interval
  setInterval(pollAllProjects, POLL_INTERVAL_MS);
}

module.exports = { start };
