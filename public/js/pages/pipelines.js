// Pipelines Page — Vanilla JS Logic
var _activeProject = null;
var _pipelineState = null;
var _pipePollTimer = null;

window.initPipelinesPage = initPipelinesPage;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPipelinesPage);
} else {
  initPipelinesPage();
}

// Clean up polling timer if navigating away via SPA router
window.addEventListener('popstate', function() {
  if (_pipePollTimer) clearInterval(_pipePollTimer);
});

async function initPipelinesPage() {
  if (_pipePollTimer) clearInterval(_pipePollTimer);

  try {
    var res = await api.get('/api/projects');
    if (res && res.projects) {
      _activeProject = res.projects.find(function(p) { return p.isActive; }) || res.projects[0];
    }
  } catch (e) {}

  if (_activeProject) {
    var nameTag = document.getElementById('pipeline-name-tag');
    if (nameTag) {
      var pName = _activeProject.pipelineName || (_activeProject.name + '-pipeline');
      nameTag.innerHTML = 'Pipeline: <strong style="color:var(--color-text-primary);">' + pName + '</strong>';
    }

    fetchPipeline(false);
    _pipePollTimer = setInterval(function() {
      fetchPipeline(false);
    }, 10000);
  } else {
    var loadingEl = document.getElementById('pipeline-loading');
    var emptyEl = document.getElementById('pipeline-empty');
    if (loadingEl) loadingEl.style.display = 'none';
    if (emptyEl) {
      emptyEl.textContent = 'No active project selected. Create or select a project to view pipeline status.';
      emptyEl.style.display = 'block';
    }
  }
}

async function fetchPipeline(isManual) {
  if (!_activeProject) return;

  var iconRefresh = document.getElementById('btn-refresh-pipe-icon');
  if (isManual && iconRefresh) iconRefresh.classList.add('animate-spin');

  var loadingEl = document.getElementById('pipeline-loading');
  var emptyEl = document.getElementById('pipeline-empty');
  var stagesList = document.getElementById('pipeline-stages-list');

  try {
    var res = await api.get('/api/pipeline/state?projectId=' + _activeProject.id);
    if (res && res.ok) {
      _pipelineState = res;
      renderPipeline();
    } else {
      // API responded but pipeline not found
      if (loadingEl) loadingEl.style.display = 'none';
      if (emptyEl) {
        emptyEl.textContent = 'No active pipeline found for this project.';
        emptyEl.style.display = 'block';
      }
      if (stagesList) stagesList.style.display = 'none';
    }
  } catch (e) {
    if (loadingEl) loadingEl.style.display = 'none';
    if (emptyEl) {
      emptyEl.textContent = 'No active pipeline found for this project.';
      emptyEl.style.display = 'block';
    }
    if (stagesList) stagesList.style.display = 'none';
  }

  if (loadingEl) loadingEl.style.display = 'none';

  if (isManual && iconRefresh) {
    setTimeout(function() { iconRefresh.classList.remove('animate-spin'); }, 400);
  }
}

function renderPipeline() {
  var stages = _pipelineState ? (_pipelineState.stageStates || _pipelineState.stages || []) : [];
  var executions = _pipelineState ? (_pipelineState.executions || []) : [];
  var activeExecution = executions[0];

  // Execution Card
  var execCard = document.getElementById('active-execution-card');
  if (activeExecution && execCard) {
    document.getElementById('exec-id-val').textContent = activeExecution.pipelineExecutionId || '--';
    var stVal = document.getElementById('exec-status-val');
    if (stVal) {
      stVal.textContent = activeExecution.status || 'In Progress';
      stVal.style.color = activeExecution.status === 'Succeeded' ? '#10b981' : '#f59e0b';
    }
    var timeVal = document.getElementById('exec-time-val');
    if (timeVal) {
      timeVal.textContent = new Date(activeExecution.startTime || Date.now()).toLocaleTimeString();
    }
    execCard.style.display = 'flex';
  } else if (execCard) {
    execCard.style.display = 'none';
  }

  // Stages List
  var countEl = document.getElementById('pipeline-stage-count');
  if (countEl) countEl.textContent = '(' + stages.length + ')';

  var stagesList = document.getElementById('pipeline-stages-list');
  var emptyEl = document.getElementById('pipeline-empty');

  if (!stagesList) return;

  stagesList.innerHTML = '';
  if (stages.length === 0) {
    stagesList.style.display = 'none';
    if (emptyEl) {
      emptyEl.textContent = 'No active pipeline found for this project.';
      emptyEl.style.display = 'block';
    }
    return;
  }

  if (emptyEl) emptyEl.style.display = 'none';
  stagesList.style.display = 'flex';

  stages.forEach(function(stg, i) {
    var actionState = stg.actionStates ? stg.actionStates[0] : null;
    var rawStatus = stg.latestExecution?.status || actionState?.latestExecution?.status || stg.inboundExecution?.status || 'Not Started';

    var isSuccess = rawStatus === 'Succeeded';
    var isFailed = rawStatus === 'Failed' || rawStatus === 'Rejected';
    var isRunning = rawStatus === 'InProgress' || rawStatus === 'Building';
    var isApprovalStage = (stg.stageName || '').toLowerCase().includes('approv');

    var displayStatus = isSuccess ? 'SUCCEEDED' : isFailed ? 'FAILED' : isRunning ? 'IN PROGRESS' : 'PENDING';
    var statusColor = isSuccess ? '#10b981' : isFailed ? '#ef4444' : isRunning ? '#f59e0b' : 'var(--color-text-tertiary)';

    var row = document.createElement('div');
    row.className = 'stage-card-row';

    var iconSvg = isSuccess ? '<i data-lucide="check-circle-2" style="width:22px;height:22px;color:#10b981;"></i>' :
                  isFailed ? '<i data-lucide="alert-circle" style="width:22px;height:22px;color:#ef4444;"></i>' :
                  isRunning ? '<i data-lucide="clock" class="animate-spin" style="width:22px;height:22px;color:#f59e0b;"></i>' :
                  '<i data-lucide="layers" style="width:22px;height:22px;color:var(--color-text-tertiary);"></i>';

    var actionName = actionState?.actionName || stg.stageName;

    var canApprove = (typeof auth !== 'undefined' && auth.isAdmin) ? auth.isAdmin() : false;

    // Determine environment URL if this is a deployment stage
    var envLinkHtml = '';
    var stgNameLower = (stg.stageName || '').toLowerCase();
    if (stgNameLower.startsWith('deploy-')) {
      var pName = _activeProject.githubRepo || _activeProject.buildProjectName || _activeProject.name || 'app';
      var prefix = String(pName).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'app';
      var domain = _activeProject.domainName || 'benevolaite.com';
      var url = '';
      if (stgNameLower === 'deploy-dev') url = 'https://dev-' + prefix + '.' + domain;
      else if (stgNameLower === 'deploy-uat') url = 'https://uat-' + prefix + '.' + domain;
      else if (stgNameLower === 'deploy-prod') url = 'https://' + prefix + '.' + domain;
      
      if (url) {
        envLinkHtml = '<a href="' + url + '" target="_blank" style="display:inline-flex;align-items:center;gap:4px;margin-left:12px;font-size:12px;color:#3b82f6;text-decoration:none;font-weight:600;"><i data-lucide="external-link" style="width:12px;height:12px;"></i> View Site</a>';
      }
    }

    var html =
      '<div style="display:flex;align-items:center;gap:14px;">' +
        iconSvg +
        '<div>' +
          '<div style="font-size:15px;font-weight:800;color:var(--color-text-primary);display:flex;align-items:center;">' +
            (i + 1) + '. ' + stg.stageName + envLinkHtml +
          '</div>' +
          '<div style="font-size:12px;color:var(--color-text-tertiary);margin-top:2px;">' +
            'Action: ' + actionName +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:12px;">' +
        '<span style="padding:4px 12px;border-radius:20px;font-size:11px;font-weight:800;letter-spacing:0.5px;background:' + statusColor + '18;color:' + statusColor + ';border:1px solid ' + statusColor + '30;">' +
          displayStatus +
        '</span>' +
        (isApprovalStage && isRunning && canApprove ?
          '<a href="/approvals" style="display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:8px;border:none;background:#10b981;color:white;font-size:12px;font-weight:800;cursor:pointer;text-decoration:none;box-shadow:0 2px 8px rgba(16,185,129,0.3);">' +
            '<i data-lucide="shield-check" style="width:14px;height:14px;"></i> Review &amp; Approve Gate' +
          '</a>' : ''
        ) +
      '</div>';


    row.innerHTML = html;
    stagesList.appendChild(row);
  });

  if (window.lucide) lucide.createIcons();
}

async function handleStartPipeline() {
  if (!_activeProject) return;
  var btn = document.getElementById('btn-run-pipeline');
  if (btn) btn.disabled = true;

  try {
    var res = await api.post('/api/pipeline/start', { projectId: _activeProject.id });
    if (res && res.ok) {
      setTimeout(function() { fetchPipeline(false); }, 1000);
    }
  } catch (e) {}

  if (btn) btn.disabled = false;
}
