// Branches Page — Vanilla JS Logic
var _activeProject = null;
var _repos = [];
var _selectedRepoId = null;
var _branches = [];
var _defaultBranch = 'main';
var _selectedBranch = null;
var _commits = [];

var _branchesClickListenerAdded = false;

function initBranchesPageRunner() {
  initBranchesPage();

  if (!_branchesClickListenerAdded) {
    _branchesClickListenerAdded = true;
    document.addEventListener('click', function(e) {
      var wrapper = document.getElementById('repo-selector-wrapper');
      if (wrapper && !wrapper.contains(e.target)) {
        var dropdown = document.getElementById('repo-dropdown-menu');
        if (dropdown) dropdown.style.display = 'none';
      }
    });
  }
}

window.initBranchesPageRunner = initBranchesPageRunner;
window.initBranchesPage = initBranchesPage;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initBranchesPageRunner);
} else {
  initBranchesPageRunner();
}

async function initBranchesPage() {
  // Reset all state on SPA re-navigation
  _repos = [];
  _branches = [];
  _selectedBranch = null;
  _selectedRepoId = null;
  _commits = [];
  _defaultBranch = 'main';

  // Reset UI to clean slate
  var noRepoEl = document.getElementById('no-repo-state');
  var gridEl = document.getElementById('branches-main-grid');
  var loadingEl = document.getElementById('branches-loading');
  var listEl = document.getElementById('branch-list-container');
  var countBadge = document.getElementById('branch-count-badge');
  if (noRepoEl) noRepoEl.style.display = 'none';
  if (gridEl) gridEl.style.display = 'none';
  if (loadingEl) loadingEl.style.display = 'none';
  if (listEl) { listEl.innerHTML = ''; listEl.style.display = 'none'; }
  if (countBadge) countBadge.textContent = '';

  var projects = [];
  try {
    var res = await api.get('/api/projects');
    if (res && res.projects) {
      projects = res.projects;
      _activeProject = projects.find(function(p) { return p.isActive; }) || projects[0];
    }
  } catch (e) {}

  if (!projects || projects.length === 0) {
    showNoRepoState('No Projects Found', 'No projects exist yet. Please create a project first.');
    return;
  }

  fetchRepos();
}

async function fetchRepos() {
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

  renderRepoSelector();

  if (_repos.length > 0) {
    selectRepo(_repos[0].id || _repos[0].repo_name || _repos[0].name);
  } else {
    showNoRepoState('No Repositories Connected', 'Connect a repository on the Repositories page first.');
  }
}

function renderRepoSelector() {
  var menu = document.getElementById('repo-dropdown-menu');
  if (!menu) return;

  menu.innerHTML = '';
  if (_repos.length === 0) {
    menu.innerHTML = '<div style="padding:12px 16px;font-size:13px;color:var(--color-text-tertiary);">No repositories connected</div>';
    return;
  }

  _repos.forEach(function(r) {
    var name = r.repo_name || r.repositoryName || r.name;
    var prov = r.provider || 'codecommit';
    var isGH = prov === 'github';
    var rid = r.id || name;

    var item = document.createElement('div');
    item.className = 'repo-dropdown-item-branch';
    item.onclick = function() {
      selectRepo(rid);
      menu.style.display = 'none';
    };

    var ghSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/></svg>';
    var awsSvg = '<svg width="16" height="16" viewBox="0 0 24 24"><path fill="#FF9900" d="M6.763 10.036c0 .296.032.535.088.71.064.176.144.368.256.576.04.064.056.128.056.184 0 .08-.048.16-.152.24l-.504.336a.383.383 0 0 1-.208.072c-.08 0-.16-.04-.24-.112a2.47 2.47 0 0 1-.288-.376 6.18 6.18 0 0 1-.248-.472c-.624.736-1.408 1.104-2.352 1.104-.672 0-1.208-.192-1.6-.576-.392-.384-.592-.896-.592-1.536 0-.68.24-1.232.728-1.648.488-.416 1.136-.624 1.96-.624.272 0 .552.024.848.064.296.04.6.104.92.176v-.584c0-.608-.128-1.032-.376-1.28-.256-.248-.688-.368-1.304-.368-.28 0-.568.032-.864.104-.296.072-.584.168-.864.296a2.298 2.298 0 0 1-.28.104.488.488 0 0 1-.128.024c-.112 0-.168-.08-.168-.248v-.392c0-.128.016-.224.056-.28a.597.597 0 0 1 .224-.168c.28-.144.616-.264 1.008-.36A4.84 4.84 0 0 1 4.8 6.6c.952 0 1.648.216 2.096.648.44.432.664 1.088.664 1.968v2.82zm-3.24 1.212c.264 0 .536-.048.824-.144.288-.096.544-.272.76-.512.128-.152.224-.32.272-.512.048-.192.08-.424.08-.696v-.336a6.709 6.709 0 0 0-.736-.136 6.02 6.02 0 0 0-.752-.048c-.536 0-.928.104-1.192.32-.264.216-.392.52-.392.92 0 .376.096.656.296.848.192.2.464.296.84.296zm6.44.864c-.144 0-.24-.024-.304-.08-.064-.048-.12-.16-.168-.312L7.58 7.616a1.42 1.42 0 0 1-.072-.32c0-.128.064-.2.192-.2h.784c.152 0 .256.024.312.08.064.048.112.16.16.312l1.48 5.836 1.376-5.836c.04-.16.088-.264.152-.312a.56.56 0 0 1 .32-.08h.64c.152 0 .256.024.32.08.064.048.12.16.152.312l1.392 5.904 1.528-5.904c.048-.16.104-.264.16-.312a.52.52 0 0 1 .312-.08h.744c.128 0 .2.064.2.2 0 .04-.008.08-.016.128a1.137 1.137 0 0 1-.056.2l-2.128 6.104c-.048.16-.104.264-.168.312a.51.51 0 0 1-.304.08h-.688c-.152 0-.256-.024-.32-.08-.064-.056-.12-.16-.152-.32L12.96 7.964l-1.368 5.836c-.04.16-.088.264-.152.32-.064.056-.176.08-.32.08h-.688zm11.336.24c-.416 0-.832-.048-1.232-.144-.4-.096-.712-.2-.92-.32-.128-.072-.216-.152-.248-.224a.56.56 0 0 1-.048-.224v-.408c0-.168.064-.248.184-.248.048 0 .096.008.144.024.048.016.12.048.2.08.272.12.568.216.888.28.328.064.648.096.976.096.52 0 .92-.088 1.2-.264a.86.86 0 0 0 .424-.76.777.777 0 0 0-.212-.556c-.144-.152-.416-.288-.808-.416l-1.16-.36c-.584-.184-1.016-.456-1.288-.816a1.953 1.953 0 0 1-.408-1.184c0-.344.072-.648.216-.912.144-.264.336-.496.576-.688.24-.192.512-.336.832-.432.32-.096.656-.144 1.008-.144.176 0 .36.008.536.032.184.024.352.056.512.096.152.04.296.088.432.136.136.048.24.096.312.144a.649.649 0 0 1 .216.208.506.506 0 0 1 .064.256v.376c0 .168-.064.256-.184.256a.83.83 0 0 1-.3-.096 3.807 3.807 0 0 0-1.596-.328c-.472 0-.84.072-1.096.224-.256.152-.384.384-.384.704 0 .216.08.4.232.552.152.152.44.304.856.44l1.136.36c.576.184.992.44 1.24.768.248.328.368.704.368 1.12 0 .352-.072.672-.208.952-.144.28-.336.52-.592.72-.256.2-.56.344-.912.448-.368.112-.76.168-1.184.168z"/><path fill="#FF9900" d="M20.16 17.196c-2.464 1.8-6.032 2.752-9.112 2.752-4.312 0-8.2-1.6-11.136-4.248-.232-.208-.024-.496.256-.336 3.168 1.848 7.088 2.952 11.128 2.952 2.728 0 5.728-.568 8.488-1.744.416-.176.768.272.376.624z"/><path fill="#FF9900" d="M21.12 16.096c-.312-.4-2.072-.192-2.864-.096-.24.032-.28-.184-.064-.344 1.4-.984 3.704-.704 3.968-.368.264.336-.072 2.64-1.384 3.744-.2.168-.392.08-.304-.144.296-.736.952-2.392.648-2.792z"/></svg>';

    item.innerHTML =
      (isGH ? ghSvg : awsSvg) +
      '<div style="flex:1;">' +
        '<div style="font-weight:600;color:var(--color-text-primary);">' + name + '</div>' +
        '<div style="font-size:11px;color:var(--color-text-tertiary);">' + (isGH ? 'GitHub' : 'AWS CodeCommit') + '</div>' +
      '</div>';

    menu.appendChild(item);
  });
}

function toggleRepoDropdown() {
  var menu = document.getElementById('repo-dropdown-menu');
  var arrow = document.getElementById('repo-selector-arrow');
  if (menu) {
    var isOpen = menu.style.display === 'block';
    menu.style.display = isOpen ? 'none' : 'block';
    if (arrow) arrow.style.transform = isOpen ? 'none' : 'rotate(180deg)';
  }
}

function selectRepo(rid) {
  _selectedRepoId = rid;
  var repo = _repos.find(function(r) { return (r.id || r.repo_name || r.name) === rid; });
  var name = repo ? (repo.repo_name || repo.repositoryName || repo.name) : 'Select Repository';
  var prov = repo ? (repo.provider || 'codecommit') : 'codecommit';
  var isGH = prov === 'github';

  var textEl = document.getElementById('repo-selector-text');
  if (textEl) textEl.textContent = name;

  var iconEl = document.getElementById('repo-selector-icon');
  if (iconEl) {
    var ghSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/></svg>';
    var awsSvg = '<svg width="16" height="16" viewBox="0 0 24 24"><path fill="#FF9900" d="M6.763 10.036c0 .296.032.535.088.71.064.176.144.368.256.576.04.064.056.128.056.184 0 .08-.048.16-.152.24l-.504.336a.383.383 0 0 1-.208.072c-.08 0-.16-.04-.24-.112a2.47 2.47 0 0 1-.288-.376 6.18 6.18 0 0 1-.248-.472c-.624.736-1.408 1.104-2.352 1.104-.672 0-1.208-.192-1.6-.576-.392-.384-.592-.896-.592-1.536 0-.68.24-1.232.728-1.648.488-.416 1.136-.624 1.96-.624.272 0 .552.024.848.064.296.04.6.104.92.176v-.584c0-.608-.128-1.032-.376-1.28-.256-.248-.688-.368-1.304-.368-.28 0-.568.032-.864.104-.296.072-.584.168-.864.296a2.298 2.298 0 0 1-.28.104.488.488 0 0 1-.128.024c-.112 0-.168-.08-.168-.248v-.392c0-.128.016-.224.056-.28a.597.597 0 0 1 .224-.168c.28-.144.616-.264 1.008-.36A4.84 4.84 0 0 1 4.8 6.6c.952 0 1.648.216 2.096.648.44.432.664 1.088.664 1.968v2.82zm-3.24 1.212c.264 0 .536-.048.824-.144.288-.096.544-.272.76-.512.128-.152.224-.32.272-.512.048-.192.08-.424.08-.696v-.336a6.709 6.709 0 0 0-.736-.136 6.02 6.02 0 0 0-.752-.048c-.536 0-.928.104-1.192.32-.264.216-.392.52-.392.92 0 .376.096.656.296.848.192.2.464.296.84.296zm6.44.864c-.144 0-.24-.024-.304-.08-.064-.048-.12-.16-.168-.312L7.58 7.616a1.42 1.42 0 0 1-.072-.32c0-.128.064-.2.192-.2h.784c.152 0 .256.024.312.08.064.048.112.16.16.312l1.48 5.836 1.376-5.836c.04-.16.088-.264.152-.312a.56.56 0 0 1 .32-.08h.64c.152 0 .256.024.32.08.064.048.12.16.152.312l1.392 5.904 1.528-5.904c.048-.16.104-.264.16-.312a.52.52 0 0 1 .312-.08h.744c.128 0 .2.064.2.2 0 .04-.008.08-.016.128a1.137 1.137 0 0 1-.056.2l-2.128 6.104c-.048.16-.104.264-.168.312a.51.51 0 0 1-.304.08h-.688c-.152 0-.256-.024-.32-.08-.064-.056-.12-.16-.152-.32L12.96 7.964l-1.368 5.836c-.04.16-.088.264-.152.32-.064.056-.176.08-.32.08h-.688zm11.336.24c-.416 0-.832-.048-1.232-.144-.4-.096-.712-.2-.92-.32-.128-.072-.216-.152-.248-.224a.56.56 0 0 1-.048-.224v-.408c0-.168.064-.248.184-.248.048 0 .096.008.144.024.048.016.12.048.2.08.272.12.568.216.888.28.328.064.648.096.976.096.52 0 .92-.088 1.2-.264a.86.86 0 0 0 .424-.76.777.777 0 0 0-.212-.556c-.144-.152-.416-.288-.808-.416l-1.16-.36c-.584-.184-1.016-.456-1.288-.816a1.953 1.953 0 0 1-.408-1.184c0-.344.072-.648.216-.912.144-.264.336-.496.576-.688.24-.192.512-.336.832-.432.32-.096.656-.144 1.008-.144.176 0 .36.008.536.032.184.024.352.056.512.096.152.04.296.088.432.136.136.048.24.096.312.144a.649.649 0 0 1 .216.208.506.506 0 0 1 .064.256v.376c0 .168-.064.256-.184.256a.83.83 0 0 1-.3-.096 3.807 3.807 0 0 0-1.596-.328c-.472 0-.84.072-1.096.224-.256.152-.384.384-.384.704 0 .216.08.4.232.552.152.152.44.304.856.44l1.136.36c.576.184.992.44 1.24.768.248.328.368.704.368 1.12 0 .352-.072.672-.208.952-.144.28-.336.52-.592.72-.256.2-.56.344-.912.448-.368.112-.76.168-1.184.168z"/><path fill="#FF9900" d="M20.16 17.196c-2.464 1.8-6.032 2.752-9.112 2.752-4.312 0-8.2-1.6-11.136-4.248-.232-.208-.024-.496.256-.336 3.168 1.848 7.088 2.952 11.128 2.952 2.728 0 5.728-.568 8.488-1.744.416-.176.768.272.376.624z"/><path fill="#FF9900" d="M21.12 16.096c-.312-.4-2.072-.192-2.864-.096-.24.032-.28-.184-.064-.344 1.4-.984 3.704-.704 3.968-.368.264.336-.072 2.64-1.384 3.744-.2.168-.392.08-.304-.144.296-.736.952-2.392.648-2.792z"/></svg>';
    iconEl.innerHTML = isGH ? ghSvg : awsSvg;
  }

  // Update Commits provider badge right away (Matches Screenshot 1 & 2)
  var badgeEl = document.getElementById('commit-provider-badge');
  if (badgeEl) {
    badgeEl.innerHTML =
      '<span style="display:inline-flex;align-items:center;gap:5px;margin-left:4px;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;background:' + (isGH ? 'rgba(255,255,255,0.08)' : 'rgba(255,153,0,0.1)') + ';border:1px solid ' + (isGH ? 'var(--color-border)' : 'rgba(255,153,0,0.3)') + ';color:' + (isGH ? 'var(--color-text-primary)' : '#d97706') + ';text-transform:uppercase;letter-spacing:0.04em;">' +
        (isGH ? 'GitHub' : 'CodeCommit') +
      '</span>';
  }

  document.getElementById('no-repo-state').style.display = 'none';
  document.getElementById('branches-main-grid').style.display = 'grid';

  var btnCreate = document.getElementById('btn-open-create-branch');
  if (btnCreate) btnCreate.disabled = false;

  fetchBranches();
}

function showNoRepoState(title, desc) {
  var loadingEl = document.getElementById('branches-loading');
  if (loadingEl) loadingEl.style.display = 'none';

  var titleEl = document.getElementById('no-repo-title');
  var descEl = document.getElementById('no-repo-desc');

  if (titleEl) titleEl.textContent = title || 'Select a Repository';
  if (descEl) descEl.textContent = desc || 'Use the repository dropdown above to select a repository and view its branches.';

  document.getElementById('no-repo-state').style.display = 'block';
  document.getElementById('branches-main-grid').style.display = 'none';

  var btnCreate = document.getElementById('btn-open-create-branch');
  if (btnCreate) btnCreate.disabled = true;
}

async function fetchBranches() {
  if (!_selectedRepoId) {
    showNoRepoState('No Repositories Connected', 'Connect a repository on the Repositories page first.');
    return;
  }

  var loadingEl = document.getElementById('branches-loading');
  var errorEl = document.getElementById('branches-error');
  var authEl = document.getElementById('branches-auth-expired');
  var listEl = document.getElementById('branch-list-container');
  var countBadge = document.getElementById('branch-count-badge');
  var iconRefresh = document.getElementById('btn-refresh-branches-icon');

  if (iconRefresh) iconRefresh.classList.add('animate-spin');
  if (loadingEl) loadingEl.style.display = 'flex';
  if (errorEl) errorEl.style.display = 'none';
  if (authEl) authEl.style.display = 'none';
  if (listEl) listEl.style.display = 'none';

  // Reset selected branch & commits empty view while loading branches (Matches Screenshot 2)
  _selectedBranch = null;
  var titleEl = document.getElementById('commit-branch-title');
  if (titleEl) titleEl.textContent = '...';
  showCommitsEmptyState('No commits found for branch');

  try {
    var params = new URLSearchParams({ repositoryId: _selectedRepoId });
    if (_activeProject) params.set('projectId', _activeProject.id);

    var res = await api.get('/api/branches/by-repo?' + params.toString());
    if (res && res.ok && res.branches) {
      _branches = res.branches;
      _defaultBranch = res.defaultBranch || 'main';
      if (countBadge) countBadge.textContent = '(' + _branches.length + ')';

      renderBranchList();

      var def = _branches.find(function(b) { return b.isDefault; }) || _branches[0];
      if (def) selectBranch(def.name || def);
    } else if (res && res.authRequired) {
      if (authEl) authEl.style.display = 'block';
      var btnCreate = document.getElementById('btn-open-create-branch');
      if (btnCreate) btnCreate.disabled = true;
    } else {
      if (errorEl) {
        document.getElementById('branches-error-text').textContent = (res && res.error) || 'Failed to load branches';
        errorEl.style.display = 'flex';
      }
    }
  } catch (err) {
    if (errorEl) {
      document.getElementById('branches-error-text').textContent = err.message || 'Error loading branches';
      errorEl.style.display = 'flex';
    }
  } finally {
    if (loadingEl) loadingEl.style.display = 'none';
    if (iconRefresh) {
      setTimeout(function() { iconRefresh.classList.remove('animate-spin'); }, 400);
    }
  }
}

function renderBranchList() {
  var listEl = document.getElementById('branch-list-container');
  if (!listEl) return;

  listEl.innerHTML = '';
  if (_branches.length === 0) {
    listEl.style.display = 'none';
    return;
  }

  listEl.style.display = 'flex';

  var selectedRepo = _repos.find(function(r) { return (r.id || r.repo_name || r.name) === _selectedRepoId; });
  var isGH = selectedRepo && selectedRepo.provider === 'github';

  _branches.forEach(function(b) {
    var bName = b.name || b;
    var isSel = _selectedBranch === bName;
    var isDef = b.isDefault || bName === _defaultBranch;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.onclick = function() { selectBranch(bName); };
    btn.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:9px 11px;border-radius:9px;border:none;background:' + (isSel ? 'rgba(99,102,241,0.1)' : 'transparent') + ';color:' + (isSel ? '#6366f1' : 'var(--color-text-primary)') + ';font-weight:' + (isSel ? '700' : '400') + ';font-size:13px;cursor:pointer;text-align:left;transition:background 0.12s ease;';

    var html =
      '<span style="display:flex;align-items:center;gap:7px;overflow:hidden;">' +
        '<i data-lucide="git-branch" style="width:14px;height:14px;flex-shrink:0;"></i>' +
        '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + bName + '</span>' +
      '</span>' +
      '<div style="display:flex;align-items:center;gap:4px;flex-shrink:0;margin-left:6px;">' +
        (isDef ? '<span style="font-size:9px;padding:2px 6px;border-radius:20px;font-weight:700;background:rgba(16,185,129,0.12);color:#10b981;text-transform:uppercase;letter-spacing:0.05em;">DEFAULT</span>' : '') +
        (!isDef && isGH && b.aheadBy > 0 ? '<span style="font-size:10px;color:#6366f1;font-weight:600;">+' + b.aheadBy + '</span>' : '') +
      '</div>';

    btn.innerHTML = html;
    listEl.appendChild(btn);
  });

  var btnCreate = document.getElementById('btn-open-create-branch');
  if (btnCreate) btnCreate.disabled = false;

  if (window.lucide) lucide.createIcons();
}

function selectBranch(bName) {
  _selectedBranch = bName;
  var titleEl = document.getElementById('commit-branch-title');
  if (titleEl) titleEl.textContent = bName;

  renderBranchList();
  fetchCommits();
}

async function fetchCommits() {
  if (!_selectedRepoId || !_selectedBranch) {
    showCommitsEmptyState('No commits found for branch');
    return;
  }

  var loadingEl = document.getElementById('commits-loading');
  var errorEl = document.getElementById('commits-error');
  var listEl = document.getElementById('commits-list-container');
  var emptyEl = document.getElementById('commits-empty-state');
  var iconRefresh = document.getElementById('btn-refresh-commits-icon');

  if (iconRefresh) iconRefresh.classList.add('animate-spin');
  if (loadingEl) loadingEl.style.display = 'flex';
  if (errorEl) errorEl.style.display = 'none';
  if (emptyEl) emptyEl.style.display = 'none';
  if (listEl) listEl.style.display = 'none';

  try {
    var params = new URLSearchParams({ repositoryId: _selectedRepoId, branch: _selectedBranch });
    if (_activeProject) params.set('projectId', _activeProject.id);

    var res = await api.get('/api/commits/by-repo?' + params.toString());
    if (res && res.ok && res.commits && res.commits.length > 0) {
      _commits = res.commits;
      renderCommitsList();
    } else {
      showCommitsEmptyState((res && res.error) || 'No commits found for branch');
    }
  } catch (err) {
    showCommitsEmptyState(err.message || 'Error loading commits');
  } finally {
    if (loadingEl) loadingEl.style.display = 'none';
    if (iconRefresh) {
      setTimeout(function() { iconRefresh.classList.remove('animate-spin'); }, 400);
    }
  }
}

function showCommitsEmptyState(msg) {
  var listEl = document.getElementById('commits-list-container');
  var emptyEl = document.getElementById('commits-empty-state');
  var textEl = document.getElementById('commits-empty-text');

  if (listEl) listEl.style.display = 'none';
  if (emptyEl) emptyEl.style.display = 'flex';
  if (textEl) textEl.textContent = msg || 'No commits found for branch';
}

function renderCommitsList() {
  var listEl = document.getElementById('commits-list-container');
  var emptyEl = document.getElementById('commits-empty-state');

  if (!listEl) return;

  listEl.innerHTML = '';
  if (_commits.length === 0) {
    showCommitsEmptyState('No commits found for branch');
    return;
  }

  if (emptyEl) emptyEl.style.display = 'none';
  listEl.style.display = 'flex';

  _commits.forEach(function(c, i) {
    var sha = c.sha || c.commitId || '';
    var msg = c.message || (c.commit && c.commit.message) || 'No commit message';
    var firstLine = msg.split('\n')[0];
    var author = c.authorName || (c.commit && c.commit.author && c.commit.author.name) || c.author || 'Developer';
    var date = c.date || (c.commit && c.commit.author && c.commit.author.date) || null;

    var item = document.createElement('div');
    item.style.cssText = 'padding:12px 14px;border:1px solid var(--color-border);border-radius:11px;background:var(--color-bg);display:flex;align-items:flex-start;justify-content:space-between;gap:14px;transition:border-color 0.15s ease;';

    var html =
      '<div style="flex:1;min-width:0;">' +
        '<div style="font-size:13px;font-weight:600;color:var(--color-text-primary);line-height:1.4;margin-bottom:6px;">' + firstLine + '</div>' +
        '<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;">' +
          '<span style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--color-text-tertiary);">' +
            (c.authorAvatar ? '<img src="' + c.authorAvatar + '" style="width:16px;height:16px;border-radius:50%;object-fit:cover;" />' : '<i data-lucide="user" style="width:12px;height:12px;"></i>') +
            '<span style="font-weight:600;color:var(--color-text-secondary);">' + author + (c.authorLogin ? ' (@' + c.authorLogin + ')' : '') + '</span>' +
          '</span>' +
          (date ? '<span style="display:flex;align-items:center;gap:4px;font-size:12px;color:var(--color-text-tertiary);"><i data-lucide="clock" style="width:12px;height:12px;"></i> ' + relTime(date) + '</span>' : '') +
        '</div>' +
      '</div>' +
      (sha ? '<span style="display:flex;align-items:center;gap:4px;font-family:monospace;font-size:11px;padding:4px 9px;background:var(--color-surface);border-radius:7px;border:1px solid var(--color-border);color:var(--color-text-secondary);flex-shrink:0;white-space:nowrap;"><i data-lucide="hash" style="width:10px;height:10px;"></i>' + sha.substring(0, 7) + '</span>' : '');

    item.innerHTML = html;
    listEl.appendChild(item);
  });

  if (window.lucide) lucide.createIcons();
}

function relTime(dateStr) {
  if (window.TimeUtil) return TimeUtil.relTime(dateStr);
  if (!dateStr) return '';
  var diff = Date.now() - new Date(dateStr).getTime();
  var m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  var h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  var d = Math.floor(h / 24);
  if (d < 30) return d + 'd ago';
  return new Date(dateStr).toLocaleDateString();
}

// ── Server Git CLI Runner ──────────────────────────────────────────────────
function toggleCliPanel() {
  var panel = document.getElementById('cli-panel');
  var btn = document.getElementById('btn-toggle-cli');
  if (!panel) return;

  var isVis = panel.style.display !== 'none';
  panel.style.display = isVis ? 'none' : 'block';
  if (btn) {
    btn.style.background = isVis ? 'var(--color-surface)' : 'rgba(99,102,241,0.1)';
    btn.style.borderColor = isVis ? 'var(--color-border)' : '#6366f1';
    btn.style.color = isVis ? 'var(--color-text-primary)' : '#6366f1';
  }
  if (window.lucide) lucide.createIcons();
}

async function handleExecCli(e) {
  e.preventDefault();
  var cmdInput = document.getElementById('cli-cmd-input');
  var preOut = document.getElementById('cli-output-pre');
  var btnRun = document.getElementById('btn-run-cli');

  var cmd = cmdInput ? cmdInput.value.trim() : '';
  if (!cmd || !_activeProject) return;

  btnRun.disabled = true;
  btnRun.textContent = 'Running…';
  preOut.style.display = 'block';
  preOut.textContent = 'Executing command on server...';

  try {
    var res = await api.post('/api/git/exec', {
      projectId: _activeProject.id,
      command: cmd
    });

    if (res.ok) {
      preOut.textContent = res.output || 'Command executed successfully.';
    } else {
      preOut.textContent = 'Error: ' + (res.error || 'Command failed');
    }
  } catch (err) {
    preOut.textContent = 'Error: ' + err.message;
  }
  btnRun.disabled = false;
  btnRun.textContent = 'Run';
}

// ── Create Branch Modal ───────────────────────────────────────────────────
function openCreateBranchModal() {
  var repo = _repos.find(function(r) { return (r.id || r.repo_name || r.name) === _selectedRepoId; });
  var name = repo ? (repo.repo_name || repo.repositoryName || repo.name) : '';
  var isGH = repo && repo.provider === 'github';

  var subtext = document.getElementById('create-modal-subtext');
  if (subtext) subtext.textContent = name + ' · ' + (isGH ? 'GitHub' : 'AWS CodeCommit');

  var selectBase = document.getElementById('create-base-branch-select');
  if (selectBase) {
    selectBase.innerHTML = '';
    _branches.forEach(function(b) {
      var bName = b.name || b;
      var opt = document.createElement('option');
      opt.value = bName;
      opt.textContent = bName + ((b.isDefault || bName === _defaultBranch) ? ' (default)' : '');
      selectBase.appendChild(opt);
    });
  }

  document.getElementById('create-branch-name-input').value = '';
  document.getElementById('create-branch-error').style.display = 'none';

  document.getElementById('modal-create-branch').style.display = 'flex';
  if (window.lucide) lucide.createIcons();
}

function closeCreateBranchModal() {
  document.getElementById('modal-create-branch').style.display = 'none';
}

async function handleCreateBranchSubmit(e) {
  e.preventDefault();
  var nameInput = document.getElementById('create-branch-name-input');
  var baseSelect = document.getElementById('create-base-branch-select');
  var errEl = document.getElementById('create-branch-error');

  var bName = nameInput ? nameInput.value.trim() : '';
  var base = baseSelect ? baseSelect.value : '';

  if (!bName || !base || !_selectedRepoId) return;

  var btn = document.getElementById('btn-submit-create-branch');
  btn.disabled = true;
  errEl.style.display = 'none';

  try {
    var res = await api.post('/api/branches/create-for-repo', {
      repositoryId: _selectedRepoId,
      branchName: bName,
      baseBranch: base,
      projectId: _activeProject ? _activeProject.id : undefined
    });

    if (res.ok) {
      closeCreateBranchModal();
      fetchBranches();
    } else {
      errEl.textContent = res.error || 'Failed to create branch';
      errEl.style.display = 'block';
    }
  } catch (err) {
    errEl.textContent = err.message || 'Error creating branch';
    errEl.style.display = 'block';
  }
  btn.disabled = false;
}
