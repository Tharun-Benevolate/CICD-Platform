const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');

const execAsync = util.promisify(exec);

// Commands that need to talk to GitHub and require token auth
const NETWORK_VERBS = new Set(['push', 'pull', 'fetch', 'clone']);

/**
 * Resolves the working directory for git commands.
 *
 * Priority:
 *   1. project.localRepoPath  — the user-configured local checkout (preferred)
 *   2. /tmp/cicd-admin-workspaces/<id> — server-side clone fallback
 */
async function resolveWorkspace(project) {
  if (project.localRepoPath && fs.existsSync(project.localRepoPath)) {
    try {
      await execAsync('git rev-parse --git-dir', { cwd: project.localRepoPath });
      return { cwd: project.localRepoPath, isLocal: true };
    } catch {
      throw new Error(`"${project.localRepoPath}" is not a git repository.`);
    }
  }

  // Fallback: server-side clone
  const WORKSPACES_DIR = '/tmp/cicd-admin-workspaces';
  const workspacePath = path.join(WORKSPACES_DIR, project.id);
  const token = process.env.GITHUB_TOKEN;

  if (!token) throw new Error('No localRepoPath configured and GITHUB_TOKEN is not set.');

  if (!fs.existsSync(WORKSPACES_DIR)) fs.mkdirSync(WORKSPACES_DIR, { recursive: true });

  const remoteUrl = `https://x-access-token:${token}@github.com/${project.githubOwner}/${project.githubRepo}.git`;

  if (!fs.existsSync(workspacePath)) {
    fs.mkdirSync(workspacePath, { recursive: true });
    await execAsync(`git clone ${remoteUrl} .`, { cwd: workspacePath });
    await execAsync(`git config user.name "CICD Admin"`, { cwd: workspacePath });
    await execAsync(`git config user.email "admin@benevolate.local"`, { cwd: workspacePath });
  } else {
    await execAsync(`git remote set-url origin ${remoteUrl}`, { cwd: workspacePath });
  }

  return { cwd: workspacePath, isLocal: false };
}

async function runGitCommand(project, commandStr) {
  const { cwd, isLocal } = await resolveWorkspace(project);

  // Detect the verb (first non-"git" word) to decide if we need token injection
  const parts = commandStr.trim().replace(/^git\s+/, '').split(/\s+/);
  const verb = (parts[0] || '').toLowerCase();

  let fullCommand = commandStr.trim().startsWith('git ') ? commandStr : `git ${commandStr}`;

  // For network operations on a local repo, we inject the token via git's
  // URL rewrite config so no interactive credential prompt is ever shown.
  // GIT_TERMINAL_PROMPT=0 ensures it fails fast instead of hanging forever.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

  if (isLocal && NETWORK_VERBS.has(verb)) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      return {
        success: false,
        output: 'GITHUB_TOKEN is not set in .env — cannot authenticate push/pull without it.',
        isLocal
      };
    }
    // Inject the token as a git config URL rewrite (no persistent side-effects)
    const tokenUrl = `https://x-access-token:${token}@github.com/`;
    fullCommand = `git -c credential.helper='' -c "url.${tokenUrl}.insteadOf=https://github.com/" ${fullCommand.replace(/^git\s+/, '')}`;
  }

  try {
    const { stdout, stderr } = await execAsync(fullCommand, { cwd, env, timeout: 30000 });
    return { success: true, output: (stdout + '\n' + stderr).trim(), isLocal };
  } catch (error) {
    const out = ((error.stdout || '') + '\n' + (error.stderr || '')).trim() || error.message;
    // If it still prompted and timed out, give a clear message
    if (error.killed || error.code === null) {
      return { success: false, output: 'Command timed out — the remote may require credentials not available here.', isLocal };
    }
    return { success: false, output: out, isLocal };
  }
}

module.exports = { runGitCommand };
