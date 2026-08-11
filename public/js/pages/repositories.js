// Repositories Page — Vanilla JS Logic
var _activeProject = null;
var _repos = [];
var _disconnectTarget = null;
var _deleteTarget = null;

// Temp CLI state
var _tempRepos = [];
var _selectedTempRepo = null;
var _selectedDuration = 60;
var _tempCredential = null;
var _tempTimer = null;
var _tempTimeLeftSec = 0;

// Connect Modal state
var _connTab = 'existing'; // 'existing' | 'create'
var _connProvider = 'codecommit'; // 'codecommit' | 'github'
var _availableRepos = [];

function initRepositoriesPage() {
  loadActiveProjectAndRepos();
  checkOAuthConnectCallback();

  document.addEventListener('click', function(e) {
    if (!e.target.closest('.repo-dropdown-menu') && !e.target.closest('.btn-manage-repo')) {
      closeAllRepoMenus();
    }
    if (!e.target.closest('.modal-provider-trigger') && !e.target.closest('#modal-provider-dropdown')) {
      var dropdown = document.getElementById('modal-provider-dropdown');
      if (dropdown) dropdown.style.display = 'none';
    }
  });
}

window.initRepositoriesPage = initRepositoriesPage;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initRepositoriesPage);
} else {
  initRepositoriesPage();
}

async function loadActiveProjectAndRepos() {
  try {
    var res = await api.get('/api/projects');
    if (res && res.projects) {
      _activeProject = res.projects.find(function(p) { return p.isActive; }) || res.projects[0];
    }
  } catch (e) {}

  var projName = _activeProject ? _activeProject.name : 'deploy-watch';
  var label = document.getElementById('repo-project-name-label');
  if (label) label.textContent = '(' + projName + ')';

  var connLabel = document.getElementById('conn-modal-proj-name');
  if (connLabel) connLabel.textContent = projName;

  fetchRepos();
}

async function fetchRepos() {
  var spinner = document.getElementById('repos-loading-spinner');
  var grid = document.getElementById('repos-grid');
  var emptyState = document.getElementById('repos-empty-state');

  if (spinner) spinner.style.display = 'flex';
  if (grid) grid.style.display = 'none';
  if (emptyState) emptyState.style.display = 'none';

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

  if (spinner) spinner.style.display = 'none';

  if (_repos.length > 0) {
    renderReposGrid();
    if (grid) grid.style.display = 'grid';
  } else {
    if (emptyState) emptyState.style.display = 'block';
  }
}

function renderReposGrid() {
  var grid = document.getElementById('repos-grid');
  if (!grid) return;

  grid.innerHTML = '';
  _repos.forEach(function(repo) {
    var repoName = repo.repo_name || repo.repositoryName || repo.name;
    var provider = repo.provider || 'codecommit';
    var isGitHub = provider === 'github';
    var defaultBranch = repo.default_branch || repo.defaultBranch || 'main';

    var cardId = repo.id || repoName;
    var container = document.createElement('div');
    container.className = 'repo-card-container';
    container.id = 'repo-card-container-' + cardId;

    var flipper = document.createElement('div');
    flipper.className = 'repo-card-flipper';

    var frontCard = document.createElement('div');
    frontCard.className = 'repo-card repo-card-front';

    var backCard = document.createElement('div');
    backCard.className = 'repo-card-back';
    backCard.id = 'repo-card-back-' + cardId;

    var canManage = (typeof auth !== 'undefined' && auth.isAdmin) ? auth.isAdmin() : false;

    var frontHtml =
      '<div>' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">' +
          '<div style="display:flex;align-items:center;gap:10px;">' +
            '<i data-lucide="folder" style="width:22px;height:22px;color:#6366f1;"></i>' +
            '<div>' +
              '<h3 style="font-size:15px;font-weight:700;color:var(--color-text-primary);margin:0;">' + repoName + '</h3>' +
              '<span style="font-size:12px;color:var(--color-text-tertiary);">' + (repo.owner ? '@' + repo.owner : (isGitHub ? 'GitHub' : 'AWS CodeCommit')) + '</span>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:6px;">' +
            '<button onclick="toggleRepoDiagnostics(\'' + cardId + '\', event)" title="Inspect Real-Time Diagnostics (i)" style="width:28px;height:28px;border-radius:50%;border:1px solid var(--color-border);background:var(--color-surface);color:#6366f1;font-weight:800;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:var(--shadow-sm);transition:all 0.2s ease;">' +
              'i' +
            '</button>' +
            '<div class="' + (isGitHub ? 'provider-badge-gh' : 'provider-badge-aws') + '">' +
              (isGitHub ? ghSvg : awsSvg) + ' ' + (isGitHub ? 'GitHub' : 'CodeCommit') +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div style="font-size:13px;color:var(--color-text-secondary);margin-bottom:16px;">' +
          'Default Branch: <span style="font-family:monospace;font-weight:600;color:var(--color-text-primary);">' + defaultBranch + '</span>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;justify-content:space-between;border-top:1px solid var(--color-border);padding-top:14px;margin-top:10px;">' +
        '<a href="/file-browser?repo=' + encodeURIComponent(repoName) + '" style="font-size:13px;color:#6366f1;text-decoration:none;font-weight:700;">Browse Files &rarr;</a>' +
        '<div style="display:flex;align-items:center;gap:6px;">' +
          '<button onclick="toggleRepoDiagnostics(\'' + cardId + '\', event)" style="padding:6px 10px;background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.2);border-radius:8px;font-size:11px;font-weight:700;color:#6366f1;cursor:pointer;display:flex;align-items:center;gap:4px;">' +
            'ℹ️ Diagnostics' +
          '</button>' +
          (canManage ?
          '<div style="position:relative;">' +
            '<button onclick="toggleRepoMenu(\'' + cardId + '\', event)" class="btn-manage-repo" style="padding:6px 12px;background:transparent;border:1px solid var(--color-border);border-radius:8px;font-size:12px;font-weight:600;color:var(--color-text-primary);cursor:pointer;display:flex;align-items:center;gap:6px;">' +
              '<i data-lucide="settings" style="width:13px;height:13px;color:var(--color-text-secondary);"></i> Manage <i data-lucide="chevron-down" style="width:12px;height:12px;"></i>' +
            '</button>' +
            '<div id="repo-menu-' + cardId + '" class="repo-dropdown-menu" style="display:none;">' +
              '<div onclick="toggleRepoDiagnostics(\'' + cardId + '\', event); closeAllRepoMenus();" class="repo-dropdown-item">' +
                '<i data-lucide="info" style="width:16px;height:16px;color:#6366f1;margin-top:2px;"></i>' +
                '<div>' +
                  '<div style="font-size:13px;font-weight:600;color:var(--color-text-primary);">Inspect Diagnostics (i)</div>' +
                  '<div style="font-size:11px;color:var(--color-text-tertiary);margin-top:2px;">Check OAuth, scope &amp; status</div>' +
                '</div>' +
              '</div>' +
              '<div style="height:1px;background:var(--color-border);margin:4px 0;"></div>' +
              '<div onclick="promptDisconnectRepo(\'' + cardId + '\')" class="repo-dropdown-item">' +
                '<i data-lucide="link-2-off" style="width:16px;height:16px;color:var(--color-warning);margin-top:2px;"></i>' +
                '<div>' +
                  '<div style="font-size:13px;font-weight:600;color:var(--color-text-primary);">Disconnect Repository</div>' +
                  '<div style="font-size:11px;color:var(--color-text-tertiary);margin-top:2px;">Remove connection from project</div>' +
                '</div>' +
              '</div>' +
              '<div style="height:1px;background:var(--color-border);margin:4px 0;"></div>' +
              '<div onclick="promptDeleteRepo(\'' + cardId + '\')" class="repo-dropdown-item">' +
                '<i data-lucide="trash-2" style="width:16px;height:16px;color:var(--color-danger);margin-top:2px;"></i>' +
                '<div>' +
                  '<div style="font-size:13px;font-weight:600;color:var(--color-danger);">Delete &amp; Disconnect Repo</div>' +
                  '<div style="font-size:11px;color:var(--color-text-tertiary);margin-top:2px;">Permanently delete at AWS/GitHub</div>' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</div>' : '') +
        '</div>' +
      '</div>';

    var backHtml =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
        '<div style="font-size:13px;font-weight:700;color:var(--color-text-primary);display:flex;align-items:center;gap:6px;">' +
          '<i data-lucide="activity" style="width:14px;height:14px;color:#6366f1;"></i> Real-Time Diagnostics' +
        '</div>' +
        '<button onclick="toggleRepoDiagnostics(\'' + cardId + '\', event)" style="background:none;border:none;color:var(--color-text-tertiary);cursor:pointer;font-size:12px;font-weight:700;display:flex;align-items:center;gap:4px;">' +
          '&larr; Back' +
        '</button>' +
      '</div>' +
      '<div id="diag-content-' + cardId + '" style="font-size:12px;color:var(--color-text-secondary);display:flex;flex-direction:column;gap:8px;">' +
        '<div style="display:flex;align-items:center;gap:6px;color:var(--color-text-tertiary);"><i data-lucide="loader-2" class="animate-spin" style="width:14px;height:14px;"></i> Fetching live status...</div>' +
      '</div>';

    frontCard.innerHTML = frontHtml;
    backCard.innerHTML = backHtml;

    flipper.appendChild(frontCard);
    flipper.appendChild(backCard);
    container.appendChild(flipper);
    grid.appendChild(container);
  });

  if (window.lucide) lucide.createIcons();
}

async function toggleRepoDiagnostics(id, e) {
  if (e) e.stopPropagation();
  var container = document.getElementById('repo-card-container-' + id);
  if (!container) return;

  var isFlipped = container.classList.contains('flipped');
  if (isFlipped) {
    container.classList.remove('flipped');
    return;
  }

  container.classList.add('flipped');
  var content = document.getElementById('diag-content-' + id);
  if (!content) return;

  content.innerHTML = '<div style="display:flex;align-items:center;gap:6px;color:var(--color-text-tertiary);"><i data-lucide="loader-2" class="animate-spin" style="width:14px;height:14px;"></i> Testing live GitHub / AWS API status...</div>';
  if (window.lucide) lucide.createIcons();

  try {
    var res = await api.get('/api/repos/' + encodeURIComponent(id) + '/diagnostics');
    if (res && res.ok && res.diagnostics) {
      var d = res.diagnostics;
      var statusBadgeClass = d.isAccessible ? 'background:rgba(16,185,129,0.12);color:#10b981;' : 'background:rgba(239,68,68,0.12);color:#ef4444;';
      var statusText = d.isAccessible ? '✔ Active (' + d.httpStatusCode + ' OK)' : '✖ Status ' + d.httpStatusCode;

      content.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;background:var(--color-bg);border-radius:8px;">' +
          '<span style="font-weight:600;">Status:</span>' +
          '<span style="padding:2px 8px;border-radius:6px;font-weight:700;font-size:11px;' + statusBadgeClass + '">' + statusText + '</span>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
          '<span style="color:var(--color-text-tertiary);">Connected By:</span>' +
          '<span style="font-weight:700;color:var(--color-text-primary);">@' + d.createdBy + '</span>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
          '<span style="color:var(--color-text-tertiary);">Scope / Account:</span>' +
          '<span style="font-weight:600;color:var(--color-text-secondary);">' + d.scope + '</span>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
          '<span style="color:var(--color-text-tertiary);">Visibility:</span>' +
          '<span style="font-weight:600;color:var(--color-text-primary);">' + (d.isPrivate ? '🔒 Private Repo' : '🌐 Public Repo') + '</span>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
          '<span style="color:var(--color-text-tertiary);">Creator OAuth:</span>' +
          '<span style="font-weight:600;' + (d.creatorOAuthConnected ? 'color:#10b981;' : 'color:var(--color-warning);') + '">' + (d.creatorOAuthConnected ? '✔ Connected' : '⚠️ Disconnected') + '</span>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
          '<span style="color:var(--color-text-tertiary);">Effective Token:</span>' +
          '<span style="font-weight:600;color:var(--color-text-primary);">' + d.resolvedTokenSource + '</span>' +
        '</div>' +
        '<div style="margin-top:4px;padding:8px;background:rgba(99,102,241,0.06);border:1px solid rgba(99,102,241,0.18);border-radius:8px;font-size:11px;line-height:1.4;color:var(--color-text-secondary);">' +
          d.statusMessage +
        '</div>';
    } else {
      content.innerHTML = '<div style="color:var(--color-danger);font-weight:600;">Failed to fetch diagnostics: ' + ((res && res.error) || 'Unknown error') + '</div>';
    }
  } catch (err) {
    content.innerHTML = '<div style="color:var(--color-danger);font-weight:600;">Error: ' + (err.message || 'Server error') + '</div>';
  }
}
window.toggleRepoDiagnostics = toggleRepoDiagnostics;

  if (window.lucide) lucide.createIcons();
}

function toggleRepoMenu(id, e) {
  e.stopPropagation();
  var menu = document.getElementById('repo-menu-' + id);
  var isOpen = menu && menu.style.display === 'block';
  closeAllRepoMenus();
  if (menu && !isOpen) menu.style.display = 'block';
}

function closeAllRepoMenus() {
  document.querySelectorAll('.repo-dropdown-menu').forEach(function(m) {
    m.style.display = 'none';
  });
}

// ── Disconnect & Delete Modals ─────────────────────────────────────────────
function promptDisconnectRepo(id) {
  closeAllRepoMenus();
  _disconnectTarget = _repos.find(function(r) { return (r.id || r.repo_name || r.name) === id; });
  if (!_disconnectTarget) return;

  var name = _disconnectTarget.repo_name || _disconnectTarget.name;
  var prov = _disconnectTarget.provider === 'github' ? 'GitHub' : 'AWS CodeCommit';

  document.getElementById('dis-proj-name').textContent = _activeProject ? _activeProject.name : 'Current Project';
  document.getElementById('dis-repo-name').textContent = name;
  document.getElementById('dis-provider-name').textContent = prov;
  document.getElementById('dis-error-msg').style.display = 'none';

  document.getElementById('modal-disconnect-repo').style.display = 'flex';
  if (window.lucide) lucide.createIcons();
}

function closeDisconnectModal() {
  document.getElementById('modal-disconnect-repo').style.display = 'none';
}

async function confirmDisconnectRepo() {
  if (!_disconnectTarget) return;
  var btn = document.getElementById('btn-dis-submit');
  var errEl = document.getElementById('dis-error-msg');
  btn.disabled = true;
  errEl.style.display = 'none';

  try {
    var res = await api.post('/api/repos/disconnect', {
      repositoryId: _disconnectTarget.id,
      projectId: _activeProject ? _activeProject.id : undefined
    });

    if (res.ok) {
      closeDisconnectModal();
      fetchRepos();
    } else {
      errEl.textContent = res.error || 'Failed to disconnect repository';
      errEl.style.display = 'block';
    }
  } catch (err) {
    errEl.textContent = err.message || 'Error occurred';
    errEl.style.display = 'block';
  }
  btn.disabled = false;
}

function promptDeleteRepo(id) {
  closeAllRepoMenus();
  _deleteTarget = _repos.find(function(r) { return (r.id || r.repo_name || r.name) === id; });
  if (!_deleteTarget) return;

  var name = _deleteTarget.repo_name || _deleteTarget.name;
  var prov = _deleteTarget.provider === 'github' ? 'GitHub' : 'AWS CodeCommit';

  document.getElementById('del-repo-name').textContent = name;
  document.getElementById('del-provider-name').textContent = prov;
  document.getElementById('del-error-msg').style.display = 'none';

  document.getElementById('modal-delete-repo').style.display = 'flex';
  if (window.lucide) lucide.createIcons();
}

function closeDeleteModal() {
  document.getElementById('modal-delete-repo').style.display = 'none';
}

async function confirmDeleteRepo() {
  if (!_deleteTarget) return;
  var btn = document.getElementById('btn-del-submit');
  var errEl = document.getElementById('del-error-msg');
  btn.disabled = true;
  errEl.style.display = 'none';

  try {
    var res = await api.post('/api/repos/delete-and-disconnect', {
      repositoryId: _deleteTarget.id,
      projectId: _activeProject ? _activeProject.id : undefined
    });

    if (res.ok) {
      closeDeleteModal();
      fetchRepos();
    } else {
      errEl.textContent = res.error || 'Failed to delete remote repository';
      errEl.style.display = 'block';
    }
  } catch (err) {
    errEl.textContent = err.message || 'Error occurred';
    errEl.style.display = 'block';
  }
  btn.disabled = false;
}

// ── Temporary CLI Credentials Section ───────────────────────────────────────
function toggleTempCliSection() {
  var section = document.getElementById('temp-cli-section');
  var btn = document.getElementById('btn-toggle-temp-cli');
  if (!section) return;

  var isVisible = section.style.display !== 'none';
  if (isVisible) {
    section.style.display = 'none';
    if (btn) {
      btn.style.background = 'transparent';
      btn.style.borderColor = '#6366f1';
      btn.style.color = '#6366f1';
    }
  } else {
    section.style.display = 'block';
    if (btn) {
      btn.style.background = 'rgba(99,102,241,0.1)';
      btn.style.borderColor = '#6366f1';
      btn.style.color = '#6366f1';
    }
    loadTempReposList();
  }
  if (window.lucide) lucide.createIcons();
}

function loadTempReposList() {
  var listEl = document.getElementById('temp-repo-list');
  if (!listEl) return;

  listEl.innerHTML = '';
  if (_repos.length === 0) {
    listEl.innerHTML = '<div style="font-size:13px;color:var(--color-text-tertiary);">No repositories connected.</div>';
    return;
  }

  _tempRepos = _repos;
  _repos.forEach(function(r, idx) {
    var name = r.repo_name || r.repositoryName || r.name;
    var prov = r.provider || 'codecommit';
    var isGH = prov === 'github';

    var item = document.createElement('div');
    item.className = 'temp-repo-item';
    item.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-radius:10px;cursor:pointer;border:1.5px solid var(--color-border);background:var(--color-bg);transition:all 0.14s ease;';
    item.onclick = function() { selectTempRepo(r, item); };

    item.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;">' +
        (isGH ? '<i data-lucide="github" style="width:15px;height:15px;color:var(--color-text-primary);"></i>' : '<i data-lucide="server" style="width:15px;height:15px;color:#d97706;"></i>') +
        '<div>' +
          '<div style="font-size:13px;font-weight:600;color:var(--color-text-primary);line-height:1;">' + name + '</div>' +
          '<div style="font-size:11px;color:var(--color-text-tertiary);margin-top:2px;">' + (isGH ? 'GitHub' : 'AWS CodeCommit') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="chk-icon-wrap" style="display:none;color:#6366f1;"><i data-lucide="check" style="width:15px;height:15px;"></i></div>';

    listEl.appendChild(item);
    if (idx === 0) selectTempRepo(r, item);
  });

  if (window.lucide) lucide.createIcons();
}

function selectTempRepo(repo, element) {
  _selectedTempRepo = repo;
  document.querySelectorAll('.temp-repo-item').forEach(function(el) {
    el.style.borderColor = 'var(--color-border)';
    el.style.background = 'var(--color-bg)';
    var chk = el.querySelector('.chk-icon-wrap');
    if (chk) chk.style.display = 'none';
  });

  if (element) {
    element.style.borderColor = '#6366f1';
    element.style.background = 'rgba(99,102,241,0.07)';
    var chk = element.querySelector('.chk-icon-wrap');
    if (chk) chk.style.display = 'block';
  }

  var btn = document.getElementById('btn-generate-temp-creds');
  if (btn) {
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
  }

  var notice = document.getElementById('temp-provider-notice');
  if (notice) {
    notice.style.display = 'block';
    if (repo.provider === 'github') {
      notice.innerHTML = '<strong style="color:#3b82f6;">GitHub:</strong> Your stored PAT will be used. After cloning, revoke the token from GitHub → Settings → Developer settings → Personal access tokens.';
    } else {
      notice.innerHTML = '<strong style="color:#10b981;">CodeCommit:</strong> A temporary IAM Git credential will be created and <strong>auto-destroyed on AWS</strong> after the session ends.';
    }
  }
}

function selectDuration(mins) {
  _selectedDuration = mins;
  [15, 30, 60, 120, 240].forEach(function(m) {
    var b = document.getElementById('dur-btn-' + m);
    if (b) {
      if (m === mins) {
        b.className = 'duration-btn active';
      } else {
        b.className = 'duration-btn';
      }
    }
  });
}

async function handleGenerateTempCreds() {
  if (!_selectedTempRepo) return;

  var stepSelect = document.getElementById('temp-step-select');
  var stepGen = document.getElementById('temp-step-generating');
  var stepDone = document.getElementById('temp-step-done');

  if (stepSelect) stepSelect.style.display = 'none';
  if (stepGen) stepGen.style.display = 'flex';
  if (stepDone) stepDone.style.display = 'none';

  try {
    var res = await api.post('/api/codecommit/create-temp-credentials', {
      repositoryId: _selectedTempRepo.id,
      durationMinutes: _selectedDuration
    });

    if (res.ok && res.credential) {
      _tempCredential = res.credential;
      displayTempCredential();
      if (stepGen) stepGen.style.display = 'none';
      if (stepDone) stepDone.style.display = 'flex';
    } else {
      alert(res.error || 'Failed to generate temporary credentials');
      resetTempCliView();
    }
  } catch (err) {
    alert(err.message || 'Network error');
    resetTempCliView();
  }
}

function displayTempCredential() {
  if (!_tempCredential) return;

  document.getElementById('temp-username-code').textContent = _tempCredential.gitUsername || 'git-user';
  document.getElementById('temp-password-code').textContent = _tempCredential.gitPassword || '••••••••';
  document.getElementById('temp-clone-pre').textContent = _tempCredential.oneClickCmd || ('git clone ' + _tempCredential.cloneUrl);

  var btnRevoke = document.getElementById('btn-revoke-temp');
  if (btnRevoke) {
    btnRevoke.textContent = _tempCredential.provider !== 'github' ? 'Revoke & Destroy on AWS' : 'Revoke & Invalidate Token';
  }

  // Start expiry countdown
  if (_tempCredential.expiresAt) {
    var expiresMs = new Date(_tempCredential.expiresAt).getTime();
    _tempTimeLeftSec = Math.max(0, Math.floor((expiresMs - Date.now()) / 1000));
    startTempCountdown();
  }
}

function startTempCountdown() {
  if (_tempTimer) clearInterval(_tempTimer);
  updateTempCountdownDisplay();

  _tempTimer = setInterval(function() {
    _tempTimeLeftSec--;
    if (_tempTimeLeftSec <= 0) {
      clearInterval(_tempTimer);
      document.getElementById('temp-time-left').textContent = 'Expired';
      resetTempCliView();
    } else {
      updateTempCountdownDisplay();
    }
  }, 1000);
}

function updateTempCountdownDisplay() {
  var m = Math.floor(_tempTimeLeftSec / 60);
  var s = _tempTimeLeftSec % 60;
  var formatted = (m < 10 ? '0' + m : m) + 'm ' + (s < 10 ? '0' + s : s) + 's';
  var span = document.getElementById('temp-time-left');
  if (span) span.textContent = formatted;
}

async function handleRevokeTempCreds() {
  if (!_tempCredential) return;
  var btn = document.getElementById('btn-revoke-temp');
  if (btn) btn.disabled = true;

  try {
    await api.delete('/api/codecommit/temp-credentials/' + _tempCredential.id);
  } catch (e) {}

  resetTempCliView();
}

function resetTempCliView() {
  if (_tempTimer) clearInterval(_tempTimer);
  _tempCredential = null;

  var stepSelect = document.getElementById('temp-step-select');
  var stepGen = document.getElementById('temp-step-generating');
  var stepDone = document.getElementById('temp-step-done');

  if (stepSelect) stepSelect.style.display = 'flex';
  if (stepGen) stepGen.style.display = 'none';
  if (stepDone) stepDone.style.display = 'none';
}

function copyText(elementId) {
  var el = document.getElementById(elementId);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent);
}

// ── Connect Repository Modal Logic ─────────────────────────────────────────
function openConnectModal() {
  document.getElementById('conn-modal-msg').style.display = 'none';
  document.getElementById('conn-new-name').value = '';
  document.getElementById('conn-new-desc').value = '';
  document.getElementById('modal-connect-repo').style.display = 'flex';

  fetchAvailableRepos();
  if (window.lucide) lucide.createIcons();
}

function closeConnectModal() {
  document.getElementById('modal-connect-repo').style.display = 'none';
}

function switchConnTab(tab) {
  _connTab = tab;
  var btnExist = document.getElementById('tab-btn-conn-existing');
  var btnCreate = document.getElementById('tab-btn-conn-create');
  var tabExist = document.getElementById('conn-tab-existing');
  var tabCreate = document.getElementById('conn-tab-create');

  if (tab === 'existing') {
    btnExist.style.background = '#6366f1';
    btnExist.style.color = 'white';
    btnCreate.style.background = 'transparent';
    btnCreate.style.color = 'var(--color-text-secondary)';
    tabExist.style.display = 'block';
    tabCreate.style.display = 'none';
  } else {
    btnCreate.style.background = '#6366f1';
    btnCreate.style.color = 'white';
    btnExist.style.background = 'transparent';
    btnExist.style.color = 'var(--color-text-secondary)';
    tabExist.style.display = 'none';
    tabCreate.style.display = 'block';
  }
}

function toggleProviderDropdown() {
  var dropdown = document.getElementById('modal-provider-dropdown');
  if (dropdown) {
    dropdown.style.display = dropdown.style.display === 'block' ? 'none' : 'block';
  }
}

function selectConnProvider(provider) {
  _connProvider = provider;
  var dropdown = document.getElementById('modal-provider-dropdown');
  if (dropdown) dropdown.style.display = 'none';

  var textEl = document.getElementById('provider-selected-text');
  var iconWrapper = document.getElementById('provider-icon-wrapper');

  var ghSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/></svg>';
  var awsSvg = '<svg width="18" height="18" viewBox="0 0 24 24"><path fill="#FF9900" d="M6.763 10.036c0 .296.032.535.088.71.064.176.144.368.256.576.04.064.056.128.056.184 0 .08-.048.16-.152.24l-.504.336a.383.383 0 0 1-.208.072c-.08 0-.16-.04-.24-.112a2.47 2.47 0 0 1-.288-.376 6.18 6.18 0 0 1-.248-.472c-.624.736-1.408 1.104-2.352 1.104-.672 0-1.208-.192-1.6-.576-.392-.384-.592-.896-.592-1.536 0-.68.24-1.232.728-1.648.488-.416 1.136-.624 1.96-.624.272 0 .552.024.848.064.296.04.6.104.92.176v-.584c0-.608-.128-1.032-.376-1.28-.256-.248-.688-.368-1.304-.368-.28 0-.568.032-.864.104-.296.072-.584.168-.864.296a2.298 2.298 0 0 1-.28.104.488.488 0 0 1-.128.024c-.112 0-.168-.08-.168-.248v-.392c0-.128.016-.224.056-.28a.597.597 0 0 1 .224-.168c.28-.144.616-.264 1.008-.36A4.84 4.84 0 0 1 4.8 6.6c.952 0 1.648.216 2.096.648.44.432.664 1.088.664 1.968v2.82zm-3.24 1.212c.264 0 .536-.048.824-.144.288-.096.544-.272.76-.512.128-.152.224-.32.272-.512.048-.192.08-.424.08-.696v-.336a6.709 6.709 0 0 0-.736-.136 6.02 6.02 0 0 0-.752-.048c-.536 0-.928.104-1.192.32-.264.216-.392.52-.392.92 0 .376.096.656.296.848.192.2.464.296.84.296zm6.44.864c-.144 0-.24-.024-.304-.08-.064-.048-.12-.16-.168-.312L7.58 7.616a1.42 1.42 0 0 1-.072-.32c0-.128.064-.2.192-.2h.784c.152 0 .256.024.312.08.064.048.112.16.16.312l1.48 5.836 1.376-5.836c.04-.16.088-.264.152-.312a.56.56 0 0 1 .32-.08h.64c.152 0 .256.024.32.08.064.048.12.16.152.312l1.392 5.904 1.528-5.904c.048-.16.104-.264.16-.312a.52.52 0 0 1 .312-.08h.744c.128 0 .2.064.2.2 0 .04-.008.08-.016.128a1.137 1.137 0 0 1-.056.2l-2.128 6.104c-.048.16-.104.264-.168.312a.51.51 0 0 1-.304.08h-.688c-.152 0-.256-.024-.32-.08-.064-.056-.12-.16-.152-.32L12.96 7.964l-1.368 5.836c-.04.16-.088.264-.152.32-.064.056-.176.08-.32.08h-.688zm11.336.24c-.416 0-.832-.048-1.232-.144-.4-.096-.712-.2-.92-.32-.128-.072-.216-.152-.248-.224a.56.56 0 0 1-.048-.224v-.408c0-.168.064-.248.184-.248.048 0 .096.008.144.024.048.016.12.048.2.08.272.12.568.216.888.28.328.064.648.096.976.096.52 0 .92-.088 1.2-.264a.86.86 0 0 0 .424-.76.777.777 0 0 0-.212-.556c-.144-.152-.416-.288-.808-.416l-1.16-.36c-.584-.184-1.016-.456-1.288-.816a1.953 1.953 0 0 1-.408-1.184c0-.344.072-.648.216-.912.144-.264.336-.496.576-.688.24-.192.512-.336.832-.432.32-.096.656-.144 1.008-.144.176 0 .36.008.536.032.184.024.352.056.512.096.152.04.296.088.432.136.136.048.24.096.312.144a.649.649 0 0 1 .216.208.506.506 0 0 1 .064.256v.376c0 .168-.064.256-.184.256a.83.83 0 0 1-.3-.096 3.807 3.807 0 0 0-1.596-.328c-.472 0-.84.072-1.096.224-.256.152-.384.384-.384.704 0 .216.08.4.232.552.152.152.44.304.856.44l1.136.36c.576.184.992.44 1.24.768.248.328.368.704.368 1.12 0 .352-.072.672-.208.952-.144.28-.336.52-.592.72-.256.2-.56.344-.912.448-.368.112-.76.168-1.184.168z"/><path fill="#FF9900" d="M20.16 17.196c-2.464 1.8-6.032 2.752-9.112 2.752-4.312 0-8.2-1.6-11.136-4.248-.232-.208-.024-.496.256-.336 3.168 1.848 7.088 2.952 11.128 2.952 2.728 0 5.728-.568 8.488-1.744.416-.176.768.272.376.624z"/><path fill="#FF9900" d="M21.12 16.096c-.312-.4-2.072-.192-2.864-.096-.24.032-.28-.184-.064-.344 1.4-.984 3.704-.704 3.968-.368.264.336-.072 2.64-1.384 3.744-.2.168-.392.08-.304-.144.296-.736.952-2.392.648-2.792z"/></svg>';

  if (provider === 'github') {
    if (textEl) textEl.textContent = 'GitHub';
    if (iconWrapper) iconWrapper.innerHTML = ghSvg;
  } else {
    if (textEl) textEl.textContent = 'AWS CodeCommit';
    if (iconWrapper) iconWrapper.innerHTML = awsSvg;
  }

  fetchAvailableRepos();
}

async function fetchAvailableRepos() {
  var selectEl = document.getElementById('conn-select-repo');
  var warnEl = document.getElementById('conn-oauth-warning');
  var refreshIcon = document.getElementById('btn-refresh-avail-icon');

  if (!selectEl) return;

  if (refreshIcon) refreshIcon.classList.add('animate-spin');
  selectEl.innerHTML = '<option value="">Loading available repositories...</option>';
  if (warnEl) warnEl.style.display = 'none';

  try {
    if (_connProvider === 'codecommit') {
      var region = _activeProject ? _activeProject.region : 'us-east-1';
      var res = await api.get('/api/repos?region=' + region);
      if (res && res.ok && res.repos) {
        selectEl.innerHTML = '';
        res.repos.forEach(function(r) {
          var name = r.repositoryName || r.name || r;
          var opt = document.createElement('option');
          opt.value = name;
          opt.textContent = name;
          selectEl.appendChild(opt);
        });
      }
    } else if (_connProvider === 'github') {
      var res = await api.get('/api/github/list-repos');
      if (res && res.ok && res.repos) {
        selectEl.innerHTML = '';
        res.repos.forEach(function(r) {
          var fullName = r.full_name || r.name;
          var opt = document.createElement('option');
          opt.value = fullName;
          opt.textContent = fullName;
          selectEl.appendChild(opt);
        });
      } else if (res && res.requiresOAuth) {
        selectEl.innerHTML = '<option value="">GitHub OAuth connection required</option>';
        if (warnEl) warnEl.style.display = 'block';
      }
    }
  } catch (e) {
    selectEl.innerHTML = '<option value="">Error loading repositories</option>';
  }

  if (refreshIcon) {
    setTimeout(function() { refreshIcon.classList.remove('animate-spin'); }, 400);
  }
}

async function handleConnectExistingSubmit() {
  var selectEl = document.getElementById('conn-select-repo');
  var repoName = selectEl ? selectEl.value : '';
  var errEl = document.getElementById('conn-modal-msg');
  errEl.style.display = 'none';

  if (!repoName || !_activeProject) {
    errEl.textContent = 'Please select a repository.';
    errEl.style.display = 'block';
    return;
  }

  var btn = document.getElementById('btn-submit-existing');
  btn.disabled = true;

  try {
    var payload = {
      projectId: _activeProject.id,
      provider: _connProvider,
      repoName: repoName,
      owner: _connProvider === 'github' ? repoName.split('/')[0] : null,
      defaultBranch: 'main'
    };

    var res = await api.post('/api/repos/connect', payload);
    if (res.ok) {
      closeConnectModal();
      fetchRepos();
    } else {
      errEl.textContent = res.error || 'Failed to connect repository';
      errEl.style.display = 'block';
    }
  } catch (err) {
    errEl.textContent = err.message || 'Error connecting repository';
    errEl.style.display = 'block';
  }
  btn.disabled = false;
}

async function handleCreateNewSubmit() {
  var nameEl = document.getElementById('conn-new-name');
  var descEl = document.getElementById('conn-new-desc');
  var repoName = nameEl ? nameEl.value.trim() : '';
  var repoDesc = descEl ? descEl.value.trim() : '';
  var errEl = document.getElementById('conn-modal-msg');
  errEl.style.display = 'none';

  if (!repoName || !_activeProject) {
    errEl.textContent = 'Please enter a repository name.';
    errEl.style.display = 'block';
    return;
  }

  var btn = document.getElementById('btn-submit-create');
  btn.disabled = true;

  try {
    if (_connProvider === 'codecommit') {
      var res = await api.post('/api/repos/create', {
        repositoryName: repoName,
        description: repoDesc,
        region: _activeProject ? _activeProject.region : 'us-east-1'
      });

      if (res.ok) {
        await api.post('/api/repos/connect', {
          projectId: _activeProject.id,
          provider: 'codecommit',
          repoName: repoName,
          defaultBranch: 'main'
        });
        closeConnectModal();
        fetchRepos();
      } else {
        errEl.textContent = res.error || 'Failed to create CodeCommit repository';
        errEl.style.display = 'block';
      }
    } else if (_connProvider === 'github') {
      var res = await api.post('/api/github/create-repo', {
        repoName: repoName,
        description: repoDesc
      });

      if (res.ok && res.repo) {
        var fullName = res.repo.full_name;
        await api.post('/api/repos/connect', {
          projectId: _activeProject.id,
          provider: 'github',
          repoName: fullName,
          owner: fullName.split('/')[0],
          defaultBranch: res.repo.default_branch || 'main'
        });
        closeConnectModal();
        fetchRepos();
      } else {
        errEl.textContent = res.error || 'Failed to create GitHub repository';
        errEl.style.display = 'block';
      }
    }
  } catch (err) {
    errEl.textContent = err.message || 'Error creating repository';
    errEl.style.display = 'block';
  }
  btn.disabled = false;
}
