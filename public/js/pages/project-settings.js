// Dedicated Standalone Project Settings Page Logic
function initProjectSettingsPage() {
  loadActiveProjectData();

  window.addEventListener('activeProjectChanged', function(e) {
    loadActiveProjectData();
  });
}

async function loadActiveProjectData() {
  var activeId = window._activeProjectId;
  if (!activeId) {
    try {
      var pRes = await api.get('/api/projects');
      if (pRes.ok && pRes.projects && pRes.projects.length > 0) {
        var active = pRes.projects.find(function(p) { return p.isActive; }) || pRes.projects[0];
        activeId = active.id;
        window._activeProjectId = activeId;
      }
    } catch (_) {}
  }
  if (!activeId) return;

  try {
    var res = await api.get('/api/projects/' + activeId);
    if (res.ok && res.project) {
      var p = res.project;
      window._activeProject = p;
      
      // Update Identity Cards
      var tagEl = document.getElementById('proj-settings-name-tag');
      var titleEl = document.getElementById('proj-settings-title-name');
      if (tagEl) tagEl.textContent = p.name || activeId;
      if (titleEl) titleEl.textContent = p.name || activeId;

      var nameEl = document.getElementById('ps-proj-name');
      var regEl = document.getElementById('ps-proj-region');
      var provEl = document.getElementById('ps-proj-provider');
      var repoEl = document.getElementById('ps-proj-repo');

      if (nameEl) nameEl.textContent = p.name || activeId;
      if (regEl) regEl.textContent = p.region || 'us-east-1';
      if (provEl) provEl.textContent = (p.sourceType || 'codecommit').toUpperCase();
      if (repoEl) repoEl.textContent = p.repoName || p.githubRepo || '--';

      // Update Slack Status
      loadProjectSlackStatus(p);

      // Update EFS Storage Config
      loadEfsConfig(p);

      // Update Buildspec
      if (p.customBuildspec) {
        var bsInput = document.getElementById('project-buildspec-input');
        if (bsInput) bsInput.value = p.customBuildspec;
      } else {
        loadGenericBuildspec();
      }

      if (window.lucide) lucide.createIcons();
    }
  } catch (err) {
    console.error("Failed to load project settings data:", err);
  }
}

async function loadProjectSlackStatus(projData) {
  var p = projData;
  if (!p && window._activeProjectId) {
    try {
      var res = await api.get('/api/projects/' + window._activeProjectId);
      if (res.ok) p = res.project;
    } catch (_) {}
  }
  if (!p) return;

  var labelEl = document.getElementById('proj-slack-name-label');
  var badgeEl = document.getElementById('proj-slack-badge');
  var nameEl = document.getElementById('proj-slack-channel-name');
  var actionEl = document.getElementById('proj-slack-action-container');

  if (labelEl) labelEl.textContent = p.name || p.id;

  var chName = p.slackChannelName || p.slack_channel_name || p.slackChannel || p.slack_channel_id;

  if (chName && chName !== 'undefined') {
    var formattedName = chName.startsWith('#') ? chName : '#' + chName;
    if (badgeEl) {
      badgeEl.textContent = '✔ Active';
      badgeEl.style.background = 'rgba(16,185,129,0.12)';
      badgeEl.style.color = '#10b981';
    }
    if (nameEl) nameEl.textContent = formattedName;
    if (actionEl) {
      actionEl.innerHTML =
        '<button onclick="provisionProjectSlackChannel()" id="btn-provision-slack" class="btn-secondary" style="display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:7px 14px;">' +
          '<i data-lucide="refresh-cw" style="width:14px;height:14px;"></i> Sync Slack Members' +
        '</button>';
    }
  } else {
    if (badgeEl) {
      badgeEl.textContent = 'Not Provisioned';
      badgeEl.style.background = 'rgba(239,68,68,0.12)';
      badgeEl.style.color = '#ef4444';
    }
    if (nameEl) nameEl.textContent = 'No channel created';
    if (actionEl) {
      actionEl.innerHTML =
        '<button onclick="provisionProjectSlackChannel()" id="btn-provision-slack" class="btn-primary" style="display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:8px 16px;">' +
          '<i data-lucide="plus-circle" style="width:15px;height:15px;"></i> Provision Slack Channel' +
        '</button>';
    }
  }
  if (window.lucide) lucide.createIcons();
}

async function provisionProjectSlackChannel() {
  if (!window._activeProjectId) return;
  var btn = document.getElementById('btn-provision-slack');
  var msgEl = document.getElementById('proj-slack-status-msg');

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-2" class="animate-spin" style="width:14px;height:14px;"></i> Provisioning...';
  }
  if (msgEl) msgEl.style.display = 'none';

  try {
    var res = await api.post('/api/projects/' + window._activeProjectId + '/provision-slack', {});
    if (res.ok) {
      var ch = res.slackChannel || 'channel';
      showMsg(msgEl, '✔ Private Slack channel #' + ch + ' provisioned & members synced successfully!', false);
      loadActiveProjectData();
    } else {
      showMsg(msgEl, res.error || 'Failed to provision Slack channel.', true);
    }
  } catch (err) {
    showMsg(msgEl, err.message || 'Server error', true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadGenericBuildspec() {
  try {
    var res = await api.get('/api/settings/buildspec');
    if (res.ok) {
      var inputEl = document.getElementById('project-buildspec-input');
      if (inputEl) inputEl.value = res.buildspec;
    }
  } catch (e) {
    console.error("Failed to load generic buildspec:", e);
  }
}

async function saveProjectBuildspec() {
  if (!window._activeProjectId) return;
  var btn = document.getElementById('buildspec-save-btn');
  var msgEl = document.getElementById('buildspec-msg');
  var customBuildspec = document.getElementById('project-buildspec-input').value;
  
  btn.disabled = true;
  if (msgEl) msgEl.style.display = 'none';
  
  try {
    var res = await api.put('/api/projects/' + window._activeProjectId + '/buildspec', {
      customBuildspec: customBuildspec
    });
    
    if (res.ok) {
      if (res.warning) {
        showMsg(msgEl, '⚠ Saved to database, but CodeBuild update failed: ' + res.warning, true);
      } else {
        showMsg(msgEl, '✔ Buildspec saved and updated on CodeBuild instantly!', false);
      }
    } else {
      showMsg(msgEl, res.error || 'Failed to save buildspec.', true);
    }
  } catch (err) {
    showMsg(msgEl, err.message || 'Server error', true);
  }
  if (btn) btn.disabled = false;
}

function showMsg(el, text, isError) {
  if (!el) return;
  el.className = 'msg-box ' + (isError ? 'error' : 'success');
  el.textContent = text;
  el.style.display = 'block';
}


// ─── EFS Storage Management ─────────────────────────────────────────

async function loadEfsConfig(projData) {
  var p = projData || window._activeProject;
  if (!p) return;
  var toggle = document.getElementById('efs-enable-toggle');
  var configPanel = document.getElementById('efs-config-panel');
  var badge = document.getElementById('efs-status-badge');
  var autoName = document.getElementById('efs-auto-name');
  var mountInput = document.getElementById('efs-mount-path');

  if (!toggle) return;

  var isEnabled = !!p.efsEnabled;
  toggle.checked = isEnabled;
  configPanel.style.display = isEnabled ? 'block' : 'none';

  if (autoName) autoName.textContent = (p.githubRepo || p.repoName || p.name || 'app').toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (mountInput && p.efsMountPath) mountInput.value = p.efsMountPath;

  if (isEnabled && p.efsFilesystemId) {
    badge.textContent = 'Connected (' + p.efsFilesystemId + ')';
    badge.style.background = 'rgba(34,197,94,0.12)';
    badge.style.color = '#22c55e';

    var existingRadio = document.querySelector('input[name="efs-mode"][value="existing"]');
    if (existingRadio) existingRadio.checked = true;
    handleEfsModeChange();
  } else if (isEnabled) {
    badge.textContent = 'Enabled (pending apply)';
    badge.style.background = 'rgba(234,179,8,0.12)';
    badge.style.color = '#eab308';
  } else {
    badge.textContent = 'Not Configured';
    badge.style.background = 'var(--color-bg)';
    badge.style.color = 'var(--color-text-tertiary)';
  }

  loadExistingEfsList(p);
}

async function loadExistingEfsList(projData) {
  var p = projData || window._activeProject;
  var select = document.getElementById('efs-existing-select');
  if (!select) return;
  try {
    var res = await api.get('/api/efs/list' + (p ? '?projectId=' + p.id : ''));
    if (res && res.ok && res.filesystems) {
      select.innerHTML = '<option value="">-- Select an EFS filesystem --</option>';
      res.filesystems.forEach(function(fs) {
        var opt = document.createElement('option');
        opt.value = fs.id;
        opt.textContent = fs.name + ' (' + fs.id + ') — ' + fs.state;
        if (p && p.efsFilesystemId === fs.id) opt.selected = true;
        select.appendChild(opt);
      });
    } else {
      select.innerHTML = '<option value="">No existing EFS filesystems found</option>';
    }
  } catch (e) {
    select.innerHTML = '<option value="">Failed to load EFS list</option>';
  }
}

function handleEfsToggleChange() {
  var toggle = document.getElementById('efs-enable-toggle');
  var configPanel = document.getElementById('efs-config-panel');
  if (configPanel) configPanel.style.display = toggle.checked ? 'block' : 'none';
}

function handleEfsModeChange() {
  var mode = document.querySelector('input[name="efs-mode"]:checked');
  var existingPanel = document.getElementById('efs-existing-panel');
  var newHint = document.getElementById('efs-new-hint');
  if (existingPanel) existingPanel.style.display = (mode && mode.value === 'existing') ? 'block' : 'none';
  if (newHint) newHint.style.display = (mode && mode.value === 'new') ? 'block' : 'none';
}

async function handleSaveEfsConfig() {
  var p = window._activeProject;
  var activeId = p ? p.id : window._activeProjectId;
  if (!activeId) return;

  var toggle = document.getElementById('efs-enable-toggle');
  var mode = document.querySelector('input[name="efs-mode"]:checked');
  var mountPath = document.getElementById('efs-mount-path');
  var existingSelect = document.getElementById('efs-existing-select');
  var msgEl = document.getElementById('efs-save-msg');

  var enabled = toggle && toggle.checked;
  var existingEfsId = '';
  if (enabled && mode && mode.value === 'existing' && existingSelect) {
    existingEfsId = existingSelect.value;
    if (!existingEfsId) {
      if (msgEl) { msgEl.style.display = 'block'; msgEl.className = 'msg-box error'; msgEl.textContent = 'Please select an existing EFS filesystem.'; }
      return;
    }
  }

  try {
    var res = await api.post('/api/projects/' + activeId + '/storage', {
      enabled: enabled,
      existingEfsId: existingEfsId,
      mountPath: (mountPath && mountPath.value) || '/mnt/efs'
    });
    if (res && res.ok) {
      if (msgEl) { msgEl.style.display = 'block'; msgEl.className = 'msg-box success'; msgEl.textContent = '✔ Storage config saved! Go to Setup Wizard → Re-apply Deployment Infra to provision.'; }
      if (p) {
        p.efsEnabled = enabled;
        p.efsFilesystemId = existingEfsId;
        p.efsMountPath = (mountPath && mountPath.value) || '/mnt/efs';
      }
      loadActiveProjectData();
    } else {
      if (msgEl) { msgEl.style.display = 'block'; msgEl.className = 'msg-box error'; msgEl.textContent = (res && res.error) || 'Failed to save EFS configuration.'; }
    }
  } catch (e) {
    if (msgEl) { msgEl.style.display = 'block'; msgEl.className = 'msg-box error'; msgEl.textContent = e.message || 'Server error'; }
  }
}

window.initProjectSettingsPage = initProjectSettingsPage;
window.loadProjectSlackStatus = loadProjectSlackStatus;
window.provisionProjectSlackChannel = provisionProjectSlackChannel;
window.loadGenericBuildspec = loadGenericBuildspec;
window.saveProjectBuildspec = saveProjectBuildspec;
window.loadEfsConfig = loadEfsConfig;
window.handleEfsToggleChange = handleEfsToggleChange;
window.handleEfsModeChange = handleEfsModeChange;
window.handleSaveEfsConfig = handleSaveEfsConfig;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initProjectSettingsPage);
} else {
  initProjectSettingsPage();
}

