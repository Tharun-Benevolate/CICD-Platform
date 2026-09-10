// Branches Page — Vanilla JS Logic
// Keep this page isolated from other SPA page scripts. Several older pages
// use generic globals such as `fetchRepos` and `_repos`; without this closure,
// visiting Repositories overwrites Branches' loader before a return navigation.
(function() {
var _activeProject = null;
var _repos = [];
var _selectedRepoId = null;
var _branches = [];
var _defaultBranch = 'main';
var _selectedBranch = null;
var _commits = [];
var _graphCommits = [];
var _graphSyncedAt = null;
var _branchesSyncInterval = null;
var _gitActivity = [];
var _relationshipRequest = 0;
var _branchesInitRequest = 0;

var _branchesClickListenerAdded = false;

async function initBranchesPageRunner() {
  var result = initBranchesPage();

  if (!_branchesClickListenerAdded) {
    _branchesClickListenerAdded = true;
    document.addEventListener('click', function(e) {
      var wrapper = document.getElementById('repo-selector-wrapper');
      var repoOption = e.target.closest('[data-branches-repository-id]');
      if (repoOption && wrapper && wrapper.contains(repoOption)) {
        e.preventDefault();
        selectRepo(repoOption.getAttribute('data-branches-repository-id'));
        var optionMenu = document.getElementById('repo-dropdown-menu');
        if (optionMenu) optionMenu.style.display = 'none';
        return;
      }
      if (wrapper && !wrapper.contains(e.target)) {
        var dropdown = document.getElementById('repo-dropdown-menu');
        if (dropdown) dropdown.style.display = 'none';
      }
    });
  }
  return result;
}

window.initBranchesPageRunner = initBranchesPageRunner;
window.initBranchesPage = initBranchesPage;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initBranchesPageRunner);
}

async function initBranchesPage() {
  var initRequest = ++_branchesInitRequest;
  // Reset all state on SPA re-navigation
  _repos = [];
  _branches = [];
  _selectedBranch = null;
  _selectedRepoId = null;
  _commits = [];
  _graphCommits = [];
  _graphSyncedAt = null;
  _gitActivity = [];
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
  var graphCard = document.getElementById('git-graph-card');
  if (graphCard) graphCard.style.display = 'none';

  if (_branchesSyncInterval) clearInterval(_branchesSyncInterval);
  _branchesSyncInterval = setInterval(function() {
    if (window.location.pathname === '/branches' && _selectedRepoId) fetchBranches();
  }, 60000);

  var projects = [];
  try {
    var res = await api.get('/api/projects');
    if (res && res.projects) {
      projects = res.projects;
      _activeProject = projects.find(function(p) { return p.isActive; }) || projects[0];
    }
  } catch (e) {}

  // A previous navigation may finish after the user has already left and
  // returned to this page. Only the newest initialization may touch this DOM.
  if (initRequest !== _branchesInitRequest) return;

  if (!projects || projects.length === 0) {
    showNoRepoState('No Projects Found', 'No projects exist yet. Please create a project first.');
    return;
  }

  return fetchRepos(initRequest);
}

async function fetchRepos(initRequest) {
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

  if (initRequest && initRequest !== _branchesInitRequest) return;

  renderRepoSelector();

  if (_repos.length > 0) {
    var savedRepoId = null;
    try { savedRepoId = sessionStorage.getItem('branches:selected-repo:' + (_activeProject?.id || 'global')); } catch (_) {}
    var savedRepo = _repos.find(function(repo) { return String(repo.id || repo.repo_name || repo.name) === String(savedRepoId); });
    var initialRepo = savedRepo || _repos[0];
    return selectRepo(initialRepo.id || initialRepo.repo_name || initialRepo.name);
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

    var item = document.createElement('button');
    item.type = 'button';
    item.className = 'repo-dropdown-item-branch';
    item.setAttribute('data-branches-repository-id', String(rid));
    item.setAttribute('aria-label', 'Open repository ' + name);

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

async function selectRepo(rid) {
  var repo = _repos.find(function(r) { return String(r.id || r.repo_name || r.name) === String(rid); });
  if (!repo) {
    showNoRepoState('Repository unavailable', 'The selected repository is no longer available. Refresh the page and try again.');
    return;
  }
  _selectedRepoId = repo.id || repo.repo_name || repo.name;
  try { sessionStorage.setItem('branches:selected-repo:' + (_activeProject?.id || 'global'), String(_selectedRepoId)); } catch (_) {}
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

  var noRepoState = document.getElementById('no-repo-state');
  var mainGrid = document.getElementById('branches-main-grid');
  if (noRepoState) noRepoState.style.display = 'none';
  if (mainGrid) mainGrid.style.display = 'grid';

  var btnCreate = document.getElementById('btn-open-create-branch');
  if (btnCreate) btnCreate.disabled = false;

  return fetchBranches();
}

function showNoRepoState(title, desc) {
  var loadingEl = document.getElementById('branches-loading');
  if (loadingEl) loadingEl.style.display = 'none';

  var titleEl = document.getElementById('no-repo-title');
  var descEl = document.getElementById('no-repo-desc');

  if (titleEl) titleEl.textContent = title || 'Select a Repository';
  if (descEl) descEl.textContent = desc || 'Use the repository dropdown above to select a repository and view its branches.';

  var noRepoState = document.getElementById('no-repo-state');
  var mainGrid = document.getElementById('branches-main-grid');
  if (noRepoState) noRepoState.style.display = 'block';
  if (mainGrid) mainGrid.style.display = 'none';

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

  var requestedRepoId = _selectedRepoId;
  try {
    var params = new URLSearchParams({ repositoryId: requestedRepoId });
    if (_activeProject) params.set('projectId', _activeProject.id);

    var res = await api.get('/api/branches/by-repo?' + params.toString());
    if (requestedRepoId !== _selectedRepoId || !document.getElementById('branches-main-grid')) return;
    if (res && res.ok && res.branches) {
      _branches = res.branches;
      _defaultBranch = res.defaultBranch || 'main';
      if (countBadge) countBadge.textContent = '(' + _branches.length + ')';

      renderBranchList();

      var mergeButton = document.getElementById('btn-open-merge');
      if (mergeButton) mergeButton.disabled = _branches.length < 2;

      var def = _branches.find(function(b) { return b.isDefault; }) || _branches[0];
      if (def) selectBranch(def.name || def);
      fetchGitGraph();
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
    if (requestedRepoId !== _selectedRepoId) return;
    if (errorEl) {
      document.getElementById('branches-error-text').textContent = err.message || 'Error loading branches';
      errorEl.style.display = 'flex';
    }
  } finally {
    if (requestedRepoId !== _selectedRepoId) return;
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
  renderGitGraph();
  fetchBranchRelationship();
  fetchCommits();
}

async function fetchBranchRelationship() {
  var el = document.getElementById('git-branch-relationship');
  if (!el) return;
  if (!_selectedBranch || _selectedBranch === _defaultBranch) {
    el.style.display = 'none';
    return;
  }
  var requestId = ++_relationshipRequest;
  el.style.display = 'block';
  el.textContent = 'Comparing ' + _selectedBranch + ' with ' + _defaultBranch + '…';
  try {
    var query = new URLSearchParams({ repositoryId: _selectedRepoId, base: _defaultBranch, head: _selectedBranch });
    var result = await api.get('/api/branches/compare?' + query);
    if (requestId !== _relationshipRequest || _selectedBranch === _defaultBranch) return;
    var diff = result?.diff;
    if (!result?.ok || !diff) throw new Error(result?.error || 'Comparison unavailable');
    var ahead = diff.aheadBy || 0, behind = diff.behindBy || 0;
    var relation;
    if (ahead === 0 && behind === 0) relation = '<strong>' + escapeGitText(_selectedBranch) + '</strong> and <strong>' + escapeGitText(_defaultBranch) + '</strong> point to the same commit.';
    else if (ahead > 0 && behind === 0) relation = '<strong>' + escapeGitText(_selectedBranch) + '</strong> contains the current <strong>' + escapeGitText(_defaultBranch) + '</strong> history plus <strong>' + ahead + '</strong> commit' + (ahead === 1 ? '' : 's') + '.';
    else if (ahead === 0) relation = '<strong>' + escapeGitText(_selectedBranch) + '</strong> is <strong>' + behind + '</strong> commit' + (behind === 1 ? '' : 's') + ' behind <strong>' + escapeGitText(_defaultBranch) + '</strong>.';
    else relation = '<strong>' + escapeGitText(_selectedBranch) + '</strong> and <strong>' + escapeGitText(_defaultBranch) + '</strong> have diverged: ' + ahead + ' ahead, ' + behind + ' behind.';
    if (diff.mergeBaseSha) relation += ' Shared base: <code>' + escapeGitText(diff.mergeBaseSha.slice(0, 7)) + '</code>.';
    el.innerHTML = relation + ' Ref labels in the graph are pointers to historical commits; they are not claims that those branches merged into this branch.';
  } catch (_) {
    if (requestId === _relationshipRequest) el.textContent = 'Branch relationship is unavailable right now; the commit graph remains limited to verified parent links.';
  }
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
      renderGitGraph();
    } else {
      _commits = [];
      renderGitGraph();
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

// ── Visual Git workspace ──────────────────────────────────────────────────
// This intentionally sits alongside the CLI runner. It turns common remote
// Git work into guided project-scoped actions, while the terminal remains
// available for advanced commands.
function escapeGitText(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function fetchGitGraph() {
  if (!_selectedRepoId || !_branches.length) return;
  var requestedRepoId = _selectedRepoId;
  var graphEl = document.getElementById('git-graph');
  if (graphEl) graphEl.innerHTML = '<div style="padding:20px;color:var(--color-text-tertiary);font-size:13px;">Syncing branch heads and parent relationships from the remote…</div>';
  var requests = _branches.slice(0, 20).map(async function(branch) {
    var name = branch.name || branch;
    var params = new URLSearchParams({ repositoryId: _selectedRepoId, branch: name, limit: '30' });
    if (_activeProject) params.set('projectId', _activeProject.id);
    try {
      var result = await api.get('/api/commits/by-repo?' + params.toString());
      return result?.ok ? (result.commits || []) : [];
    } catch (_) { return []; }
  });
  var histories = await Promise.all(requests);
  if (requestedRepoId !== _selectedRepoId) return;
  var bySha = new Map();
  histories.forEach(function(history) {
    history.forEach(function(commit) {
      var sha = commit.sha || commit.commitId;
      if (sha && !bySha.has(sha)) bySha.set(sha, commit);
    });
  });
  _graphCommits = Array.from(bySha.values());
  _graphSyncedAt = new Date();
  renderGitGraph();
  fetchGitActivity(requestedRepoId);
}

async function fetchGitActivity(requestedRepoId) {
  var params = new URLSearchParams({ repositoryId: requestedRepoId || _selectedRepoId });
  if (_activeProject) params.set('projectId', _activeProject.id);
  try {
    var response = await api.get('/api/branches/activity?' + params.toString());
    if ((requestedRepoId || _selectedRepoId) !== _selectedRepoId) return;
    _gitActivity = response?.ok ? (response.activity || []) : [];
  } catch (_) {
    _gitActivity = [];
  }
  renderGitActivity();
}

function renderGitActivity() {
  var feed = document.getElementById('git-activity-feed');
  if (!feed) return;
  if (!_gitActivity.length) { feed.style.display = 'none'; return; }
  var descriptions = {
    merge: 'Merge recorded: the graph shows the resulting parent convergence.',
    rebase: 'Rebase recorded: commits were rewritten into a new linear sequence; prior commits may no longer be reachable.',
    reset: 'Reset recorded: a branch ref moved; commits removed from reachability cannot be reconstructed from the final graph.',
    revert: 'Revert recorded: this creates a compensating change and preserves the original history.',
    push: 'Push recorded: remote refs were updated.',
    commit: 'Commit recorded: a new commit was created.',
    branch: 'Branch operation recorded.'
  };
  feed.style.display = 'block';
  feed.innerHTML = '<div style="font-size:12px;font-weight:700;color:var(--color-text-secondary);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;">Platform-recorded Git actions</div>' +
    _gitActivity.slice(0, 8).map(function(item) {
      return '<div style="display:flex;gap:9px;padding:8px 0;border-top:1px solid var(--color-border-subtle);font-size:12px;"><span style="min-width:56px;text-transform:uppercase;font-weight:800;color:#a78bfa;">' + escapeGitText(item.type) + '</span><span style="flex:1;color:var(--color-text-secondary);">' + escapeGitText(descriptions[item.type] || item.action) + '</span><span style="color:var(--color-text-tertiary);white-space:nowrap;">' + escapeGitText(relTime(item.timestamp)) + '</span></div>';
    }).join('');
}

function renderGitGraph() {
  var card = document.getElementById('git-graph-card');
  var branchEl = document.getElementById('git-graph-branches');
  var graphEl = document.getElementById('git-graph');
  var subtitle = document.getElementById('git-graph-subtitle');
  var syncEl = document.getElementById('git-graph-sync');
  if (!card || !branchEl || !graphEl) return;
  card.style.display = _selectedBranch ? 'block' : 'none';
  if (!_selectedBranch) return;

  var palette = ['#6366f1', '#22c55e', '#f59e0b', '#a78bfa', '#38bdf8', '#f472b6'];
  branchEl.innerHTML = '';
  _branches.forEach(function(branch, index) {
    var name = branch.name || branch;
    var selected = name === _selectedBranch;
    var isDefault = branch.isDefault || name === _defaultBranch;
    var color = palette[index % palette.length];
    var button = document.createElement('button');
    button.type = 'button';
    button.onclick = function() { selectBranch(name); };
    button.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:5px 9px;border:1px solid ' + (selected ? color : 'var(--color-border)') + ';border-radius:999px;background:' + (selected ? 'rgba(99,102,241,.12)' : 'var(--color-bg)') + ';color:' + (selected ? color : 'var(--color-text-secondary)') + ';font-size:11px;font-weight:700;cursor:pointer;';
    button.innerHTML = '<i style="width:7px;height:7px;display:inline-block;border-radius:50%;background:' + color + ';"></i>' + escapeGitText(name) + (isDefault ? ' <span style="opacity:.7;">default</span>' : '');
    branchEl.appendChild(button);
  });

  var commits = _graphCommits.length ? _graphCommits : _commits;
  if (!commits.length) {
    graphEl.innerHTML = '<div style="padding:20px;color:var(--color-text-tertiary);font-size:13px;">No history available for this branch.</div>';
    return;
  }
  var bySha = new Map();
  commits.forEach(function(commit) { var sha = commit.sha || commit.commitId; if (sha) bySha.set(sha, commit); });
  var selectedRef = _branches.find(function(branch) { return (branch.name || branch) === _selectedBranch; });
  var selectedHead = selectedRef?.sha;
  if (!selectedHead || !bySha.has(selectedHead)) {
    graphEl.innerHTML = '<div style="padding:20px;color:var(--color-text-tertiary);font-size:13px;">The selected branch head is outside the retrieved history window. Refresh to try again.</div>';
    return;
  }

  // Restrict the graph to the selected ref's ancestry. Other branches are
  // shown as labels only when their head points at an exact commit in this
  // path. This is how an IDE graph avoids unrelated branch heads becoming
  // phantom parallel lanes.
  var reachable = new Set();
  function markReachable(sha) {
    if (!sha || reachable.has(sha) || !bySha.has(sha)) return;
    reachable.add(sha);
    (bySha.get(sha).parents || []).forEach(markReachable);
  }
  markReachable(selectedHead);
  var childCount = new Map();
  reachable.forEach(function(sha) { childCount.set(sha, 0); });
  reachable.forEach(function(sha) {
    (bySha.get(sha).parents || []).forEach(function(parent) {
      if (reachable.has(parent)) childCount.set(parent, (childCount.get(parent) || 0) + 1);
    });
  });
  var ready = Array.from(reachable).filter(function(sha) { return childCount.get(sha) === 0; });
  var ordered = [];
  while (ready.length) {
    ready.sort(function(a, b) { return new Date(bySha.get(b).date || 0) - new Date(bySha.get(a).date || 0); });
    var sha = ready.shift(), commit = bySha.get(sha);
    ordered.push(commit);
    (commit.parents || []).forEach(function(parent) {
      if (!reachable.has(parent)) return;
      childCount.set(parent, childCount.get(parent) - 1);
      if (childCount.get(parent) === 0) ready.push(parent);
    });
  }

  var refColors = new Map();
  _branches.forEach(function(branch, index) {
    if (branch.sha) refColors.set(branch.sha, palette[index % palette.length]);
  });
  var lanes = [{ sha: selectedHead, color: refColors.get(selectedHead) || palette[0] }];
  var rows = ordered.map(function(commit) {
    var sha = commit.sha || commit.commitId;
    var lane = lanes.findIndex(function(item) { return item.sha === sha; });
    if (lane < 0) { lanes.push({ sha: sha, color: refColors.get(sha) || palette[lanes.length % palette.length] }); lane = lanes.length - 1; }
    var before = lanes.slice();
    var parents = (commit.parents || []).filter(function(parent) { return bySha.has(parent); });
    var next = before.slice();
    var parentLanes = parents.map(function(parent, index) {
      var target = next.findIndex(function(item) { return item.sha === parent; });
      if (target < 0) {
        var item = { sha: parent, color: refColors.get(parent) || (index === 0 ? before[lane].color : palette[(lane + index + 1) % palette.length]) };
        if (index === 0) { next[lane] = item; target = lane; }
        else { next.splice(lane + index, 0, item); target = lane + index; }
      } else if (index === 0 && target !== lane) {
        next.splice(lane, 1);
        if (target > lane) target--;
      }
      return target;
    });
    if (!parents.length) next.splice(lane, 1);
    lanes = next;
    return { commit: commit, lane: lane, before: before, after: next, parentLanes: parentLanes, laneCount: Math.max(before.length, next.length, 1) };
  });
  if (subtitle) subtitle.textContent = 'Actual parent relationships reachable from ' + _selectedBranch + '; branch labels appear at their exact head commit.';
  if (syncEl) syncEl.textContent = _graphSyncedAt ? 'Synced ' + _graphSyncedAt.toLocaleTimeString() : '';
  graphEl.innerHTML = rows.map(function(row) {
    var width = Math.max(48, row.laneCount * 22 + 18);
    var x = function(index) { return 11 + index * 22; };
    var laneColor = function(index) { return row.before[index]?.color || palette[index % palette.length]; };
    var lines = row.before.map(function(_, index) { return '<line x1="' + x(index) + '" y1="0" x2="' + x(index) + '" y2="42" stroke="' + laneColor(index) + '" stroke-opacity=".72" stroke-width="1.8" />'; }).join('');
    var links = row.parentLanes.map(function(parentLane) { return '<line x1="' + x(row.lane) + '" y1="21" x2="' + x(parentLane) + '" y2="42" stroke="' + (row.after[parentLane]?.color || palette[parentLane % palette.length]) + '" stroke-width="2.2" />'; }).join('');
    var merge = row.parentLanes.length > 1;
    var commit = row.commit, sha = commit.sha || commit.commitId || '', message = (commit.message || 'No commit message').split('\n')[0];
    var refNames = _branches.filter(function(branch) { return branch.sha === sha; }).map(function(branch) { return branch.name || branch; });
    // A badge is deliberately called a "ref": it says where a branch points,
    // rather than implying the branch was merged into the selected one.
    var refsHere = refNames.map(function(name, index) { return '<span title="Branch ref pointing at this commit" style="display:inline-block;margin-left:5px;padding:1px 5px;border-radius:6px;background:rgba(99,102,241,.12);color:' + (refColors.get(sha) || palette[index % palette.length]) + ';font-size:10px;">ref: ' + escapeGitText(name) + '</span>'; }).join('');
    var explanation;
    if (merge) {
      explanation = 'Verified merge: ' + row.parentLanes.length + ' Git parent paths converge here. The original parent histories remain intact.';
    } else if (!row.parentLanes.length) {
      explanation = 'Initial commit: this starts the displayed history.';
    } else if (/^revert\b/i.test(message)) {
      explanation = 'Commit message declares a revert: it is a new compensating commit and does not remove history.';
    } else {
      explanation = 'One Git parent: this continues history. Any ordinary line bend is graph layout/shared ancestry, not a merge.';
    }
    if (refNames.length) explanation += ' Ref points here: ' + refNames.join(', ') + '.';
    return '<div class="git-graph-row"><svg width="' + width + '" height="42" viewBox="0 0 ' + width + ' 42" aria-hidden="true">' + lines + links + '<circle cx="' + x(row.lane) + '" cy="21" r="' + (merge ? '7' : '5') + '" fill="' + (merge ? '#a78bfa' : laneColor(row.lane)) + '" stroke="var(--color-surface)" stroke-width="3" /></svg><div style="min-width:0;"><div style="font-size:13px;font-weight:600;color:var(--color-text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeGitText(message) + refsHere + '</div><div style="font-size:11px;color:var(--color-text-tertiary);margin-top:3px;">' + (merge ? 'Merge commit · ' : '') + escapeGitText(relTime(commit.date)) + '</div></div><div style="font-size:11px;line-height:1.4;color:var(--color-text-secondary);padding:6px 8px;border-radius:7px;background:var(--color-bg);border:1px solid var(--color-border);">' + escapeGitText(explanation) + '</div><code style="font-size:11px;color:var(--color-text-tertiary);">' + escapeGitText(sha.slice(0, 7)) + '</code></div>';
  }).join('');
}

function openMergeModal() {
  if (!_selectedRepoId || _branches.length < 2) return;
  var source = document.getElementById('merge-source-branch');
  var target = document.getElementById('merge-target-branch');
  var error = document.getElementById('merge-branch-error');
  var preview = document.getElementById('merge-preview');
  if (!source || !target) return;
  var options = _branches.map(function(branch) {
    var name = branch.name || branch;
    return '<option value="' + escapeGitText(name) + '">' + escapeGitText(name) + '</option>';
  }).join('');
  source.innerHTML = options;
  target.innerHTML = options;
  source.value = _selectedBranch || (_branches[0].name || _branches[0]);
  target.value = _defaultBranch;
  if (source.value === target.value) source.selectedIndex = 1;
  error.style.display = 'none';
  preview.style.display = 'none';
  var conflictGuide = document.getElementById('merge-conflict-guide');
  if (conflictGuide) conflictGuide.style.display = 'none';
  document.getElementById('merge-message').value = '';
  document.getElementById('modal-merge-branch').style.display = 'flex';
  updateMergePreview();
  source.onchange = updateMergePreview;
  target.onchange = updateMergePreview;
  if (window.lucide) lucide.createIcons();
}

function closeMergeModal() { document.getElementById('modal-merge-branch').style.display = 'none'; }

function shellQuote(value) {
  return "'" + String(value || '').replace(/'/g, "'\\\"'\\\"'") + "'";
}

function showMergeConflictGuide(source, target) {
  var guide = document.getElementById('merge-conflict-guide');
  if (!guide) return;
  var fetchCommand = 'git fetch origin --prune';
  var checkoutCommand = 'git checkout ' + shellQuote(target) + ' && git pull --ff-only origin ' + shellQuote(target);
  var mergeCommand = 'git merge ' + shellQuote('origin/' + source);
  guide.style.display = 'block';
  guide.innerHTML = '<div style="font-weight:800;color:#fbbf24;margin-bottom:6px;">Merge conflict — nothing was merged</div>' +
    '<div style="line-height:1.45;margin-bottom:9px;">GitHub rejected this merge before changing <strong>' + escapeGitText(target) + '</strong>. Resolve it in the project-scoped Git CLI, then retry here.</div>' +
    '<ol style="margin:0 0 10px 18px;padding:0;line-height:1.65;">' +
      '<li>Fetch remote updates: <code>' + escapeGitText(fetchCommand) + '</code></li>' +
      '<li>Switch to the target safely: <code>' + escapeGitText(checkoutCommand) + '</code></li>' +
      '<li>Start the same merge locally: <code>' + escapeGitText(mergeCommand) + '</code></li>' +
      '<li>Edit only files reported by <code>git status</code>, then run <code>git add &lt;file&gt;</code>, <code>git commit</code>, and <code>git push origin ' + escapeGitText(target) + '</code>.</li>' +
    '</ol>' +
    '<button type="button" id="btn-open-conflict-cli" class="btn-secondary" style="padding:7px 10px;border-radius:7px;font-size:12px;font-weight:700;">Open Git CLI with step 1</button>';
  var openButton = document.getElementById('btn-open-conflict-cli');
  if (openButton) openButton.onclick = function() { openConflictCli(fetchCommand); };
}

function openConflictCli(command) {
  var panel = document.getElementById('cli-panel');
  if (panel && panel.style.display === 'none') toggleCliPanel();
  var input = document.getElementById('cli-cmd-input');
  if (input) { input.value = command; input.focus(); }
}

async function updateMergePreview() {
  var source = document.getElementById('merge-source-branch')?.value;
  var target = document.getElementById('merge-target-branch')?.value;
  var preview = document.getElementById('merge-preview');
  if (!source || !target || source === target || !preview) return;
  preview.style.display = 'block';
  preview.textContent = 'Comparing branches…';
  try {
    var query = new URLSearchParams({ repositoryId: _selectedRepoId, base: target, head: source });
    var res = await api.get('/api/branches/compare?' + query);
    var diff = res?.diff || {};
    var ahead = diff.aheadBy || 0;
    preview.textContent = res?.ok ? (ahead + ' commit' + (ahead === 1 ? '' : 's') + ' to merge · ' + (diff.files?.length || 0) + ' changed file' + ((diff.files?.length || 0) === 1 ? '' : 's')) : (res?.error || 'Unable to compare branches.');
  } catch (_) { preview.textContent = 'Unable to compare branches right now.'; }
}

async function handleMergeBranchSubmit(event) {
  event.preventDefault();
  var source = document.getElementById('merge-source-branch').value;
  var target = document.getElementById('merge-target-branch').value;
  var message = document.getElementById('merge-message').value.trim();
  var error = document.getElementById('merge-branch-error');
  var button = document.getElementById('btn-submit-merge');
  if (!source || !target || source === target) { error.textContent = 'Choose two different branches.'; error.style.display = 'block'; return; }
  if (!window.confirm('Merge "' + source + '" into "' + target + '"? This creates a remote merge commit.')) return;
  button.disabled = true; button.textContent = 'Merging…'; error.style.display = 'none';
  var conflictGuide = document.getElementById('merge-conflict-guide');
  if (conflictGuide) conflictGuide.style.display = 'none';
  try {
    var res = await api.post('/api/branches/merge', { repositoryId: _selectedRepoId, baseBranch: target, headBranch: source, commitMessage: message || undefined });
    if (res?.mergeConflict) { showMergeConflictGuide(source, target); return; }
    if (!res?.ok) throw new Error(res?.error || 'Merge failed');
    closeMergeModal();
    _selectedBranch = target;
    await fetchBranches();
  } catch (err) { error.textContent = err.message || 'Merge failed'; error.style.display = 'block'; }
  finally { button.disabled = false; button.textContent = 'Merge branches'; }
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

    if (res.ok && res.result?.success) {
      preOut.textContent = res.result.output || 'Command executed successfully.';
    } else {
      preOut.textContent = 'Error: ' + (res.result?.output || res.error || 'Command failed');
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

// Only functions called by the server-rendered markup or SPA router are public.
// All page state and helpers stay private to prevent cross-page collisions.
Object.assign(window, {
  initBranchesPageRunner: initBranchesPageRunner,
  initBranchesPage: initBranchesPage,
  toggleRepoDropdown: toggleRepoDropdown,
  fetchBranches: fetchBranches,
  fetchCommits: fetchCommits,
  toggleCliPanel: toggleCliPanel,
  handleExecCli: handleExecCli,
  openMergeModal: openMergeModal,
  closeMergeModal: closeMergeModal,
  handleMergeBranchSubmit: handleMergeBranchSubmit,
  openCreateBranchModal: openCreateBranchModal,
  closeCreateBranchModal: closeCreateBranchModal,
  handleCreateBranchSubmit: handleCreateBranchSubmit
});
})();
