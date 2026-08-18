// Setup Wizard — Vanilla JS Logic
var _activeProject = null;
var _projects = [];
var _eventSource = null;
var _activeRunId = null;
var _foundationDone = false;
var _confirmModalCallback = null;
var _setupPollTimer = null;

window.initSetupWizardPage = initSetupWizardPage;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSetupWizardPage);
} else {
  initSetupWizardPage();
}

function initSetupWizardPage() {
  // Clear any previous polling timer
  if (_setupPollTimer) clearInterval(_setupPollTimer);
  loadProjectsAndSetup();
  _setupPollTimer = setInterval(checkActiveRun, 4000);
}

async function loadProjectsAndSetup() {
  try {
    var res = await api.get('/api/projects');
    if (res && res.projects) {
      _projects = res.projects;
      _activeProject = res.projects.find(function(p) { return p.isActive; }) || res.projects[0];
    }
    
    updateSetupUI();
    checkFoundationStatus();
    checkActiveRun();
  } catch (e) {
    console.error('Failed to load projects for setup wizard:', e);
  }
}

function updateSetupUI() {
  if (!_activeProject) return;

  var titleEl = document.getElementById('setup-project-title');
  if (titleEl) titleEl.textContent = _activeProject.name || 'Platform';

  var repoEl = document.getElementById('initial-repo-name');
  if (repoEl) repoEl.textContent = _activeProject.repoName || _activeProject.githubRepo || 'uat-benevolate-beta';

  var targetNameEl = document.getElementById('destroy-target-project-name');
  if (targetNameEl) targetNameEl.textContent = _activeProject.name;

  // Initial Infra status
  var initialDone = !!_activeProject.initialTfApplied;
  var initialBadge = document.getElementById('initial-status-badge');
  var btnRunInitial = document.getElementById('btn-run-initial');
  var btnDestroyInitial = document.getElementById('btn-destroy-initial');

  if (initialBadge) initialBadge.style.display = initialDone ? 'inline-flex' : 'none';
  if (btnRunInitial) {
    btnRunInitial.textContent = initialDone ? 'Re-apply Initial Infrastructure' : 'Create Initial Infrastructure';
  }
  if (btnDestroyInitial) {
    btnDestroyInitial.style.display = initialDone ? 'inline-flex' : 'none';
  }

  // Deployment Infra status
  var deployDone = !!_activeProject.deploymentTfApplied;
  var deployBadge = document.getElementById('deploy-status-badge');
  var btnRunDeploy = document.getElementById('btn-run-deploy');
  var btnDestroyDeploy = document.getElementById('btn-destroy-deploy');

  if (deployBadge) deployBadge.style.display = deployDone ? 'inline-flex' : 'none';
  if (btnRunDeploy) {
    btnRunDeploy.textContent = deployDone ? 'Re-apply Deployment Infrastructure' : 'Create Deployment Infrastructure';
  }
  if (btnDestroyDeploy) {
    btnDestroyDeploy.style.display = deployDone ? 'inline-flex' : 'none';
  }

  if (window.lucide) lucide.createIcons();
}

async function checkFoundationStatus() {
  var container = document.getElementById('foundation-status-container');
  var actionsRow = document.getElementById('foundation-actions-row');
  if (!container || !actionsRow) return;

  try {
    var res = await api.get('/api/terraform/foundation/status');
    if (res && res.ok) {
      _foundationDone = !!res.applied;
      
      if (_foundationDone) {
        container.innerHTML = '<div class="badge-status-green"><i data-lucide="check-circle-2" style="width:16px;height:16px;"></i> Shared Foundation Provisioned</div>';
        actionsRow.innerHTML =
          '<button onclick="handleRunFoundation()" class="btn-grad-blue">' +
            'Re-apply Shared Foundation' +
          '</button>' +
          '<button onclick="handlePromptDestroyFoundation()" class="btn-outline-danger">' +
            '<i data-lucide="trash-2" style="width:14px;height:14px;"></i> Destroy Shared Foundation' +
          '</button>';
      } else {
        container.innerHTML = '';
        actionsRow.innerHTML =
          '<button onclick="handleRunFoundation()" class="btn-grad-blue">' +
            'Apply Shared Foundation' +
          '</button>';
      }
      if (window.lucide) lucide.createIcons();
    }
  } catch (e) {
    container.innerHTML = '<div style="font-size:12px;color:var(--color-danger);">Failed to check Shared Foundation status.</div>';
  }
}

async function checkActiveRun() {
  try {
    var url = _activeProject ? '/api/terraform/active-run?projectId=' + _activeProject.id : '/api/terraform/active-run';
    var res = await api.get(url);
    if (res && res.ok && res.activeRun && res.activeRun.status === 'running') {
      var runId = res.activeRun.runId;
      var label = res.activeRun.moduleLabel || 'running';
      if (_activeRunId !== runId) {
        subscribeToLogs(runId, label);
      }
    }
  } catch (e) {}
}

// ── SSE Log Stream Subscription ───────────────────────────────────────────
function subscribeToLogs(runId, type) {
  if (_eventSource) {
    try { _eventSource.close(); } catch (e) {}
  }

  _activeRunId = runId;
  var termBox = document.getElementById('terminal-box');
  var termPre = document.getElementById('terminal-logs-pre');
  var termLabel = document.getElementById('terminal-type-label');
  var termBadge = document.getElementById('terminal-status-badge');

  if (termBox) termBox.style.display = 'block';
  if (termLabel) termLabel.textContent = type.toUpperCase();
  if (termBadge) {
    termBadge.innerHTML = '<i data-lucide="loader-2" class="animate-spin" style="width:12px;height:12px;"></i> RUNNING';
    termBadge.style.background = 'rgba(56,189,248,0.15)';
    termBadge.style.color = '#38bdf8';
  }
  if (termPre) {
    termPre.innerHTML = '<div style="color:#cbd5e1;">Connecting to live Terraform execution stream (runId: ' + runId + ')...</div>';
  }

  // Smooth scroll content area to terminal box
  var contentArea = document.querySelector('.content-area');
  if (contentArea && termBox) {
    setTimeout(function() {
      termBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 100);
  }

  _eventSource = new EventSource('/api/terraform/' + runId + '/logs');

  _eventSource.onmessage = function(event) {
    try {
      var data = JSON.parse(event.data);
      if (data.line && termPre) {
        var isErr = data.line.includes('ERROR') || data.line.includes('Error:');
        var isOk = data.line.includes('✔') || data.line.includes('Apply complete!') || data.line.includes('completed successfully');
        var color = isErr ? '#f87171' : (isOk ? '#4ade80' : '#cbd5e1');

        var div = document.createElement('div');
        div.style.color = color;
        div.textContent = data.line;
        termPre.appendChild(div);
        termPre.scrollTop = termPre.scrollHeight;
      }
    } catch (e) {}
  };

  _eventSource.addEventListener('done', function(event) {
    try {
      var result = JSON.parse(event.data);
      _activeRunId = null;

      if (termBadge) {
        if (result.status === 'done' || result.status === 'success') {
          termBadge.innerHTML = '✔ COMPLETED';
          termBadge.style.background = 'rgba(16,185,129,0.15)';
          termBadge.style.color = '#10b981';
        } else {
          termBadge.innerHTML = '✖ FAILED';
          termBadge.style.background = 'rgba(239,68,68,0.15)';
          termBadge.style.color = '#ef4444';
        }
      }

      if (termPre) {
        var doneDiv = document.createElement('div');
        doneDiv.style.color = '#4ade80';
        doneDiv.style.fontWeight = 'bold';
        doneDiv.textContent = '\n✔ Terraform execution completed with status: ' + result.status;
        termPre.appendChild(doneDiv);
        termPre.scrollTop = termPre.scrollHeight;
      }

      // Reload project state & foundation
      loadProjectsAndSetup();

      // Auto close terminal console after 5s
      setTimeout(function() {
        if (termBox) termBox.style.display = 'none';
      }, 5000);
    } catch (e) {}
    _eventSource.close();
    _eventSource = null;
  });

  _eventSource.addEventListener('error', function() {
    if (_eventSource) _eventSource.close();
    _eventSource = null;
  });
}

function closeTerminalConsole() {
  var termBox = document.getElementById('terminal-box');
  if (termBox) termBox.style.display = 'none';
  if (_eventSource) {
    try { _eventSource.close(); } catch (e) {}
    _eventSource = null;
  }
}

// ── Terraform Run Actions ──────────────────────────────────────────────────
async function handleRunFoundation() {
  clearErrorMsg();
  try {
    var res = await api.post('/api/terraform/foundation/run', { region: _activeProject ? _activeProject.region : 'us-east-1' });
    if (res.ok && res.runId) subscribeToLogs(res.runId, 'foundation');
    else showSetupError(res.error || 'Failed to start Shared Foundation');
  } catch (err) { showSetupError(err.message); }
}

function handlePromptDestroyFoundation() {
  openConfirmModal(
    'Destroy Shared Foundation Infrastructure?',
    '⚠️ CRITICAL WARNING: Destroying the Shared Foundation will delete the global VPC, Subnets, Security Groups, and Shared ALB. All projects relying on this platform foundation will be affected and lose load balancing & networking capabilities!',
    'Yes, Destroy Shared Foundation',
    async function() {
      clearErrorMsg();
      try {
        var res = await api.post('/api/terraform/foundation/destroy', { region: _activeProject ? _activeProject.region : 'us-east-1' });
        if (res.ok && res.runId) subscribeToLogs(res.runId, 'foundation');
        else showSetupError(res.error || 'Failed to destroy Shared Foundation');
      } catch (err) { showSetupError(err.message); }
    }
  );
}

async function handleRunInitial() {
  if (!_activeProject) return;
  clearErrorMsg();
  try {
    var res = await api.post('/api/terraform/initial/run', {
      projectId: _activeProject.id,
      githubOwner: _activeProject.githubOwner || '',
      githubRepo: _activeProject.githubRepo || '',
      githubBranch: _activeProject.githubBranch || 'main',
      sourceType: _activeProject.sourceType || 'github'
    });
    if (res.ok && res.runId) subscribeToLogs(res.runId, 'initial');
    else showSetupError(res.error || 'Failed to start Initial Infrastructure');
  } catch (err) { showSetupError(err.message); }
}

function handlePromptDestroyInitial() {
  if (!_activeProject) return;
  if (_activeProject.deploymentTfApplied) {
    showSetupError('Destroy Deployment Infrastructure first before destroying Initial Infrastructure.');
    return;
  }
  openConfirmModal(
    'Destroy Initial Infrastructure?',
    'This will destroy IAM roles, CodeBuild project, and S3 artifact bucket for project "' + _activeProject.name + '".',
    'Yes, Destroy Initial Infra',
    async function() {
      clearErrorMsg();
      try {
        var res = await api.post('/api/terraform/initial/destroy', { projectId: _activeProject.id });
        if (res.ok && res.runId) subscribeToLogs(res.runId, 'initial');
        else showSetupError(res.error || 'Failed to destroy Initial Infrastructure');
      } catch (err) { showSetupError(err.message); }
    }
  );
}

async function handleRunDeployment() {
  if (!_activeProject) return;
  clearErrorMsg();
  try {
    var res = await api.post('/api/terraform/deployment/run', { projectId: _activeProject.id });
    if (res.ok && res.runId) subscribeToLogs(res.runId, 'deployment');
    else showSetupError(res.error || 'Failed to start Deployment Infrastructure');
  } catch (err) { showSetupError(err.message); }
}

function handlePromptDestroyDeployment() {
  if (!_activeProject) return;
  openConfirmModal(
    'Destroy Deployment Infrastructure?',
    'This will destroy the ECS clusters, ECR repository, target groups, CodePipeline, and Fargate services for project "' + _activeProject.name + '".',
    'Yes, Destroy Deployment Infra',
    async function() {
      clearErrorMsg();
      try {
        var res = await api.post('/api/terraform/deployment/destroy', { projectId: _activeProject.id });
        if (res.ok && res.runId) subscribeToLogs(res.runId, 'deployment');
        else showSetupError(res.error || 'Failed to destroy Deployment Infrastructure');
      } catch (err) { showSetupError(err.message); }
    }
  );
}

// ── Danger Zone: Destroy Project & Repositories ───────────────────────────
function handleOpenDestroyProjectModal() {
  if (!_activeProject) return;

  var hasInitial = !!_activeProject.initialTfApplied;
  var hasDeploy = !!_activeProject.deploymentTfApplied;

  if (hasInitial || hasDeploy) {
    var activeSteps = [];
    if (hasInitial) activeSteps.push('Initial Infrastructure (Step 1)');
    if (hasDeploy) activeSteps.push('Deployment Infrastructure (Step 2)');

    openConfirmModal(
      'Active Infrastructure Detected — Cannot Delete Project',
      'Project "' + _activeProject.name + '" currently has running AWS cloud infrastructure:\n\n• ' + activeSteps.join('\n• ') + '\n\nTo prevent orphaned cloud resources and unexpected AWS charges, please destroy both Initial Infrastructure (Step 1) and Deployment Infrastructure (Step 2) using the buttons above before deleting this project.',
      'Understood — Destroy Infrastructure First',
      function() { closeConfirmModal(); },
      true
    );
    return;
  }

  document.getElementById('destroy-confirm-input').value = '';
  document.getElementById('chk-delete-provider-repos').checked = false;
  document.getElementById('destroy-project-error').style.display = 'none';
  document.getElementById('btn-confirm-destroy-project').disabled = true;
  document.getElementById('btn-confirm-destroy-project').style.opacity = '0.4';
  document.getElementById('btn-confirm-destroy-project').style.cursor = 'not-allowed';

  document.getElementById('destroy-project-modal').style.display = 'flex';
}

function validateDestroyConfirmInput() {
  var inputVal = document.getElementById('destroy-confirm-input').value.trim().toLowerCase();
  var targetName = (_activeProject ? _activeProject.name : '').trim().toLowerCase();
  var btn = document.getElementById('btn-confirm-destroy-project');

  var isMatch = inputVal === targetName && targetName.length > 0;
  btn.disabled = !isMatch;
  btn.style.opacity = isMatch ? '1' : '0.4';
  btn.style.cursor = isMatch ? 'pointer' : 'not-allowed';
}

function closeDestroyProjectModal() {
  document.getElementById('destroy-project-modal').style.display = 'none';
}

async function executeDestroyProject() {
  if (!_activeProject) return;
  var btn = document.getElementById('btn-confirm-destroy-project');
  btn.disabled = true;
  btn.textContent = 'Destroying...';

  var deleteRepos = document.getElementById('chk-delete-provider-repos').checked;
  var errEl = document.getElementById('destroy-project-error');
  errEl.style.display = 'none';

  try {
    var res = await api.delete('/api/projects/' + _activeProject.id, { deleteRepos: deleteRepos });
    if (res.ok) {
      closeDestroyProjectModal();
      window.location.href = '/dashboard';
    } else {
      errEl.textContent = res.error || 'Failed to destroy project.';
      errEl.style.display = 'block';
    }
  } catch (err) {
    errEl.textContent = err.message || 'Server error';
    errEl.style.display = 'block';
  }
  btn.disabled = false;
  btn.textContent = 'Completely Destroy Project';
}

// ── Custom Modal Confirmation Helpers ─────────────────────────────────────
function openConfirmModal(title, description, actionLabel, onConfirm, isWarningOnly) {
  var modal = document.getElementById('custom-confirm-modal');
  var titleText = document.getElementById('modal-title-text');
  var descEl = document.getElementById('modal-desc');
  var btnAction = document.getElementById('modal-btn-action');
  var btnCancel = document.getElementById('modal-btn-cancel');

  if (titleText) titleText.textContent = title;
  if (descEl) descEl.textContent = description;
  if (btnAction) btnAction.textContent = actionLabel;
  if (btnCancel) btnCancel.style.display = isWarningOnly ? 'none' : 'inline-block';

  _confirmModalCallback = onConfirm;
  if (modal) modal.style.display = 'flex';
  if (window.lucide) lucide.createIcons();
}

function closeConfirmModal() {
  var modal = document.getElementById('custom-confirm-modal');
  if (modal) modal.style.display = 'none';
  _confirmModalCallback = null;
}

function executeConfirmModalAction() {
  var callback = _confirmModalCallback;
  closeConfirmModal();
  if (callback) callback();
}

// Helper: Error Box
function showSetupError(text) {
  var el = document.getElementById('setup-error-msg');
  if (el) {
    el.textContent = text;
    el.style.display = 'block';
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function clearErrorMsg() {
  var el = document.getElementById('setup-error-msg');
  if (el) el.style.display = 'none';
}
