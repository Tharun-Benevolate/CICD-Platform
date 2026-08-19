const express = require("express");
const router = express.Router();
const auth = require("../auth");
const store = require("../projectStore");
const { upsertProjectSecret, listProjectSecretKeys, deleteProjectSecret } = require("../aws");
const auditStore = require("../auditStore");
const { secretPrefixForProject } = require("../utils/projectNaming");

async function requireProject(req, res) {
  const proj = await store.getProject(req.params.projectId);
  if (!proj) {
    res.status(404).json({ ok: false, error: "Project not found" });
    return null;
  }
  return proj;
}

// GET /api/secrets/:projectId/name — returns the auto-generated AWS secret name for this project
// This lets the UI show users exactly where their secrets are stored without them typing anything.
router.get("/:projectId/name", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res);
    if (!project) return;
    const prefix = secretPrefixForProject(project);
    res.json({ ok: true, secretName: `${prefix}/secrets`, prefix, arn: project.secretArn || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/secrets/:projectId — list key names (no values)
router.get("/:projectId", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res);
    if (!project) return;
    const prefix = getProjectPrefix(project);
    const keys = await listProjectSecretKeys(project.region || "us-east-1", prefix);
    res.json({ ok: true, keys });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/secrets/:projectId — upsert key-value pairs
router.post("/:projectId", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res);
    if (!project) return;
    const prefix = secretPrefixForProject(project);
    
    // We expect a flat object of secrets: { "DB_HOST": "...", "DB_PASSWORD": "..." }
    const newSecrets = req.body.secrets || {};
    if (Object.keys(newSecrets).length === 0) {
      return res.status(400).json({ ok: false, error: "No secrets provided" });
    }

    const region = project.region || "us-east-1";
    
    // To preserve existing secrets, we need to read them first (only on backend)
    // and merge with the new ones. But since this is a full upsert, the frontend
    // should send the full object (it doesn't have values, so maybe it's tricky? 
    // Wait, if frontend doesn't have values, it can't send them. 
    // So the API should just add/update the keys provided in the request body, 
    // and preserve existing ones.
    const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
    const secretsClient = new SecretsManagerClient({ region });
    const secretName = `${prefix}/secrets`;
    
    let existingSecrets = {};
    try {
      const resp = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
      existingSecrets = JSON.parse(resp.SecretString || "{}");
    } catch(err) {
      if (err.name !== "ResourceNotFoundException") throw err;
    }

    const mergedSecrets = { ...existingSecrets, ...newSecrets };

    const arn = await upsertProjectSecret(region, prefix, mergedSecrets);
    
    // Update project with the ARN
    await store.updateProject(project.id, { secretArn: arn });
    
    auditStore.logAction(auth.getLoggedInUser(req), "Update Project Secrets", project.name, "Completed");
    res.json({ ok: true, arn, keys: Object.keys(mergedSecrets) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/secrets/:projectId/:key — remove a single key
router.delete("/:projectId/:key", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res);
    if (!project) return;
    const prefix = secretPrefixForProject(project);
    const keyToDelete = req.params.key;

    const region = project.region || "us-east-1";
    const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
    const secretsClient = new SecretsManagerClient({ region });
    const secretName = `${prefix}/secrets`;

    let existingSecrets = {};
    try {
      const resp = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
      existingSecrets = JSON.parse(resp.SecretString || "{}");
    } catch(err) {
      if (err.name !== "ResourceNotFoundException") throw err;
    }

    if (existingSecrets[keyToDelete]) {
      delete existingSecrets[keyToDelete];
      await upsertProjectSecret(region, prefix, existingSecrets);
    }
    
    auditStore.logAction(auth.getLoggedInUser(req), `Delete Secret Key (${keyToDelete})`, project.name, "Completed");
    res.json({ ok: true, keys: Object.keys(existingSecrets) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/secrets/:projectId/restart — force-restarts ECS services so they pick up updated secret values.
// This avoids a full Terraform re-apply just for a secret value change.
// It does a zero-downtime rolling update: ECS stops old tasks and starts new ones which pull fresh secrets.
router.post("/:projectId/restart", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res);
    if (!project) return;

    if (!project.secretArn) {
      return res.status(400).json({ ok: false, error: "No secrets configured for this project yet." });
    }

    const { ECSClient, UpdateServiceCommand } = require("@aws-sdk/client-ecs");
    const region = project.region || "us-east-1";
    const ecsClient = new ECSClient({ region });

    const restarted = [];
    const failed = [];

    // Restart across all 3 environment clusters — only if the service name is known
    const services = [
      { cluster: project.ecsClusterNameNonProd, service: project.devServiceName,  env: "dev" },
      { cluster: project.ecsClusterNameNonProd, service: project.uatServiceName,  env: "uat" },
      { cluster: project.ecsClusterNameProd,    service: project.prodServiceName, env: "prod" },
    ];

    for (const { cluster, service, env } of services) {
      if (!cluster || !service) { failed.push(`${env} (not provisioned)`); continue; }
      try {
        await ecsClient.send(new UpdateServiceCommand({
          cluster,
          service,
          forceNewDeployment: true   // triggers rolling restart without changing task definition
        }));
        restarted.push(env);
      } catch (err) {
        failed.push(`${env}: ${err.message}`);
      }
    }

    auditStore.logAction(auth.getLoggedInUser(req), "Force Restart ECS (secret update)", project.name, "Completed");
    res.json({ ok: true, restarted, failed });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
