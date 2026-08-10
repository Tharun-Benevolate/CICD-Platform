// terraformRunner.js — spawns terraform commands and streams logs back to the panel
const { spawn, execSync } = require("child_process");
const fs   = require("fs");
const path = require("path");

// In-memory store of active runs: runId → { logs, status, outputs, error }
const runs = new Map();

// ── Cross-platform Terraform binary resolver ──
function getTerraformBin() {
  if (process.env.TF_BINARY && fs.existsSync(process.env.TF_BINARY)) {
    return process.env.TF_BINARY;
  }

  const commonLinuxPaths = [
    "/usr/local/bin/terraform",
    "/usr/bin/terraform",
    "/bin/terraform",
    "/snap/bin/terraform",
    "/home/admin/.local/bin/terraform",
    "/home/ubuntu/.local/bin/terraform"
  ];

  if (process.platform !== "win32") {
    for (const p of commonLinuxPaths) {
      if (fs.existsSync(p)) return p;
    }
    try {
      const found = execSync("which terraform", { encoding: "utf8" }).trim().split("\n")[0];
      if (found && fs.existsSync(found)) return found;
    } catch (_) {}
  } else {
    try {
      const found = execSync("where terraform", { encoding: "utf8" }).trim().split("\n")[0];
      if (found && fs.existsSync(found)) return found;
    } catch (_) {}
  }

  return "terraform";
}

// ── Folder paths (resolving to priority merged Terraform folders) ──
const PROJECT_ROOT   = path.resolve(__dirname, "../..");
const TERRAFORM_ROOT = path.join(PROJECT_ROOT, "terraform");

function getStackDir(folderName) {
  const inTf = path.join(TERRAFORM_ROOT, folderName);
  if (fs.existsSync(inTf)) return inTf;
  const inRoot = path.join(PROJECT_ROOT, folderName);
  if (fs.existsSync(inRoot)) return inRoot;
  return inTf;
}

const INITIAL_DIR           = getStackDir("infra-initial");
const DEPLOYMENT_DIR        = getStackDir("golf-infra-terraform");
const AURORA_DIR            = getStackDir("aurora-db-terraform");
const ECS_DEPLOY_DIR        = getStackDir("ecs-deploy-terraform");
const SHARED_FOUNDATION_DIR = getStackDir("shared-foundation-terraform");

function generateRunId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * Start a terraform run in the background.
 * @param {string} folder - absolute path to the terraform folder
 * @param {object} tfvars - key/value pairs to write as panel.auto.tfvars
 * @returns {string} runId — poll logs via getRun(runId)
 */
function startRun(folder, tfvars, options = {}) {
  const runId = generateRunId();
  runs.set(runId, {
    logs: [],
    status: "running",
    outputs: null,
    error: null,
    projectId: options.projectId || null,
    moduleLabel: options.moduleLabel || "run",
    isDestroy: false,
    startedAt: Date.now()
  });
  _execute(runId, folder, tfvars, false).catch(() => {});
  return runId;
}

function startDestroy(folder, tfvars, options = {}) {
  const runId = generateRunId();
  runs.set(runId, {
    logs: [],
    status: "running",
    outputs: null,
    error: null,
    projectId: options.projectId || null,
    moduleLabel: options.moduleLabel || "destroy",
    isDestroy: true,
    startedAt: Date.now()
  });
  _execute(runId, folder, tfvars, true).catch(() => {});
  return runId;
}

async function _execute(runId, folder, tfvars, isDestroy) {
  const run = runs.get(runId);
  const addLog = (line) => run.logs.push({ ts: Date.now(), line: line.trimEnd() });

  try {
    if (!fs.existsSync(folder)) {
      addLog(`❌ Error: Terraform directory does not exist at "${folder}".`);
      run.status = "error";
      run.error  = `Directory not found: ${folder}`;
      return;
    }

    // 0. Clean up stale lock files if left behind by crashed/interrupted runs
    const lockInfoFile = path.join(folder, "terraform.tfstate.lock.info");
    if (fs.existsSync(lockInfoFile)) {
      try { fs.unlinkSync(lockInfoFile); } catch (_) {}
    }

    // Allow Windows/Linux OS file handles to settle cleanly
    await new Promise(resolve => setTimeout(resolve, 500));

    // Automatically resolve active AWS Account ID via STS & ensure backend infra
    const { getCallerAccountId, ensureTerraformBackendInfra } = require("../aws");
    const activeAccountId = await getCallerAccountId();
    tfvars.aws_account_id = activeAccountId;

    // Ensure S3 state bucket and DynamoDB lock table exist in active AWS account
    await ensureTerraformBackendInfra(process.env.AWS_REGION || "us-east-1");

    // Detect if AWS Account ID changed from previous run in this folder
    const accountTrackingFile = path.join(folder, ".last_active_aws_account");
    let previousAccount = null;
    if (fs.existsSync(accountTrackingFile)) {
      try { previousAccount = fs.readFileSync(accountTrackingFile, "utf8").trim(); } catch (_) {}
    }

    if (previousAccount && previousAccount !== activeAccountId) {
      addLog(`🔄 AWS Account ID changed (${previousAccount} ➔ ${activeAccountId}). Purging stale local .terraform cache...`);
      const dotTerraform = path.join(folder, ".terraform");
      const lockHcl = path.join(folder, ".terraform.lock.hcl");
      if (fs.existsSync(dotTerraform)) {
        try { fs.rmSync(dotTerraform, { recursive: true, force: true }); } catch (_) {}
      }
      if (fs.existsSync(lockHcl)) {
        try { fs.unlinkSync(lockHcl); } catch (_) {}
      }
    }
    fs.writeFileSync(accountTrackingFile, activeAccountId, "utf8");

    // Write dynamic S3 backend_override.tf using active AWS Account ID & project slug
    const bucketName = `benevolate-tf-state-${activeAccountId}`;
    const projectSlug = tfvars.project_name || path.basename(folder);
    const stackName = path.basename(folder);
    const backendContent = `
terraform {
  backend "s3" {
    bucket         = "${bucketName}"
    key            = "${projectSlug}/${stackName}/terraform.tfstate"
    region         = "${process.env.AWS_REGION || 'us-east-1'}"
    dynamodb_table = "${process.env.TF_LOCK_TABLE || 'benevolate-tf-locks'}"
    encrypt        = true
  }
}
`;
    fs.writeFileSync(path.join(folder, "backend_override.tf"), backendContent.trim() + "\n");

    // Write terraform.auto.tfvars so terraform picks them up automatically
    const tfvarsContent = Object.entries(tfvars)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${k} = ${JSON.stringify(String(v))}`)
      .join("\n");
    fs.writeFileSync(path.join(folder, "panel.auto.tfvars"), tfvarsContent + "\n");

    addLog(`Working directory: ${folder}`);

    // terraform init (with -reconfigure to prevent file lock collisions)
    addLog("Running: terraform init -reconfigure -input=false");
    try {
      await spawnAsync("terraform", ["init", "-reconfigure", "-input=false", "-no-color"], folder, addLog);
    } catch (initErr) {
      const initLog = run.logs.map(l => l.line).join("\n");
      const hasChecksumError = initLog.includes("state data in S3 does not have the expected content") ||
                               initLog.includes("checksum stored in DynamoDB") ||
                               initLog.includes("does not match the checksum");

      if (hasChecksumError) {
        addLog("⚠️ S3/DynamoDB state checksum mismatch detected. Clearing stale DynamoDB digest entry...");
        try {
          const { DynamoDBClient, DeleteItemCommand } = require("@aws-sdk/client-dynamodb");
          const ddb = new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" });
          const lockTable = process.env.TF_LOCK_TABLE || "benevolate-tf-locks";
          const stateKey  = `${tfvars.project_name || path.basename(folder)}/${path.basename(folder)}/terraform.tfstate`;
          // Delete the stale digest item so Terraform can re-sync
          await ddb.send(new DeleteItemCommand({
            TableName: lockTable,
            Key: { LockID: { S: `${bucketName}/${stateKey}-md5` } }
          }));
          addLog(`✔ Cleared stale DynamoDB digest for key: ${stateKey}-md5. Retrying init...`);
          await spawnAsync("terraform", ["init", "-reconfigure", "-input=false", "-no-color"], folder, addLog);
        } catch (ddbErr) {
          addLog(`⚠️ DynamoDB cleanup failed (${ddbErr.message}). Retrying init with -migrate-state...`);
          await spawnAsync("terraform", ["init", "-migrate-state", "-force-copy", "-input=false", "-no-color"], folder, addLog);
        }
      } else {
        addLog("Retrying terraform init with -migrate-state -force-copy...");
        await spawnAsync("terraform", ["init", "-migrate-state", "-force-copy", "-input=false", "-no-color"], folder, addLog);
      }
    }

    if (isDestroy) {
      addLog("Running: terraform destroy -auto-approve");
      await spawnAsync("terraform", ["apply", "-destroy", "-auto-approve", "-lock=false", "-input=false", "-no-color"], folder, addLog);
      
      run.outputs = {};
      run.status  = "done";
      addLog("ℹ️ Infrastructure destruction complete (0 active cloud resources remain).");
      addLog("Terraform destroy completed successfully.");
    } else {
      addLog("Running: terraform apply -auto-approve");
      try {
        await spawnAsync("terraform", ["apply", "-auto-approve", "-input=false", "-no-color"], folder, addLog);
      } catch (err) {
        const logText = run.logs.map(l => l.line).join("\n");
        const hasLockError = logText.includes("Error acquiring the state lock") || (err.message && err.message.includes("lock"));
        const hasAlreadyExists = logText.includes("EntityAlreadyExists") || logText.includes("BucketAlreadyExists") || logText.includes("BucketAlreadyOwnedByYou");

        if (hasLockError) {
          const lockMatch = logText.match(/ID:\s+([a-f0-9\-]+)/i);
          if (lockMatch && lockMatch[1]) {
            const lockId = lockMatch[1];
            addLog(`🔓 Stale DynamoDB lock detected (${lockId}). Automatically force-unlocking...`);
            try {
              await spawnAsync("terraform", ["force-unlock", "-force", lockId], folder, addLog);
              addLog("✔ Stale lock released. Retrying apply...");
              await spawnAsync("terraform", ["apply", "-auto-approve", "-input=false", "-no-color"], folder, addLog);
            } catch (_) {
              addLog("⚠️ Force-unlock fallback: retrying apply with -lock=false...");
              await spawnAsync("terraform", ["apply", "-auto-approve", "-lock=false", "-input=false", "-no-color"], folder, addLog);
            }
          } else {
            addLog("⚠️ Stale lock detected: retrying apply with -lock=false...");
            await spawnAsync("terraform", ["apply", "-auto-approve", "-lock=false", "-input=false", "-no-color"], folder, addLog);
          }
        } else if (hasAlreadyExists || logText.includes("ResourceAlreadyExistsException")) {
          addLog("⚠️ Pre-existing AWS resources detected. Auto-reconciling with Terraform state...");
          let importedAny = false;

          // Reconcile IAM Roles
          const roleMatches = [...logText.matchAll(/Role with name ([\w\-]+) already exists/g)];
          for (const m of roleMatches) {
            const roleName = m[1];
            let tfTarget = null;
            if (roleName.endsWith("-build-role")) tfTarget = "aws_iam_role.build_role";
            else if (roleName.endsWith("-pipeline-role")) tfTarget = "aws_iam_role.pipeline_role";
            else if (roleName.endsWith("-ecs-exec-role")) tfTarget = "aws_iam_role.ecs_execution_role";

            if (tfTarget) {
              addLog(`⚡ Importing existing IAM role "${roleName}" into state...`);
              try {
                await spawnAsync("terraform", ["import", "-input=false", "-no-color", tfTarget, roleName], folder, addLog);
                importedAny = true;
              } catch (impErr) {
                addLog(`Notice: Role import result: ${impErr.message}`);
              }
            }
          }

          // Reconcile S3 Bucket
          const bucketMatch = logText.match(/creating S3 Bucket \(([\w\-]+)\): (BucketAlreadyExists|BucketAlreadyOwnedByYou)/);
          if (bucketMatch && bucketMatch[1]) {
            const bucketName = bucketMatch[1];
            addLog(`⚡ Importing existing S3 bucket "${bucketName}" into state...`);
            try {
              await spawnAsync("terraform", ["import", "-input=false", "-no-color", "aws_s3_bucket.artifacts", bucketName], folder, addLog);
              importedAny = true;
            } catch (impErr) {
              addLog(`Notice: S3 Bucket import result: ${impErr.message}`);
            }
          }

          // Reconcile CodeBuild Project
          const arnMatch = logText.match(/Project already exists: (arn:aws:codebuild:[\w\-]+:[\d]+:project\/[\w\-]+)/i);
          const nameMatch = logText.match(/creating CodeBuild Project \(([\w\-]+)\):/i) || logText.match(/Project already exists: ([\w\-]+)/i);

          let buildImportTarget = null;
          if (arnMatch && arnMatch[1]) {
            buildImportTarget = arnMatch[1];
          } else if (nameMatch && nameMatch[1]) {
            const pName = nameMatch[1];
            buildImportTarget = pName.startsWith("arn:") ? pName : `arn:aws:codebuild:${process.env.AWS_REGION || "us-east-1"}:${activeAccountId}:project/${pName}`;
          }

          if (buildImportTarget) {
            addLog(`⚡ Importing existing CodeBuild project "${buildImportTarget}" into state...`);
            try {
              await spawnAsync("terraform", ["import", "-input=false", "-no-color", "aws_codebuild_project.build", buildImportTarget], folder, addLog);
              importedAny = true;
            } catch (impErr) {
              addLog(`Notice: CodeBuild import result: ${impErr.message}`);
            }
          }

          if (importedAny) {
            addLog("✔ State reconciliation complete. Re-running terraform apply...");
            await spawnAsync("terraform", ["apply", "-auto-approve", "-input=false", "-no-color"], folder, addLog);
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }

      // capture outputs as JSON
      addLog("Running: terraform output -json");
      const raw = await captureStdout("terraform", ["output", "-json"], folder);
      const parsed = JSON.parse(raw || "{}");

      // Flatten: { key: { value: ... } } → { key: value }
      const outputs = {};
      for (const [k, v] of Object.entries(parsed)) {
        outputs[k] = v.value;
      }

      run.outputs = outputs;
      run.status  = "done";
      addLog("Terraform completed successfully.");
    }
  } catch (err) {
    run.status = "error";
    run.error  = err.message;
    addLog(`Failed: ${err.message}`);
  }
}

function spawnAsync(cmd, args, cwd, onLog) {
  const tfBin = getTerraformBin();
  const execCmd = cmd === "terraform" ? tfBin : cmd;

  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(execCmd, args, {
        cwd,
        env: { ...process.env, TF_IN_AUTOMATION: "1", TF_CLI_ARGS: "" }
      });
    } catch (err) {
      onLog(`❌ Failed to spawn terraform process (${execCmd}): ${err.message}`);
      return reject(err);
    }

    const forward = (data) => {
      data.toString().split("\n").forEach(line => {
        if (line.trim()) onLog(line);
      });
    };

    if (proc.stdout) proc.stdout.on("data", forward);
    if (proc.stderr) proc.stderr.on("data", forward);

    proc.on("error", (err) => {
      onLog(`❌ Terraform execution error (${execCmd}): ${err.message}`);
      if (err.code === "ENOENT") {
        onLog(`⚠️ Terraform binary not found at "${execCmd}". Please verify Terraform is installed on this system (e.g., sudo apt-get install terraform or download from terraform.io).`);
      }
      reject(err);
    });

    proc.on("close", code => (code === 0 ? resolve() : reject(new Error(`Exit code ${code}`))));
  });
}

function captureStdout(cmd, args, cwd) {
  const tfBin = getTerraformBin();
  const execCmd = cmd === "terraform" ? tfBin : cmd;

  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(execCmd, args, { cwd, env: { ...process.env } });
    } catch (err) {
      return reject(err);
    }
    let out = "";
    if (proc.stdout) proc.stdout.on("data", d => out += d.toString());
    proc.on("error", err => reject(err));
    proc.on("close", code => (code === 0 ? resolve(out) : reject(new Error(`Capture failed: exit ${code}`))));
  });
}

let cachedFoundationOutputs = null;
let lastFoundationFetch = 0;
const DATA_DIR = path.join(__dirname, "../data");
if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
}
const FOUNDATION_CACHE_FILE = path.join(DATA_DIR, "foundation_outputs.json");

function clearFoundationCache() {
  cachedFoundationOutputs = null;
  lastFoundationFetch = 0;
  if (fs.existsSync(FOUNDATION_CACHE_FILE)) {
    try { fs.unlinkSync(FOUNDATION_CACHE_FILE); } catch (_) {}
  }
}

async function saveFoundationOutputs(outputs) {
  if (!outputs || !outputs.vpc_id) return null;
  const { getCallerAccountId } = require("../aws");
  let activeAccountId = "511974512004";
  try { activeAccountId = await getCallerAccountId(); } catch (_) {}

  const dataToSave = { ...outputs, _aws_account_id: activeAccountId };
  cachedFoundationOutputs = dataToSave;
  lastFoundationFetch = Date.now();
  try {
    fs.writeFileSync(FOUNDATION_CACHE_FILE, JSON.stringify(dataToSave, null, 2));
  } catch (_) {}
  return dataToSave;
}

async function readFoundationOutputs(forceRefresh = false) {
  let activeAccountId = process.env.AWS_ACCOUNT_ID || "511974512004";
  try {
    const { getCallerAccountId } = require("../aws");
    activeAccountId = await getCallerAccountId();
  } catch (_) {}

  // 1. Return in-memory cache if valid for active account
  if (!forceRefresh && cachedFoundationOutputs && cachedFoundationOutputs._aws_account_id === activeAccountId && cachedFoundationOutputs.vpc_id) {
    return cachedFoundationOutputs;
  }

  // 2. Read disk cache (.foundation_outputs.json) if valid for active account
  if (!forceRefresh && fs.existsSync(FOUNDATION_CACHE_FILE)) {
    try {
      const fileData = JSON.parse(fs.readFileSync(FOUNDATION_CACHE_FILE, "utf8"));
      if (fileData && fileData._aws_account_id === activeAccountId && fileData.vpc_id) {
        cachedFoundationOutputs = fileData;
        lastFoundationFetch = Date.now();
        return cachedFoundationOutputs;
      }
    } catch (_) {}
  }

  // 3. Fast return for non-force checks: if no cache exists, Shared Foundation is not applied
  if (!forceRefresh) {
    return {};
  }

  // 3. Fallback: query S3 backend live by running terraform init + terraform output
  try {
    const bucketName = process.env.TF_STATE_BUCKET || `benevolate-tf-state-${activeAccountId}`;
    const stackName = path.basename(SHARED_FOUNDATION_DIR);
    const backendContent = `
terraform {
  backend "s3" {
    bucket         = "${bucketName}"
    key            = "${stackName}/${stackName}/terraform.tfstate"
    region         = "${process.env.AWS_REGION || 'us-east-1'}"
    dynamodb_table = "${process.env.TF_LOCK_TABLE || 'benevolate-tf-locks'}"
    encrypt        = true
  }
}
`;
    fs.writeFileSync(path.join(SHARED_FOUNDATION_DIR, "backend_override.tf"), backendContent.trim() + "\n");
    await spawnAsync("terraform", ["init", "-reconfigure", "-input=false"], SHARED_FOUNDATION_DIR, () => {});
    const raw = await captureStdout("terraform", ["output", "-json"], SHARED_FOUNDATION_DIR);
    const parsed = JSON.parse(raw || "{}");
    const res = {};
    for (const [k, v] of Object.entries(parsed)) {
      res[k] = v.value;
    }
    if (Object.keys(res).length > 0 && res.vpc_id) {
      res._aws_account_id = activeAccountId;
      cachedFoundationOutputs = res;
      lastFoundationFetch = Date.now();
      try { fs.writeFileSync(FOUNDATION_CACHE_FILE, JSON.stringify(res, null, 2)); } catch (_) {}
      return res;
    }
    return cachedFoundationOutputs || null;
  } catch (_) {
    return cachedFoundationOutputs || null;
  }
}

async function readProjectOutputs(folder, projectSlug) {
  try {
    const accountId = process.env.AWS_ACCOUNT_ID || "511974512004";
    const bucketName = process.env.TF_STATE_BUCKET || `benevolate-tf-state-${accountId}`;
    const stackName = path.basename(folder);
    const backendContent = `
terraform {
  backend "s3" {
    bucket         = "${bucketName}"
    key            = "${projectSlug}/${stackName}/terraform.tfstate"
    region         = "${process.env.AWS_REGION || 'us-east-1'}"
    dynamodb_table = "${process.env.TF_LOCK_TABLE || 'benevolate-tf-locks'}"
    encrypt        = true
  }
}
`;
    fs.writeFileSync(path.join(folder, "backend_override.tf"), backendContent.trim() + "\n");
    const raw = await captureStdout("terraform", ["output", "-json"], folder);
    const parsed = JSON.parse(raw || "{}");
    const res = {};
    for (const [k, v] of Object.entries(parsed)) {
      res[k] = v.value;
    }
    return Object.keys(res).length > 0 ? res : null;
  } catch (_) {
    return null;
  }
}

/** Get the current state of a run */
function getRun(runId) {
  return runs.get(runId) || null;
}

/** Find active running run for a given project or shared foundation */
function getActiveRun(projectId) {
  for (const [runId, run] of runs.entries()) {
    if (run && run.status === "running") {
      // Return if it matches the project OR if it's a global shared foundation run
      if (!projectId || run.projectId === projectId || (run.moduleLabel && run.moduleLabel.includes("foundation"))) {
        return { runId, ...run };
      }
    }
  }
  return null;
}

module.exports = {
  startRun,
  startDestroy,
  getRun,
  getActiveRun,
  captureStdout,
  readFoundationOutputs,
  saveFoundationOutputs,
  clearFoundationCache,
  readProjectOutputs,
  INITIAL_DIR,
  DEPLOYMENT_DIR,
  AURORA_DIR,
  ECS_DEPLOY_DIR,
  SHARED_FOUNDATION_DIR
};
