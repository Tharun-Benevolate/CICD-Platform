"""
register_taskdefs.py
────────────────────
Registers per-environment ECS task definitions with Secrets Manager references,
then optionally updates the ECS service's active task def when the secrets schema
has changed.

Called from the CodeBuild post_build phase.  ALL configuration is read from
environment variables so the same script works for every project the platform
manages:

  AWS_REGION                  – region for all AWS API calls
  ECR_REPO_URI                – <account>.dkr.ecr.<region>.amazonaws.com/<name>
  IMAGE_TAG                   – git commit SHA or "latest"
  CONTAINER_NAME              – ECS container / ECR repo name
  EXECUTION_ROLE_ARN          – ECS task execution IAM role ARN
  ECS_CLUSTER_NAME_NON_PROD   – cluster for dev + uat (falls back to <name>-non-prod-cluster)
  ECS_CLUSTER_NAME_PROD       – cluster for prod       (falls back to <name>-prod-cluster)
  DEV_SERVICE_NAME            – ECS service name for dev  (falls back to <name>-dev)
  UAT_SERVICE_NAME            – ECS service name for uat  (falls back to <name>-uat)
  PROD_SERVICE_NAME           – ECS service name for prod (falls back to <name>-prod)
  SECRET_ARN_DEV / _UAT / _PROD    – Secrets Manager secret ARN per env
  SECRET_KEYS_DEV / _UAT / _PROD   – JSON array of key names stored in that secret
"""

import os
import json
import subprocess
import tempfile
import sys

REGION         = os.environ["AWS_REGION"]
ECR_REPO_URI   = os.environ["ECR_REPO_URI"]
IMAGE_TAG      = os.environ.get("IMAGE_TAG", "latest")
CONTAINER_NAME = os.environ["CONTAINER_NAME"]
EXEC_ROLE      = os.environ.get("EXECUTION_ROLE_ARN", "")

NON_PROD = os.environ.get("ECS_CLUSTER_NAME_NON_PROD") or (CONTAINER_NAME + "-non-prod-cluster")
PROD     = os.environ.get("ECS_CLUSTER_NAME_PROD")     or (CONTAINER_NAME + "-prod-cluster")
DEV_SVC  = os.environ.get("DEV_SERVICE_NAME")          or (CONTAINER_NAME + "-dev")
UAT_SVC  = os.environ.get("UAT_SERVICE_NAME")          or (CONTAINER_NAME + "-uat")
PROD_SVC = os.environ.get("PROD_SERVICE_NAME")         or (CONTAINER_NAME + "-prod")


def run_aws(*args):
    """Run an aws CLI command; raise RuntimeError on failure."""
    cmd = ["aws"] + list(args) + ["--region", REGION]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or r.stdout.strip())
    return r.stdout.strip()


def process_env(env, cluster, service, secret_arn, secret_keys_raw):
    """
    Register a new ECS task definition revision for <env> with:
      - the freshly built image
      - Secrets Manager references for all keys in the secret

    If the secrets schema has changed (keys added/removed or ARN changed),
    also update the service so the subsequent CodePipeline ECS deploy action
    reads a task def that already has secrets — ensuring they are never lost.
    """
    print("\n=== [%s] cluster=%s  service=%s ===" % (env.upper(), cluster, service))

    # Parse secret keys safely via json.loads (no shell interpolation).
    try:
        keys = json.loads(secret_keys_raw) if secret_keys_raw else []
    except Exception:
        keys = []

    secrets_array = (
        [{"name": k, "valueFrom": "%s:%s::" % (secret_arn, k)} for k in keys if k]
        if secret_arn and keys else []
    )

    # ── Fetch current task def ARN from the service ───────────────────────
    try:
        td_arn = run_aws(
            "ecs", "describe-services",
            "--cluster", cluster, "--services", service,
            "--query", "services[0].taskDefinition", "--output", "text",
        )
    except Exception as exc:
        print("  WARN: Could not describe service: %s  (skipping — will work after first terraform apply)" % exc)
        return

    if not td_arn or td_arn == "None":
        print("  WARN: Service '%s' not found in cluster '%s'.  Skipping." % (service, cluster))
        return

    print("  Current task def: " + td_arn)
    td = json.loads(run_aws(
        "ecs", "describe-task-definition",
        "--task-definition", td_arn,
        "--query", "taskDefinition", "--output", "json",
    ))
    c0 = td.get("containerDefinitions", [{}])[0]

    # ── Detect whether the secrets schema has changed ─────────────────────
    existing  = c0.get("secrets", [])
    ex_keys   = sorted(s["name"] for s in existing)
    ex_arns   = list({s.get("valueFrom", "").split(":")[0]
                      for s in existing if s.get("valueFrom")})
    ex_arn    = ex_arns[0] if ex_arns else ""
    new_keys  = sorted(k for k in keys if k)
    changed   = (ex_keys != new_keys) or (bool(secret_arn) and ex_arn != secret_arn)
    print("  Secrets schema changed: %s  (had=%s  want=%s)" % (changed, ex_keys, new_keys))

    # ── Build the updated container definition ────────────────────────────
    new_c = dict(c0)
    new_c["image"] = "%s:%s" % (ECR_REPO_URI, IMAGE_TAG)
    if secrets_array:
        new_c["secrets"] = secrets_array
    else:
        new_c.pop("secrets", None)   # remove stale entries if all secrets cleared

    # ── Build the task def payload ────────────────────────────────────────
    payload = {
        "family":                  td["family"],
        "requiresCompatibilities": td.get("requiresCompatibilities", ["FARGATE"]),
        "networkMode":             td.get("networkMode", "awsvpc"),
        "cpu":                     td["cpu"],
        "memory":                  td["memory"],
        "executionRoleArn":        td.get("executionRoleArn") or EXEC_ROLE,
        "taskRoleArn":             (td.get("taskRoleArn")
                                    or td.get("executionRoleArn")
                                    or EXEC_ROLE),
        "volumes":                 td.get("volumes", []),
        "containerDefinitions":    [new_c],
    }

    # Write payload to a temp file — avoids CLI arg-length limits and avoids
    # any quoting issues with special characters in secret key names.
    tf = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
    json.dump(payload, tf)
    tf.close()

    new_arn = run_aws(
        "ecs", "register-task-definition",
        "--cli-input-json", "file://" + tf.name,
        "--query", "taskDefinition.taskDefinitionArn", "--output", "text",
    )
    print("  Registered: " + new_arn)

    # ── Only update-service when secrets schema changed ───────────────────
    # Purpose: the CodePipeline ECS deploy action reads the service's CURRENT
    # task def and carries all its settings (including secrets) forward when
    # it registers a new revision.  If the current task def has no secrets
    # (e.g. it was bootstrapped before secrets were configured), calling
    # update-service here makes the new secrets-aware task def become the
    # "current" one that the deploy action will read and carry forward.
    #
    # For value-only secret changes (same keys, new values in Secrets Manager),
    # we skip update-service — ECS re-fetches values automatically on every
    # new task start, so a forceNewDeployment via the admin UI is sufficient.
    if changed:
        print("  Updating service active task def (secrets schema changed)...")
        run_aws("ecs", "update-service",
                "--cluster", cluster, "--service", service,
                "--task-definition", new_arn)
        print("  Service updated.")


# ── Process all three environments ────────────────────────────────────────────
errors = []

for env_name, cl, svc, arn_key, keys_key in [
    ("dev",  NON_PROD, DEV_SVC,  "SECRET_ARN_DEV",  "SECRET_KEYS_DEV"),
    ("uat",  NON_PROD, UAT_SVC,  "SECRET_ARN_UAT",  "SECRET_KEYS_UAT"),
    ("prod", PROD,     PROD_SVC, "SECRET_ARN_PROD", "SECRET_KEYS_PROD"),
]:
    try:
        process_env(
            env_name, cl, svc,
            os.environ.get(arn_key, ""),
            os.environ.get(keys_key, "[]"),
        )
    except Exception as exc:
        msg = "  ERROR [%s]: %s" % (env_name, exc)
        print(msg, file=sys.stderr)
        errors.append(msg)

if errors:
    print("\nWARN: Some environments had errors (non-fatal — image push succeeded):")
    for e in errors:
        print(e)
else:
    print("\nAll environments processed successfully.")
