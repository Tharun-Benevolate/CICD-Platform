// services/providers/githubProvider.js
// GitHub REST API provider. Wraps the existing github.js module and adds new
// file-level operations needed for the developer platform (file browser, editor,
// multi-file commit, conflict checking).
//
// All functions accept an optional `token` param for per-user OAuth (Phase 5).
// Falls back to process.env.GITHUB_TOKEN when not provided.

const API = "https://api.github.com";

// Internal fetch helper — mirrors the one in github.js but accepts a token param.
async function ghFetch(path, { method = "GET", body, token } = {}) {
  const authToken = token || process.env.GITHUB_TOKEN;
  if (!authToken) {
    const err = new Error("GITHUB_TOKEN is not set and no per-user token was provided.");
    err.status = 502;
    throw err;
  }

  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${authToken}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (res.status === 204) return { status: 204 };

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const isAuthFailure = res.status === 401 || res.status === 403;
    const err = new Error(
      isAuthFailure
        ? `GitHub rejected the token (${res.status}): ${data.message || "check token validity and scopes"}`
        : (data.message || `GitHub API error (${res.status})`)
    );
    err.status = isAuthFailure ? 502 : res.status;
    err.details = data;
    throw err;
  }

  return data;
}

// ─── Owner/repo resolution ───────────────────────────────────────────────────
// Fixes the case where repoName is stored as "owner/repo" full path (e.g.
// "amruthkumartj/deploy-watch-new") but owner is also set separately.
// Without this, all API calls become /repos/amruthkumartj/amruthkumartj/deploy-watch-new.
function resolveOwnerRepo(owner, repoName) {
  let o = (owner || '').trim();
  let r = (repoName || '').trim();
  if (r.includes('/')) {
    const parts = r.split('/');
    r = parts[parts.length - 1];   // always use the last segment as repo name
    if (!o) o = parts[0];          // use first segment as owner only if owner not set
    // If owner equals the first segment of repo path, don't prepend it again
  }
  return { owner: o, repo: r };
}

// ─── Branch operations ────────────────────────────────────────────────────

async function listBranches(ownerArg, repoArg, token) {
  const { owner, repo } = resolveOwnerRepo(ownerArg, repoArg);
  // Reuse the full implementation from github.js for the canvas graph
  const gh = require("../../github");
  return gh.listBranches(owner, repo); // existing impl, token support in Phase 5
}

async function createBranch(ownerArg, repoArg, branchName, baseBranch, token) {
  const { owner, repo } = resolveOwnerRepo(ownerArg, repoArg);
  const baseRef = await ghFetch(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`, { token });
  return ghFetch(`/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    body: { ref: `refs/heads/${branchName}`, sha: baseRef.object.sha },
    token
  });
}

async function deleteBranch(ownerArg, repoArg, branchName, token) {
  const { owner, repo } = resolveOwnerRepo(ownerArg, repoArg);
  await ghFetch(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branchName)}`, { method: "DELETE", token });
  return { deleted: true };
}

// ─── File operations ──────────────────────────────────────────────────────

// Get a single file's content (decoded from base64).
async function getFileContent(ownerArg, repoArg, filePath, ref, token) {
  const { owner, repo } = resolveOwnerRepo(ownerArg, repoArg);
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const data = await ghFetch(
    `/repos/${owner}/${repo}/contents/${encodedPath}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`,
    { token }
  );
  const content = Buffer.from(data.content || "", "base64").toString("utf8");
  return { content, sha: data.sha, size: data.size, encoding: data.encoding, name: data.name, path: data.path };
}

// Update (or create) a single file with a commit.
async function updateFile(ownerArg, repoArg, filePath, content, message, branch, sha, committer, token) {
  const { owner, repo } = resolveOwnerRepo(ownerArg, repoArg);
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const encodedContent = Buffer.from(content, "utf8").toString("base64");
  const body = { message, content: encodedContent, branch };
  if (sha) body.sha = sha; // required for update; omit for new file creation
  if (committer) body.committer = committer; // { name, email }
  return ghFetch(`/repos/${owner}/${repo}/contents/${encodedPath}`, { method: "PUT", body, token });
}

// Delete a single file with a commit.
async function deleteFile(ownerArg, repoArg, filePath, message, branch, sha, token) {
  const { owner, repo } = resolveOwnerRepo(ownerArg, repoArg);
  let fileSha = sha;
  if (!fileSha) {
    try {
      const existing = await getFileContent(owner, repo, filePath, branch, token);
      fileSha = existing?.sha;
    } catch (_) {}
  }
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const body = { message, branch };
  if (fileSha) body.sha = fileSha;
  return ghFetch(`/repos/${owner}/${repo}/contents/${encodedPath}`, {
    method: "DELETE",
    body,
    token
  });
}

// Commit multiple files in one atomic commit using the Git Data API:
// create blob → create tree → create commit → update ref.
// files = [{ path, content (string), mode?, type? }]
async function createMultiFileCommit(ownerArg, repoArg, branch, files, message, committer, token) {
  const { owner, repo } = resolveOwnerRepo(ownerArg, repoArg);
  // 1. Get current HEAD sha for the branch
  const ref = await ghFetch(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, { token });
  const headSha = ref.object.sha;

  // 2. Get the current tree sha
  const commit = await ghFetch(`/repos/${owner}/${repo}/git/commits/${headSha}`, { token });
  const baseTreeSha = commit.tree.sha;

  // 3. Create blobs for each file
  const treeItems = await Promise.all(files.map(async (f) => {
    const blob = await ghFetch(`/repos/${owner}/${repo}/git/blobs`, {
      method: "POST",
      body: { content: Buffer.from(f.content, "utf8").toString("base64"), encoding: "base64" },
      token
    });
    return {
      path: f.path,
      mode: f.mode || "100644",
      type: f.type || "blob",
      sha: blob.sha
    };
  }));

  // 4. Create a new tree on top of the base tree
  const newTree = await ghFetch(`/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    body: { base_tree: baseTreeSha, tree: treeItems },
    token
  });

  // 5. Create the commit
  const newCommit = await ghFetch(`/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    body: {
      message,
      tree: newTree.sha,
      parents: [headSha],
      ...(committer ? { committer } : {})
    },
    token
  });

  // 6. Update the branch ref to point at the new commit
  await ghFetch(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: "PATCH",
    body: { sha: newCommit.sha },
    token
  });

  return { sha: newCommit.sha, message: newCommit.message, tree: newTree.sha };
}

// Get a file tree for the given ref, with optional folderPath prefix filter.
// Signature matches codecommitProvider: getTree(owner, repo, ref, recursive, folderPath, token)
async function getTree(ownerArg, repoArg, ref, recursive = true, folderPath, token) {
  const { owner, repo } = resolveOwnerRepo(ownerArg, repoArg);
  const data = await ghFetch(
    `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}${recursive ? "?recursive=1" : ""}`,
    { token }
  );
  let items = data.tree || [];

  // Filter by folder prefix when browsing a subdirectory
  if (folderPath) {
    const prefix = folderPath.endsWith('/') ? folderPath : folderPath + '/';
    // Show only immediate children of folderPath (not deeply nested sub-items)
    items = items.filter(item => {
      if (!item.path.startsWith(prefix)) return false;
      const relative = item.path.slice(prefix.length);
      // Only include direct children (no nested slash)
      return relative.length > 0 && !relative.slice(0, -1).includes('/');
    });
  } else {
    // At root: only show top-level items (no slash in path, or folder items ending with /)
    items = items.filter(item => !item.path.includes('/'));
  }

  // Normalize to match CodeCommit shape: { name, path, type (blob->file, tree->dir) }
  return items.map(item => ({
    name: item.path.split('/').pop(),
    path: item.path,
    type: item.type === 'blob' ? 'file' : 'dir',
    size: item.size || 0,
    sha: item.sha
  }));
}

// Simple branch list for the unified /api/repos/branches endpoint
async function listBranchesSimple(ownerArg, repoArg, token) {
  const { owner, repo } = resolveOwnerRepo(ownerArg, repoArg);
  const data = await ghFetch(`/repos/${owner}/${repo}/branches?per_page=100`, { token });
  return (data || []).map(b => ({ name: b.name, sha: b.commit?.sha }));
}

// ─── Comparison & merge ───────────────────────────────────────────────────

async function compareBranches(ownerArg, repoArg, base, head, token) {
  const { owner, repo } = resolveOwnerRepo(ownerArg, repoArg);
  const cmp = await ghFetch(
    `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    { token }
  );
  return {
    aheadBy: cmp.ahead_by,
    behindBy: cmp.behind_by,
    status: cmp.status,
    totalCommits: cmp.total_commits,
    commits: (cmp.commits || []).map(c => ({
      sha: c.sha, message: c.commit.message,
      authorName: c.commit.author?.name || c.author?.login || "unknown",
      authorLogin: c.author?.login || null,
      authorAvatar: c.author?.avatar_url || null,
      date: c.commit.author?.date
    })),
    files: (cmp.files || []).map(f => ({
      filename: f.filename, status: f.status,
      additions: f.additions, deletions: f.deletions,
      patch: f.patch || null
    }))
  };
}

// Merge head into base. Uses the basic merges API.
async function mergeBranches(ownerArg, repoArg, base, head, commitMessage, mergeMethod, token) {
  const { owner, repo } = resolveOwnerRepo(ownerArg, repoArg);
  try {
    const result = await ghFetch(`/repos/${owner}/${repo}/merges`, {
      method: "POST",
      body: { base, head, commit_message: commitMessage || `Merge ${head} into ${base}` },
      token
    });
    if (result.status === 204) return { merged: false, alreadyUpToDate: true };
    return { merged: true, sha: result.sha, message: result.commit?.message };
  } catch (err) {
    if (err.status === 409) {
      const conflictErr = new Error(`Merge conflict between "${head}" and "${base}"`);
      conflictErr.status = 409;
      throw conflictErr;
    }
    throw err;
  }
}

// Commits for a ref
async function getCommits(ownerArg, repoArg, ref, limit, token) {
  const { owner, repo } = resolveOwnerRepo(ownerArg, repoArg);
  const raw = await ghFetch(
    `/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(ref)}&per_page=${limit || 30}`,
    { token }
  );
  return raw.map(c => ({
    sha: c.sha,
    message: c.commit.message,
    authorName: c.commit.author?.name || c.author?.login || "unknown",
    authorLogin: c.author?.login || null,
    authorAvatar: c.author?.avatar_url || null,
    date: c.commit.author?.date,
    parents: (c.parents || []).map(p => p.sha)
  }));
}

// Single commit with file diffs
async function getCommit(ownerArg, repoArg, sha, token) {
  const { owner, repo } = resolveOwnerRepo(ownerArg, repoArg);
  const c = await ghFetch(`/repos/${owner}/${repo}/commits/${sha}`, { token });
  return {
    sha: c.sha,
    message: c.commit.message,
    authorName: c.commit.author?.name || c.author?.login || "unknown",
    authorLogin: c.author?.login || null,
    authorAvatar: c.author?.avatar_url || null,
    date: c.commit.author?.date,
    stats: c.stats,
    files: (c.files || []).map(f => ({
      filename: f.filename, status: f.status,
      additions: f.additions, deletions: f.deletions,
      patch: f.patch || null
    }))
  };
}

// Get the combined CI/CD status for a commit
async function getCommitStatus(ownerArg, repoArg, ref, token) {
  const { owner, repo } = resolveOwnerRepo(ownerArg, repoArg);
  const data = await ghFetch(`/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/status`, { token });
  return {
    state: data.state,
    total_count: data.total_count,
    statuses: (data.statuses || []).map(s => ({
      state: s.state,
      context: s.context,
      description: s.description,
      target_url: s.target_url
    }))
  };
}

// Check for merge conflicts between two branches.
async function checkConflicts(ownerArg, repoArg, base, head, token) {
  const { owner, repo } = resolveOwnerRepo(ownerArg, repoArg);
  try {
    const cmp = await compareBranches(owner, repo, base, head, token);
    if (cmp.behindBy > 0 && cmp.aheadBy > 0) {
      return { hasConflicts: false, diverged: true, aheadBy: cmp.aheadBy, behindBy: cmp.behindBy };
    }
    return { hasConflicts: false, diverged: false, aheadBy: cmp.aheadBy, behindBy: cmp.behindBy };
  } catch (err) {
    if (err.status === 409) {
      return { hasConflicts: true, conflictingFiles: [] };
    }
    throw err;
  }
}

module.exports = {
  listBranches,
  listBranchesSimple,
  createBranch,
  deleteBranch,
  getFileContent,
  updateFile,
  deleteFile,
  createMultiFileCommit,
  getTree,
  compareBranches,
  mergeBranches,
  getCommits,
  getCommit,
  getCommitStatus,
  checkConflicts
};
