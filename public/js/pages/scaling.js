// Auto-scaling Page — Vanilla JS Logic
var _activeProject = null;
var _fleetData = {
  dev: { runningCount: 0, desiredCount: 0, pendingCount: 0, configured: false },
  uat: { runningCount: 0, desiredCount: 0, pendingCount: 0, configured: false },
  prod: { runningCount: 0, desiredCount: 0, pendingCount: 0, configured: false }
};
var _scalingConfigs = {
  dev: { minCapacity: 1, maxCapacity: 5, targetCpuPercent: 70 },
  uat: { minCapacity: 1, maxCapacity: 5, targetCpuPercent: 70 },
  prod: { minCapacity: 2, maxCapacity: 10, targetCpuPercent: 70 }
};
var _scalingActivities = { dev: [], uat: [], prod: [] };
var _activeActivityEnv = 'dev';

window.initScalingPage = initScalingPage;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initScalingPage);
} else {
  initScalingPage();
}

async function initScalingPage() {
  try {
    var res = await api.get('/api/projects');
    if (res && res.projects) {
      _activeProject = res.projects.find(function(p) { return p.isActive; }) || res.projects[0];
    }
  } catch (e) {}

  if (_activeProject) {
    var tag = document.getElementById('scaling-project-name');
    if (tag) tag.innerHTML = 'Project: <strong style="color:var(--color-text-primary);">' + _activeProject.name + '</strong>';
  }

  fetchAllData();
}

async function fetchAllData() {
  var icon = document.getElementById('btn-refresh-scale-icon');
  if (icon) icon.classList.add('animate-spin');

  hideResultBanner();

  if (!_activeProject) {
    if (icon) icon.classList.remove('animate-spin');
    return;
  }

  try {
    // 1. Fetch Fleet Task Status
    var fleetRes = await api.get('/api/ecs/fleet-status?projectId=' + _activeProject.id);
    if (fleetRes && fleetRes.ok && fleetRes.fleet) {
      _fleetData = fleetRes.fleet;
    }

    // 2. Fetch Scaling Configs & Activities for dev, uat, prod
    var envs = ['dev', 'uat', 'prod'];
    await Promise.all(envs.map(async function(env) {
      try {
        var cfgRes = await api.get('/api/scaling/config?projectId=' + _activeProject.id + '&env=' + env);
        if (cfgRes && cfgRes.ok) {
          _scalingConfigs[env] = cfgRes;
        }
      } catch (e) {}

      try {
        var actRes = await api.get('/api/scaling/activity?projectId=' + _activeProject.id + '&env=' + env);
        if (actRes && actRes.ok && Array.isArray(actRes.activities)) {
          _scalingActivities[env] = actRes.activities;
        }
      } catch (e) {}
    }));
  } catch (e) {}

  if (icon) {
    setTimeout(function() { icon.classList.remove('animate-spin'); }, 400);
  }

  renderFleetData();
  renderPolicyForms();
  renderActivities();
}

function renderFleetData() {
  ['dev', 'uat', 'prod'].forEach(function(env) {
    var info = _fleetData[env] || { runningCount: 0, desiredCount: 0, pendingCount: 0 };
    var runEl = document.getElementById('stat-running-' + env);
    var desEl = document.getElementById('stat-desired-' + env);
    var penEl = document.getElementById('stat-pending-' + env);

    if (runEl) {
      runEl.textContent = info.runningCount || 0;
      runEl.style.color = info.runningCount > 0 ? '#10b981' : 'var(--color-text-primary)';
    }
    if (desEl) desEl.textContent = info.desiredCount || 0;
    if (penEl) {
      penEl.textContent = info.pendingCount || 0;
      penEl.style.color = info.pendingCount > 0 ? '#f59e0b' : 'var(--color-text-secondary)';
    }

    var badge = document.getElementById('badge-status-' + env);
    if (badge) {
      var isAct = info.runningCount > 0;
      var isProv = info.desiredCount > 0;
      var color = isAct ? '#10b981' : isProv ? '#f59e0b' : '#64748b';
      badge.innerHTML = '<span style="width:6px;height:6px;border-radius:50%;background:' + color + ';"></span>' +
                        (isAct ? 'ACTIVE' : isProv ? 'PROVISIONING' : 'SCALED TO 0');
      badge.style.background = color + '15';
      badge.style.color = color;
      badge.style.borderColor = color + '30';
    }

    var imgWrap = document.getElementById('image-tag-wrap-' + env);
    var imgVal = document.getElementById('image-tag-val-' + env);
    if (info.imageUri && imgWrap && imgVal) {
      var shortTag = (info.imageUri.split('/').pop() || info.imageUri).slice(0, 24);
      imgVal.textContent = shortTag;
      imgVal.title = info.imageUri;
      imgWrap.style.display = 'flex';
    } else if (imgWrap) {
      imgWrap.style.display = 'none';
    }

    var btnZero = document.getElementById('btn-scale-zero-' + env);
    if (btnZero) {
      btnZero.disabled = info.desiredCount === 0;
      btnZero.style.background = info.desiredCount === 0 ? 'var(--color-bg)' : 'rgba(239,68,68,0.1)';
      btnZero.style.color = info.desiredCount === 0 ? 'var(--color-text-tertiary)' : '#ef4444';
    }
  });
}

function renderPolicyForms() {
  ['dev', 'uat', 'prod'].forEach(function(env) {
    var cfg = _scalingConfigs[env] || {};
    var badge = document.getElementById('policy-badge-' + env);
    if (badge) {
      badge.textContent = cfg.configured ? 'Active Target Tracking' : 'Default Preset';
      badge.style.color = cfg.configured ? '#10b981' : 'var(--color-text-tertiary)';
    }

    var minInput = document.getElementById('policy-min-' + env);
    var maxInput = document.getElementById('policy-max-' + env);
    var cpuSlider = document.getElementById('policy-cpu-slider-' + env);
    var cpuVal = document.getElementById('policy-cpu-val-' + env);
    var cpuDesc = document.getElementById('policy-cpu-desc-' + env);

    if (minInput && !minInput.dataset.userEdited) {
      minInput.value = cfg.minCapacity ?? (env === 'prod' ? 2 : 1);
    }
    if (maxInput && !maxInput.dataset.userEdited) {
      maxInput.value = cfg.maxCapacity ?? (env === 'prod' ? 10 : 5);
    }
    if (cpuSlider && !cpuSlider.dataset.userEdited) {
      var targetCpu = cfg.targetCpuPercent ?? 70;
      cpuSlider.value = targetCpu;
      if (cpuVal) cpuVal.textContent = targetCpu + '%';
      if (cpuDesc) cpuDesc.textContent = 'AWS will scale out when avg CPU exceeds ' + targetCpu + '%.';
    }
  });
}

function updateCpuSliderVal(env, val) {
  var slider = document.getElementById('policy-cpu-slider-' + env);
  if (slider) slider.dataset.userEdited = 'true';

  var valEl = document.getElementById('policy-cpu-val-' + env);
  var descEl = document.getElementById('policy-cpu-desc-' + env);
  if (valEl) valEl.textContent = val + '%';
  if (descEl) descEl.textContent = 'AWS will scale out when avg CPU exceeds ' + val + '%.';
}

function setActiveActivityTab(env) {
  _activeActivityEnv = env;
  ['dev', 'uat', 'prod'].forEach(function(e) {
    var btn = document.getElementById('activity-tab-' + e);
    if (btn) btn.className = e === env ? 'activity-tab-btn active' : 'activity-tab-btn';
  });
  renderActivities();
}

function renderActivities() {
  ['dev', 'uat', 'prod'].forEach(function(env) {
    var countTag = document.getElementById('activity-count-' + env);
    var list = _scalingActivities[env] || [];
    if (countTag) countTag.textContent = '(' + list.length + ')';
  });

  var container = document.getElementById('scaling-activity-container');
  if (!container) return;

  var currentList = _scalingActivities[_activeActivityEnv] || [];
  container.innerHTML = '';

  if (currentList.length === 0) {
    container.innerHTML =
      '<div style="padding:36px;text-align:center;color:var(--color-text-tertiary);font-size:13px;background:var(--color-bg);border-radius:12px;">' +
        'No recent auto-scaling activities logged for ' + _activeActivityEnv.toUpperCase() + ' fleet.' +
      '</div>';
    return;
  }

  currentList.forEach(function(act, idx) {
    var row = document.createElement('div');
    row.style.cssText = 'padding:14px 18px;border-radius:10px;background:var(--color-bg);border:1px solid var(--color-border);display:flex;justify-content:space-between;align-items:center;';

    var dateStr = act.startTime ? new Date(act.startTime).toLocaleString() : '';
    var status = (act.statusCode || 'COMPLETED').toUpperCase();
    var isSuccess = status === 'SUCCESSFUL' || status === 'COMPLETED';

    var html =
      '<div style="flex:1;padding-right:16px;">' +
        '<div style="font-size:13px;font-weight:700;color:var(--color-text-primary);">' +
          (act.description || 'Auto-scaling activity triggered') +
        '</div>' +
        '<div style="font-size:12px;color:var(--color-text-tertiary);margin-top:2px;">' +
          'Cause: ' + (act.cause || 'Target tracking CPU policy recommendation') +
        '</div>' +
        (dateStr ?
          '<div style="font-size:11px;color:var(--color-text-tertiary);margin-top:4px;display:flex;align-items:center;gap:4px;">' +
            '<i data-lucide="clock" style="width:12px;height:12px;"></i> ' + dateStr +
          '</div>' : ''
        ) +
      '</div>' +
      '<div>' +
        '<span style="padding:4px 10px;border-radius:6px;font-size:11px;font-weight:800;letter-spacing:0.5px;background:' + (isSuccess ? 'rgba(16,185,129,0.15)' : 'rgba(59,130,246,0.15)') + ';color:' + (isSuccess ? '#10b981' : '#60a5fa') + ';">' +
          status +
        '</span>' +
      '</div>';

    row.innerHTML = html;
    container.appendChild(row);
  });

  if (window.lucide) lucide.createIcons();
}

// Actions
async function handleDirectScale(env, targetCount) {
  if (!_activeProject) return;
  hideResultBanner();
  try {
    var res = await api.post('/api/ecs/scale', {
      projectId: _activeProject.id,
      environment: env,
      desiredCount: targetCount
    });
    if (res && res.ok) {
      showResultBanner('success', 'Successfully set ' + env.toUpperCase() + ' fleet desired tasks to ' + targetCount + '.');
      fetchAllData();
    } else {
      showResultBanner('error', (res && res.error) || ('Failed to scale ' + env.toUpperCase() + ' fleet'));
    }
  } catch (err) {
    showResultBanner('error', err.message || 'Error scaling fleet');
  }
}

function handleDirectScaleUp(env) {
  var info = _fleetData[env] || { desiredCount: 0 };
  handleDirectScale(env, (info.desiredCount || 0) + 1);
}

function handleCustomScale(env) {
  var input = document.getElementById('custom-desired-' + env);
  if (!input) return;
  var count = parseInt(input.value, 10);
  if (!isNaN(count) && count >= 0) {
    handleDirectScale(env, count);
  }
}

async function handleSavePolicy(env) {
  if (!_activeProject) return;
  hideResultBanner();

  var minVal = parseInt(document.getElementById('policy-min-' + env)?.value, 10) || 0;
  var maxVal = parseInt(document.getElementById('policy-max-' + env)?.value, 10) || 1;
  var cpuVal = parseInt(document.getElementById('policy-cpu-slider-' + env)?.value, 10) || 70;

  var btn = document.getElementById('btn-save-policy-' + env);
  if (btn) btn.disabled = true;

  try {
    var res = await api.post('/api/scaling/config', {
      projectId: _activeProject.id,
      env: env,
      minCapacity: minVal,
      maxCapacity: maxVal,
      targetCpuPercent: cpuVal
    });
    if (res && res.ok) {
      showResultBanner('success', 'Updated AWS Target Tracking Policy for ' + env.toUpperCase() + ': Min=' + minVal + ', Max=' + maxVal + ', CPU Target=' + cpuVal + '%.');
      fetchAllData();
    } else {
      showResultBanner('error', (res && res.error) || ('Failed to save policy for ' + env.toUpperCase()));
    }
  } catch (err) {
    showResultBanner('error', err.message || 'Error saving policy');
  }

  if (btn) btn.disabled = false;
}

function showResultBanner(type, msg) {
  var banner = document.getElementById('scaling-result-banner');
  if (!banner) return;
  banner.className = type === 'success' ? 'msg-box success' : 'msg-box error';
  banner.style.borderColor = type === 'success' ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)';
  banner.style.background = type === 'success' ? 'rgba(16, 185, 129, 0.08)' : 'rgba(239, 68, 68, 0.08)';
  banner.style.color = type === 'success' ? '#10b981' : '#f87171';
  banner.textContent = msg;
  banner.style.display = 'flex';
}

function hideResultBanner() {
  var banner = document.getElementById('scaling-result-banner');
  if (banner) banner.style.display = 'none';
}

function copyImageUri(env) {
  var info = _fleetData[env];
  if (!info || !info.imageUri) return;
  navigator.clipboard.writeText(info.imageUri);
  var valEl = document.getElementById('image-tag-val-' + env);
  if (valEl) {
    var orig = valEl.textContent;
    valEl.textContent = 'Copied!';
    setTimeout(function() { valEl.textContent = orig; }, 2000);
  }
}
