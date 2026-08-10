// Build Logs Page — Vanilla JS Logic
var _activeProject = null;

window.initBuildLogsPage = initBuildLogsPage;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initBuildLogsPage);
} else {
  initBuildLogsPage();
}

async function initBuildLogsPage() {
  try {
    var res = await api.get('/api/projects');
    if (res && res.projects) {
      _activeProject = res.projects.find(function(p) { return p.isActive; }) || res.projects[0];
    }
  } catch (e) {}

  if (_activeProject) {
    var tag = document.getElementById('build-logs-project-name');
    if (tag) tag.innerHTML = 'Project: <strong style="color:var(--color-text-primary);">' + _activeProject.name + '</strong>';
  }

  fetchBuildLogs();
}

async function fetchBuildLogs() {
  var icon = document.getElementById('btn-refresh-build-logs-icon');
  var termBody = document.getElementById('build-terminal-body');
  if (icon) icon.classList.add('animate-spin');

  if (!_activeProject) {
    if (termBody) termBody.textContent = 'No active project selected.';
    if (icon) icon.classList.remove('animate-spin');
    return;
  }

  try {
    var url = '/api/build/history?projectId=' + _activeProject.id;
    var historyRes = await api.get(url);

    if (historyRes && historyRes.ok && Array.isArray(historyRes.builds) && historyRes.builds.length > 0) {
      var latestBuild = historyRes.builds[0];
      var logUrl = '/api/build/execution-logs?projectId=' + _activeProject.id + '&buildId=' + encodeURIComponent(latestBuild.id);
      var logRes = await api.get(logUrl);

      if (logRes && logRes.ok && Array.isArray(logRes.logs) && logRes.logs.length > 0) {
        termBody.textContent = logRes.logs.map(function(l) {
          return typeof l === 'string' ? l : (l.message || JSON.stringify(l));
        }).join('\n');
      } else {
        termBody.textContent = '[INFO] Build #' + (latestBuild.buildNumber || 1) + ' (' + latestBuild.id + ')\n[INFO] Status: ' + (latestBuild.status || 'SUCCEEDED') + '\n[INFO] No detailed log lines returned.';
      }
    } else {
      termBody.textContent = '[INFO] No CodeBuild execution logs recorded for ' + _activeProject.name + '.';
    }
  } catch (err) {
    if (termBody) termBody.textContent = 'Failed to load build logs: ' + err.message;
  }

  if (termBody) termBody.scrollTop = termBody.scrollHeight;
  if (icon) {
    setTimeout(function() { icon.classList.remove('animate-spin'); }, 400);
  }
}
