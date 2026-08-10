// Approvals Page — Vanilla JS Logic
var _activeProject = null;
var _pendingApprovals = [];
var _submittingId = null;

window.initApprovalsPage = initApprovalsPage;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApprovalsPage);
} else {
  initApprovalsPage();
}

async function initApprovalsPage() {
  try {
    var res = await api.get('/api/projects');
    if (res && res.projects) {
      _activeProject = res.projects.find(function(p) { return p.isActive; }) || res.projects[0];
    }
  } catch (e) {}

  if (_activeProject) {
    var pipeNameEl = document.getElementById('approvals-pipeline-name');
    if (pipeNameEl) {
      var pName = _activeProject.pipelineName || (_activeProject.name + '-pipeline');
      pipeNameEl.innerHTML = 'Pipeline: <strong style="color:var(--color-text-primary);">' + pName + '</strong>';
    }
  }

  fetchApprovals();
}

async function fetchApprovals() {
  var loadingEl = document.getElementById('approvals-loading');
  var emptyEl = document.getElementById('approvals-empty');
  var listEl = document.getElementById('approvals-list-container');
  var iconRefresh = document.getElementById('btn-refresh-app-icon');

  if (iconRefresh) iconRefresh.classList.add('animate-spin');
  if (loadingEl) loadingEl.style.display = 'block';
  if (emptyEl) emptyEl.style.display = 'none';
  if (listEl) listEl.style.display = 'none';

  try {
    var url = _activeProject ? '/api/pipeline/approvals?projectId=' + _activeProject.id : '/api/pipeline/approvals';
    var res = await api.get(url);
    if (res && res.ok && Array.isArray(res.pending)) {
      _pendingApprovals = res.pending;
    } else {
      _pendingApprovals = [];
    }
  } catch (e) {
    _pendingApprovals = [];
  }

  if (loadingEl) loadingEl.style.display = 'none';
  if (iconRefresh) {
    setTimeout(function() { iconRefresh.classList.remove('animate-spin'); }, 400);
  }

  renderApprovals();
}

function renderApprovals() {
  var uatGates = _pendingApprovals.filter(function(p) {
    return p.envGate === 'uat' || (p.stageName || '').toLowerCase().includes('uat');
  });
  var prodGates = _pendingApprovals.filter(function(p) {
    return p.envGate === 'prod' || (p.stageName || '').toLowerCase().includes('prod');
  });

  // Metrics update
  var metricCount = document.getElementById('metric-pending-count');
  if (metricCount) {
    metricCount.textContent = _pendingApprovals.length + ' ' + (_pendingApprovals.length === 1 ? 'Gate' : 'Gates');
    metricCount.style.color = _pendingApprovals.length > 0 ? '#f59e0b' : '#10b981';
  }

  var metricUat = document.getElementById('metric-uat-status');
  if (metricUat) {
    metricUat.textContent = uatGates.length > 0 ? 'Awaiting Approval' : 'Clear';
    metricUat.style.color = uatGates.length > 0 ? '#f59e0b' : 'var(--color-text-secondary)';
  }

  var metricProd = document.getElementById('metric-prod-status');
  if (metricProd) {
    metricProd.textContent = prodGates.length > 0 ? 'Awaiting Approval' : 'Clear';
    metricProd.style.color = prodGates.length > 0 ? '#ef4444' : 'var(--color-text-secondary)';
  }

  var queueCount = document.getElementById('approvals-queue-count');
  if (queueCount) queueCount.textContent = '(' + _pendingApprovals.length + ')';

  var listEl = document.getElementById('approvals-list-container');
  var emptyEl = document.getElementById('approvals-empty');

  if (!listEl) return;

  listEl.innerHTML = '';
  if (_pendingApprovals.length === 0) {
    listEl.style.display = 'none';
    if (emptyEl) emptyEl.style.display = 'block';
    return;
  }

  if (emptyEl) emptyEl.style.display = 'none';
  listEl.style.display = 'flex';

  _pendingApprovals.forEach(function(app, i) {
    var key = app.token || app.stageName || i;
    var isBusy = _submittingId === key;
    var envLabel = (app.envGate || app.stageName || 'PROD').toUpperCase();

    var card = document.createElement('div');
    card.className = 'approval-gate-card';

    var html =
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;">' +
        '<div>' +
          '<div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;">' +
            '<span style="font-size:17px;font-weight:800;color:var(--color-text-primary);">' +
              'Stage: ' + app.stageName +
            '</span>' +
            '<span style="padding:3px 10px;border-radius:20px;font-size:11px;font-weight:800;letter-spacing:0.5px;background:rgba(245,158,11,0.15);color:#f59e0b;border:1px solid rgba(245,158,11,0.3);">' +
              'WAITING FOR APPROVAL (' + envLabel + ')' +
            '</span>' +
          '</div>' +
          '<div style="font-size:12px;color:var(--color-text-secondary);font-family:monospace;">' +
            'Token: ' + (app.token || 'AWS-GATE-TOKEN') +
          '</div>' +
        '</div>' +
        '<div style="font-size:12px;color:var(--color-text-tertiary);text-align:right;">' +
          'Pipeline: <strong style="color:var(--color-text-secondary);">' + (app.pipelineName || 'N/A') + '</strong>' +
        '</div>' +
      '</div>' +

      '<div style="margin-bottom:16px;">' +
        '<label style="display:block;font-size:12px;font-weight:700;color:var(--color-text-secondary);margin-bottom:6px;">' +
          'Reviewer Comment &amp; Release Justification' +
        '</label>' +
        '<input type="text" id="comment-input-' + i + '" placeholder="e.g. Approved after UAT verification and QA sign-off" style="width:100%;padding:10px 14px;border-radius:8px;border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text-primary);font-size:13px;outline:none;" />' +
      '</div>' +

      '<div style="display:flex;justify-content:flex-end;gap:12px;">' +
        '<button type="button" onclick="handleDecision(' + i + ', false)" ' + (isBusy ? 'disabled' : '') + ' style="display:inline-flex;align-items:center;gap:6px;padding:10px 20px;border-radius:10px;border:1px solid rgba(239,68,68,0.4);background:rgba(239,68,68,0.1);color:#ef4444;font-size:13px;font-weight:700;cursor:pointer;">' +
          '<i data-lucide="x-circle" style="width:16px;height:16px;"></i> ' + (isBusy ? 'Processing...' : 'Reject &amp; Stop Pipeline') +
        '</button>' +
        '<button type="button" onclick="handleDecision(' + i + ', true)" ' + (isBusy ? 'disabled' : '') + ' style="display:inline-flex;align-items:center;gap:6px;padding:10px 22px;border-radius:10px;border:none;background:#10b981;color:white;font-size:13px;font-weight:800;cursor:pointer;box-shadow:0 4px 12px rgba(16,185,129,0.25);">' +
          '<i data-lucide="shield-check" style="width:16px;height:16px;"></i> ' + (isBusy ? 'Promoting...' : 'Approve &amp; Promote') +
        '</button>' +
      '</div>';

    card.innerHTML = html;
    listEl.appendChild(card);
  });

  if (window.lucide) lucide.createIcons();
}

async function handleDecision(idx, approved) {
  var app = _pendingApprovals[idx];
  if (!app || !_activeProject) return;

  var key = app.token || app.stageName || idx;
  _submittingId = key;

  var banner = document.getElementById('approvals-banner');
  if (banner) banner.style.display = 'none';

  var commentInput = document.getElementById('comment-input-' + idx);
  var userComment = commentInput ? commentInput.value.trim() : '';
  var defaultComment = approved ? 'Approved by release manager' : 'Rejected by release manager';
  var comment = userComment || defaultComment;

  try {
    var res = await api.post('/api/pipeline/approve', {
      projectId: _activeProject.id,
      stageName: app.stageName,
      actionName: app.actionName || app.stageName,
      token: app.token,
      approved: approved,
      comment: comment
    });

    if (res && res.ok) {
      showBanner('success', 'Successfully ' + (approved ? 'approved and promoted' : 'rejected') + ' stage "' + app.stageName + '".');
      fetchApprovals();
    } else {
      showBanner('error', (res && res.error) || 'Failed to process approval decision.');
    }
  } catch (err) {
    showBanner('error', err.message || 'Error processing decision');
  }

  _submittingId = null;
}

function showBanner(type, msg) {
  var banner = document.getElementById('approvals-banner');
  if (!banner) return;

  banner.className = type === 'success' ? 'msg-box success' : 'msg-box error';
  banner.textContent = msg;
  banner.style.display = 'block';
}
