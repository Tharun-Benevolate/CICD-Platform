// services/providers/gitlabProvider.js — Stub for Phase 5.
// Implements the same interface as githubProvider.js.
// All functions throw until Phase 5 implementation.

const NOT_IMPL = () => { throw new Error("GitLab provider is not yet implemented (Phase 5)"); };

module.exports = {
  listBranches: NOT_IMPL,
  createBranch: NOT_IMPL,
  deleteBranch: NOT_IMPL,
  getFileContent: NOT_IMPL,
  updateFile: NOT_IMPL,
  deleteFile: NOT_IMPL,
  createMultiFileCommit: NOT_IMPL,
  getTree: NOT_IMPL,
  compareBranches: NOT_IMPL,
  mergeBranches: NOT_IMPL,
  getCommits: NOT_IMPL,
  getCommit: NOT_IMPL,
  checkConflicts: NOT_IMPL
};
