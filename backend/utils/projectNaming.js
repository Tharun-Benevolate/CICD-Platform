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

module.exports = { sanitizeProjectPrefix, namesForProject, betaTgNameFor };
