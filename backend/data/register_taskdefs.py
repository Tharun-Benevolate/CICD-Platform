"""
register_taskdefs.py — per-env ECS task def registration.
Reads env vars set by the admin platform (SECRET_ARN_DEV/UAT/PROD,
SECRET_KEYS_DEV/UAT/PROD, ECS_CLUSTER_NAME_NON_PROD/PROD,
DEV/UAT/PROD_SERVICE_NAME, EXECUTION_ROLE_ARN) so one script works
for every project without modification.
"""
import os, json, subprocess, tempfile, sys

REGION = os.environ["AWS_REGION"]
ECR    = os.environ["ECR_REPO_URI"]
TAG    = os.environ.get("IMAGE_TAG", "latest")
CNAME  = os.environ["CONTAINER_NAME"]
EROLE  = os.environ.get("EXECUTION_ROLE_ARN", "")

NP  = os.environ.get("ECS_CLUSTER_NAME_NON_PROD") or (CNAME + "-non-prod-cluster")
PR  = os.environ.get("ECS_CLUSTER_NAME_PROD")     or (CNAME + "-prod-cluster")
DS  = os.environ.get("DEV_SERVICE_NAME")          or (CNAME + "-dev")
US  = os.environ.get("UAT_SERVICE_NAME")          or (CNAME + "-uat")
PS  = os.environ.get("PROD_SERVICE_NAME")         or (CNAME + "-prod")

def cli(*args):
    r = subprocess.run(["aws"] + list(args) + ["--region", REGION],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or r.stdout.strip())
    return r.stdout.strip()

def process(env, cluster, service, arn, keys_raw):
    print("\n=== [%s] %s / %s ===" % (env.upper(), cluster, service))
    try:
        keys = json.loads(keys_raw) if keys_raw else []
    except Exception:
        keys = []
    secrets = ([{"name": k, "valueFrom": "%s:%s::" % (arn, k)} for k in keys if k]
               if arn and keys else [])

    try:
        td_arn = cli("ecs", "describe-services",
                     "--cluster", cluster, "--services", service,
                     "--query", "services[0].taskDefinition", "--output", "text")
    except Exception as e:
        print("  WARN:", e); return
    if not td_arn or td_arn == "None":
        print("  WARN: service not found — skipping (normal on first deploy)"); return

    td = json.loads(cli("ecs", "describe-task-definition",
                        "--task-definition", td_arn,
                        "--query", "taskDefinition", "--output", "json"))
    c0 = td.get("containerDefinitions", [{}])[0]

    ex    = c0.get("secrets", [])
    ex_k  = sorted(s["name"] for s in ex)
    ex_a  = list({s.get("valueFrom","").split(":")[0] for s in ex if s.get("valueFrom")})
    new_k = sorted(k for k in keys if k)
    changed = (ex_k != new_k) or (bool(arn) and (ex_a[0] if ex_a else "") != arn)
    print("  schema changed:", changed, " ex=%s new=%s" % (ex_k, new_k))

    nc = dict(c0)
    nc["image"] = "%s:%s" % (ECR, TAG)
    if secrets: nc["secrets"] = secrets
    else: nc.pop("secrets", None)

    payload = {
        "family": td["family"],
        "requiresCompatibilities": td.get("requiresCompatibilities", ["FARGATE"]),
        "networkMode": td.get("networkMode", "awsvpc"),
        "cpu": td["cpu"], "memory": td["memory"],
        "executionRoleArn": td.get("executionRoleArn") or EROLE,
        "taskRoleArn": td.get("taskRoleArn") or td.get("executionRoleArn") or EROLE,
        "volumes": td.get("volumes", []),
        "containerDefinitions": [nc],
    }
    tf = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
    json.dump(payload, tf); tf.close()
    new_arn = cli("ecs", "register-task-definition",
                  "--cli-input-json", "file://" + tf.name,
                  "--query", "taskDefinition.taskDefinitionArn", "--output", "text")
    print("  registered:", new_arn)

    if changed:
        cli("ecs", "update-service", "--cluster", cluster,
            "--service", service, "--task-definition", new_arn)
        print("  service updated (schema changed)")

errors = []
for env, cl, svc, ak, kk in [
    ("dev",  NP, DS, "SECRET_ARN_DEV",  "SECRET_KEYS_DEV"),
    ("uat",  NP, US, "SECRET_ARN_UAT",  "SECRET_KEYS_UAT"),
    ("prod", PR, PS, "SECRET_ARN_PROD", "SECRET_KEYS_PROD"),
]:
    try:
        process(env, cl, svc, os.environ.get(ak,""), os.environ.get(kk,"[]"))
    except Exception as ex:
        print("  ERROR [%s]: %s" % (env, ex), file=sys.stderr)
        errors.append(env)

print("\nDone. Errors:" if errors else "\nAll envs processed successfully.")
for e in errors: print(" -", e)
