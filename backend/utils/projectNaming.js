// Sanitize a GitHub repo / project name into a safe AWS resource prefix.
// e.g. "Golf-test-app" → "golf-test-app", "My_App!" → "my-app"
function sanitizeProjectPrefix(name) {
  return String(name || "app")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "app";
}

// AWS target group names are capped at 32 chars — truncate the prefix so
// "<prefix>-beta-tg" always fits.
function betaTgNameFor(prefix) {
  return `${String(prefix || "app").slice(0, 24)}-beta-tg`;
}

function namesForProject({ githubRepo, projectName, buildProjectName } = {}) {
  const prefix = sanitizeProjectPrefix(githubRepo || buildProjectName || projectName || "app");
  const connPrefix = prefix.slice(0, 24);
  return {
    prefix,
    projectName: prefix,
    s3BucketName: `${prefix}-artifacts-bucket`,
    ecsClusterName: `${prefix}-cluster`, // Legacy fallback
    ecsClusterNameNonProd: `${prefix}-non-prod-cluster`,
    ecsClusterNameProd: `${prefix}-prod-cluster`,
    ecrRepoName: prefix,
    devServiceName: `${prefix}-dev`,
    uatServiceName: `${prefix}-uat`,
    prodServiceName: `${prefix}-prod`,
    prodBetaServiceName: `${prefix}-prod-beta`,
    codebuildProjectName: prefix,
    pipelineName: `${prefix}-prod-cluster-pipeline`,
    dnsHostPrefix: prefix,
    githubConnectionName: `${connPrefix}-github`
  };
}

/**
 * Returns the canonical AWS Secrets Manager prefix for a project.
 * Secret is stored as: `{prefix}/secrets`
 * This is the single source of truth — used by both secrets.js and terraform.js.
 */
function secretPrefixForProject(project) {
  const name = project.githubRepo || project.buildProjectName || project.name || "app";
  return sanitizeProjectPrefix(name);
}

// AWS Secrets Manager names allow: alphanumerics and the characters / _ + = . @ -
// (max 512 chars). Strip anything else so a user-typed name can't break the API call.
function sanitizeSecretName(name) {
  return String(name || "")
    .trim()
    .replace(/[^A-Za-z0-9/_+=.@-]/g, "-")
    .slice(0, 512);
}

/**
 * Resolves the actual AWS Secrets Manager name to use for a project.
 * If the user typed a custom name in the setup wizard (stored as project.secretName
 * the first time secrets were saved), that name is authoritative and is reused for
 * every subsequent read/write/delete — it is NEVER re-derived from the project prefix.
 * Only projects that have never had a name chosen fall back to the auto `{prefix}/secrets`.
 */
function resolveSecretName(project) {
  if (project && project.secretName) return project.secretName;
  return `${secretPrefixForProject(project)}/secrets`;
}

/**
 * Returns the per-env secret config for a given environment.
 * Falls back to legacy project.secretName/project.secretArn for backward compat.
 */
function getSecretForEnv(project, env) {
  if (!project) return null;
  // New per-env schema
  if (project.secrets && project.secrets[env]) return project.secrets[env];
  // Legacy fallback: dev gets the old shared secret
  if (env === "dev" && project.secretArn) {
    return { name: project.secretName, arn: project.secretArn, keys: project.secretKeys || [] };
  }
  return null;
}

/**
 * Returns the AWS Secrets Manager name for a given environment.
 * If per-env secrets exist, uses that env's name. Otherwise falls back to legacy.
 */
function resolveSecretNameForEnv(project, env) {
  const cfg = getSecretForEnv(project, env);
  if (cfg && cfg.name) return cfg.name;
  // Generate default: {prefix}/{env}-secrets
  const prefix = secretPrefixForProject(project);
  return `${prefix}/${env}-secrets`;
}

module.exports = { sanitizeProjectPrefix, namesForProject, betaTgNameFor, secretPrefixForProject, sanitizeSecretName, resolveSecretName, getSecretForEnv, resolveSecretNameForEnv };
