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

// Map of executionId -> last known status so we don't fire duplicate alerts
const _seenStatuses = new Map();
const _seenStageStatuses = new Map();

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

    // --- CHECK STAGE COMPLETIONS FOR UAT & PROD ---
    // Even if pipeline is InProgress, UAT or PROD might have just finished deploying.
    if (Array.isArray(stageStates)) {
      for (const stage of stageStates) {
        if (stage.stageName === "Deploy-UAT" || stage.stageName === "Deploy-Prod") {
          const stageStatus = stage.latestExecution?.status;
          const stageExecId = stage.latestExecution?.pipelineExecutionId;
          if (stageExecId && stageStatus === "Succeeded") {
            const key = `${stageExecId}-${stage.stageName}`;
            if (_seenStageStatuses.get(key) !== stageStatus) {
              _seenStageStatuses.set(key, stageStatus);
              
              const envName = stage.stageName === "Deploy-UAT" ? "UAT" : "PROD";
              
              // Find the reviewer by looking at the corresponding approval gate summary
              const approveStageName = envName === "UAT" ? "Approve-UAT" : "Approve-Prod";
              const approveStage = stageStates.find(s => s.stageName === approveStageName);
              let reviewer = "system";
              if (approveStage && approveStage.actionStates) {
                const action = approveStage.actionStates.find(a => a.actionName === "Approve");
                if (action?.latestExecution?.summary) {
                  // e.g. "Approved by john@example.com" or our API comment
                  reviewer = action.latestExecution.summary; 
                  // Fallback string manipulation if AWS prefixes it
                  if (reviewer.startsWith("Approved by ")) {
                    reviewer = "@" + reviewer.replace("Approved by ", "").split(". ")[0];
                  }
                }
              }

              // Resolve pipeline triggerer
              let triggeredBy = "AWS CodePipeline";
              try {
                // Check if execId is available to resolve the triggerer
                const fullExec = await aws.getPipelineExecution(project.region, project.pipelineName, stageExecId);
                triggeredBy = resolveTrigger(fullExec);
              } catch (_) {}

              const title     = `\u2705 Deployed to ${envName}: ${project.name}`;
              const color     = "#10b981";
              const msgText   = `Automated pipeline deployment to *${envName}* for *${project.name}* was successful.`;

              const stageFields = [
                { title: "Project",      value: project.name },
                { title: "Environment",  value: envName },
                { title: "Triggered By", value: triggeredBy },
                { title: "Approved By",  value: reviewer },
                { title: "Execution ID", value: stageExecId }
              ];

              // Build the same payload structure used for DEV notifications
              const stagePayload = {
                text: title,
                attachments: [{
                  color,
                  blocks: [
                    { type: "header",  text: { type: "plain_text", text: title, emoji: true } },
                    { type: "section", text: { type: "mrkdwn", text: msgText } },
                    {
                      type: "section",
                      fields: stageFields.map(f => ({ type: "mrkdwn", text: `*${f.title}:*\n${f.value}` }))
                    }
                  ]
                }]
              };

              // Post to private project channel (same bot DM where DEV notifications go)
              const privateChannelId = project.slack_channel_id || project.slackChannelId || null;
              if (privateChannelId) {
                const sent = await slackService.postToSlackChannelById(privateChannelId, stagePayload);
                console.log(`[PipelineMonitor] ${envName} stage alert -> private channel ${privateChannelId}: ${sent ? "\u2714 sent" : "\u2718 failed"}`);
              }

              // Also send to global ops webhook for visibility in integrate-devops-alerts
              slackService.sendOpsAlert({
                title,
                message: msgText,
                fields: stageFields,
                level: "success",
                link: "https://devops.benevolaite.com/pipelines"
              }).catch(() => {});

              console.log(`[PipelineMonitor] Sent automated ${envName} deployment success alert for ${project.name}`);
            }
          }
        }
      }
    }

    // Skip non-terminal states \u2014 we don't notify for InProgress
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

    // ── Routing: ALWAYS send to global webhook, ALSO send to private channel ──
    //
    // Step 1: Always fire to the global SLACK_DEV_WEBHOOK_URL (guaranteed delivery,
    //         no bot token needed — works as long as webhook is configured in .env).
    // Step 2: If the project has a private Slack channel AND a bot token is available,
    //         also post directly there via chat.postMessage.
    await slackService.notifyPipelineExecution({
      projectName:   project.name,
      status,
      triggeredBy,
      branch:        project.githubBranch || "main",
      buildNumber,
      executionCode: execId || "N/A",
      errorMsg
    });
    console.log(`[PipelineMonitor] Sent to global #dev webhook`);

    // Step 2: Also attempt private project channel if configured (best-effort)
    const privateChannelId = project.slack_channel_id || project.slackChannelId || null;
    if (privateChannelId) {
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

      const sent = await slackService.postToSlackChannelById(privateChannelId, payload);
      console.log(`[PipelineMonitor] Private channel ${privateChannelId}: ${sent ? "✔ sent" : "✘ failed (no bot token?)"}`);
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
