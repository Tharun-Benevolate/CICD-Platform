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
    loadSecrets();
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

// ─── SECRETS MANAGEMENT ─────────────────────────────────────────────

var _secretKeys = [];
var _secretNameLocked = false;

async function loadSecrets() {
  if (!_activeProject) return;
  var container = document.getElementById('secrets-table-container');
  if (!container) return;

  try {
    var nameInput = document.getElementById('secret-name-input');
    var nameHint = document.getElementById('secret-name-hint');
    var nameRes = await api.get('/api/secrets/' + _activeProject.id + '/name');
    if (nameRes && nameRes.ok && nameInput) {
      nameInput.value = nameRes.secretName || '';
      _secretNameLocked = !!nameRes.locked;
      nameInput.readOnly = _secretNameLocked;
      nameInput.style.opacity = _secretNameLocked ? '0.7' : '1';
      nameInput.style.cursor = _secretNameLocked ? 'not-allowed' : 'text';
      if (nameHint) {
        nameHint.textContent = _secretNameLocked
          ? 'This secret already exists in AWS Secrets Manager under this name — it\'s locked in for this project.'
          : 'Choose the exact name to create in AWS Secrets Manager. This is set once — after the first save it can\'t be changed here (delete the secret in AWS first if you need to reuse a different name).';
      }
    }

    container.innerHTML = '<div style="font-size:12px;color:var(--color-text-tertiary);"><i data-lucide="loader-2" class="animate-spin" style="width:14px;height:14px;"></i> Loading secrets...</div>';
    if (window.lucide) lucide.createIcons();
    
    var res = await api.get('/api/secrets/' + _activeProject.id);
    if (res && res.ok) {
      _secretKeys = res.keys || [];
      renderSecretsTable();
    }
  } catch (e) {
    container.innerHTML = '<div style="font-size:12px;color:var(--color-danger);">Failed to load secrets.</div>';
  }
}

function renderSecretsTable() {
  var container = document.getElementById('secrets-table-container');
  if (!container) return;

  if (_secretKeys.length === 0) {
    container.innerHTML = '<div style="font-size:13px;color:var(--color-text-tertiary);padding:16px;border:1px dashed var(--color-border);border-radius:8px;text-align:center;">No secrets configured yet.</div>';
    return;
  }

  var html = '<table style="width:100%;border-collapse:collapse;font-size:13px;">' +
             '<thead><tr style="border-bottom:1px solid var(--color-border);text-align:left;color:var(--color-text-tertiary);">' +
             '<th style="padding:8px;font-weight:600;">Key (e.g. DB_HOST)</th>' +
             '<th style="padding:8px;font-weight:600;">Value</th>' +
             '<th style="padding:8px;width:40px;"></th>' +
             '</tr></thead><tbody>';
             
  _secretKeys.forEach(function(key, index) {
    html += '<tr style="border-bottom:1px solid var(--color-border);">' +
            '<td style="padding:8px;"><input type="text" class="secret-key-input" value="' + key + '" readonly style="width:100%;padding:6px 10px;border-radius:6px;border:1px solid var(--color-border);background:var(--color-bg-secondary);color:var(--color-text-secondary);outline:none;font-family:monospace;font-size:12px;" /></td>' +
            '<td style="padding:8px;"><input type="text" value="••••••••" readonly style="width:100%;padding:6px 10px;border-radius:6px;border:1px solid var(--color-border);background:var(--color-bg-secondary);color:var(--color-text-tertiary);outline:none;font-family:monospace;font-size:12px;" /></td>' +
            '<td style="padding:8px;text-align:center;"><button type="button" onclick="handleDeleteSecret(\'' + key + '\')" style="color:var(--color-danger);background:transparent;border:none;cursor:pointer;padding:4px;"><i data-lucide="trash-2" style="width:14px;height:14px;"></i></button></td>' +
            '</tr>';
  });
  
  html += '</tbody></table>';
  container.innerHTML = html;
  if (window.lucide) lucide.createIcons();
}

function handleAddSecretRow() {
  var container = document.getElementById('secrets-table-container');
  if (!container) return;
  
  var table = container.querySelector('table');
  
  if (!table) {
    container.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:13px;">' +
             '<thead><tr style="border-bottom:1px solid var(--color-border);text-align:left;color:var(--color-text-tertiary);">' +
             '<th style="padding:8px;font-weight:600;">Key (e.g. DB_HOST)</th>' +
             '<th style="padding:8px;font-weight:600;">Value</th>' +
             '<th style="padding:8px;width:40px;"></th>' +
             '</tr></thead><tbody></tbody></table>';
    table = container.querySelector('table');
  }

  var tbody = table.querySelector('tbody');
  var tr = document.createElement('tr');
  tr.style.borderBottom = '1px solid var(--color-border)';
  tr.innerHTML = 
    '<td style="padding:8px;"><input type="text" class="new-secret-key" placeholder="DB_HOST" autocomplete="off" data-lpignore="true" style="width:100%;padding:6px 10px;border-radius:6px;border:1px solid var(--color-border);background:var(--color-bg);color:var(--color-text-primary);outline:none;font-family:monospace;font-size:12px;" /></td>' +
    '<td style="padding:8px;"><input type="password" class="new-secret-val" placeholder="Value (write-only)" autocomplete="new-password" data-lpignore="true" style="width:100%;padding:6px 10px;border-radius:6px;border:1px solid var(--color-border);background:var(--color-bg);color:var(--color-text-primary);outline:none;font-family:monospace;font-size:12px;" /></td>' +
    '<td style="padding:8px;text-align:center;"><button type="button" onclick="this.closest(\'tr\').remove(); if(document.querySelectorAll(\'.new-secret-key\').length===0 && _secretKeys.length===0) renderSecretsTable();" style="color:var(--color-danger);background:transparent;border:none;cursor:pointer;padding:4px;"><i data-lucide="x" style="width:14px;height:14px;"></i></button></td>';
  
  tbody.appendChild(tr);
  if (window.lucide) lucide.createIcons();
  
  var keyInput = tr.querySelector('.new-secret-key');
  if (keyInput) keyInput.focus();
}

async function handleSaveSecrets() {
  if (!_activeProject) return;
  var btn = document.getElementById('btn-save-secrets');
  var msg = document.getElementById('secrets-save-msg');
  
  var newKeyInputs = document.querySelectorAll('.new-secret-key');
  var newValInputs = document.querySelectorAll('.new-secret-val');
  
  var secretsObj = {};
  var hasNew = false;
  
  for (var i = 0; i < newKeyInputs.length; i++) {
    var key = newKeyInputs[i].value.trim();
    var val = newValInputs[i].value;
    if (key && val) {
      secretsObj[key] = val;
      hasNew = true;
    }
  }
  
  if (!hasNew) {
    if (msg) {
      msg.textContent = 'No new secrets to save.';
      msg.style.color = 'var(--color-text-tertiary)';
      msg.style.display = 'block';
      setTimeout(function() { msg.style.display = 'none'; }, 3000);
    }
    return;
  }

  var nameInput = document.getElementById('secret-name-input');
  var typedName = nameInput ? nameInput.value.trim() : '';
  if (!_secretNameLocked && !typedName) {
    if (msg) {
      msg.textContent = 'Enter a secret name before saving.';
      msg.style.color = 'var(--color-danger)';
      msg.style.display = 'block';
    }
    if (nameInput) nameInput.focus();
    return;
  }

  try {
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-2" class="animate-spin" style="width:14px;height:14px;"></i> Saving...';
    if (window.lucide) lucide.createIcons();

    var payload = { secrets: secretsObj };
    if (!_secretNameLocked) payload.secretName = typedName;

    var res = await api.post('/api/secrets/' + _activeProject.id, payload);
    if (res && res.ok) {
      _secretKeys = res.keys;
      renderSecretsTable();
      if (res.secretName && nameInput) {
        nameInput.value = res.secretName;
        nameInput.readOnly = true;
        nameInput.style.opacity = '0.7';
        nameInput.style.cursor = 'not-allowed';
        _secretNameLocked = true;
        var nameHint = document.getElementById('secret-name-hint');
        if (nameHint) nameHint.textContent = 'This secret already exists in AWS Secrets Manager under this name — it\'s locked in for this project.';
      }
      if (msg) {
        msg.innerHTML = '<span style="color:var(--color-success);"><i data-lucide="check-circle-2" style="width:14px;height:14px;display:inline-block;vertical-align:text-bottom;"></i> Secrets saved successfully. Please Re-apply Deployment Infra below to update running containers.</span>';
        msg.style.display = 'block';
        if (window.lucide) lucide.createIcons();
        setTimeout(function() { msg.style.display = 'none'; }, 8000);
      }
    } else {
      throw new Error(res.error || 'Failed to save secrets');
    }
  } catch (e) {
    if (msg) {
      msg.textContent = 'Error: ' + e.message;
      msg.style.color = 'var(--color-danger)';
      msg.style.display = 'block';
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save to AWS Secrets Manager';
  }
}

async function handleDeleteSecret(key) {
  if (!confirm('Are you sure you want to delete the secret key "' + key + '"? This will remove it from AWS Secrets Manager immediately.')) return;
  
  try {
    var res = await api.delete('/api/secrets/' + _activeProject.id + '/' + key);
    if (res && res.ok) {
      _secretKeys = res.keys;
      renderSecretsTable();
      var msg = document.getElementById('secrets-save-msg');
      if (msg) {
        msg.innerHTML = '<span style="color:var(--color-warning);"><i data-lucide="info" style="width:14px;height:14px;display:inline-block;vertical-align:text-bottom;"></i> Secret deleted. Please Re-apply Deployment Infra to update running containers.</span>';
        msg.style.display = 'block';
        if (window.lucide) lucide.createIcons();
        setTimeout(function() { msg.style.display = 'none'; }, 8000);
      }
    } else {
      alert('Failed to delete secret: ' + (res.error || 'Unknown error'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

// ─── SECRETS APPLY ACTIONS ───────────────────────────────────────────────────

// Helper: open the inline status panel with a given label and state
function setSecretsActionStatus(label, state /* 'running'|'success'|'failed' */, logLines) {
  var panel  = document.getElementById('secrets-action-status');
  var badge  = document.getElementById('secrets-action-badge');
  var lbl    = document.getElementById('secrets-action-label');
  var logEl  = document.getElementById('secrets-action-log');

  if (!panel) return;
  panel.style.display = 'block';
  if (lbl) lbl.textContent = label;

  var stateMap = {
    running: { html: '<i data-lucide="loader-2" class="animate-spin" style="width:10px;height:10px;"></i> RUNNING',  bg: 'rgba(56,189,248,0.15)', color: '#38bdf8' },
    success: { html: '✔ COMPLETED', bg: 'rgba(16,185,129,0.15)', color: '#10b981' },
    failed:  { html: '✖ FAILED',    bg: 'rgba(239,68,68,0.15)',  color: '#ef4444' },
  };
  var s = stateMap[state] || stateMap.running;
  if (badge) {
    badge.innerHTML = s.html;
    badge.style.background = s.bg;
    badge.style.color = s.color;
    if (window.lucide) lucide.createIcons();
  }

  if (logEl && logLines && logLines.length) {
    logLines.forEach(function(line) {
      var div = document.createElement('div');
      div.style.color = (line.includes('ERROR') || line.includes('error') || line.includes('failed')) ? '#f87171'
                       : (line.includes('✔') || line.includes('success') || line.includes('completed')) ? '#4ade80'
                       : '#cbd5e1';
      div.textContent = line;
      logEl.appendChild(div);
      logEl.scrollTop = logEl.scrollHeight;
    });
  }

  // Scroll panel into view
  setTimeout(function() { panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 80);
}

// Restart ECS — fast path, no Terraform needed. Picks up updated secret VALUES.
async function handleRestartEcs() {
  if (!_activeProject) return;
  var btn = document.getElementById('btn-restart-ecs');
  var logEl = document.getElementById('secrets-action-log');

  // Reset log
  if (logEl) logEl.innerHTML = '';
  setSecretsActionStatus('RESTART ECS', 'running', ['Sending force-restart to ECS services...']);

  if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }

  try {
    var res = await api.post('/api/secrets/' + _activeProject.id + '/restart', {});
    if (res && res.ok) {
      var lines = [];
      if (res.restarted && res.restarted.length) lines.push('✔ Restarted: ' + res.restarted.join(', '));
      if (res.failed && res.failed.length)    lines.push('⚠ Skipped/Failed: ' + res.failed.join(' | '));
      lines.push('\n✔ ECS rolling restart triggered. New tasks will pull fresh secret values.');
      setSecretsActionStatus('RESTART ECS', 'success', lines);
    } else {
      throw new Error(res.error || 'Restart failed');
    }
  } catch (e) {
    setSecretsActionStatus('RESTART ECS', 'failed', ['✖ Error: ' + e.message]);
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }
}

// Re-apply Deployment Infra — needed when a NEW secret key was added.
// Streams Terraform logs into the inline panel (same SSE as the wizard).
async function handleReapplyDeployment() {
  if (!_activeProject) return;
  var logEl = document.getElementById('secrets-action-log');
  var btn   = document.getElementById('btn-reapply-deploy');

  // Reset
  if (logEl) logEl.innerHTML = '';
  setSecretsActionStatus('RE-APPLY INFRA', 'running', ['Starting Terraform deployment apply...']);
  if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }

  try {
    var res = await api.post('/api/terraform/deployment/run', { projectId: _activeProject.id });
    if (!res || !res.ok) throw new Error(res.error || 'Failed to start Terraform run');

    var runId = res.runId;
    setSecretsActionStatus('RE-APPLY INFRA', 'running', ['Run ID: ' + runId, 'Streaming live logs...']);

    // Wire up SSE into our inline log panel (mirror — does NOT steal the main terminal)
    var es = new EventSource('/api/terraform/' + runId + '/logs');
    es.onmessage = function(event) {
      try {
        var data = JSON.parse(event.data);
        if (data.line && logEl) {
          var div = document.createElement('div');
          div.style.color = (data.line.includes('ERROR') || data.line.includes('Error:')) ? '#f87171'
                           : (data.line.includes('✔') || data.line.includes('Apply complete!')) ? '#4ade80'
                           : '#cbd5e1';
          div.textContent = data.line;
          logEl.appendChild(div);
          logEl.scrollTop = logEl.scrollHeight;
        }
      } catch (e) {}
    };
    es.addEventListener('done', function(event) {
      try {
        var result = JSON.parse(event.data);
        var ok = result.status === 'done' || result.status === 'success';
        setSecretsActionStatus('RE-APPLY INFRA', ok ? 'success' : 'failed',
          [ok ? '\n✔ Terraform apply completed successfully.' : '\n✖ Terraform apply failed — check logs above.']);
        loadProjectsAndSetup(); // refresh badges
      } catch (e) {}
      es.close();
      if (btn) { btn.disabled = false; btn.style.opacity = ''; }
    });
    es.addEventListener('error', function() {
      setSecretsActionStatus('RE-APPLY INFRA', 'failed', ['✖ Lost connection to log stream.']);
      es.close();
      if (btn) { btn.disabled = false; btn.style.opacity = ''; }
    });

  } catch (e) {
    setSecretsActionStatus('RE-APPLY INFRA', 'failed', ['✖ ' + e.message]);
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }
}


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
