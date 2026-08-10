// File Browser Page — Vanilla JS Logic
var _activeProject = null;
var _repos = [];
var _selectedRepoId = '';
var _selectedBranch = 'main';
var _branches = ['main'];
var _currentPath = '';
var _fileTree = [];
var _selectedFile = null;
var _fileContent = '';
var _fileContentEdited = false;  // tracks if user has actually made edits

var _integrateFiles = [];
var _deleteTarget = null;

window.initFileBrowserPage = initFileBrowserPage;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initFileBrowserPage);
} else {
  initFileBrowserPage();
}

async function initFileBrowserPage() {
  // Reset state so SPA re-navigation always starts clean
  _repos = [];
  _fileTree = [];
  _selectedFile = null;
  _fileContent = '';
  _fileContentEdited = false;
  _selectedBranch = 'main';
  _branches = ['main'];
  _currentPath = '';

  // Reset UI
  var branchText = document.getElementById('fb-branch-text');
  if (branchText) branchText.textContent = 'main';
  var btnSave = document.getElementById('btn-save-commit');
  if (btnSave) btnSave.style.display = 'none';
  var emptyEl = document.getElementById('fb-editor-empty');
  if (emptyEl) emptyEl.style.display = 'flex';
  var workspaceEl = document.getElementById('fb-editor-workspace');
  if (workspaceEl) workspaceEl.style.display = 'none';

  try {
    var res = await api.get('/api/projects');
    if (res && res.projects) {
      _activeProject = res.projects.find(function(p) { return p.isActive; }) || res.projects[0];
    }
  } catch (e) {}

  fetchProjectRepos();
}

async function fetchProjectRepos() {
  try {
    var url = _activeProject ? '/api/repos?projectId=' + _activeProject.id : '/api/repos';
    var res = await api.get(url);
    if (res && res.ok && (res.repositories || res.repos)) {
      _repos = res.repositories || res.repos;
    } else {
      _repos = [];
    }
  } catch (e) {
    _repos = [];
  }

  if (!_repos.length && _activeProject && (_activeProject.repoName || _activeProject.githubRepo)) {
    _repos = [{
      id: 'p-' + _activeProject.id,
      repo_name: _activeProject.githubRepo || _activeProject.repoName,
      provider: _activeProject.githubRepo ? 'github' : (_activeProject.sourceType || 'codecommit'),
      default_branch: _activeProject.githubBranch || 'main'
    }];
  }

  renderRepoList();

  if (_repos.length > 0) {
    selectRepo(_repos[0].id);
  } else {
    var loadingEl = document.getElementById('fb-tree-loading');
    if (loadingEl) loadingEl.style.display = 'none';
    var container = document.getElementById('fb-tree-container');
    if (container) {
      container.style.display = 'flex';
      container.innerHTML = '<div style="padding:24px 0;text-align:center;color:var(--color-text-tertiary);font-size:13px;">No repositories connected</div>';
    }
  }
}

function renderRepoList() {
  var listEl = document.getElementById('fb-repo-list-container');
  var countEl = document.getElementById('fb-repo-count');
  if (countEl) countEl.textContent = '(' + _repos.length + ')';
  if (!listEl) return;

  listEl.innerHTML = '';
  if (_repos.length === 0) {
    listEl.innerHTML = '<div style="padding:14px;font-size:13px;color:var(--color-text-tertiary);text-align:center;">No repositories connected</div>';
    return;
  }

  _repos.forEach(function(r) {
    var name = r.repo_name || r.repositoryName || r.name;
    var isSel = r.id === _selectedRepoId;
    var prov = r.provider || 'codecommit';
    var isGH = prov === 'github';

    var item = document.createElement('div');
    item.className = 'fb-dropdown-item';
    item.style.background = isSel ? 'rgba(99,102,241,0.1)' : 'transparent';
    item.onclick = function() {
      selectRepo(r.id);
      document.getElementById('fb-repo-dropdown-menu').style.display = 'none';
    };

    var ghSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="2"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg>';
    var awsSvg = '<i data-lucide="database" style="width:16px;height:16px;color:#3b82f6;"></i>';

    var html =
      '<div style="display:flex;align-items:center;gap:10px;overflow:hidden;">' +
        (isGH ? ghSvg : awsSvg) +
        '<div style="overflow:hidden;">' +
          '<div style="font-size:13px;font-weight:' + (isSel ? '700' : '500') + ';color:var(--color-text-primary);text-overflow:ellipsis;overflow:hidden;white-space:nowrap;">' + name + '</div>' +
          '<div style="font-size:11px;color:var(--color-text-tertiary);">' + (isGH ? 'GitHub' : 'AWS CodeCommit') + ' &bull; ' + (r.default_branch || 'main') + '</div>' +
        '</div>' +
      '</div>' +
      (isSel ? '<i data-lucide="check" style="width:16px;height:16px;color:#6366f1;"></i>' : '');

    item.innerHTML = html;
    listEl.appendChild(item);
  });

  if (window.lucide) lucide.createIcons();
}

function toggleFbRepoDropdown() {
  var m = document.getElementById('fb-repo-dropdown-menu');
  var arrow = document.getElementById('fb-repo-arrow');
  if (m) {
    var isVis = m.style.display === 'block';
    m.style.display = isVis ? 'none' : 'block';
    if (arrow) arrow.style.transform = isVis ? 'none' : 'rotate(180deg)';
  }
}

function selectRepo(rid) {
  _selectedRepoId = rid;
  var repo = _repos.find(function(r) { return r.id === rid; });
  var name = repo ? (repo.repo_name || repo.repositoryName || repo.name) : 'Select Repository';
  var prov = repo ? (repo.provider || 'codecommit') : 'codecommit';

  var textEl = document.getElementById('fb-repo-text');
  if (textEl) {
    textEl.innerHTML = name + '<span style="margin-left:6px;font-size:11px;font-weight:600;padding:2px 6px;border-radius:6px;background:' + (prov === 'github' ? 'rgba(168,85,247,0.12)' : 'rgba(59,130,246,0.12)') + ';color:' + (prov === 'github' ? '#a855f7' : '#3b82f6') + ';">' + (prov === 'github' ? 'GitHub' : 'CodeCommit') + '</span>';
  }

  var breadcrumbRepo = document.getElementById('fb-breadcrumb-repo');
  if (breadcrumbRepo) breadcrumbRepo.textContent = name;

  renderRepoList();
  fetchBranches();
}

async function fetchBranches() {
  try {
    var params = new URLSearchParams({ repositoryId: _selectedRepoId });
    if (_activeProject) params.set('projectId', _activeProject.id);

    var res = await api.get('/api/branches/by-repo?' + params.toString());
    if (res && res.ok && res.branches) {
      _branches = res.branches.map(function(b) { return b.name || b; });
    } else {
      _branches = ['main'];
    }
  } catch (e) {
    _branches = ['main'];
  }

  if (!_branches.includes(_selectedBranch)) {
    _selectedBranch = _branches[0] || 'main';
  }

  var branchText = document.getElementById('fb-branch-text');
  if (branchText) branchText.textContent = _selectedBranch;

  renderBranchList();
  loadTree('');
}

function renderBranchList() {
  var listEl = document.getElementById('fb-branch-list-container');
  if (!listEl) return;

  var query = (document.getElementById('fb-branch-search')?.value || '').toLowerCase();
  var filtered = _branches.filter(function(b) { return b.toLowerCase().includes(query); });

  listEl.innerHTML = '';
  if (filtered.length === 0) {
    listEl.innerHTML = '<div style="padding:12px;font-size:12px;color:var(--color-text-tertiary);text-align:center;">No branch found</div>';
    return;
  }

  filtered.forEach(function(b) {
    var isSel = b === _selectedBranch;
    var item = document.createElement('div');
    item.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;cursor:pointer;font-size:13px;background:' + (isSel ? 'rgba(99,102,241,0.1)' : 'transparent') + ';font-weight:' + (isSel ? '700' : '400') + ';color:' + (isSel ? '#6366f1' : 'var(--color-text-primary)') + ';';
    item.onclick = function() {
      _selectedBranch = b;
      document.getElementById('fb-branch-text').textContent = b;
      document.getElementById('fb-branch-dropdown-menu').style.display = 'none';
      deselectFile();
      loadTree(_currentPath);
    };

    item.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;">' +
        '<i data-lucide="git-branch" style="width:14px;height:14px;color:' + (isSel ? '#6366f1' : 'var(--color-text-tertiary)') + ';"></i>' +
        '<span>' + b + '</span>' +
      '</div>' +
      (isSel ? '<i data-lucide="check" style="width:14px;height:14px;color:#6366f1;"></i>' : '');

    listEl.appendChild(item);
  });

  if (window.lucide) lucide.createIcons();
}

function filterFbBranches() {
  renderBranchList();
}

function toggleFbBranchDropdown() {
  var m = document.getElementById('fb-branch-dropdown-menu');
  var arrow = document.getElementById('fb-branch-arrow');
  if (m) {
    var isVis = m.style.display === 'block';
    m.style.display = isVis ? 'none' : 'block';
    if (arrow) arrow.style.transform = isVis ? 'none' : 'rotate(180deg)';
    // Always re-render when opening so it's never empty
    if (!isVis) renderBranchList();
  }
}

async function loadTree(path) {
  _currentPath = path || '';
  var loadingEl = document.getElementById('fb-tree-loading');
  var container = document.getElementById('fb-tree-container');

  // Always show the spinner — reset tree so it's fresh
  _fileTree = [];
  if (loadingEl) loadingEl.style.display = 'flex';
  if (container) container.style.display = 'none';

  try {
    var repoQuery = _selectedRepoId ? 'repositoryId=' + encodeURIComponent(_selectedRepoId) : 'projectId=' + (_activeProject ? _activeProject.id : '');
    var url = '/api/files/tree?' + repoQuery + '&ref=' + encodeURIComponent(_selectedBranch) + '&path=' + encodeURIComponent(_currentPath);
    var res = await api.get(url);
    if (res && res.ok && res.tree) {
      _fileTree = res.tree;
    } else {
      _fileTree = [];
    }
  } catch (e) {
    _fileTree = [];
  }

  if (loadingEl) loadingEl.style.display = 'none';
  renderTree();
  updateBreadcrumbs();
  if (container) container.style.display = 'flex';
}

function renderTree() {
  var container = document.getElementById('fb-tree-container');
  if (!container) return;

  container.innerHTML = '';
  if (_fileTree.length === 0) {
    container.innerHTML = '<div style="padding:24px 0;text-align:center;color:var(--color-text-tertiary);font-size:13px;">No files found in directory</div>';
    return;
  }

  var sorted = [..._fileTree].sort(function(a, b) {
    var isDirA = a.type === 'dir' || a.type === 'tree';
    var isDirB = b.type === 'dir' || b.type === 'tree';
    if (isDirA && !isDirB) return -1;
    if (!isDirA && isDirB) return 1;
    var nameA = (a.name || a.path.split('/').pop()).toLowerCase();
    var nameB = (b.name || b.path.split('/').pop()).toLowerCase();
    return nameA.localeCompare(nameB);
  });

  sorted.forEach(function(item) {
    var isDir = item.type === 'dir' || item.type === 'tree';
    var isSel = _selectedFile && _selectedFile.path === item.path;
    var fName = item.name || item.path.split('/').pop();

    var row = document.createElement('div');
    row.className = 'tree-item-row';
    row.style.background = isSel ? 'rgba(99,102,241,0.1)' : 'transparent';

    var html =
      '<div onclick="handleSelectTreeItem(\'' + item.path + '\', ' + isDir + ')" style="display:flex;align-items:center;gap:8px;flex:1;overflow:hidden;color:' + (isSel ? '#6366f1' : 'var(--color-text-primary)') + ';font-size:13px;font-weight:' + (isSel ? '700' : '400') + ';">' +
        '<i data-lucide="' + (isDir ? 'folder' : 'file-code') + '" style="width:16px;height:16px;color:' + (isDir ? '#6366f1' : 'inherit') + ';"></i>' +
        '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + fName + '</span>' +
      '</div>' +
      '<button type="button" onclick="confirmDeleteItem(\'' + item.path + '\', ' + isDir + ', event)" title="Delete" style="background:none;border:none;color:var(--color-danger);cursor:pointer;padding:4px;border-radius:4px;display:inline-flex;opacity:0.7;">' +
        '<i data-lucide="trash-2" style="width:14px;height:14px;"></i>' +
      '</button>';

    row.innerHTML = html;
    container.appendChild(row);
  });

  if (window.lucide) lucide.createIcons();
}

function updateBreadcrumbs() {
  var bContainer = document.getElementById('fb-breadcrumb-container');
  var repo = _repos.find(function(r) { return r.id === _selectedRepoId; });
  var repoName = repo ? (repo.repo_name || repo.repositoryName || repo.name) : 'root';

  if (!bContainer) return;

  var html =
    '<span onclick="loadTree(\'\')" style="cursor:pointer;font-weight:700;color:#6366f1;display:inline-flex;align-items:center;gap:4px;">' +
      '<i data-lucide="folder" style="width:15px;height:15px;"></i> <span>' + repoName + '</span>' +
    '</span>';

  var parts = _currentPath ? _currentPath.split('/') : [];
  parts.forEach(function(part, index) {
    var subPath = parts.slice(0, index + 1).join('/');
    var isLast = index === parts.length - 1 && !_selectedFile;
    html +=
      '<span style="display:inline-flex;align-items:center;gap:6px;">' +
        '<i data-lucide="chevron-right" style="width:14px;height:14px;color:var(--color-text-tertiary);"></i>' +
        '<span onclick="' + (isLast ? '' : 'loadTree(\'' + subPath + '\')') + '" style="cursor:' + (isLast ? 'default' : 'pointer') + ';font-weight:' + (isLast ? '700' : '500') + ';color:' + (isLast ? 'var(--color-text-primary)' : '#6366f1') + ';">' + part + '</span>' +
      '</span>';
  });

  if (_selectedFile) {
    html +=
      '<span style="display:inline-flex;align-items:center;gap:6px;">' +
        '<i data-lucide="chevron-right" style="width:14px;height:14px;color:var(--color-text-tertiary);"></i>' +
        '<span style="font-weight:700;color:var(--color-text-primary);">' + _selectedFile.path.split('/').pop() + '</span>' +
      '</span>';
  }

  bContainer.innerHTML = html;
  if (window.lucide) lucide.createIcons();
}

function handleSelectTreeItem(path, isDir) {
  if (isDir) {
    loadTree(path);
  } else {
    var item = _fileTree.find(function(f) { return f.path === path; }) || { path: path, type: 'file' };
    selectFile(item);
  }
}

async function selectFile(item) {
  _selectedFile = item;
  renderTree();
  updateBreadcrumbs();

  var emptyEl = document.getElementById('fb-editor-empty');
  var loadingEl = document.getElementById('fb-editor-loading');
  var workspaceEl = document.getElementById('fb-editor-workspace');
  var btnSave = document.getElementById('btn-save-commit');
  var langEl = document.getElementById('fb-editor-lang');

  _fileContentEdited = false;
  if (emptyEl) emptyEl.style.display = 'none';
  if (workspaceEl) workspaceEl.style.display = 'none';
  if (loadingEl) loadingEl.style.display = 'flex';
  if (btnSave) btnSave.style.display = 'none';  // hidden until user edits
  if (langEl) langEl.textContent = getLanguage(item.path);

  try {
    var repoQuery = _selectedRepoId ? 'repositoryId=' + encodeURIComponent(_selectedRepoId) : 'projectId=' + (_activeProject ? _activeProject.id : '');
    var url = '/api/files/content?' + repoQuery + '&path=' + encodeURIComponent(item.path) + '&ref=' + encodeURIComponent(_selectedBranch);
    var res = await api.get(url);
    if (res && res.ok) {
      _fileContent = res.file?.content !== undefined ? res.file.content : (res.content !== undefined ? res.content : '');
      if (res.file?.sha) _selectedFile.sha = res.file.sha;
    } else {
      _fileContent = '// Failed to load file content.';
    }
  } catch (e) {
    _fileContent = '// Failed to load file content.';
  }

  if (loadingEl) loadingEl.style.display = 'none';
  var textarea = document.getElementById('fb-editor-textarea');
  if (textarea) textarea.value = _fileContent;
  if (workspaceEl) workspaceEl.style.display = 'block';
}

function deselectFile() {
  _selectedFile = null;
  _fileContent = '';
  _fileContentEdited = false;
  document.getElementById('fb-editor-empty').style.display = 'flex';
  document.getElementById('fb-editor-workspace').style.display = 'none';
  document.getElementById('btn-save-commit').style.display = 'none';
  document.getElementById('fb-editor-lang').textContent = '';
  updateBreadcrumbs();
  renderTree();
}

// Called every time user types in the editor
function onEditorInput() {
  if (!_fileContentEdited) {
    _fileContentEdited = true;
    var btnSave = document.getElementById('btn-save-commit');
    if (btnSave) {
      btnSave.style.display = 'inline-flex';
      // Subtle pulse to draw attention
      btnSave.style.animation = 'none';
      setTimeout(function() { btnSave.style.animation = ''; }, 10);
    }
  }
}

function getLanguage(path) {
  if (!path) return 'plaintext';
  if (path.endsWith('.js') || path.endsWith('.jsx')) return 'javascript';
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.css')) return 'css';
  if (path.endsWith('.html')) return 'html';
  if (path.endsWith('.md')) return 'markdown';
  if (path.endsWith('.tf') || path.endsWith('.hcl')) return 'hcl';
  if (path.endsWith('.py')) return 'python';
  if (path.endsWith('.sh') || path.endsWith('.bash')) return 'shell';
  if (path.endsWith('.yml') || path.endsWith('.yaml')) return 'yaml';
  return 'plaintext';
}

// ── Modals & Actions ──────────────────────────────────────────────────────
function openSaveCommitModal() {
  if (!_selectedFile) return;
  document.getElementById('commit-branch-val').value = _selectedBranch;
  document.getElementById('commit-msg-input').value = '';
  document.getElementById('commit-file-error').style.display = 'none';
  document.getElementById('commit-file-success').style.display = 'none';
  document.getElementById('modal-commit-file').style.display = 'flex';
}

function closeSaveCommitModal() {
  document.getElementById('modal-commit-file').style.display = 'none';
}

async function handleSaveAndCommitSubmit(e) {
  e.preventDefault();
  var msg = document.getElementById('commit-msg-input').value.trim();
  var content = document.getElementById('fb-editor-textarea').value;
  var errEl = document.getElementById('commit-file-error');
  var succEl = document.getElementById('commit-file-success');
  var btn = document.getElementById('btn-submit-file-commit');

  if (!msg || !_selectedFile || !_selectedRepoId) return;

  btn.disabled = true;
  errEl.style.display = 'none';

  try {
    var res = await api.put('/api/files/content', {
      repositoryId: _selectedRepoId,
      projectId: _activeProject ? _activeProject.id : undefined,
      path: _selectedFile.path,
      content: content,
      message: msg,
      branch: _selectedBranch,
      sha: _selectedFile.sha || null
    });

    if (res.ok) {
      succEl.style.display = 'block';
      setTimeout(function() {
        closeSaveCommitModal();
        loadTree(_currentPath);
      }, 1000);
    } else {
      errEl.textContent = res.error || 'Failed to commit changes';
      errEl.style.display = 'block';
    }
  } catch (err) {
    errEl.textContent = err.message || 'Error committing changes';
    errEl.style.display = 'block';
  }
  btn.disabled = false;
}

function openNewFileModal() {
  document.getElementById('new-file-path-input').value = '';
  document.getElementById('new-file-content-textarea').value = '';
  document.getElementById('new-file-commit-msg-input').value = '';
  document.getElementById('new-file-error').style.display = 'none';
  document.getElementById('modal-new-file').style.display = 'flex';
}

function closeNewFileModal() {
  document.getElementById('modal-new-file').style.display = 'none';
}

async function handleCreateFileSubmit(e) {
  e.preventDefault();
  var fPath = document.getElementById('new-file-path-input').value.trim();
  var fContent = document.getElementById('new-file-content-textarea').value;
  var cMsg = document.getElementById('new-file-commit-msg-input').value.trim();
  var errEl = document.getElementById('new-file-error');
  var btn = document.getElementById('btn-submit-new-file');

  if (!fPath || !_selectedRepoId) return;
  var fullPath = _currentPath ? _currentPath + '/' + fPath.replace(/^\//, '') : fPath.replace(/^\//, '');

  btn.disabled = true;
  errEl.style.display = 'none';

  try {
    var res = await api.put('/api/files/content', {
      repositoryId: _selectedRepoId,
      projectId: _activeProject ? _activeProject.id : undefined,
      path: fullPath,
      content: fContent || '',
      message: cMsg || ('Create ' + fullPath),
      branch: _selectedBranch
    });

    if (res.ok) {
      closeNewFileModal();
      await loadTree(_currentPath);
      selectFile({ path: fullPath, type: 'file' });
    } else {
      errEl.textContent = res.error || 'Failed to create file';
      errEl.style.display = 'block';
    }
  } catch (err) {
    errEl.textContent = err.message || 'Error creating file';
    errEl.style.display = 'block';
  }
  btn.disabled = false;
}

function openNewFolderModal() {
  document.getElementById('new-folder-name-input').value = '';
  document.getElementById('modal-new-folder').style.display = 'flex';
}

function closeNewFolderModal() {
  document.getElementById('modal-new-folder').style.display = 'none';
}

async function handleCreateFolderSubmit(e) {
  e.preventDefault();
  var fName = document.getElementById('new-folder-name-input').value.trim().replace(/^\/|\/$/g, '');
  var btn = document.getElementById('btn-submit-new-folder');

  if (!fName || !_selectedRepoId) return;
  var keepPath = _currentPath ? _currentPath + '/' + fName + '/.gitkeep' : fName + '/.gitkeep';

  btn.disabled = true;
  try {
    var res = await api.put('/api/files/content', {
      repositoryId: _selectedRepoId,
      projectId: _activeProject ? _activeProject.id : undefined,
      path: keepPath,
      content: '# Benevolate Directory Placeholder\n',
      message: 'Create directory ' + fName,
      branch: _selectedBranch
    });

    if (res.ok) {
      closeNewFolderModal();
      loadTree(_currentPath);
    }
  } catch (e) {}
  btn.disabled = false;
}

function confirmDeleteItem(path, isDir, e) {
  if (e) e.stopPropagation();
  _deleteTarget = { path: path, isFolder: isDir };
  document.getElementById('delete-modal-title').textContent = 'Confirm ' + (isDir ? 'Folder' : 'File') + ' Deletion';
  document.getElementById('delete-modal-desc').innerHTML = isDir ?
    'Deleting folder <strong>' + path + '</strong> will permanently delete all contained files and subfolders from the remote Git repository.' :
    'Deleting file <strong>' + path + '</strong> will commit the removal to the remote repository.';

  document.getElementById('modal-delete-confirm').style.display = 'flex';
}

function closeDeleteModal() {
  document.getElementById('modal-delete-confirm').style.display = 'none';
  _deleteTarget = null;
}

async function handleDeleteConfirmSubmit() {
  if (!_deleteTarget || !_selectedRepoId) return;
  var btn = document.getElementById('btn-submit-delete');
  btn.disabled = true;

  try {
    var res = await api.delete('/api/files/content', {
      repositoryId: _selectedRepoId,
      projectId: _activeProject ? _activeProject.id : undefined,
      path: _deleteTarget.path,
      message: 'Delete ' + (_deleteTarget.isFolder ? 'folder' : 'file') + ' ' + _deleteTarget.path,
      branch: _selectedBranch,
      isFolder: _deleteTarget.isFolder
    });

    if (res.ok) {
      if (_selectedFile && _selectedFile.path === _deleteTarget.path) deselectFile();
      closeDeleteModal();
      loadTree(_currentPath);
    }
  } catch (e) {}
  btn.disabled = false;
}

// ── Integration Wizard Modal ─────────────────────────────────────────────
function openIntegrateModal() {
  setIntegrateStage('choose');
  document.getElementById('modal-integrate').style.display = 'flex';
  if (window.lucide) lucide.createIcons();
}

function closeIntegrateModal() {
  document.getElementById('modal-integrate').style.display = 'none';
}

function setIntegrateStage(stage) {
  ['choose', 'github', 'upload', 'review'].forEach(function(s) {
    var el = document.getElementById('integrate-stage-' + s);
    if (el) el.style.display = s === stage ? 'block' : 'none';
  });
}

async function startGithubPullFlow() {
  setIntegrateStage('github');
  var loadingEl = document.getElementById('gh-integrate-loading');
  var contentEl = document.getElementById('gh-integrate-content');
  var selectEl = document.getElementById('gh-repo-select');

  if (loadingEl) loadingEl.style.display = 'block';
  if (contentEl) contentEl.style.display = 'none';

  try {
    var res = await api.get('/api/github/list-repos');
    if (res && res.ok && res.repos) {
      selectEl.innerHTML = '';
      res.repos.forEach(function(r) {
        var opt = document.createElement('option');
        opt.value = r.full_name || r.name;
        opt.textContent = (r.full_name || r.name) + (r.private ? ' (Private)' : ' (Public)');
        selectEl.appendChild(opt);
      });
      if (contentEl) contentEl.style.display = 'block';
    }
  } catch (e) {}

  if (loadingEl) loadingEl.style.display = 'none';
}

async function processGithubPullFetch() {
  var repoName = document.getElementById('gh-repo-select').value;
  var errEl = document.getElementById('gh-integrate-error');
  if (!repoName) return;

  try {
    var res = await api.post('/api/files/github-fetch-files', { githubRepo: repoName, branch: 'main' });
    if (res && res.ok && res.files) {
      _integrateFiles = res.files;
      renderIntegrateFilesPreview('Integrated files from GitHub repository ' + repoName);
      setIntegrateStage('review');
    } else if (errEl) {
      errEl.textContent = (res && res.error) || 'Failed to fetch files from GitHub';
      errEl.style.display = 'block';
    }
  } catch (err) {
    if (errEl) {
      errEl.textContent = err.message || 'Error fetching files';
      errEl.style.display = 'block';
    }
  }
}

async function handleZipFileUpload(e) {
  var file = e.target.files ? e.target.files[0] : null;
  if (!file) return;

  var errEl = document.getElementById('upload-integrate-error');
  if (errEl) errEl.style.display = 'none';

  try {
    if (file.name.endsWith('.zip')) {
      var formData = new FormData();
      formData.append('file', file);
      var res = await api.post('/api/files/extract-zip', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      if (res && res.ok && res.files) {
        _integrateFiles = res.files;
        renderIntegrateFilesPreview('Integrated files from ZIP package ' + file.name);
        setIntegrateStage('review');
      } else if (errEl) {
        errEl.textContent = (res && res.error) || 'Failed to extract ZIP file';
        errEl.style.display = 'block';
      }
    } else {
      var text = await file.text();
      _integrateFiles = [{ path: file.name, content: text }];
      renderIntegrateFilesPreview('Integrated file ' + file.name);
      setIntegrateStage('review');
    }
  } catch (err) {
    if (errEl) {
      errEl.textContent = err.message || 'Error processing uploaded file';
      errEl.style.display = 'block';
    }
  }
}

function renderIntegrateFilesPreview(defaultMsg) {
  document.getElementById('integrate-file-count').textContent = _integrateFiles.length;
  document.getElementById('integrate-commit-msg').value = defaultMsg || '';

  var previewEl = document.getElementById('integrate-files-preview');
  if (!previewEl) return;

  previewEl.innerHTML = '';
  _integrateFiles.forEach(function(f, idx) {
    var div = document.createElement('div');
    div.style.cssText = 'font-size:12px;font-family:monospace;padding:3px 0;border-bottom:' + (idx < _integrateFiles.length - 1 ? '1px solid var(--color-border)' : 'none') + ';color:var(--color-text-primary);';
    div.textContent = '📄 ' + f.path;
    previewEl.appendChild(div);
  });
}

function toggleNewBranchInput() {
  var action = document.getElementById('integrate-target-action').value;
  document.getElementById('new-branch-input-wrapper').style.display = action === 'new' ? 'block' : 'none';
}

async function executeIntegrationCommit() {
  if (!_integrateFiles.length || !_selectedRepoId) return;

  var action = document.getElementById('integrate-target-action').value;
  var newBranch = document.getElementById('integrate-new-branch-name').value.trim();
  var msg = document.getElementById('integrate-commit-msg').value.trim();
  var targetBranch = action === 'new' ? (newBranch || 'integration-branch') : _selectedBranch;

  var errEl = document.getElementById('integrate-commit-error');
  var succEl = document.getElementById('integrate-commit-success');
  var btn = document.getElementById('btn-submit-integrate');

  btn.disabled = true;
  errEl.style.display = 'none';

  try {
    if (action === 'new' && newBranch) {
      try {
        await api.post('/api/branches/create-for-repo', {
          repositoryId: _selectedRepoId,
          branchName: newBranch,
          baseBranch: _selectedBranch,
          projectId: _activeProject ? _activeProject.id : undefined
        });
      } catch (_) {}
    }

    var res = await api.post('/api/files/upload', {
      repositoryId: _selectedRepoId,
      projectId: _activeProject ? _activeProject.id : undefined,
      branch: targetBranch,
      message: msg || ('Integrated ' + _integrateFiles.length + ' files'),
      files: _integrateFiles
    });

    if (res && res.ok) {
      succEl.style.display = 'block';
      setTimeout(function() {
        closeIntegrateModal();
        if (action === 'new') _selectedBranch = targetBranch;
        loadTree(_currentPath);
      }, 1200);
    } else {
      errEl.textContent = (res && res.error) || 'Failed to commit integrated files';
      errEl.style.display = 'block';
    }
  } catch (err) {
    errEl.textContent = err.message || 'Error executing integration commit';
    errEl.style.display = 'block';
  }
  btn.disabled = false;
}
