// services/providers/codecommitProvider.js
// Full AWS CodeCommit implementation for the file browser, editor, and branch operations.
// Uses the @aws-sdk/client-codecommit package already installed in the project.

const {
  CodeCommitClient,
  GetFolderCommand,
  GetFileCommand,
  PutFileCommand,
  DeleteFileCommand,
  ListBranchesCommand,
  CreateBranchCommand,
  GetBranchCommand,
  GetDifferencesCommand,
  MergeBranchesByFastForwardCommand,
  GetMergeConflictsCommand,
  GetCommitCommand,
} = require("@aws-sdk/client-codecommit");

function client(region) {
  return new CodeCommitClient({ region: region || process.env.AWS_REGION || "us-east-1" });
}

// owner is used as the AWS region for CodeCommit (no owner concept in CodeCommit).
// repo is the CodeCommit repositoryName.

// ─── Branches ───────────────────────────────────────────────────────────────

async function listBranches(owner, repo) {
  const cc = client(owner);
  const res = await cc.send(new ListBranchesCommand({ repositoryName: repo }));
  return (res.branches || []).map(b => ({ name: b }));
}

async function createBranch(owner, repo, branchName, baseBranch) {
  const cc = client(owner);
  let commitId;
  try {
    const baseRes = await cc.send(new GetBranchCommand({ repositoryName: repo, branchName: baseBranch }));
    commitId = baseRes.branch.commitId;
  } catch (e) {
    throw new Error(`Base branch "${baseBranch}" not found in ${repo}`);
  }
  await cc.send(new CreateBranchCommand({ repositoryName: repo, branchName, commitId }));
  return { name: branchName };
}

async function deleteBranch(owner, repo, branchName) {
  // CodeCommit doesn't support deleting branches via SDK directly — placeholder
  throw new Error("Branch deletion is not supported via CodeCommit API");
}

// ─── File tree ───────────────────────────────────────────────────────────────

async function getTree(owner, repo, ref, recursive, startPath) {
  const cc = client(owner);
  const items = [];
  const rootFolder = startPath || "";

  let res;
  try {
    res = await cc.send(new GetFolderCommand({
      repositoryName: repo,
      commitSpecifier: ref,
      folderPath: rootFolder || "/"
    }));
  } catch (e) {
    if (e.name === "FolderDoesNotExistException" || e.name === "CommitDoesNotExistException" || e.name === "RepositoryEmptyException") {
      return [];
    }
    throw e;
  }

  for (const f of (res.files || [])) {
    const fullPath = rootFolder ? `${rootFolder}/${f.relativePath}` : f.relativePath;
    items.push({
      type: "file",
      name: f.relativePath.split("/").pop(),
      path: fullPath,
      size: f.fileSize,
      sha: f.blobId
    });
  }
  for (const d of (res.subFolders || [])) {
    const dirPath = rootFolder ? `${rootFolder}/${d.relativePath}` : d.relativePath;
    items.push({ type: "dir", name: d.relativePath.split("/").pop(), path: dirPath });
  }

  return items;
}

// ─── File content ────────────────────────────────────────────────────────────

async function getFileContent(owner, repo, filePath, ref) {
  const cc = client(owner);
  const res = await cc.send(new GetFileCommand({
    repositoryName: repo,
    commitSpecifier: ref || "HEAD",
    filePath
  }));
  const content = Buffer.from(res.fileContent).toString("utf-8");
  return {
    path: filePath,
    content,
    encoding: "utf-8",
    sha: res.blobId,
    size: res.fileSize
  };
}

// ─── File update (single file commit) ───────────────────────────────────────

async function updateFile(owner, repo, filePath, content, message, branch, sha, committer) {
  const cc = client(owner);

  // Get current branch commit for parentCommitId
  let parentCommitId;
  try {
    const branchRes = await cc.send(new GetBranchCommand({ repositoryName: repo, branchName: branch }));
    parentCommitId = branchRes.branch.commitId;
  } catch (e) {
    parentCommitId = undefined;
  }

  const res = await cc.send(new PutFileCommand({
    repositoryName: repo,
    branchName: branch,
    fileContent: Buffer.from(content, "utf-8"),
    filePath,
    commitMessage: message,
    parentCommitId,
    ...(committer ? { name: committer.name, email: committer.email } : {})
  }));

  return {
    commit: { sha: res.commitId, message },
    content: { sha: res.blobId, path: filePath }
  };
}

// ─── File delete ─────────────────────────────────────────────────────────────

async function deleteFile(owner, repo, filePath, message, branch, sha, committer) {
  const cc = client(owner);

  let parentCommitId;
  try {
    const branchRes = await cc.send(new GetBranchCommand({ repositoryName: repo, branchName: branch }));
    parentCommitId = branchRes.branch.commitId;
  } catch (e) {
    parentCommitId = undefined;
  }

  const res = await cc.send(new DeleteFileCommand({
    repositoryName: repo,
    branchName: branch,
    filePath,
    parentCommitId,
    commitMessage: message,
    ...(committer ? { name: committer.name, email: committer.email } : {})
  }));

  return { commit: { sha: res.commitId } };
}

// ─── Multi-file commit ───────────────────────────────────────────────────────
// CodeCommit doesn't natively support multi-file commits in a single API call.
// We commit files sequentially, chaining parentCommitId through each PutFile.

async function createMultiFileCommit(owner, repo, branch, files, message, committer) {
  const cc = client(owner);

  let parentCommitId;
  try {
    const branchRes = await cc.send(new GetBranchCommand({ repositoryName: repo, branchName: branch }));
    parentCommitId = branchRes.branch.commitId;
  } catch (e) {
    parentCommitId = undefined;
  }

  let lastCommitId = parentCommitId;
  for (let i = 0; i < files.length; i++) {
    const { path: filePath, content } = files[i];
    const isLast = i === files.length - 1;
    const res = await cc.send(new PutFileCommand({
      repositoryName: repo,
      branchName: branch,
      fileContent: Buffer.from(content || "", "utf-8"),
      filePath,
      commitMessage: isLast ? message : `${message} (${i + 1}/${files.length})`,
      parentCommitId: lastCommitId,
      ...(committer ? { name: committer.name, email: committer.email } : {})
    }));
    lastCommitId = res.commitId;
  }

  return { commitId: lastCommitId };
}

// ─── Branch comparison ───────────────────────────────────────────────────────

async function compareBranches(owner, repo, base, head) {
  const cc = client(owner);
  const res = await cc.send(new GetDifferencesCommand({
    repositoryName: repo,
    beforeCommitSpecifier: base,
    afterCommitSpecifier: head
  }));
  return (res.differences || []).map(d => ({
    status: d.changeType === "A" ? "added" : d.changeType === "D" ? "removed" : "modified",
    filename: d.afterBlob?.path || d.beforeBlob?.path
  }));
}

// ─── Merge ───────────────────────────────────────────────────────────────────

async function mergeBranches(owner, repo, base, head, message, committer) {
  const cc = client(owner);
  const res = await cc.send(new MergeBranchesByFastForwardCommand({
    repositoryName: repo,
    sourceCommitSpecifier: head,
    destinationCommitSpecifier: base,
    targetBranch: base
  }));
  return { commitId: res.commitId };
}

// ─── Commits ─────────────────────────────────────────────────────────────────

async function getCommits(owner, repo, branch, limit) {
  const cc = client(owner);
  const branchRes = await cc.send(new GetBranchCommand({ repositoryName: repo, branchName: branch }));
  const commitId = branchRes.branch.commitId;
  const commitRes = await cc.send(new GetCommitCommand({ repositoryName: repo, commitId }));
  const c = commitRes.commit;
  return [{
    sha: commitId,
    message: c.message,
    author: c.author?.name,
    date: c.author?.date
  }];
}

async function getCommit(owner, repo, sha) {
  const cc = client(owner);
  const res = await cc.send(new GetCommitCommand({ repositoryName: repo, commitId: sha }));
  return res.commit;
}

// ─── Conflict check ──────────────────────────────────────────────────────────

async function checkConflicts(owner, repo, base, head) {
  const cc = client(owner);
  try {
    const res = await cc.send(new GetMergeConflictsCommand({
      repositoryName: repo,
      sourceCommitSpecifier: head,
      destinationCommitSpecifier: base,
      mergeOption: "FAST_FORWARD_MERGE"
    }));
    return { hasConflicts: res.conflictMetadataList?.length > 0, conflicts: res.conflictMetadataList || [] };
  } catch (e) {
    return { hasConflicts: false, conflicts: [] };
  }
}

module.exports = {
  listBranches,
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
  checkConflicts
};
