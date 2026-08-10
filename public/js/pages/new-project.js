// New Project Wizard — Enterprise Vanilla JS Logic
var _currentStep = 1;
var _projectName = '';
var _selectedRegion = 'us-east-1';
var _projectDesc = '';
var _repoTab = 'connect'; // 'connect' | 'create'
var _selectedProvider = 'codecommit'; // 'codecommit' | 'github'
var _selectedOrg = ''; // '' = Personal account, or org.login
var _githubOrgs = [];
var _existingRepos = [];
var _selectedRepo = '';
var _defaultBranch = 'main';
var _refreshSpinTimer = null;
var _githubRequiresOAuth = false;

function initNewProjectPage() {
  fetchGitHubOrgs();
  fetchExistingRepos();
}

window.initNewProjectPage = initNewProjectPage;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initNewProjectPage);
} else {
  initNewProjectPage();
}

function goToStep(step) {
  _currentStep = step;
  [1, 2, 3].forEach(function(s) {
    var card = document.getElementById('new-project-step-' + s);
    var circle = document.getElementById('step-indicator-' + s);
    var title = document.getElementById('step-label-' + s);

    if (card) card.style.display = s === step ? 'block' : 'none';

    if (circle && title) {
      if (s < step) {
        circle.className = 'wizard-step-circle completed';
        circle.innerHTML = '✓';
        title.className = 'wizard-step-title completed';
      } else if (s === step) {
        circle.className = 'wizard-step-circle active';
        circle.innerHTML = s;
        title.className = 'wizard-step-title active';
      } else {
        circle.className = 'wizard-step-circle';
        circle.innerHTML = s;
        title.className = 'wizard-step-title';
      }
    }
  });

  if (step === 2) {
    fetchExistingRepos();
  }
  if (step === 3) {
    populateReviewDetails();
  }

  if (window.lucide) lucide.createIcons();
}

function goToStep2(e) {
  if (e) e.preventDefault();
  var nameInput = document.getElementById('project-name-input');
  var descInput = document.getElementById('project-desc-input');

  if (!nameInput || !nameInput.value.trim()) return;
  _projectName = nameInput.value.trim();
  _projectDesc = descInput ? descInput.value.trim() : '';

  goToStep(2);
}

function selectRegion(r) {
  _selectedRegion = r;
  ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1'].forEach(function(reg) {
    var btn = document.getElementById('region-' + reg);
    if (btn) btn.className = reg === r ? 'region-btn active' : 'region-btn';
  });
  if (_currentStep === 2) fetchExistingRepos();
}

// ── Provider Dropdown Logic ────────────────────────────────────────────────
function toggleProviderDropdown() {
  var menu = document.getElementById('provider-dropdown-menu');
  var chev = document.getElementById('provider-chevron');
  var orgMenu = document.getElementById('org-dropdown-menu');
  if (orgMenu) orgMenu.style.display = 'none';

  if (menu) {
    var isHidden = menu.style.display === 'none' || !menu.style.display;
    menu.style.display = isHidden ? 'flex' : 'none';
    if (chev) chev.style.transform = isHidden ? 'rotate(180deg)' : 'none';
  }
}

function selectProvider(p) {
  if (p !== 'codecommit' && p !== 'github') return;
  _selectedProvider = p;
  if (p === 'github') _githubRequiresOAuth = true;

  var label = document.getElementById('provider-selected-label');
  var pText = p === 'codecommit' ? 'AWS CodeCommit' : 'GitHub';
  if (label) label.textContent = pText;

  ['codecommit', 'github'].forEach(function(key) {
    var opt = document.getElementById('opt-provider-' + key);
    if (opt) opt.className = key === p ? 'dropdown-item active' : 'dropdown-item';
  });

  var menu = document.getElementById('provider-dropdown-menu');
  var chev = document.getElementById('provider-chevron');
  if (menu) menu.style.display = 'none';
  if (chev) chev.style.transform = 'none';

  // Clear step-2 message when switching provider
  var msgEl = document.getElementById('step-2-msg');
  if (msgEl) msgEl.style.display = 'none';

  // Toggle Owner/Workspace container
  var orgContainer = document.getElementById('owner-workspace-container');
  if (orgContainer) orgContainer.style.display = p === 'github' ? 'block' : 'none';

  if (p === 'github') fetchGitHubOrgs();
  fetchExistingRepos(true);
}

// ── Owner / Workspace Dropdown Logic ─────────────────────────────────────────
function toggleOrgDropdown() {
  var menu = document.getElementById('org-dropdown-menu');
  var chev = document.getElementById('org-chevron');
  var pMenu = document.getElementById('provider-dropdown-menu');
  if (pMenu) pMenu.style.display = 'none';

  if (menu) {
    var isHidden = menu.style.display === 'none' || !menu.style.display;
    menu.style.display = isHidden ? 'flex' : 'none';
    if (chev) chev.style.transform = isHidden ? 'rotate(180deg)' : 'none';
  }
}

function selectOrg(orgLogin) {
  _selectedOrg = orgLogin;
  var label = document.getElementById('org-selected-label');
  if (label) {
    label.innerHTML = orgLogin ?
      '<i data-lucide="building-2" style="width:16px;height:16px;color:#4f46e5;"></i> Organization: ' + orgLogin :
      '<i data-lucide="user" style="width:16px;height:16px;color:#4f46e5;"></i> Personal Account (Default)';
  }

  var optPersonal = document.getElementById('opt-org-personal');
  if (optPersonal) optPersonal.className = orgLogin === '' ? 'dropdown-item active' : 'dropdown-item';

  _githubOrgs.forEach(function(o) {
    var opt = document.getElementById('opt-org-' + o.login);
    if (opt) opt.className = o.login === orgLogin ? 'dropdown-item active' : 'dropdown-item';
  });

  var menu = document.getElementById('org-dropdown-menu');
  var chev = document.getElementById('org-chevron');
  if (menu) menu.style.display = 'none';
  if (chev) chev.style.transform = 'none';

  if (window.lucide) lucide.createIcons();
  fetchExistingRepos(true);
}

async function fetchGitHubOrgs() {
  try {
    var res = await api.get('/api/github/orgs');
    _githubOrgs = (res && res.ok && res.orgs) ? res.orgs : [];
  } catch (e) {
    _githubOrgs = [];
  }

  var listContainer = document.getElementById('org-list-items');
  if (listContainer) {
    listContainer.innerHTML = '';
    _githubOrgs.forEach(function(o) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'opt-org-' + o.login;
      btn.className = _selectedOrg === o.login ? 'dropdown-item active' : 'dropdown-item';
      btn.style.display = 'flex';
      btn.style.alignItems = 'center';
      btn.style.gap = '8px';
      btn.onclick = function() { selectOrg(o.login); };
      btn.innerHTML = '<i data-lucide="building-2" style="width:15px;height:15px;"></i> Organization: ' + o.login;
      listContainer.appendChild(btn);
    });
  }
  if (window.lucide) lucide.createIcons();
}

// ── Tab Switcher ─────────────────────────────────────────────────────────────
function setRepoTab(tab) {
  _repoTab = tab;
  ['connect', 'create'].forEach(function(t) {
    var btn = document.getElementById('repo-tab-' + t);
    var content = document.getElementById('repo-content-' + t);
    if (btn) btn.className = t === tab ? 'repo-subtab-btn active' : 'repo-subtab-btn';
    if (content) content.style.display = t === tab ? 'block' : 'none';
  });

  var msgEl = document.getElementById('step-2-msg');
  if (msgEl) msgEl.style.display = 'none';
}

// ── Refresh Button Icon Spin Controller ──────────────────────────────────────
function triggerRefreshIconSpin() {
  var wrapper = document.getElementById('btn-refresh-repos-icon-wrapper');
  if (wrapper) {
    wrapper.classList.add('animate-spin');
  }

  if (_refreshSpinTimer) clearTimeout(_refreshSpinTimer);

  _refreshSpinTimer = setTimeout(function() {
    var activeWrapper = document.getElementById('btn-refresh-repos-icon-wrapper');
    if (activeWrapper) activeWrapper.classList.remove('animate-spin');
    _refreshSpinTimer = null;
  }, 1000);
}

// ── Repository Fetching & State Feedbacks ────────────────────────────────────
async function fetchExistingRepos(isTriggered) {
  var stateFetching = document.getElementById('repos-state-fetching');
  var stateOAuth = document.getElementById('repos-state-oauth');
  var stateAvailable = document.getElementById('repos-state-available');
  var stateEmpty = document.getElementById('repos-state-empty');
  var fetchingText = document.getElementById('repos-fetching-text');
  var emptyText = document.getElementById('empty-feedback-text');

  triggerRefreshIconSpin();

  if (stateFetching) stateFetching.style.display = 'flex';
  if (stateOAuth) stateOAuth.style.display = 'none';
  if (stateAvailable) stateAvailable.style.display = 'none';
  if (stateEmpty) stateEmpty.style.display = 'none';

  if (fetchingText) {
    fetchingText.textContent = _selectedProvider === 'codecommit' ?
      ('Fetching CodeCommit repositories in ' + _selectedRegion + '...') :
      ('Fetching GitHub repositories' + (_selectedOrg ? (' for ' + _selectedOrg) : '') + '...');
  }

  var requiresOAuth = false;
  var oauthMsg = '';

  try {
    var url = _selectedProvider === 'github' ?
      ('/api/github/list-repos' + (_selectedOrg ? ('?org=' + encodeURIComponent(_selectedOrg)) : '')) :
      ('/api/repos?region=' + _selectedRegion);

    var res = await api.get(url);

    if (res && res.requiresOAuth) {
      requiresOAuth = true;
      oauthMsg = res.message || 'Please connect your GitHub account via OAuth to list and select your repositories.';
    } else if (res && res.ok && Array.isArray(res.repos)) {
      _existingRepos = res.repos;
    } else if (_selectedProvider === 'github' && (!res || !res.ok)) {
      requiresOAuth = true;
    } else {
      _existingRepos = [];
    }
  } catch (e) {
    _existingRepos = [];
    if (_selectedProvider === 'github') requiresOAuth = true;
  }

  _githubRequiresOAuth = requiresOAuth;

  // Artificial delay so user sees smooth fetching state for exactly 300ms
  await new Promise(function(resolve) { setTimeout(resolve, 300); });

  if (stateFetching) stateFetching.style.display = 'none';

  if (requiresOAuth && _selectedProvider === 'github') {
    if (stateOAuth) {
      var txt = document.getElementById('oauth-feedback-text');
      if (txt && oauthMsg) txt.textContent = oauthMsg;
      stateOAuth.style.display = 'block';
    }
  } else if (_existingRepos.length > 0) {
    var select = document.getElementById('select-existing-repo');
    if (select) {
      select.innerHTML = '';
      _existingRepos.forEach(function(r) {
        var rName = typeof r === 'string' ? r : (r.full_name || r.name || r.repositoryName);
        var opt = document.createElement('option');
        opt.value = rName;
        opt.textContent = rName;
        select.appendChild(opt);
      });
      _selectedRepo = select.value;
    }
    if (stateAvailable) stateAvailable.style.display = 'block';
  } else {
    if (emptyText) {
      emptyText.textContent = 'No repositories found in ' + (_selectedProvider === 'codecommit' ? _selectedRegion : (_selectedOrg || 'Personal Account')) + '.';
    }
    if (stateEmpty) stateEmpty.style.display = 'block';
  }

  if (window.lucide) lucide.createIcons();
}

async function handleCreateNewRepo(e) {
  if (e) e.preventDefault();
  var msgEl = document.getElementById('step-2-msg');
  if (msgEl) msgEl.style.display = 'none';

  if (_selectedProvider === 'github' && _githubRequiresOAuth) {
    if (msgEl) {
      msgEl.className = 'msg-box error';
      msgEl.style.background = 'rgba(239,68,68,0.1)';
      msgEl.style.color = '#ef4444';
      msgEl.style.border = '1px solid rgba(239,68,68,0.2)';
      msgEl.textContent = 'GitHub account is not connected via OAuth. Please connect GitHub in Settings → Integrations first.';
      msgEl.style.display = 'block';
    }
    return;
  }

  var nameInput = document.getElementById('new-repo-name-input');
  var descInput = document.getElementById('new-repo-desc-input');
  var newName = nameInput ? nameInput.value.trim() : '';
  var newDesc = descInput ? descInput.value.trim() : '';

  if (!newName) {
    if (msgEl) {
      msgEl.className = 'msg-box error';
      msgEl.style.background = 'rgba(239,68,68,0.1)';
      msgEl.style.color = '#ef4444';
      msgEl.style.border = '1px solid rgba(239,68,68,0.2)';
      msgEl.textContent = 'Repository name is required for creating a new repository.';
      msgEl.style.display = 'block';
    }
    return;
  }

  var btnSubmit = document.getElementById('btn-create-repo-submit');
  if (btnSubmit) {
    btnSubmit.disabled = true;
    btnSubmit.innerHTML = '<i data-lucide="loader-2" class="animate-spin" style="width:16px;height:16px;"></i> Creating Repo...';
    if (window.lucide) lucide.createIcons();
  }

  try {
    if (_selectedProvider === 'github') {
      var res = await api.post('/api/github/create-repo', {
        repoName: newName,
        org: _selectedOrg || null,
        description: newDesc
      });

      if (res && res.ok && res.repo) {
        _selectedRepo = res.repo.full_name || (res.repo.owner ? (res.repo.owner.login + '/' + res.repo.name) : newName);
        _defaultBranch = res.repo.default_branch || 'main';
        goToStep(3);
      } else {
        if (msgEl) {
          msgEl.className = 'msg-box error';
          msgEl.style.background = 'rgba(239,68,68,0.1)';
          msgEl.style.color = '#ef4444';
          msgEl.style.border = '1px solid rgba(239,68,68,0.2)';
          msgEl.textContent = (res && res.error) || 'Failed to create GitHub repository.';
          msgEl.style.display = 'block';
        }
      }
    } else {
      var res = await api.post('/api/repos/create', {
        repositoryName: newName,
        description: newDesc,
        region: _selectedRegion
      });

      if (res && res.ok) {
        _selectedRepo = newName;
        _defaultBranch = 'main';
        goToStep(3);
      } else {
        if (msgEl) {
          msgEl.className = 'msg-box error';
          msgEl.style.background = 'rgba(239,68,68,0.1)';
          msgEl.style.color = '#ef4444';
          msgEl.style.border = '1px solid rgba(239,68,68,0.2)';
          msgEl.textContent = (res && res.error) || 'Failed to create repository.';
          msgEl.style.display = 'block';
        }
      }
    }
  } catch (err) {
    if (msgEl) {
      msgEl.className = 'msg-box error';
      msgEl.style.background = 'rgba(239,68,68,0.1)';
      msgEl.style.color = '#ef4444';
      msgEl.style.border = '1px solid rgba(239,68,68,0.2)';
      msgEl.textContent = err.message || 'Error creating repository';
      msgEl.style.display = 'block';
    }
  }

  if (btnSubmit) {
    btnSubmit.disabled = false;
    btnSubmit.textContent = 'Create & Provision Repo';
  }
}

async function handleStep2Next() {
  var msgEl = document.getElementById('step-2-msg');
  if (msgEl) msgEl.style.display = 'none';

  if (_selectedProvider === 'github' && _githubRequiresOAuth) {
    if (msgEl) {
      msgEl.className = 'msg-box error';
      msgEl.style.background = 'rgba(239,68,68,0.1)';
      msgEl.style.color = '#ef4444';
      msgEl.style.border = '1px solid rgba(239,68,68,0.2)';
      msgEl.textContent = 'GitHub account is not connected via OAuth. Please connect GitHub in Settings → Integrations first.';
      msgEl.style.display = 'block';
    }
    return;
  }

  if (_repoTab === 'connect') {
    var select = document.getElementById('select-existing-repo');
    _selectedRepo = select ? select.value : '';
    if (!_selectedRepo) {
      if (msgEl) {
        msgEl.className = 'msg-box error';
        msgEl.style.background = 'rgba(239,68,68,0.1)';
        msgEl.style.color = '#ef4444';
        msgEl.style.border = '1px solid rgba(239,68,68,0.2)';
        msgEl.textContent = 'Please select an existing repository from the list or create a new repository before proceeding.';
        msgEl.style.display = 'block';
      }
      return;
    }
    goToStep(3);
  } else {
    handleCreateNewRepo();
  }
}

function populateReviewDetails() {
  document.getElementById('review-name').textContent = _projectName || '--';
  document.getElementById('review-region').textContent = _selectedRegion;
  document.getElementById('review-provider').textContent = _selectedProvider.toUpperCase();
  document.getElementById('review-repo').textContent = _selectedRepo || '--';
}

async function handleFinalSubmit() {
  var errEl = document.getElementById('new-project-error');
  var btnCreate = document.getElementById('btn-create-project');
  var btnBack = document.getElementById('btn-back-step-3');

  if (errEl) errEl.style.display = 'none';
  if (btnCreate) {
    btnCreate.disabled = true;
    btnCreate.innerHTML = '<i data-lucide="loader-2" class="animate-spin" style="width:16px;height:16px;"></i> Creating Project...';
    if (window.lucide) lucide.createIcons();
  }
  if (btnBack) btnBack.disabled = true;

  try {
    var payload = {
      name: _projectName,
      region: _selectedRegion,
      sourceType: _selectedProvider,
      repoName: _selectedRepo,
      githubOwner: _selectedProvider === 'github' ? (_selectedOrg || (_selectedRepo.includes('/') ? _selectedRepo.split('/')[0] : null)) : null,
      githubRepo: _selectedProvider === 'github' ? (_selectedRepo.includes('/') ? _selectedRepo.split('/')[1] : _selectedRepo) : null,
      data: {
        description: _projectDesc,
        defaultBranch: _defaultBranch,
        environments: ['dev', 'uat', 'prod'],
        created_at: new Date().toISOString()
      }
    };

    var res = await api.post('/api/projects', payload);
    if (res && res.ok && res.project) {
      window.location.href = '/setup/repo';
    } else {
      if (errEl) {
        errEl.textContent = (res && res.error) || 'Failed to create project';
        errEl.style.display = 'block';
      }
    }
  } catch (err) {
    if (errEl) {
      errEl.textContent = err.message || 'Server error creating project';
      errEl.style.display = 'block';
    }
  }

  if (btnCreate) {
    btnCreate.disabled = false;
    btnCreate.textContent = 'Create Project';
  }
  if (btnBack) btnBack.disabled = false;
}
