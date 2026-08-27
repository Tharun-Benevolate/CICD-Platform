const express = require("express");
const router = express.Router();
const auth = require("../auth");
const store = require("../projectStore");
const { upsertProjectSecret, listProjectSecretKeys, deleteProjectSecret } = require("../aws");
const { updateBuildProjectEnvVars } = require("../config/aws");
const auditStore = require("../auditStore");
const { secretPrefixForProject, sanitizeSecretName, resolveSecretName, getSecretForEnv, resolveSecretNameForEnv } = require("../utils/projectNaming");

const VALID_ENVS = ["dev", "uat", "prod"];

// ── Push per-env secret ARNs + keys into CodeBuild env vars ────────────────
// CodeBuild gets: SECRET_ARN_DEV, SECRET_KEYS_DEV, SECRET_ARN_UAT, etc.
// Also pushes cluster names and execution role so the buildspec can register
// task def revisions with proper Secrets Manager references per env.
async function syncSecretsToCodeBuild(project) {
  if (!project.buildProjectName) return;
  const envVars = {};
  let hasAny = false;

  for (const env of VALID_ENVS) {
    const cfg = getSecretForEnv(project, env);
    const upper = env.toUpperCase();
    if (cfg && cfg.arn) {
      envVars[`SECRET_ARN_${upper}`] = cfg.arn;
      envVars[`SECRET_KEYS_${upper}`] = JSON.stringify(cfg.keys || []);
      hasAny = true;
    } else {
      // Clear stale env vars for this env
      envVars[`SECRET_ARN_${upper}`] = "";
      envVars[`SECRET_KEYS_${upper}`] = "[]";
    }
  }

  // Also clear legacy single-secret vars if they exist
  envVars["SECRET_ARN"] = "";
  envVars["SECRET_KEYS"] = "[]";

  // Push cluster names so the buildspec can look up the current task def per env
  if (project.ecsClusterNameNonProd) envVars["ECS_CLUSTER_NAME_NON_PROD"] = project.ecsClusterNameNonProd;
  if (project.ecsClusterNameProd)    envVars["ECS_CLUSTER_NAME_PROD"]     = project.ecsClusterNameProd;

  // Push service names so the buildspec can look up the correct service per env
  if (project.devServiceName)  envVars["DEV_SERVICE_NAME"]  = project.devServiceName;
  if (project.uatServiceName)  envVars["UAT_SERVICE_NAME"]  = project.uatServiceName;
  if (project.prodServiceName) envVars["PROD_SERVICE_NAME"] = project.prodServiceName;

  // Push execution role ARN (needed for RegisterTaskDefinition in buildspec)
  if (project.ecsExecutionRoleArn) envVars["EXECUTION_ROLE_ARN"] = project.ecsExecutionRoleArn;

  if (!hasAny) {
    // Even with no secrets, push cluster/service/role names so the buildspec
    // can still register task defs (with empty secrets array) correctly.
    if (!project.ecsClusterNameNonProd && !project.ecsClusterNameProd) return;
  }

  try {
    await updateBuildProjectEnvVars(project.region || "us-east-1", project.buildProjectName, envVars);
  } catch (e) {
    console.warn(`[secrets] Could not update CodeBuild env vars for ${project.buildProjectName}:`, e.message);
  }
}

async function requireProject(req, res) {
  const proj = await store.getProject(req.params.projectId);
  if (!proj) {
    res.status(404).json({ ok: false, error: "Project not found" });
    return null;
  }
  return proj;
}

function validateEnv(env) {
  return VALID_ENVS.includes(env) ? env : null;
}

// ── GET /api/secrets/:projectId/names — returns all env secret names + lock status ──
router.get("/:projectId/names", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res);
    if (!project) return;

    const result = {};
    for (const env of VALID_ENVS) {
      const cfg = getSecretForEnv(project, env);
      let locked = !!cfg;
      let name = cfg ? cfg.name : resolveSecretNameForEnv(project, env);

      // Verify the secret still exists in AWS (unless we just generated a default name)
      if (locked && cfg.arn) {
        try {
          const { SecretsManagerClient, DescribeSecretCommand } = require("@aws-sdk/client-secrets-manager");
          const sm = new SecretsManagerClient({ region: project.region || "us-east-1" });
          const desc = await sm.send(new DescribeSecretCommand({ SecretId: cfg.arn }));
          // Also treat scheduled-for-deletion secrets as gone
          if (desc.DeletedDate) {
            const updatedSecrets = { ...project.secrets, [env]: null };
            await store.updateProject(project.id, { secrets: updatedSecrets });
            locked = false;
            name = resolveSecretNameForEnv(project, env);
          }
        } catch (err) {
          if (err.name === "ResourceNotFoundException" || err.name === "InvalidRequestException") {
            // Secret deleted/marked for deletion — clear stale reference
            const updatedSecrets = { ...project.secrets, [env]: null };
            await store.updateProject(project.id, { secrets: updatedSecrets });
            locked = false;
            name = resolveSecretNameForEnv(project, env);
          }
        }
      }

      result[env] = { name, locked, arn: locked ? cfg.arn : null };
    }

    res.json({ ok: true, environments: result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/secrets/:projectId/values/:env — read current secret VALUES for editing ──
router.get("/:projectId/values/:env", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res);
    if (!project) return;
    const env = validateEnv(req.params.env);
    if (!env) return res.status(400).json({ ok: false, error: "Invalid environment. Use dev, uat, or prod." });

    const cfg = getSecretForEnv(project, env);
    if (!cfg || !cfg.arn) {
      return res.json({ ok: true, values: {}, exists: false });
    }

    const region = project.region || "us-east-1";
    const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
    const secretsClient = new SecretsManagerClient({ region });

    let values = {};
    try {
      const resp = await secretsClient.send(new GetSecretValueCommand({ SecretId: cfg.name }));
      values = JSON.parse(resp.SecretString || "{}");
    } catch (err) {
      if (err.name === "ResourceNotFoundException" || err.name === "InvalidRequestException") {
        // Secret deleted — clear stale reference
        const updatedSecrets = { ...project.secrets, [env]: null };
        await store.updateProject(project.id, { secrets: updatedSecrets });
        return res.json({ ok: true, values: {}, exists: false });
      }
      throw err;
    }

    const user = auth.getLoggedInUser(req) || "unknown";
    auditStore.logAction(user, `Read ${env} secret values (${Object.keys(values).length} keys)`, project.name, "Success", "Secrets");

    res.json({ ok: true, values, exists: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/secrets/:projectId/values — legacy: returns dev values (backward compat) ──
router.get("/:projectId/values", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  // Redirect to dev values for backward compatibility
  req.params.env = "dev";
  return router.handle(req, res);
});

// ── GET /api/secrets/:projectId — list key names for dev (backward compat) ──
router.get("/:projectId", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res);
    if (!project) return;
    const env = "dev";
    const cfg = getSecretForEnv(project, env);
    if (!cfg || !cfg.name) return res.json({ ok: true, keys: [] });
    const keys = await listProjectSecretKeys(project.region || "us-east-1", cfg.name);
    res.json({ ok: true, keys });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/secrets/:projectId/keys/:env — list key names for a specific env ──
router.get("/:projectId/keys/:env", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res);
    if (!project) return;
    const env = validateEnv(req.params.env);
    if (!env) return res.status(400).json({ ok: false, error: "Invalid environment." });

    const cfg = getSecretForEnv(project, env);
    if (!cfg || !cfg.name) return res.json({ ok: true, keys: [] });
    const keys = await listProjectSecretKeys(project.region || "us-east-1", cfg.name);
    res.json({ ok: true, keys });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/secrets/:projectId — upsert secrets for a specific env ──
// Body: { env: "dev"|"uat"|"prod", secrets: { KEY: value, ... }, secretName?: "custom/name" }
router.post("/:projectId", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res);
    if (!project) return;

    const env = validateEnv(req.body.env);
    if (!env) return res.status(400).json({ ok: false, error: "env is required (dev, uat, or prod)." });

    const newSecrets = req.body.secrets || {};
    if (Object.keys(newSecrets).length === 0) {
      return res.status(400).json({ ok: false, error: "No secrets provided." });
    }

    const region = project.region || "us-east-1";

    // Resolve secret name for this env
    const existingCfg = getSecretForEnv(project, env);
    let secretNameToUse = existingCfg ? existingCfg.name : null;
    if (!secretNameToUse) {
      const requested = sanitizeSecretName(req.body.secretName);
      secretNameToUse = requested || resolveSecretNameForEnv(project, env);
    }

    const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
    const secretsClient = new SecretsManagerClient({ region });

    // Read existing values to merge
    let existingSecrets = {};
    try {
      const resp = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretNameToUse }));
      existingSecrets = JSON.parse(resp.SecretString || "{}");
    } catch (err) {
      if (err.name === "InvalidRequestException") {
        // Secret marked for deletion — clear and treat as new
        const updatedSecrets = { ...project.secrets, [env]: null };
        await store.updateProject(project.id, { secrets: updatedSecrets });
        project.secrets[env] = null;
      } else if (err.name !== "ResourceNotFoundException") {
        throw err;
      }
    }

    const mergedSecrets = { ...existingSecrets, ...newSecrets };

    const arn = await upsertProjectSecret(region, secretNameToUse, mergedSecrets);

    // Save per-env secret config
    const updatedSecrets = { ...(project.secrets || {}), [env]: { name: secretNameToUse, arn, keys: Object.keys(mergedSecrets) } };
    await store.updateProject(project.id, { secrets: updatedSecrets });

    // Sync ALL env vars to CodeBuild
    const updatedProject = { ...project, secrets: updatedSecrets, buildProjectName: project.buildProjectName };
    syncSecretsToCodeBuild(updatedProject).catch(() => {});

    auditStore.logAction(auth.getLoggedInUser(req), `Update ${env} Secrets`, project.name, "Completed");
    res.json({ ok: true, arn, secretName: secretNameToUse, keys: Object.keys(mergedSecrets), env });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/secrets/:projectId/inherit — copy secrets from source env to target env ──
// Body: { sourceEnv: "dev", targetEnv: "uat" } — copies key names (not values) as a starting point
router.post("/:projectId/inherit", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res);
    if (!project) return;

    const { sourceEnv, targetEnv } = req.body;
    if (!validateEnv(sourceEnv) || !validateEnv(targetEnv)) {
      return res.status(400).json({ ok: false, error: "sourceEnv and targetEnv must be dev, uat, or prod." });
    }
    if (sourceEnv === targetEnv) {
      return res.status(400).json({ ok: false, error: "sourceEnv and targetEnv must be different." });
    }

    const sourceCfg = getSecretForEnv(project, sourceEnv);
    if (!sourceCfg || !sourceCfg.arn) {
      return res.status(400).json({ ok: false, error: `No secrets configured for ${sourceEnv}.` });
    }

    // Read current values from source env
    const region = project.region || "us-east-1";
    const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
    const secretsClient = new SecretsManagerClient({ region });

    let sourceValues = {};
    try {
      const resp = await secretsClient.send(new GetSecretValueCommand({ SecretId: sourceCfg.name }));
      sourceValues = JSON.parse(resp.SecretString || "{}");
    } catch (err) {
      if (err.name === "ResourceNotFoundException" || err.name === "InvalidRequestException") {
        return res.status(400).json({ ok: false, error: `Source secret ${sourceEnv} was deleted from AWS.` });
      }
      throw err;
    }

    // Pre-fill target env with source values (user can edit before saving)
    const user = auth.getLoggedInUser(req) || "unknown";
    auditStore.logAction(user, `Inherit ${sourceEnv} → ${targetEnv} secrets (${Object.keys(sourceValues).length} keys)`, project.name, "Completed");

    res.json({ ok: true, values: sourceValues, keys: Object.keys(sourceValues) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── DELETE /api/secrets/:projectId/:env/:key — remove a single key from an env ──
router.delete("/:projectId/:env/:key", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res);
    if (!project) return;
    const env = validateEnv(req.params.env);
    if (!env) return res.status(400).json({ ok: false, error: "Invalid environment." });

    const cfg = getSecretForEnv(project, env);
    if (!cfg || !cfg.name) return res.json({ ok: true, keys: [] });

    const keyToDelete = req.params.key;
    const region = project.region || "us-east-1";
    const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
    const secretsClient = new SecretsManagerClient({ region });

    let existingSecrets = {};
    try {
      const resp = await secretsClient.send(new GetSecretValueCommand({ SecretId: cfg.name }));
      existingSecrets = JSON.parse(resp.SecretString || "{}");
    } catch (err) {
      if (err.name === "ResourceNotFoundException" || err.name === "InvalidRequestException") {
        const updatedSecrets = { ...project.secrets, [env]: null };
        await store.updateProject(project.id, { secrets: updatedSecrets });
        syncSecretsToCodeBuild(project).catch(() => {});
        return res.json({ ok: true, keys: [], message: "Secret was deleted from AWS. Reference cleared." });
      }
      throw err;
    }

    if (existingSecrets[keyToDelete]) {
      delete existingSecrets[keyToDelete];
      await upsertProjectSecret(region, cfg.name, existingSecrets);
    }

    // If no keys remain, clear the env reference
    const remainingKeys = Object.keys(existingSecrets);
    if (remainingKeys.length === 0) {
      const updatedSecrets = { ...project.secrets, [env]: null };
      await store.updateProject(project.id, { secrets: updatedSecrets });
    } else {
      // Update the keys list
      const updatedSecrets = { ...(project.secrets || {}), [env]: { ...cfg, keys: remainingKeys } };
      await store.updateProject(project.id, { secrets: updatedSecrets });
    }

    syncSecretsToCodeBuild(project).catch(() => {});
    auditStore.logAction(auth.getLoggedInUser(req), `Delete ${env} Secret Key (${keyToDelete})`, project.name, "Completed");
    res.json({ ok: true, keys: remainingKeys });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Legacy DELETE endpoint (backward compat) ──
router.delete("/:projectId/:key", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  // Route to dev env for backward compatibility
  req.params.env = "dev";
  return router.handle(req, res);
});

// ── POST /api/secrets/:projectId/restart — force-restart ECS services with updated task defs ──
// When secrets are updated (new keys added or values changed), running tasks need
// to pick up the changes. For value-only changes, forceNewDeployment is enough
// (ECS re-fetches from Secrets Manager on task start). For new keys, we must
// register a new task def revision with the updated `secrets` array first.
router.post("/:projectId/restart", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res);
    if (!project) return;

    const {
      ECSClient, UpdateServiceCommand, DescribeServicesCommand, DescribeTaskDefinitionCommand, RegisterTaskDefinitionCommand
    } = require("@aws-sdk/client-ecs");
    const region = project.region || "us-east-1";
    const ecsClient = new ECSClient({ region });

    const restarted = [];
    const failed = [];

    const services = [
      { cluster: project.ecsClusterNameNonProd, service: project.devServiceName,  env: "dev" },
      { cluster: project.ecsClusterNameNonProd, service: project.uatServiceName,  env: "uat" },
      { cluster: project.ecsClusterNameProd,    service: project.prodServiceName, env: "prod" },
    ];

    for (const { cluster, service, env } of services) {
      if (!cluster || !service) { failed.push(`${env} (not provisioned)`); continue; }

      const cfg = getSecretForEnv(project, env);
      if (!cfg || !cfg.arn) { failed.push(`${env} (no secrets configured)`); continue; }

      try {
        // ── Step 1: Read current task def for this service ──────────────────
        const svcRes = await ecsClient.send(new DescribeServicesCommand({
          cluster, services: [service]
        }));
        const svc = svcRes.services?.[0];
        if (!svc || !svc.taskDefinition) {
          failed.push(`${env}: service not found or has no task definition`);
          continue;
        }

        const tdRes = await ecsClient.send(new DescribeTaskDefinitionCommand({
          taskDefinition: svc.taskDefinition
        }));
        const td = tdRes.taskDefinition;
        const c0 = td?.containerDefinitions?.[0];
        if (!td || !c0) {
          failed.push(`${env}: could not read task definition`);
          continue;
        }

        // ── Step 2: Build updated secrets array from current per-env config ─
        // The cfg.keys list is always kept up to date by the secrets save route.
        const secretsArray = (cfg.keys || []).map(key => ({
          name: key,
          valueFrom: `${cfg.arn}:${key}::`
        }));

        // ── Step 3: Compare with existing secrets in task def ──────────────
        // Only register a new revision if the secrets array actually changed.
        // This avoids unnecessary task def churn for pure value-only updates.
        const existingSecrets = c0.secrets || [];
        const existingKeys = existingSecrets.map(s => s.name).sort().join(",");
        const newKeys      = secretsArray.map(s => s.name).sort().join(",");
        const existingArns = [...new Set(existingSecrets.map(s => (s.valueFrom || "").split(":")[0]))].join(",");
        const secretsChanged = existingKeys !== newKeys || existingArns !== cfg.arn;

        if (secretsChanged) {
          // ── Step 4a: Register new task def revision with updated secrets ──
          console.log(`[secrets/restart] Registering new task def for ${env} (secrets changed)`);
          const newContainerDef = {
            ...c0,
            image: c0.image,                           // keep current deployed image
            secrets: secretsArray.length > 0 ? secretsArray : undefined
          };
          // Remove undefined fields that ECS API rejects
          if (!newContainerDef.secrets) delete newContainerDef.secrets;

          const registerRes = await ecsClient.send(new RegisterTaskDefinitionCommand({
            family:                  td.family,
            requiresCompatibilities: td.requiresCompatibilities || ["FARGATE"],
            networkMode:             td.networkMode || "awsvpc",
            cpu:                     td.cpu,
            memory:                  td.memory,
            executionRoleArn:        td.executionRoleArn,
            taskRoleArn:             td.taskRoleArn || td.executionRoleArn,
            volumes:                 td.volumes || [],
            containerDefinitions:    [newContainerDef]
          }));

          const newTaskDefArn = registerRes.taskDefinition?.taskDefinitionArn;
          console.log(`[secrets/restart] New task def for ${env}: ${newTaskDefArn}`);

          // Update service to use new task def revision then force restart
          await ecsClient.send(new UpdateServiceCommand({
            cluster,
            service,
            taskDefinition:    newTaskDefArn,
            forceNewDeployment: true
          }));
        } else {
          // ── Step 4b: Secrets array unchanged — force restart only ──────────
          // ECS re-fetches secret VALUES from Secrets Manager at task start,
          // so this is sufficient for value-only updates.
          console.log(`[secrets/restart] Secrets schema unchanged for ${env}, force-restarting only`);
          await ecsClient.send(new UpdateServiceCommand({
            cluster,
            service,
            forceNewDeployment: true
          }));
        }

        restarted.push(env);
      } catch (err) {
        console.error(`[secrets/restart] Failed for ${env}:`, err);
        failed.push(`${env}: ${err.message}`);
      }
    }

    auditStore.logAction(auth.getLoggedInUser(req), "Force Restart ECS (secret update)", project.name, "Completed");
    res.json({ ok: true, restarted, failed });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── DELETE /api/secrets/:projectId/:env — force-delete entire secret from AWS + clear reference ──
router.delete("/:projectId/:env", auth.requireRole(...auth.ADMIN_ROLES), async (req, res) => {
  try {
    const project = await requireProject(req, res);
    if (!project) return;
    const env = validateEnv(req.params.env);
    if (!env) return res.status(400).json({ ok: false, error: "Invalid environment." });

    const cfg = getSecretForEnv(project, env);
    if (!cfg || !cfg.name) {
      return res.json({ ok: true, message: "No secret configured for this environment." });
    }

    const region = project.region || "us-east-1";
    const { SecretsManagerClient, DeleteSecretCommand } = require("@aws-sdk/client-secrets-manager");
    const sm = new SecretsManagerClient({ region });

    try {
      await sm.send(new DeleteSecretCommand({ SecretId: cfg.name, ForceDeleteWithoutRecovery: true }));
    } catch (err) {
      if (err.name !== "ResourceNotFoundException") {
        console.warn(`[secrets] Could not delete ${cfg.name} from AWS:`, err.message);
      }
    }

    // Clear reference in project
    const updatedSecrets = { ...(project.secrets || {}), [env]: null };
    await store.updateProject(project.id, { secrets: updatedSecrets });

    syncSecretsToCodeBuild({ ...project, secrets: updatedSecrets }).catch(() => {});
    auditStore.logAction(auth.getLoggedInUser(req), `Delete entire ${env} secret from AWS`, project.name, "Completed");
    res.json({ ok: true, message: `Secret ${cfg.name} deleted from AWS. Reference cleared.` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
module.exports.syncSecretsToCodeBuild = syncSecretsToCodeBuild;
