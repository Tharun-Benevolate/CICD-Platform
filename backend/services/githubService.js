// github.js — GitHub REST API client for the in-app Git workspace.

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

function cleanRepo(repo) {
  if (!repo) return "";
  return repo.includes("/") ? repo.split("/").pop() : repo;
}

async function getDefaultBranch(owner, repo, token) {
  const r = cleanRepo(repo);
  const data = await gh(`/repos/${owner}/${r}`, { token });
  return data.default_branch;
}

async function listBranches(owner, repo, token) {
  const r = cleanRepo(repo);
  const defaultBranch = await getDefaultBranch(owner, r, token);
  const raw = await gh(`/repos/${owner}/${r}/branches?per_page=50`, { token });

  const branches = await Promise.all(raw.map(async (b) => {
    if (b.name === defaultBranch) {
      return { name: b.name, sha: b.commit.sha, isDefault: true, aheadBy: 0, behindBy: 0, lastCommit: null };
    }
    let aheadBy = 0, behindBy = 0;
    try {
      const cmp = await gh(`/repos/${owner}/${r}/compare/${encodeURIComponent(defaultBranch)}...${encodeURIComponent(b.name)}`, { token });
      aheadBy = cmp.ahead_by; behindBy = cmp.behind_by;
    } catch { /* leave at 0/0 */ }
    return { name: b.name, sha: b.commit.sha, isDefault: false, aheadBy, behindBy };
  }));

  return { defaultBranch, branches };
}

async function getCommits(owner, repo, ref, perPage = 30, token) {
  const r = cleanRepo(repo);
  const raw = await gh(`/repos/${owner}/${r}/commits?sha=${encodeURIComponent(ref)}&per_page=${perPage}`, { token });
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

async function getCommit(owner, repo, sha, token) {
  const r = cleanRepo(repo);
  const c = await gh(`/repos/${owner}/${r}/commits/${sha}`, { token });
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

async function compareBranches(owner, repo, base, head, token) {
  const r = cleanRepo(repo);
  const cmp = await gh(`/repos/${owner}/${r}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, { token });
  return {
    aheadBy: cmp.ahead_by, behindBy: cmp.behind_by,
    status: cmp.status, totalCommits: cmp.total_commits,
    commits: (cmp.commits || []).map(c => ({
      sha: c.sha, message: c.commit.message,
      authorName: c.commit.author?.name || c.author?.login || "unknown",
      authorLogin: c.author?.login || null,
      authorAvatar: c.author?.avatar_url || null,
      date: c.commit.author?.date
    })),
    files: (cmp.files || []).map(f => ({
      filename: f.filename, status: f.status,
      additions: f.additions, deletions: f.deletions, patch: f.patch || null
    }))
  };
}

async function createBranch(owner, repo, branchName, baseBranch, token) {
  const r = cleanRepo(repo);
  const baseRef = await gh(`/repos/${owner}/${r}/git/ref/heads/${encodeURIComponent(baseBranch)}`, { token });
  return gh(`/repos/${owner}/${r}/git/refs`, {
    method: "POST",
    body: { ref: `refs/heads/${branchName}`, sha: baseRef.object.sha },
    token
  });
}

async function deleteBranch(owner, repo, branchName, token) {
  const r = cleanRepo(repo);
  await gh(`/repos/${owner}/${r}/git/refs/heads/${encodeURIComponent(branchName)}`, { method: "DELETE", token });
  return { deleted: true };
}

async function mergeBranches(owner, repo, base, head, commitMessage, token) {
  const r = cleanRepo(repo);
  try {
    const result = await gh(`/repos/${owner}/${r}/merges`, {
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

async function listUserRepos(token, org = null) {
  if (org) {
    return await gh(`/orgs/${encodeURIComponent(org)}/repos?per_page=100&sort=updated`, { token });
  }
  return await gh("/user/repos?per_page=100&sort=updated&affiliation=owner", { token });
}

async function listUserOrgs(token) {
  return await gh("/user/orgs?per_page=100", { token });
}

async function createRepo(token, repoName, org = null, description = "") {
  const path = org ? `/orgs/${org}/repos` : "/user/repos";
  return await gh(path, {
    method: "POST",
    body: {
      name: repoName,
      private: true, // Always enforce private repository creation!
      auto_init: true,
      description: description || "Provisioned via Benevolate CI/CD Platform"
    },
    token
  });
}

async function deleteRepo(owner, repo, token) {
  const r = cleanRepo(repo);
  await gh(`/repos/${owner}/${r}`, { method: "DELETE", token });
  return { deleted: true };
}

async function testRepoAccess(owner, repo, token) {
  try {
    const r = cleanRepo(repo);
    const tok = token || process.env.GITHUB_TOKEN;
    if (!tok) return { ok: false, status: 401, message: "No token available" };

    const res = await fetch(`https://api.github.com/repos/${owner}/${r}`, {
      headers: {
        "Authorization": `Bearer ${tok}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });

    if (!res.ok) {
      return { ok: false, status: res.status };
    }

    const data = await res.json().catch(() => ({}));
    return {
      ok: true,
      status: 200,
      isPrivate: data.private ?? true,
      defaultBranch: data.default_branch || "main",
      ownerType: data.owner?.type || "User"
    };
  } catch (err) {
    return { ok: false, status: 500, message: err.message };
  }
}

module.exports = {
  getDefaultBranch, listBranches, getCommits, getCommit, compareBranches,
  createBranch, deleteBranch, mergeBranches, listUserRepos, listUserOrgs,
  createRepo, deleteRepo, testRepoAccess
};
