// Build History Page — Vanilla JS Logic
var _activeProject = null;
var _builds = [];
var _projectName = '';
var _selectedBuildLogs = null;

window.initBuildsPage = initBuildsPage;
window.initBuildHistoryPage = initBuildsPage;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initBuildsPage);
} else {
  initBuildsPage();
}

async function initBuildsPage() {
  try {
    var res = await api.get('/api/projects');
    if (res && res.projects) {
      _activeProject = res.projects.find(function(p) { return p.isActive; }) || res.projects[0];
    }
  } catch (e) {}

  if (_activeProject) {
    var pNameTag = document.getElementById('builds-project-name');
    if (pNameTag) {
      pNameTag.innerHTML = 'Project: <strong style="color:var(--color-text-primary);">' + _activeProject.name + '</strong>';
    }
  }

  fetchBuilds();
}

async function fetchBuilds() {
  var loadingEl = document.getElementById('builds-loading');
  var emptyEl = document.getElementById('builds-empty');
  var listEl = document.getElementById('builds-list-container');
  var iconRefresh = document.getElementById('btn-refresh-builds-icon');

  if (iconRefresh) iconRefresh.classList.add('animate-spin');
  if (loadingEl) loadingEl.style.display = 'block';
  if (emptyEl) emptyEl.style.display = 'none';
  if (listEl) listEl.style.display = 'none';

  try {
    var url = _activeProject ? '/api/build/history?projectId=' + _activeProject.id : '/api/build/history';
    var res = await api.get(url);
    if (res && res.ok) {
      _builds = res.builds || [];
      _projectName = res.projectName || (_activeProject ? (_activeProject.buildProjectName || _activeProject.name) : 'deploy-watch-new');
    } else {
      _builds = [];
    }
  } catch (e) {
    _builds = [];
  }

  if (loadingEl) loadingEl.style.display = 'none';
  if (iconRefresh) {
    setTimeout(function() { iconRefresh.classList.remove('animate-spin'); }, 400);
  }

  renderBuilds();
}

function renderBuilds() {
  var projEl = document.getElementById('metric-build-project-name');
  if (projEl) projEl.textContent = _projectName || 'deploy-watch-new';

  var totalEl = document.getElementById('metric-build-total');
  if (totalEl) totalEl.textContent = _builds.length;

  var succCount = _builds.filter(function(b) { return b.status === 'SUCCEEDED'; }).length;
  var rate = _builds.length > 0 ? Math.round((succCount / _builds.length) * 100) : 100;

  var rateEl = document.getElementById('metric-build-rate');
  if (rateEl) rateEl.textContent = rate + '% (' + succCount + '/' + _builds.length + ')';

  var countTag = document.getElementById('builds-count-tag');
  if (countTag) countTag.textContent = '(' + _builds.length + ')';

  var listEl = document.getElementById('builds-list-container');
  var emptyEl = document.getElementById('builds-empty');

  if (!listEl) return;

  listEl.innerHTML = '';
  if (_builds.length === 0) {
    listEl.style.display = 'none';
    if (emptyEl) emptyEl.style.display = 'block';
    return;
  }

  if (emptyEl) emptyEl.style.display = 'none';
  listEl.style.display = 'flex';

  _builds.forEach(function(b, i) {
    var statusColor = b.status === 'SUCCEEDED' ? '#10b981' : b.status === 'FAILED' ? '#ef4444' : '#60a5fa';
    var row = document.createElement('div');
    row.className = 'build-card-row';

    var bNum = b.buildNumber || (_builds.length - i);
    var startTimeStr = b.startTime ? new Date(b.startTime).toLocaleString() : '--';
    var durationStr = b.duration || '--';
    var initiatorStr = b.initiator || 'System';

    var html =
      '<div style="flex:1;padding-right:20px;">' +
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;">' +
          '<span style="font-weight:800;font-size:15px;color:var(--color-text-primary);">' +
            'Build #' + bNum +
          '</span>' +
          '<span style="padding:3px 10px;border-radius:20px;font-size:11px;font-weight:800;letter-spacing:0.5px;background:' + statusColor + '18;color:' + statusColor + ';border:1px solid ' + statusColor + '30;">' +
            (b.status || 'SUCCEEDED') +
          '</span>' +
        '</div>' +

        '<div style="font-size:12px;color:var(--color-text-secondary);margin-bottom:6px;font-family:monospace;">' +
          'ID: ' + b.id +
        '</div>' +

        '<div style="display:flex;align-items:center;gap:16px;font-size:12px;color:var(--color-text-tertiary);flex-wrap:wrap;">' +
          '<span>Started: <strong style="color:var(--color-text-secondary);">' + startTimeStr + '</strong></span>' +
          '<span>Duration: <strong style="color:var(--color-text-secondary);">' + durationStr + '</strong></span>' +
          '<span>Trigger: <strong style="color:var(--color-text-secondary);">' + initiatorStr + '</strong></span>' +
        '</div>' +
      '</div>' +

      '<div style="display:flex;align-items:center;gap:10px;">' +
        '<button type="button" onclick="openLogModal(' + i + ')" style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:8px;border:1px solid var(--color-border);background:var(--color-surface);color:#6366f1;font-size:12px;font-weight:700;cursor:pointer;">' +
          '<i data-lucide="terminal" style="width:14px;height:14px;"></i> View Logs' +
        '</button>' +
        '<button type="button" onclick="copyBuildId(\'' + b.id + '\', this)" title="Copy Build ID" style="padding:8px;border-radius:8px;border:1px solid var(--color-border);background:transparent;color:var(--color-text-tertiary);cursor:pointer;">' +
          '<i data-lucide="copy" style="width:14px;height:14px;"></i>' +
        '</button>' +
      '</div>';

    row.innerHTML = html;
    listEl.appendChild(row);
  });

  if (window.lucide) lucide.createIcons();
}

function copyBuildId(id, btn) {
  navigator.clipboard.writeText(id);
  btn.innerHTML = '<i data-lucide="check" style="width:14px;height:14px;color:#10b981;"></i>';
  if (window.lucide) lucide.createIcons();
  setTimeout(function() {
    btn.innerHTML = '<i data-lucide="copy" style="width:14px;height:14px;"></i>';
    if (window.lucide) lucide.createIcons();
  }, 2000);
}

async function handleTriggerBuild() {
  if (!_activeProject) return;
  var btn = document.getElementById('btn-trigger-build');
  if (btn) btn.disabled = true;

  try {
    var res = await api.post('/api/build/trigger', { projectId: _activeProject.id });
    if (res && res.ok) {
      fetchBuilds();
    }
  } catch (e) {}

  if (btn) btn.disabled = false;
}

// ── CloudWatch Log Viewer Modal ─────────────────────────────────────────────
async function openLogModal(idx) {
  _selectedBuildLogs = _builds[idx];
  if (!_selectedBuildLogs) return;

  document.getElementById('log-modal-title').textContent = 'CloudWatch Logs — ' + _selectedBuildLogs.id;
  document.getElementById('log-modal-sub').innerHTML =
    'Status: <span style="color:' + (_selectedBuildLogs.status === 'SUCCEEDED' ? '#10b981' : '#ef4444') + ';font-weight:700;">' + _selectedBuildLogs.status + '</span> &bull; Duration: ' + (_selectedBuildLogs.duration || '--');
  document.getElementById('log-modal-group').textContent = (_selectedBuildLogs.logs && _selectedBuildLogs.logs.groupName) ? _selectedBuildLogs.logs.groupName : ('/aws/codebuild/' + _projectName);

  var termBody = document.getElementById('log-terminal-body');
  termBody.textContent = 'Streaming CloudWatch build log events...';

  document.getElementById('modal-build-logs').style.display = 'flex';
  if (window.lucide) lucide.createIcons();

  try {
    var url = '/api/build/execution-logs?projectId=' + (_activeProject ? _activeProject.id : '') + '&buildId=' + encodeURIComponent(_selectedBuildLogs.id);
    var res = await api.get(url);
    if (res && res.ok && Array.isArray(res.logs)) {
      termBody.textContent = res.logs.map(function(l) {
        return typeof l === 'string' ? l : (l.message || JSON.stringify(l));
      }).join('\n');
    } else {
      termBody.textContent = 'No log events recorded for this build execution.';
    }
  } catch (err) {
    termBody.textContent = 'Failed to load logs: ' + err.message;
  }

  termBody.scrollTop = termBody.scrollHeight;
}

function closeLogModal() {
  document.getElementById('modal-build-logs').style.display = 'none';
  _selectedBuildLogs = null;
}
