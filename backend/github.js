// github.js — GitHub REST API client for the in-app Git workspace.
//
// Scope is intentionally "row 1" only: everything here is backed directly by
// GitHub's API (no cloning, no local git execution). That covers log, diff,
// show, branch list/create/delete, and merge. True working-tree operations
// (rebase, cherry-pick, reset, stash) are NOT implemented here — GitHub's API
// has no equivalent for those; they'd need an ephemeral clone + real `git`
// execution, which is a deliberately separate, later phase.
//
// Auth: a single server-side Personal Access Token (GITHUB_TOKEN in .env),
// scoped to `repo`. Every request in this app acts as that token's identity —
// there's no per-user GitHub auth yet. Mutating calls (create/delete branch,
// merge) are gated to admin roles at the route level in server.js, same as
// the Terraform routes.

const API = "https://api.github.com";

function getToken(override) {
  const token = override || process.env.GITHUB_TOKEN;
  if (!token) {
    const err = new Error("No GitHub token available. Set GITHUB_TOKEN in .env or save a PAT in Settings → Git Credentials.");
    err.status = 502;
    throw err;
  }
  return token;
}

async function gh(path, { method = "GET", body, token } = {}) {
  const tok = getToken(token);
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${tok}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (res.status === 204) return { status: 204 };

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const isGithubAuthFailure = res.status === 401 || res.status === 403;
    const err = new Error(
      isGithubAuthFailure
        ? `GitHub rejected the token (${res.status}): ${data.message || "check token validity, expiry, and repo scope"}`
        : (data.message || `GitHub API error (${res.status})`)
    );
    err.status = isGithubAuthFailure ? 502 : res.status;
    err.details = data;
    throw err;
  }
  return data;
}

async function getDefaultBranch(owner, repo, token) {
  const data = await gh(`/repos/${owner}/${repo}`, { token });
  return data.default_branch;
}

async function listBranches(owner, repo, token) {
  const defaultBranch = await getDefaultBranch(owner, repo, token);
  const raw = await gh(`/repos/${owner}/${repo}/branches?per_page=50`, { token });

  const branches = await Promise.all(raw.map(async (b) => {
    if (b.name === defaultBranch) {
      return { name: b.name, sha: b.commit.sha, isDefault: true, aheadBy: 0, behindBy: 0, lastCommit: null };
    }
    let aheadBy = 0, behindBy = 0;
    try {
      const cmp = await gh(`/repos/${owner}/${repo}/compare/${encodeURIComponent(defaultBranch)}...${encodeURIComponent(b.name)}`, { token });
      aheadBy = cmp.ahead_by; behindBy = cmp.behind_by;
    } catch { /* leave at 0/0 */ }
    return { name: b.name, sha: b.commit.sha, isDefault: false, aheadBy, behindBy };
  }));

  return { defaultBranch, branches };
}

async function getCommits(owner, repo, ref, perPage = 30, token) {
  const raw = await gh(`/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(ref)}&per_page=${perPage}`, { token });
  return raw.map(c => ({
    sha: c.sha,
    message: c.commit.message,
    authorName: c.commit.author?.name || c.author?.login || "unknown",
    authorAvatar: c.author?.avatar_url || null,
    date: c.commit.author?.date,
    parents: (c.parents || []).map(p => p.sha)
  }));
}

async function getCommit(owner, repo, sha, token) {
  const c = await gh(`/repos/${owner}/${repo}/commits/${sha}`, { token });
  return {
    sha: c.sha,
    message: c.commit.message,
    authorName: c.commit.author?.name || c.author?.login || "unknown",
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

async function compareBranches(owner, repo, base, head, token) {
  const cmp = await gh(`/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, { token });
  return {
    aheadBy: cmp.ahead_by, behindBy: cmp.behind_by,
    status: cmp.status, totalCommits: cmp.total_commits,
    commits: (cmp.commits || []).map(c => ({
      sha: c.sha, message: c.commit.message,
      authorName: c.commit.author?.name || "unknown", date: c.commit.author?.date
    })),
    files: (cmp.files || []).map(f => ({
      filename: f.filename, status: f.status,
      additions: f.additions, deletions: f.deletions, patch: f.patch || null
    }))
  };
}

async function createBranch(owner, repo, branchName, baseBranch, token) {
  const baseRef = await gh(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`, { token });
  return gh(`/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    body: { ref: `refs/heads/${branchName}`, sha: baseRef.object.sha },
    token
  });
}

async function deleteBranch(owner, repo, branchName, token) {
  await gh(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branchName)}`, { method: "DELETE", token });
  return { deleted: true };
}

async function mergeBranches(owner, repo, base, head, commitMessage, token) {
  try {
    const result = await gh(`/repos/${owner}/${repo}/merges`, {
      method: "POST",
      body: { base, head, commit_message: commitMessage || `Merge ${head} into ${base}` },
      token
    });
    if (result.status === 204) return { merged: false, alreadyUpToDate: true };
    return { merged: true, sha: result.sha, message: result.commit?.message };
  } catch (err) {
    if (err.status === 409) {
      const conflictErr = new Error(`Merge conflict between "${head}" and "${base}" — resolve manually.`);
      conflictErr.status = 409;
      throw conflictErr;
    }
    throw err;
  }
}


// Branch list with ahead/behind vs the default branch, so the canvas can lay
// branches out relative to main without a second round trip per branch from
// the frontend. Capped at 50 branches — comparing every branch against the
// default is one API call each, and this is a small-team tool, not GitHub.com.
// Branch list with ahead/behind vs the default branch, so the canvas can lay
// branches out relative to main without a second round trip per branch from
// the frontend. Capped at 50 branches — comparing every branch against the
// default is one API call each, and this is a small-team tool, not GitHub.com.
async function listBranches(owner, repo, token) {
  const defaultBranch = await getDefaultBranch(owner, repo, token);
  const raw = await gh(`/repos/${owner}/${repo}/branches?per_page=50`, { token });

  const branches = await Promise.all(raw.map(async (b) => {
    if (b.name === defaultBranch) {
      return {
        name: b.name, sha: b.commit.sha, isDefault: true,
        aheadBy: 0, behindBy: 0, lastCommit: null
      };
    }
    let aheadBy = 0, behindBy = 0;
    try {
      const cmp = await gh(`/repos/${owner}/${repo}/compare/${encodeURIComponent(defaultBranch)}...${encodeURIComponent(b.name)}`, { token });
      aheadBy = cmp.ahead_by; behindBy = cmp.behind_by;
    } catch { /* leave at 0/0 if the compare call fails for one branch */ }
    return { name: b.name, sha: b.commit.sha, isDefault: false, aheadBy, behindBy };
  }));

  return { defaultBranch, branches };
}

// git log — commit history for one branch/ref.
async function getCommits(owner, repo, ref, perPage = 30, token) {
  const raw = await gh(`/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(ref)}&per_page=${perPage}`, { token });
  return raw.map(c => ({
    sha: c.sha,
    message: c.commit.message,
    authorName: c.commit.author?.name || c.author?.login || "unknown",
    authorAvatar: c.author?.avatar_url || null,
    date: c.commit.author?.date,
    parents: (c.parents || []).map(p => p.sha)
  }));
}

// git show <sha> — one commit's metadata + per-file patch.
async function getCommit(owner, repo, sha, token) {
  const c = await gh(`/repos/${owner}/${repo}/commits/${sha}`, { token });
  return {
    sha: c.sha,
    message: c.commit.message,
    authorName: c.commit.author?.name || c.author?.login || "unknown",
    authorAvatar: c.author?.avatar_url || null,
    date: c.commit.author?.date,
    stats: c.stats,
    files: (c.files || []).map(f => ({
      filename: f.filename, status: f.status,
      additions: f.additions, deletions: f.deletions,
      patch: f.patch || null // binary files / renames-without-changes have no patch
    }))
  };
}

// git diff base..head — full comparison between two refs.
async function compareBranches(owner, repo, base, head, token) {
  const cmp = await gh(`/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, { token });
  return {
    aheadBy: cmp.ahead_by,
    behindBy: cmp.behind_by,
    status: cmp.status, // "ahead" | "behind" | "diverged" | "identical"
    totalCommits: cmp.total_commits,
    commits: (cmp.commits || []).map(c => ({
      sha: c.sha, message: c.commit.message,
      authorName: c.commit.author?.name || "unknown", date: c.commit.author?.date
    })),
    files: (cmp.files || []).map(f => ({
      filename: f.filename, status: f.status,
      additions: f.additions, deletions: f.deletions,
      patch: f.patch || null
    }))
  };
}

async function createBranch(owner, repo, branchName, baseBranch, token) {
  const baseRef = await gh(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`, { token });
  return gh(`/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    body: { ref: `refs/heads/${branchName}`, sha: baseRef.object.sha },
    token
  });
}

async function deleteBranch(owner, repo, branchName, token) {
  await gh(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branchName)}`, { method: "DELETE", token });
  return { deleted: true };
}

// Merge `head` into `base`, creating a real merge commit (or fast-forwarding
// if possible). Mirrors `git checkout base && git merge head`.
async function mergeBranches(owner, repo, base, head, commitMessage, token) {
  try {
    const result = await gh(`/repos/${owner}/${repo}/merges`, {
      method: "POST",
      body: { base, head, commit_message: commitMessage || `Merge ${head} into ${base}` },
      token
    });
    if (result.status === 204) return { merged: false, alreadyUpToDate: true };
    return { merged: true, sha: result.sha, message: result.commit?.message };
  } catch (err) {
    if (err.status === 409) {
      const conflictErr = new Error(`Merge conflict between "${head}" and "${base}" — this needs to be resolved with a real merge/rebase, not the API.`);
      conflictErr.status = 409;
      throw conflictErr;
    }
    throw err;
  }
}

async function fileExists(owner, repo, ref, path, token) {
  try {
    await gh(`/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, { token });
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}

module.exports = {
  getDefaultBranch, listBranches, getCommits, getCommit, compareBranches,
  createBranch, deleteBranch, mergeBranches, fileExists
};
