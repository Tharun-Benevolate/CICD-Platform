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
async function resolveWorkspace(project, target, tokenOverride) {
  const targetOwner = target?.owner || project.githubOwner;
  const targetRepo = target?.repo || project.githubRepo;

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
  const workspacePath = path.join(WORKSPACES_DIR, project.id, targetRepo || 'default');
  const token = tokenOverride || process.env.GITHUB_TOKEN;

  if (!token) throw new Error('No localRepoPath configured and no GitHub token is available.');

  if (!fs.existsSync(WORKSPACES_DIR)) fs.mkdirSync(WORKSPACES_DIR, { recursive: true });

  const remoteUrl = `https://x-access-token:${token}@github.com/${targetOwner}/${targetRepo}.git`;

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

/**
 * Makes `git push <remote> <branch>` work regardless of what's checked out
 * locally.
 *
 * Plain `git push origin release1` tells git "push my *local* ref named
 * release1". If no local branch called release1 exists (common in this UI —
 * the user is scoping the command to whatever branch they clicked on the
 * graph, not necessarily what's checked out locally), git fails fast with:
 *   "error: src refspec release1 does not match any"
 *
 * If the target isn't a real local branch, we rewrite the command to the
 * explicit refspec `HEAD:release1`, which pushes the current commit to that
 * branch on the remote (creating it if it doesn't exist yet) and, combined
 * with -u, still sets up tracking correctly. This makes push behave the same
 * whether the branch exists locally, only on GitHub, or not at all yet.
 */
async function resolvePushParts(parts, cwd) {
  const args = parts.slice(1);
  // Don't touch branch-deletion or already-explicit-refspec pushes.
  if (args.some(a => a === '-d' || a === '--delete')) return { parts, note: null };

  const positional = [];
  args.forEach((value, i) => {
    if (!value.startsWith('-')) positional.push({ value, idx: i + 1 }); // +1 re-indexes against `parts`
  });

  // Need at least `<remote> <branch>` to know what's being targeted.
  if (positional.length < 2) return { parts, note: null };

  const branchArg = positional[1];
  if (branchArg.value.includes(':')) return { parts, note: null }; // already an explicit refspec

  try {
    await execAsync(`git rev-parse --verify --quiet refs/heads/${branchArg.value}`, { cwd });
    return { parts, note: null }; // a real local branch exists — normal push semantics are correct
  } catch {
    const rewritten = [...parts];
    rewritten[branchArg.idx] = `HEAD:${branchArg.value}`;
    return {
      parts: rewritten,
      note: `Note: no local branch named "${branchArg.value}" — pushed current HEAD to origin/${branchArg.value} instead.`
    };
  }
}

async function runGitCommand(project, commandStr, target = null, tokenOverride = null) {
  const { cwd, isLocal } = await resolveWorkspace(project, target, tokenOverride);

  // Detect the verb (first non-"git" word) to decide if we need token injection
  let parts = commandStr.trim().replace(/^git\s+/, '').split(/\s+/);
  const verb = (parts[0] || '').toLowerCase();

  let pushNote = null;
  if (verb === 'push') {
    const resolved = await resolvePushParts(parts, cwd);
    parts = resolved.parts;
    pushNote = resolved.note;
  }

  let fullCommand = 'git ' + parts.join(' ');

  // For network operations on a local repo, we inject the token via git's
  // URL rewrite config so no interactive credential prompt is ever shown.
  // GIT_TERMINAL_PROMPT=0 ensures it fails fast instead of hanging forever.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

  if (isLocal && NETWORK_VERBS.has(verb)) {
    const token = tokenOverride || process.env.GITHUB_TOKEN;
    if (!token) {
      return {
        success: false,
        output: 'No GitHub token available — cannot authenticate push/pull.',
        isLocal
      };
    }
    // Inject the token as a git config URL rewrite (no persistent side-effects)
    const tokenUrl = `https://x-access-token:${token}@github.com/`;
    fullCommand = `git -c credential.helper='' -c "url.${tokenUrl}.insteadOf=https://github.com/" ${fullCommand.replace(/^git\s+/, '')}`;
  }

  const withNote = (text) => (pushNote ? `${pushNote}\n${text}` : text);

  try {
    const { stdout, stderr } = await execAsync(fullCommand, { cwd, env, timeout: 30000 });
    return { success: true, output: withNote((stdout + '\n' + stderr).trim()), isLocal };
  } catch (error) {
    const out = ((error.stdout || '') + '\n' + (error.stderr || '')).trim() || error.message;
    // If it still prompted and timed out, give a clear message
    if (error.killed || error.code === null) {
      return { success: false, output: withNote('Command timed out — the remote may require credentials not available here.'), isLocal };
    }
    return { success: false, output: withNote(out), isLocal };
  }
}

module.exports = { runGitCommand };
