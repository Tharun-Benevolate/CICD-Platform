const express = require("express");
const router = express.Router();
const auth = require("../auth");
const store = require("../projectStore");
const { upsertProjectSecret, listProjectSecretKeys, deleteProjectSecret } = require("../aws");
const auditStore = require("../auditStore");
const { secretPrefixForProject, sanitizeSecretName, resolveSecretName } = require("../utils/projectNaming");

async function requireProject(req, res) {
  const proj = await store.getProject(req.params.projectId);
  if (!proj) {
    res.status(404).json({ ok: false, error: "Project not found" });
    return null;
  }
  return proj;
}

// GET /api/secrets/:projectId/name — returns the AWS secret name for this project.
// If the user already chose/saved a custom name, that name is returned and `locked: true`
// (it can't change without deleting the underlying AWS secret first). Otherwise this
// returns the auto-generated default as just a suggestion the user can overwrite before
// the first save.
router.get("/:projectId/name", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res);
    if (!project) return;
    const secretName = resolveSecretName(project);
    res.json({
      ok: true,
      secretName,
      locked: !!project.secretName,
      arn: project.secretArn || null
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/secrets/:projectId — list key names (no values)
router.get("/:projectId", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res);
    if (!project) return;
    const secretName = resolveSecretName(project);
    const keys = await listProjectSecretKeys(project.region || "us-east-1", secretName);
    res.json({ ok: true, keys });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/secrets/:projectId — upsert key-value pairs
// Body: { secrets: { KEY: value, ... }, secretName?: "custom/name" }
// `secretName` is only honored the FIRST time secrets are saved for this project (i.e.
// before project.secretName has been set). Once a name has been chosen it is locked in
// and reused for every future save/read/delete — we never silently rename or regenerate
// it, since that would orphan whatever is already in AWS Secrets Manager under the old name.
router.post("/:projectId", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res);
    if (!project) return;

    // We expect a flat object of secrets: { "DB_HOST": "...", "DB_PASSWORD": "..." }
    const newSecrets = req.body.secrets || {};
    if (Object.keys(newSecrets).length === 0) {
      return res.status(400).json({ ok: false, error: "No secrets provided" });
    }

    const region = project.region || "us-east-1";

    // Resolve (and, on first save, persist) the secret name.
    let secretNameToUse = project.secretName || null;
    if (!secretNameToUse) {
      const requested = sanitizeSecretName(req.body.secretName);
      secretNameToUse = requested || `${secretPrefixForProject(project)}/secrets`;
    }

    // To preserve existing secrets, we need to read them first (only on backend)
    // and merge with the new ones. But since this is a full upsert, the frontend
    // should send the full object (it doesn't have values, so maybe it's tricky? 
    // Wait, if frontend doesn't have values, it can't send them. 
    // So the API should just add/update the keys provided in the request body, 
    // and preserve existing ones.
    const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
    const secretsClient = new SecretsManagerClient({ region });

    let existingSecrets = {};
    try {
      const resp = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretNameToUse }));
      existingSecrets = JSON.parse(resp.SecretString || "{}");
    } catch(err) {
      if (err.name !== "ResourceNotFoundException") throw err;
    }

    const mergedSecrets = { ...existingSecrets, ...newSecrets };

    const arn = await upsertProjectSecret(region, secretNameToUse, mergedSecrets);

    // Lock in the name (only actually changes anything on the first save) and store the ARN.
    await store.updateProject(project.id, { secretName: secretNameToUse, secretArn: arn });

    auditStore.logAction(auth.getLoggedInUser(req), "Update Project Secrets", project.name, "Completed");
    res.json({ ok: true, arn, secretName: secretNameToUse, keys: Object.keys(mergedSecrets) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/secrets/:projectId/:key — remove a single key
router.delete("/:projectId/:key", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res);
    if (!project) return;
    const secretName = resolveSecretName(project);
    const keyToDelete = req.params.key;

    const region = project.region || "us-east-1";
    const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
    const secretsClient = new SecretsManagerClient({ region });

    let existingSecrets = {};
    try {
      const resp = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
      existingSecrets = JSON.parse(resp.SecretString || "{}");
    } catch(err) {
      if (err.name !== "ResourceNotFoundException") throw err;
    }

    if (existingSecrets[keyToDelete]) {
      delete existingSecrets[keyToDelete];
      await upsertProjectSecret(region, secretName, existingSecrets);
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
