// Change Requests / Git Diff & Merge Page — Vanilla JS Logic
var _crActiveProject = null;
var _crRepos = [];
var _crSelectedRepoId = null;
var _crBranches = [];
var _crDiffResult = null;    // the current compare result
var _crSelectedCrId = null;  // for legacy CR panel

window.initChangeRequestsPage = initChangeRequestsPage;
window.initCrPage = initChangeRequestsPage;
window.toggleCustomDropdown = toggleCustomDropdown;
window.toggleDiffRepoDropdown = toggleDiffRepoDropdown;
window.onDiffBaseBranchChange = onDiffBaseBranchChange;
window.onDiffHeadBranchChange = onDiffHeadBranchChange;
window.onDiffBranchChange = onDiffBranchChange;
window.setDiffViewMode = setDiffViewMode;
window.runDiff = runDiff;
window.openMergeModal = openMergeModal;
window.closeMergeModal = closeMergeModal;
window.executeMerge = executeMerge;
window.clearSelectedCommitFilter = clearSelectedCommitFilter;
window.selectCrRepo = selectCrRepo;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initChangeRequestsPage);
} else {
  initChangeRequestsPage();
}


// ── Initialise ────────────────────────────────────────────────────────────────
async function initChangeRequestsPage() {
  _crDiffResult = null;
  _crSelectedRepoId = null;
  _crBranches = [];
  _crRepos = [];

  // Reset UI
  showDiffState('empty');
  var statusBar = document.getElementById('diff-status-bar');
  if (statusBar) statusBar.style.display = 'none';
  var btnMerge = document.getElementById('btn-open-merge');
  if (btnMerge) btnMerge.style.display = 'none';

  try {
    var res = await api.get('/api/projects');
    if (res && res.projects) {
      _crActiveProject = res.projects.find(function(p) { return p.isActive; }) || res.projects[0];
    }
  } catch(e) {}

  fetchCrRepos();
  fetchLegacyCRs();
}

// ── Repository Dropdown ────────────────────────────────────────────────────────
async function fetchCrRepos() {
  var menu = document.getElementById('diff-repo-menu');
  if (menu) menu.innerHTML = '<div style="padding:12px 16px;font-size:13px;color:var(--color-text-tertiary);">Loading…</div>';

  try {
    var url = _crActiveProject ? '/api/repos?projectId=' + _crActiveProject.id : '/api/repos';
    var res = await api.get(url);
    _crRepos = (res && (res.repos || res.repositories)) || [];
  } catch(e) { _crRepos = []; }

  renderCrRepoMenu();
  if (_crRepos.length > 0) selectCrRepo(_crRepos[0].id || _crRepos[0].repo_name || _crRepos[0].name);
}

function renderCrRepoMenu() {
  var menu = document.getElementById('diff-repo-menu');
  if (!menu) return;
  menu.innerHTML = '';
  if (_crRepos.length === 0) {
    menu.innerHTML = '<div style="padding:12px 16px;font-size:13px;color:var(--color-text-tertiary);">No repositories connected</div>';
    return;
  }
  _crRepos.forEach(function(r) {
    var name = r.repo_name || r.repositoryName || r.name;
    var rid = r.id || name;
    var div = document.createElement('div');
    div.style.cssText = 'padding:10px 16px;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:8px;transition:background 0.1s;';
    div.onmouseover = function() { div.style.background = 'var(--color-surface-hover)'; };
    div.onmouseout = function() { div.style.background = ''; };
    div.innerHTML = '<i data-lucide="folder" style="width:13px;height:13px;color:#6366f1;flex-shrink:0;"></i><span style="font-weight:600;color:var(--color-text-primary);">' + name + '</span>';
    div.onclick = function() {
      selectCrRepo(rid);
      document.getElementById('diff-repo-menu').style.display = 'none';
      var arrow = document.getElementById('diff-repo-arrow');
      if (arrow) arrow.style.transform = 'none';
      if (window.lucide) lucide.createIcons();
    };
    menu.appendChild(div);
  });
  if (window.lucide) lucide.createIcons();
}

function toggleDiffRepoDropdown() {
  var menu = document.getElementById('diff-repo-menu');
  var arrow = document.getElementById('diff-repo-arrow');
  if (!menu) return;
  var isOpen = menu.style.display === 'block';
  menu.style.display = isOpen ? 'none' : 'block';
  if (arrow) arrow.style.transform = isOpen ? 'none' : 'rotate(180deg)';
}

async function selectCrRepo(rid) {
  _crSelectedRepoId = rid;
  var repo = _crRepos.find(function(r) { return (r.id || r.repo_name || r.name) === rid; });
  var name = repo ? (repo.repo_name || repo.repositoryName || repo.name) : 'Repository';
  var textEl = document.getElementById('diff-repo-text');
  if (textEl) textEl.textContent = name;

  // Fetch branches for this repo
  _crBranches = [];
  populateBranchSelects([]);
  setBtnDiff(false);

  try {
    var params = new URLSearchParams({ repositoryId: rid });
    if (_crActiveProject) params.set('projectId', _crActiveProject.id);
    var res = await api.get('/api/branches/by-repo?' + params.toString());
    if (res && res.ok && res.branches) {
      _crBranches = res.branches;
    }
  } catch(e) {}

  populateBranchSelects(_crBranches);
  showDiffState('empty');
  var statusBar = document.getElementById('diff-status-bar');
  if (statusBar) statusBar.style.display = 'none';
}

var _crDiffViewMode = 'side'; // 'side' | 'unified'
var _crSelectedCommitSha = null;

var _crSelectedVals = {
  'diff-base-branch': '',
  'diff-base-commit': '',
  'diff-head-branch': '',
  'diff-head-commit': ''
};


// Global click handler to close dropdowns when clicking outside
document.addEventListener('click', function(e) {
  ['diff-base-branch', 'diff-base-commit', 'diff-head-branch', 'diff-head-commit', 'diff-repo'].forEach(function(id) {
    var wrapper = document.getElementById(id + '-wrapper');
    var menu = document.getElementById(id + '-menu');
    var arrow = document.getElementById(id + '-arrow');
    if (menu && wrapper && !wrapper.contains(e.target)) {
      menu.style.display = 'none';
      if (arrow) arrow.style.transform = 'none';
    }
  });
});

function toggleCustomDropdown(id) {
  ['diff-base-branch', 'diff-base-commit', 'diff-head-branch', 'diff-head-commit', 'diff-repo'].forEach(function(otherId) {
    if (otherId !== id) {
      var otherMenu = document.getElementById(otherId + '-menu');
      var otherArrow = document.getElementById(otherId + '-arrow');
      if (otherMenu) otherMenu.style.display = 'none';
      if (otherArrow) otherArrow.style.transform = 'none';
    }
  });

  var menu = document.getElementById(id + '-menu');
  var arrow = document.getElementById(id + '-arrow');
  if (!menu) return;
  var isOpen = menu.style.display === 'block';
  menu.style.display = isOpen ? 'none' : 'block';
  if (arrow) arrow.style.transform = isOpen ? 'none' : 'rotate(180deg)';
}

function renderCustomDropdownMenu(id, options, currentVal, onSelect) {
  var menu = document.getElementById(id + '-menu');
  if (!menu) return;
  menu.innerHTML = '';

  if (!options || options.length === 0) {
    menu.innerHTML = '<div style="padding:10px 14px;font-size:12px;color:var(--color-text-tertiary);">No options available</div>';
    return;
  }

  options.forEach(function(opt) {
    var val = opt.value;
    var label = opt.label || val;
    var isSelected = (val === currentVal);

    var item = document.createElement('div');
    item.style.cssText = 'padding:8px 12px;font-size:13px;border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:8px;transition:background 0.1s;' +
      (isSelected ? 'background:rgba(99,102,241,0.1);color:#6366f1;font-weight:700;' : 'color:var(--color-text-primary);font-weight:500;');

    item.onmouseover = function() { if (!isSelected) item.style.background = 'var(--color-surface-hover)'; };
    item.onmouseout = function() { if (!isSelected) item.style.background = 'transparent'; };

    item.innerHTML =
      '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escHtml(label) + '</span>' +
      (isSelected ? '<i data-lucide="check" style="width:14px;height:14px;color:#6366f1;flex-shrink:0;"></i>' : '');

    item.onclick = function() {
      _crSelectedVals[id] = val;
      var textEl = document.getElementById(id + '-text');
      if (textEl) textEl.textContent = label;
      menu.style.display = 'none';
      var arrow = document.getElementById(id + '-arrow');
      if (arrow) arrow.style.transform = 'none';
      if (window.lucide) lucide.createIcons();
      if (onSelect) onSelect(val);
    };

    menu.appendChild(item);
  });

  if (window.lucide) lucide.createIcons();
}

function setDiffViewMode(mode) {
  _crDiffViewMode = mode;
  var btnSide = document.getElementById('btn-view-side');
  var btnUnified = document.getElementById('btn-view-unified');
  if (btnSide && btnUnified) {
    if (mode === 'side') {
      btnSide.style.background = '#6366f1';
      btnSide.style.color = 'white';
      btnSide.classList.add('active');
      btnUnified.style.background = 'transparent';
      btnUnified.style.color = 'var(--color-text-secondary)';
      btnUnified.classList.remove('active');
    } else {
      btnUnified.style.background = '#6366f1';
      btnUnified.style.color = 'white';
      btnUnified.classList.add('active');
      btnSide.style.background = 'transparent';
      btnSide.style.color = 'var(--color-text-secondary)';
      btnSide.classList.remove('active');
    }
  }
  if (_crDiffResult) {
    renderDiffResults(_crDiffResult, _crSelectedVals['diff-base-branch'], _crSelectedVals['diff-head-branch']);
  }
}

function populateBranchSelects(branches) {
  if (!branches || branches.length === 0) {
    renderCustomDropdownMenu('diff-base-branch', [], '', null);
    renderCustomDropdownMenu('diff-head-branch', [], '', null);
    return;
  }

  var def = branches.find(function(b) { return b.isDefault; }) || branches[0];
  var defVal = def.name || def;
  var defLabel = defVal + (def.isDefault ? ' (default)' : '');

  var comp = branches.find(function(b) { return (b.name || b) !== defVal; }) || branches[1] || branches[0];
  var compVal = comp.name || comp;
  var compLabel = compVal + (comp.isDefault ? ' (default)' : '');

  _crSelectedVals['diff-base-branch'] = defVal;
  var textBase = document.getElementById('diff-base-branch-text');
  if (textBase) textBase.textContent = defLabel;

  _crSelectedVals['diff-head-branch'] = compVal;
  var textHead = document.getElementById('diff-head-branch-text');
  if (textHead) textHead.textContent = compLabel;

  var branchOptions = branches.map(function(b) {
    var bName = b.name || b;
    return { value: bName, label: bName + (b.isDefault ? ' (default)' : '') };
  });

  renderCustomDropdownMenu('diff-base-branch', branchOptions, defVal, function(val) {
    onDiffBaseBranchChange();
  });

  renderCustomDropdownMenu('diff-head-branch', branchOptions, compVal, function(val) {
    onDiffHeadBranchChange();
  });

  onDiffBaseBranchChange();
  onDiffHeadBranchChange();
}

async function onDiffBaseBranchChange() {
  var base = _crSelectedVals['diff-base-branch'];
  _crSelectedVals['diff-base-commit'] = '';
  var textEl = document.getElementById('diff-base-commit-text');
  if (textEl) textEl.textContent = 'Latest (HEAD)';

  var commitOptions = [{ value: '', label: 'Latest (HEAD)' }];
  renderCustomDropdownMenu('diff-base-commit', commitOptions, '', function() { onDiffBranchChange(); });

  if (base && _crSelectedRepoId) {
    try {
      var params = new URLSearchParams({ repositoryId: _crSelectedRepoId, branch: base, limit: '20' });
      if (_crActiveProject) params.set('projectId', _crActiveProject.id);
      var res = await api.get('/api/commits/by-repo?' + params.toString());
      if (res && res.ok && res.commits) {
        res.commits.forEach(function(c) {
          var sha = c.sha || c.commitId || '';
          var msg = c.message || (c.commit && c.commit.message) || '';
          var firstLine = msg.split('\n')[0];
          commitOptions.push({
            value: sha,
            label: sha.substring(0, 7) + ' - ' + (firstLine.length > 18 ? firstLine.substring(0, 18) + '…' : firstLine)
          });
        });
        renderCustomDropdownMenu('diff-base-commit', commitOptions, _crSelectedVals['diff-base-commit'], function() { onDiffBranchChange(); });
      }
    } catch (_) {}
  }
  onDiffBranchChange();
}

async function onDiffHeadBranchChange() {
  var head = _crSelectedVals['diff-head-branch'];
  _crSelectedVals['diff-head-commit'] = '';
  var textEl = document.getElementById('diff-head-commit-text');
  if (textEl) textEl.textContent = 'Latest (HEAD)';

  var commitOptions = [{ value: '', label: 'Latest (HEAD)' }];
  renderCustomDropdownMenu('diff-head-commit', commitOptions, '', function() { onDiffBranchChange(); });

  if (head && _crSelectedRepoId) {
    try {
      var params = new URLSearchParams({ repositoryId: _crSelectedRepoId, branch: head, limit: '20' });
      if (_crActiveProject) params.set('projectId', _crActiveProject.id);
      var res = await api.get('/api/commits/by-repo?' + params.toString());
      if (res && res.ok && res.commits) {
        res.commits.forEach(function(c) {
          var sha = c.sha || c.commitId || '';
          var msg = c.message || (c.commit && c.commit.message) || '';
          var firstLine = msg.split('\n')[0];
          commitOptions.push({
            value: sha,
            label: sha.substring(0, 7) + ' - ' + (firstLine.length > 18 ? firstLine.substring(0, 18) + '…' : firstLine)
          });
        });
        renderCustomDropdownMenu('diff-head-commit', commitOptions, _crSelectedVals['diff-head-commit'], function() { onDiffBranchChange(); });
      }
    } catch (_) {}
  }
  onDiffBranchChange();
}

function onDiffBranchChange() {
  var baseBranch = _crSelectedVals['diff-base-branch'] || '';
  var headBranch = _crSelectedVals['diff-head-branch'] || '';
  var baseCommit = _crSelectedVals['diff-base-commit'] || '';
  var headCommit = _crSelectedVals['diff-head-commit'] || '';

  var finalBase = baseCommit || baseBranch;
  var finalHead = headCommit || headBranch;

  setBtnDiff(!!(finalBase && finalHead && _crSelectedRepoId));
}

function setBtnDiff(enabled) {
  var btn = document.getElementById('btn-run-diff');
  if (btn) btn.disabled = !enabled;
}

// ── Run Diff ────────────────────────────────────────────────────────────────
async function runDiff() {
  var baseBranch = _crSelectedVals['diff-base-branch'] || '';
  var headBranch = _crSelectedVals['diff-head-branch'] || '';
  var baseCommit = _crSelectedVals['diff-base-commit'] || '';
  var headCommit = _crSelectedVals['diff-head-commit'] || '';

  var finalBase = baseCommit || baseBranch;
  var finalHead = headCommit || headBranch;

  // Single Commit Inspection Logic:
  // If user selected a specific compare commit (e.g. 3d0614f) and left baseCommit empty (HEAD),
  // compare against that commit's parent (3d0614f~1) so the commit's own diff shows up!
  if (headCommit && !baseCommit) {
    finalBase = headCommit + '~1';
  } else if (baseCommit && !headCommit) {
    finalHead = baseCommit;
    finalBase = baseCommit + '~1';
  }

  if (!finalBase || !finalHead || !_crSelectedRepoId) return;

  _crDiffResult = null;
  _crSelectedCommitSha = null;
  showDiffState('loading');
  var statusBar = document.getElementById('diff-status-bar');
  if (statusBar) statusBar.style.display = 'none';

  try {
    var params = new URLSearchParams({
      repositoryId: _crSelectedRepoId,
      base: finalBase,
      head: finalHead
    });
    if (_crActiveProject) params.set('projectId', _crActiveProject.id);

    var res = await api.get('/api/branches/compare?' + params.toString());
    if (res && res.ok && res.diff) {
      _crDiffResult = res.diff;
      renderDiffResults(_crDiffResult, finalBase, finalHead);
    } else {
      showDiffState('empty');
      showToast(res && res.error ? res.error : 'Failed to compare branches/commits', 'error');
    }
  } catch(err) {
    showDiffState('empty');
    showToast(err.message || 'Error comparing branches/commits', 'error');
  }
}

function selectCommitFilter(sha) {

  if (_crSelectedCommitSha === sha) {
    _crSelectedCommitSha = null;
  } else {
    _crSelectedCommitSha = sha;
  }
  var filterBtn = document.getElementById('btn-filter-all-commits');
  if (filterBtn) filterBtn.style.display = _crSelectedCommitSha ? 'inline-block' : 'none';

  if (_crDiffResult) {
    renderDiffResults(_crDiffResult, document.getElementById('diff-base-branch').value, document.getElementById('diff-head-branch').value);
  }
}

function clearSelectedCommitFilter() {
  _crSelectedCommitSha = null;
  var filterBtn = document.getElementById('btn-filter-all-commits');
  if (filterBtn) filterBtn.style.display = 'none';
  if (_crDiffResult) {
    renderDiffResults(_crDiffResult, document.getElementById('diff-base-branch').value, document.getElementById('diff-head-branch').value);
  }
}

function renderDiffResults(diff, base, head) {
  var commits = diff.commits || [];
  var files = diff.files || [];
  var additions = files.reduce(function(s, f) { return s + (f.additions || 0); }, 0);
  var deletions = files.reduce(function(s, f) { return s + (f.deletions || 0); }, 0);

  // Update status bar
  document.getElementById('diff-stat-commits').textContent = commits.length + ' commit' + (commits.length !== 1 ? 's' : '');
  document.getElementById('diff-stat-files').textContent = files.length + ' file' + (files.length !== 1 ? 's' : '') + ' changed';
  document.getElementById('diff-stat-add').textContent = '+' + additions;
  document.getElementById('diff-stat-del').textContent = '-' + deletions;

  var conflictBadge = document.getElementById('diff-conflict-badge');
  var cleanBadge = document.getElementById('diff-clean-badge');
  var hasConflicts = diff.hasConflicts || false;
  if (conflictBadge) conflictBadge.style.display = hasConflicts ? 'inline-flex' : 'none';
  if (cleanBadge) cleanBadge.style.display = hasConflicts ? 'none' : 'inline-flex';

  var statusBar = document.getElementById('diff-status-bar');
  if (statusBar) {
    statusBar.style.display = 'flex';
  }

  // Show merge button only if no conflicts
  var btnMerge = document.getElementById('btn-open-merge');
  if (btnMerge) {
    btnMerge.style.display = (commits.length > 0 && !hasConflicts) ? 'inline-flex' : 'none';
  }

  // Render commits list
  var commitsList = document.getElementById('diff-commits-list');
  var commitsBadge = document.getElementById('diff-commits-badge');
  if (commitsBadge) commitsBadge.textContent = '(' + commits.length + ')';
  if (commitsList) {
    commitsList.innerHTML = '';
    if (commits.length === 0) {
      commitsList.innerHTML = '<div style="text-align:center;padding:30px;color:var(--color-text-tertiary);font-size:13px;">No commits found</div>';
    } else {
      commits.forEach(function(c) {
        var sha = c.sha || c.commitId || '';
        var isSelected = _crSelectedCommitSha && (sha === _crSelectedCommitSha || sha.startsWith(_crSelectedCommitSha));
        var msg = c.message || (c.commit && c.commit.message) || 'No message';
        var firstLine = msg.split('\n')[0];
        var author = c.authorName || (c.commit && c.commit.author && c.commit.author.name) || 'Developer';
        var date = c.date || (c.commit && c.commit.author && c.commit.author.date) || null;
        var avatar = c.authorAvatar || '';

        var div = document.createElement('div');
        div.style.cssText = 'padding:10px 12px;border-radius:10px;border:1px solid ' + (isSelected ? '#6366f1' : 'var(--color-border)') + ';background:' + (isSelected ? 'rgba(99,102,241,0.08)' : 'var(--color-bg)') + ';transition:all 0.15s;cursor:pointer;';
        div.onclick = function() { selectCommitFilter(sha); };
        div.onmouseover = function() { if (!isSelected) div.style.borderColor = '#6366f1'; };
        div.onmouseout = function() { if (!isSelected) div.style.borderColor = 'var(--color-border)'; };
        div.innerHTML =
          '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">' +
            (avatar ? '<img src="' + avatar + '" style="width:18px;height:18px;border-radius:50%;" />' : '<i data-lucide="user" style="width:14px;height:14px;color:var(--color-text-tertiary);"></i>') +
            '<span style="font-size:11px;font-weight:600;color:var(--color-text-secondary);">' + author + '</span>' +
            (sha ? '<span style="margin-left:auto;font-family:monospace;font-size:10px;color:var(--color-text-tertiary);background:var(--color-surface);padding:2px 6px;border-radius:5px;">' + sha.substring(0, 7) + '</span>' : '') +
          '</div>' +
          '<div style="font-size:12px;font-weight:600;color:var(--color-text-primary);line-height:1.4;margin-bottom:4px;">' + firstLine + '</div>' +
          (date ? '<div style="font-size:11px;color:var(--color-text-tertiary);">' + (window.TimeUtil ? TimeUtil.relTime(date) : relTimeFallback(date)) + '</div>' : '');
        commitsList.appendChild(div);
      });
    }
  }

  // Render file diffs
  var filesList = document.getElementById('diff-files-list');
  var filesBadge = document.getElementById('diff-files-badge');
  if (filesBadge) filesBadge.textContent = '(' + files.length + ' changed)';
  if (filesList) {
    filesList.innerHTML = '';
    if (files.length === 0) {
      filesList.innerHTML = '<div style="text-align:center;padding:40px;color:var(--color-text-tertiary);font-size:13px;">No file changes between these branches/commits</div>';
    } else {
      files.forEach(function(f) {
        renderFileDiff(filesList, f);
      });
    }
  }

  showDiffState('results');
  if (window.lucide) lucide.createIcons();
}

function renderFileDiff(container, f) {
  var statusColor = { added: '#10b981', removed: '#ef4444', deleted: '#ef4444', modified: '#f59e0b', renamed: '#6366f1' };
  var statusLabel = { added: 'A', removed: 'D', deleted: 'D', modified: 'M', renamed: 'R' };
  var st = f.status || 'modified';
  var color = statusColor[st] || '#6366f1';
  var label = statusLabel[st] || 'M';
  var patch = f.patch || '';

  var wrapper = document.createElement('div');
  wrapper.style.cssText = 'border-bottom:1px solid var(--color-border);';

  // File header row
  var header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 16px;cursor:pointer;background:var(--color-bg);transition:background 0.1s;';
  header.onmouseover = function() { header.style.background = 'var(--color-surface-hover)'; };
  header.onmouseout = function() { header.style.background = 'var(--color-bg)'; };
  header.innerHTML =
    '<span style="font-size:11px;font-weight:800;color:' + color + ';background:' + color + '1a;padding:2px 7px;border-radius:5px;flex-shrink:0;">' + label + '</span>' +
    '<span style="font-family:monospace;font-size:12px;font-weight:600;color:var(--color-text-primary);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (f.filename || f.path || 'unknown') + '</span>' +
    '<span style="font-size:11px;color:#10b981;font-weight:700;flex-shrink:0;">+' + (f.additions || 0) + '</span>' +
    '<span style="font-size:11px;color:#ef4444;font-weight:700;flex-shrink:0;margin-left:4px;">-' + (f.deletions || 0) + '</span>' +
    '<i data-lucide="chevron-down" class="file-diff-toggle" style="width:14px;height:14px;color:var(--color-text-tertiary);flex-shrink:0;transition:transform 0.15s;"></i>';

  var patchBlock = document.createElement('div');
  patchBlock.style.display = 'none';

  if (patch) {
    if (_crDiffViewMode === 'side') {
      patchBlock.innerHTML = buildSideBySideHtml(patch);
    } else {
      patchBlock.innerHTML = buildUnifiedHtml(patch);
    }
  } else {
    patchBlock.innerHTML = '<div style="padding:14px 18px;font-size:12px;color:var(--color-text-tertiary);font-style:italic;">No patch data available for this file.</div>';
  }

  var expanded = false;
  header.onclick = function() {
    expanded = !expanded;
    patchBlock.style.display = expanded ? 'block' : 'none';
    var icon = header.querySelector('.file-diff-toggle');
    if (icon) icon.style.transform = expanded ? 'rotate(180deg)' : 'none';
  };

  wrapper.appendChild(header);
  wrapper.appendChild(patchBlock);
  container.appendChild(wrapper);
}

function buildUnifiedHtml(patch) {
  var lines = patch.split('\n');
  var pre = document.createElement('pre');
  pre.style.cssText = 'margin:0;padding:12px 16px;font-family:Consolas,Monaco,monospace;font-size:12px;line-height:1.6;overflow-x:auto;background:#0d1117;';
  pre.innerHTML = lines.map(function(line) {
    if (line.startsWith('@@')) {
      return '<span style="color:#6366f1;font-weight:600;">' + escHtml(line) + '</span>';
    } else if (line.startsWith('+')) {
      return '<span style="color:#3fb950;background:rgba(63,185,80,0.07);display:block;">' + escHtml(line) + '</span>';
    } else if (line.startsWith('-')) {
      return '<span style="color:#f85149;background:rgba(248,81,73,0.07);display:block;">' + escHtml(line) + '</span>';
    }
    return '<span style="color:#8b949e;">' + escHtml(line) + '</span>';
  }).join('\n');
  return pre.outerHTML;
}

function buildSideBySideHtml(patch) {
  var lines = patch.split('\n');
  var rows = [];
  var oldLine = 0;
  var newLine = 0;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.startsWith('@@')) {
      var match = line.match(/@@\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      rows.push({ type: 'hunk', header: line });
      continue;
    }

    if (line.startsWith('-')) {
      // Look ahead for matching + line to align side-by-side
      var nextLine = lines[i + 1];
      if (nextLine && nextLine.startsWith('+')) {
        rows.push({
          type: 'change',
          oldNum: oldLine++,
          oldText: line.substring(1),
          newNum: newLine++,
          newText: nextLine.substring(1)
        });
        i++; // skip next line
      } else {
        rows.push({
          type: 'deletion',
          oldNum: oldLine++,
          oldText: line.substring(1),
          newNum: '',
          newText: ''
        });
      }
    } else if (line.startsWith('+')) {
      rows.push({
        type: 'addition',
        oldNum: '',
        oldText: '',
        newNum: newLine++,
        newText: line.substring(1)
      });
    } else {
      var content = line.startsWith(' ') ? line.substring(1) : line;
      rows.push({
        type: 'normal',
        oldNum: oldLine++,
        oldText: content,
        newNum: newLine++,
        newText: content
      });
    }
  }

  var html = '<div style="overflow-x:auto;background:#0d1117;font-family:Consolas,Monaco,monospace;font-size:12px;line-height:1.6;">' +
    '<table style="width:100%;border-collapse:collapse;table-layout:fixed;">' +
    '<colgroup><col style="width:40px;"><col><col style="width:40px;"><col></colgroup>';

  rows.forEach(function(row) {
    if (row.type === 'hunk') {
      html += '<tr><td colspan="4" style="background:rgba(99,102,241,0.12);color:#6366f1;font-weight:600;padding:4px 12px;border-top:1px solid #30363d;border-bottom:1px solid #30363d;">' + escHtml(row.header) + '</td></tr>';
    } else if (row.type === 'change') {
      html += '<tr>' +
        '<td style="text-align:right;padding:2px 8px;color:#484f58;background:rgba(248,81,73,0.15);user-select:none;border-right:1px solid #30363d;">' + row.oldNum + '</td>' +
        '<td style="padding:2px 8px;color:#f85149;background:rgba(248,81,73,0.15);white-space:pre-wrap;word-break:break-all;border-right:1px solid #30363d;">' + escHtml(row.oldText) + '</td>' +
        '<td style="text-align:right;padding:2px 8px;color:#484f58;background:rgba(63,185,80,0.15);user-select:none;border-right:1px solid #30363d;">' + row.newNum + '</td>' +
        '<td style="padding:2px 8px;color:#3fb950;background:rgba(63,185,80,0.15);white-space:pre-wrap;word-break:break-all;">' + escHtml(row.newText) + '</td>' +
      '</tr>';
    } else if (row.type === 'deletion') {
      html += '<tr>' +
        '<td style="text-align:right;padding:2px 8px;color:#484f58;background:rgba(248,81,73,0.15);user-select:none;border-right:1px solid #30363d;">' + row.oldNum + '</td>' +
        '<td style="padding:2px 8px;color:#f85149;background:rgba(248,81,73,0.15);white-space:pre-wrap;word-break:break-all;border-right:1px solid #30363d;">' + escHtml(row.oldText) + '</td>' +
        '<td style="text-align:right;padding:2px 8px;color:#484f58;background:#0d1117;user-select:none;border-right:1px solid #30363d;"></td>' +
        '<td style="padding:2px 8px;background:#0d1117;"></td>' +
      '</tr>';
    } else if (row.type === 'addition') {
      html += '<tr>' +
        '<td style="text-align:right;padding:2px 8px;color:#484f58;background:#0d1117;user-select:none;border-right:1px solid #30363d;"></td>' +
        '<td style="padding:2px 8px;background:#0d1117;border-right:1px solid #30363d;"></td>' +
        '<td style="text-align:right;padding:2px 8px;color:#484f58;background:rgba(63,185,80,0.15);user-select:none;border-right:1px solid #30363d;">' + row.newNum + '</td>' +
        '<td style="padding:2px 8px;color:#3fb950;background:rgba(63,185,80,0.15);white-space:pre-wrap;word-break:break-all;">' + escHtml(row.newText) + '</td>' +
      '</tr>';
    } else {
      html += '<tr>' +
        '<td style="text-align:right;padding:2px 8px;color:#484f58;user-select:none;border-right:1px solid #30363d;">' + row.oldNum + '</td>' +
        '<td style="padding:2px 8px;color:#c9d1d9;white-space:pre-wrap;word-break:break-all;border-right:1px solid #30363d;">' + escHtml(row.oldText) + '</td>' +
        '<td style="text-align:right;padding:2px 8px;color:#484f58;user-select:none;border-right:1px solid #30363d;">' + row.newNum + '</td>' +
        '<td style="padding:2px 8px;color:#c9d1d9;white-space:pre-wrap;word-break:break-all;">' + escHtml(row.newText) + '</td>' +
      '</tr>';
    }
  });

  html += '</table></div>';
  return html;
}

function escHtml(s) {

  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function relTimeFallback(dateStr) {
  if (!dateStr) return '';
  var diff = Date.now() - new Date(dateStr).getTime();
  var m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  var h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

// ── UI State ─────────────────────────────────────────────────────────────────
function showDiffState(state) {
  var loading = document.getElementById('diff-loading');
  var empty = document.getElementById('diff-empty');
  var results = document.getElementById('diff-results');
  if (loading) loading.style.display = state === 'loading' ? 'block' : 'none';
  if (empty) empty.style.display = state === 'empty' ? 'block' : 'none';
  if (results) results.style.display = state === 'results' ? 'grid' : 'none';
}

// ── Merge Modal ────────────────────────────────────────────────────────────────
function openMergeModal() {
  var base = document.getElementById('diff-base-branch').value;
  var head = document.getElementById('diff-head-branch').value;
  document.getElementById('merge-base-label').textContent = base;
  document.getElementById('merge-head-label').textContent = head;
  document.getElementById('merge-commit-msg').value = "Merge '" + head + "' into '" + base + "'";
  document.getElementById('merge-error').style.display = 'none';
  document.getElementById('modal-merge').style.display = 'flex';
  if (window.lucide) lucide.createIcons();
}

function closeMergeModal() {
  document.getElementById('modal-merge').style.display = 'none';
}

async function executeMerge() {
  var base = document.getElementById('diff-base-branch').value;
  var head = document.getElementById('diff-head-branch').value;
  var msg = document.getElementById('merge-commit-msg').value.trim();
  var errEl = document.getElementById('merge-error');
  var btn = document.getElementById('btn-confirm-merge');

  if (!base || !head || !_crSelectedRepoId) return;

  btn.disabled = true;
  btn.textContent = 'Merging…';
  errEl.style.display = 'none';

  try {
    var res = await api.post('/api/branches/merge', {
      repositoryId: _crSelectedRepoId,
      baseBranch: base,
      headBranch: head,
      commitMessage: msg,
      projectId: _crActiveProject ? _crActiveProject.id : undefined
    });

    if (res && res.ok) {
      closeMergeModal();
      showToast('✅ Successfully merged ' + head + ' into ' + base, 'success');
      // Re-run diff to show clean state
      setTimeout(runDiff, 1200);
    } else {
      errEl.textContent = (res && res.error) || 'Merge failed';
      errEl.style.display = 'block';
    }
  } catch(err) {
    errEl.textContent = err.message || 'Merge error';
    errEl.style.display = 'block';
  }

  btn.disabled = false;
  btn.innerHTML = '<i data-lucide="git-merge" style="width:14px;height:14px;"></i> Confirm Merge';
  if (window.lucide) lucide.createIcons();
}

// ── Legacy CR Panel ───────────────────────────────────────────────────────────
function openLegacyCrModal() {
  document.getElementById('panel-legacy-cr').style.display = 'flex';
  document.getElementById('panel-legacy-backdrop').style.display = 'block';
  fetchLegacyCRs();
  if (window.lucide) lucide.createIcons();
}

function closeLegacyCrModal() {
  document.getElementById('panel-legacy-cr').style.display = 'none';
  document.getElementById('panel-legacy-backdrop').style.display = 'none';
}

async function fetchLegacyCRs() {
  var loadingEl = document.getElementById('legacy-cr-loading');
  var listEl = document.getElementById('legacy-cr-list');
  if (loadingEl) loadingEl.style.display = 'block';
  if (listEl) listEl.innerHTML = '';

  try {
    var url = _crActiveProject ? '/api/change-requests?projectId=' + _crActiveProject.id : '/api/change-requests';
    var res = await api.get(url);
    var crs = (res && (res.changeRequests || res.change_requests)) || [];
    if (loadingEl) loadingEl.style.display = 'none';

    if (crs.length === 0) {
      if (listEl) listEl.innerHTML = '<div style="text-align:center;padding:30px;color:var(--color-text-tertiary);font-size:13px;">No change requests yet</div>';
      return;
    }

    crs.forEach(function(cr) {
      var statusColor = { open: '#6366f1', merged: '#10b981', closed: '#6b7280', draft: '#f59e0b', approved: '#10b981', rejected: '#ef4444', conflict: '#ef4444' };
      var sc = statusColor[cr.status] || '#6366f1';
      var isSlack = (cr.title && cr.title.includes('[Slack]')) || (cr.author && cr.author.startsWith('slack'));
      var slackBadge = isSlack ? '<span style="padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700;background:rgba(74,21,75,0.15);color:#e01e5a;margin-right:6px;">Slack</span>' : '';

      var div = document.createElement('div');
      div.style.cssText = 'padding:12px 14px;border:1px solid var(--color-border);border-radius:10px;background:var(--color-bg);';
      div.innerHTML =
        '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:6px;">' +
          '<span style="font-size:13px;font-weight:700;color:var(--color-text-primary);line-height:1.3;">' + slackBadge + (cr.title || 'Untitled') + '</span>' +
          '<span style="padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700;background:' + sc + '1a;color:' + sc + ';text-transform:uppercase;flex-shrink:0;">' + (cr.status || 'open') + '</span>' +
        '</div>' +
        '<div style="font-size:11px;color:var(--color-text-tertiary);">By <b>' + (cr.author || 'unknown') + '</b>' +
          (cr.head_branch ? ' · <code style="color:#6366f1;">' + cr.head_branch + '</code> → <code>' + (cr.base_branch || 'main') + '</code>' : '') +
          (cr.created_at ? ' · ' + (window.TimeUtil ? TimeUtil.relTime(cr.created_at) : relTimeFallback(cr.created_at)) : '') +
        '</div>';
      if (listEl) listEl.appendChild(div);
    });
  } catch(e) {
    if (loadingEl) loadingEl.style.display = 'none';
    if (listEl) listEl.innerHTML = '<div style="color:var(--color-danger);font-size:13px;padding:12px;">Failed to load change requests</div>';
  }
}

async function syncSlackChangeRequests() {
  var btn = document.getElementById('btn-sync-slack-cr');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-2" class="animate-spin" style="width:12px;height:12px;"></i> Syncing...';
  }
  try {
    var res = await api.post('/api/change-requests/sync-slack', {});
    if (res.ok) {
      var count = res.count || 0;
      showToast('✔ Synced Slack channel! ' + count + ' @change request(s) updated.', 'success');
      fetchLegacyCRs();
    } else {
      showToast(res.error || 'Failed to sync Slack messages.', 'error');
    }
  } catch (err) {
    showToast(err.message || 'Server error', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="refresh-cw" style="width:12px;height:12px;"></i> Sync Slack';
    }
    if (window.lucide) lucide.createIcons();
  }
}

window.syncSlackChangeRequests = syncSlackChangeRequests;

// ── Create CR Modal (for legacy panel) ────────────────────────────────────────
function openCreateCrModal() {
  document.getElementById('modal-create-cr').style.display = 'flex';
  if (window.lucide) lucide.createIcons();
}

function closeCreateCrModal() {
  document.getElementById('modal-create-cr').style.display = 'none';
}

async function handleCreateCrSubmit(e) {
  e.preventDefault();
  if (!_crSelectedRepoId) {
    showToast('Please select a repository first', 'error');
    return;
  }
  var title = document.getElementById('cr-title-input').value.trim();
  var desc = document.getElementById('cr-desc-textarea').value.trim();
  var errEl = document.getElementById('cr-create-error');
  var btn = document.getElementById('btn-submit-create-cr');

  btn.disabled = true;
  errEl.style.display = 'none';

  try {
    var res = await api.post('/api/change-requests', {
      repositoryId: _crSelectedRepoId,
      title: title,
      description: desc
    });
    if (res && res.ok) {
      closeCreateCrModal();
      closeLegacyCrModal();
      showToast('Change request created successfully', 'success');
    } else {
      errEl.textContent = (res && res.error) || 'Failed to create change request';
      errEl.style.display = 'block';
    }
  } catch(err) {
    errEl.textContent = err.message || 'Error creating change request';
    errEl.style.display = 'block';
  }
  btn.disabled = false;
}

// ── Toast Notification ────────────────────────────────────────────────────────
function showToast(msg, type) {
  var existing = document.getElementById('cr-toast');
  if (existing) existing.remove();
  var toast = document.createElement('div');
  toast.id = 'cr-toast';
  toast.style.cssText = 'position:fixed;bottom:24px;right:24px;padding:12px 20px;border-radius:12px;font-size:13px;font-weight:600;z-index:9999;max-width:380px;box-shadow:0 8px 32px rgba(0,0,0,0.3);display:flex;align-items:center;gap:8px;animation:slideInRight 0.3s ease;' +
    (type === 'error'
      ? 'background:rgba(239,68,68,0.95);color:white;'
      : 'background:rgba(16,185,129,0.95);color:white;');
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(function() { if (toast.parentNode) toast.remove(); }, 4000);
}

// Close repo dropdown when clicking outside
document.addEventListener('click', function(e) {
  var wrapper = document.getElementById('diff-repo-wrapper');
  if (wrapper && !wrapper.contains(e.target)) {
    var menu = document.getElementById('diff-repo-menu');
    if (menu) menu.style.display = 'none';
    var arrow = document.getElementById('diff-repo-arrow');
    if (arrow) arrow.style.transform = 'none';
  }
});
