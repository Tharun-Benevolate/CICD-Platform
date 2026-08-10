function initDashboardPage() {
  loadHealth();
  loadProjects();
  loadPipeline();
  loadRecentActivity();
  loadDeveloperWorkspace();
}

window.initDashboardPage = initDashboardPage;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDashboardPage);
} else {
  initDashboardPage();
}

async function loadDeveloperWorkspace() {
  var devProjectsCount = document.getElementById('dev-projects-count');
  if (!devProjectsCount) return;

  try {
    var projRes = await api.get('/api/projects');
    var projects = projRes.projects || [];
    devProjectsCount.textContent = projects.length + (projects.length === 1 ? ' Project' : ' Projects');

    var activeProject = projects.find(function(p) { return p.isActive; }) || projects[0];

    if (activeProject) {
      try {
        var repoRes = await api.get('/api/repos?projectId=' + activeProject.id);
        var repos = (repoRes && repoRes.repositories) ? repoRes.repositories : [];
        var activeRepo = repos[0];

        var repoEl = document.getElementById('dev-repo-name');
        if (repoEl) {
          repoEl.textContent = activeRepo ? (activeRepo.repo_name || activeRepo.repositoryName || activeRepo.name) : 'No Repo';
        }

        if (activeRepo) {
          loadDeveloperCommits(activeRepo.id, activeProject.id);
        } else {
          var commitsList = document.getElementById('dev-commits-list');
          if (commitsList) {
            commitsList.innerHTML = '<div style="text-align:center;padding:30px;color:var(--color-text-tertiary);font-size:12px;">No repository connected to this project yet.</div>';
          }
        }
      } catch(e) {}

      loadDeveloperPipeline(activeProject);
    } else {
      document.getElementById('dev-repo-name').textContent = 'None Assigned';
      document.getElementById('dev-commits-list').innerHTML = '<div style="text-align:center;padding:30px;color:var(--color-text-tertiary);font-size:12px;">No projects currently assigned to your account.</div>';
      document.getElementById('dev-pipeline-content').innerHTML = '<div style="text-align:center;padding:30px;color:var(--color-text-tertiary);font-size:12px;">No project assigned.</div>';
    }
  } catch(e) {}
}

async function loadDeveloperPipeline(project) {
  var container = document.getElementById('dev-pipeline-content');
  var statusText = document.getElementById('dev-pipeline-status');
  var statusDot = document.getElementById('dev-pipeline-dot');
  if (!container) return;

  var headerBox = '<div style="padding:12px 16px;background:var(--color-bg);border:1px solid var(--color-border);border-radius:10px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;">' +
    '<div>' +
      '<span style="font-size:11px;color:var(--color-text-tertiary);display:block;margin-bottom:2px;font-weight:600;letter-spacing:0.5px;">ACTIVE ASSIGNED PROJECT</span>' +
      '<span style="font-size:14px;font-weight:700;color:var(--color-text-primary);">' + project.name + '</span>' +
    '</div>' +
    '<a href="/file-browser" style="font-size:12px;color:#6366f1;text-decoration:none;font-weight:600;display:inline-flex;align-items:center;gap:4px;">' +
      'Browse Files →' +
    '</a>' +
  '</div>';

  try {
    var res = await api.get('/api/pipeline/status?projectId=' + project.id);
    if (res && res.ok && res.stageStates && res.stageStates.length > 0) {
      var succeededCount = 0;
      var stagesHtml = res.stageStates.slice(0, 4).map(function(stg) {
        var status = stg.latestExecution ? stg.latestExecution.status : 'Idle';
        if (status === 'Succeeded') succeededCount++;
        var isSucc = status === 'Succeeded';
        return '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border:1px solid var(--color-border);border-radius:8px;background:var(--color-surface);">' +
          '<div style="display:flex;align-items:center;gap:10px;">' +
            '<i data-lucide="' + (isSucc ? 'check-circle-2' : 'clock') + '" style="width:16px;height:16px;color:' + (isSucc ? '#10b981' : '#94a3b8') + ';"></i>' +
            '<span style="font-size:13px;font-weight:600;color:var(--color-text-primary);">' + stg.stageName + '</span>' +
          '</div>' +
          '<span style="font-size:11px;padding:3px 10px;border-radius:12px;font-weight:700;background:' + (isSucc ? 'rgba(16,185,129,0.12)' : 'var(--color-bg)') + ';color:' + (isSucc ? '#10b981' : 'var(--color-text-secondary)') + ';">' +
            status +
          '</span>' +
        '</div>';
      }).join('');

      container.innerHTML = headerBox + '<div style="display:flex;flex-direction:column;gap:8px;">' + stagesHtml + '</div>';

      if (statusText) statusText.textContent = succeededCount === res.stageStates.length ? 'Pipeline Healthy' : 'Idle / Ready';
      if (statusDot) statusDot.style.background = succeededCount === res.stageStates.length ? '#10b981' : '#6366f1';
    } else {
      container.innerHTML = headerBox + '<div style="text-align:center;padding:24px 12px;color:var(--color-text-secondary);font-size:13px;line-height:1.5;">Pipeline is ready & configured on default branch (main).</div>';
      if (statusText) statusText.textContent = 'Idle / Ready';
      if (statusDot) statusDot.style.background = '#10b981';
    }
  } catch(e) {
    container.innerHTML = headerBox + '<div style="text-align:center;padding:24px 12px;color:var(--color-text-tertiary);font-size:12px;">Pipeline status check ready.</div>';
  }
  if (window.lucide) lucide.createIcons();
}

async function loadDeveloperCommits(repoId, projectId) {
  var container = document.getElementById('dev-commits-list');
  if (!container) return;

  try {
    var params = new URLSearchParams({ repositoryId: repoId, limit: '5' });
    if (projectId) params.set('projectId', projectId);
    var res = await api.get('/api/commits/by-repo?' + params.toString());

    if (res && res.ok && res.commits && res.commits.length > 0) {
      var commits = res.commits.slice(0, 5);
      container.innerHTML = commits.map(function(c) {
        var sha = (c.sha || c.commitId || '').substring(0, 7);
        var msg = c.message || (c.commit && c.commit.message) || 'No message';
        var firstLine = msg.split('\n')[0];
        if (firstLine.length > 42) firstLine = firstLine.substring(0, 42) + '…';
        var author = c.author || (c.commit && c.commit.author && c.commit.author.name) || 'Developer';
        var dateStr = c.date ? new Date(c.date).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Recent';

        return '<div style="padding:10px 14px;border:1px solid var(--color-border);border-radius:10px;background:var(--color-surface);display:flex;align-items:center;justify-content:space-between;gap:12px;">' +
          '<div style="min-width:0;flex:1;">' +
            '<div style="font-size:13px;font-weight:600;color:var(--color-text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + firstLine + '</div>' +
            '<div style="font-size:11px;color:var(--color-text-tertiary);margin-top:3px;display:flex;align-items:center;gap:6px;">' +
              '<span>' + author + '</span> &bull; <span>' + dateStr + '</span>' +
            '</div>' +
          '</div>' +
          '<span style="font-family:monospace;font-size:11px;font-weight:700;padding:3px 8px;background:rgba(99,102,241,0.1);color:#6366f1;border-radius:6px;flex-shrink:0;">' +
            sha +
          '</span>' +
        '</div>';
      }).join('');
    } else {
      container.innerHTML = '<div style="text-align:center;padding:30px;color:var(--color-text-tertiary);font-size:12px;">No recent commits found in repository.</div>';
    }
  } catch(e) {
    container.innerHTML = '<div style="text-align:center;padding:30px;color:var(--color-text-tertiary);font-size:12px;">Unable to load recent commits.</div>';
  }
}


async function loadHealth() {
  try {
    var res = await api.get('/api/health');
    // Database
    var dbOk = res.db && res.db !== 'error';
    document.getElementById('db-dot').style.background = dbOk ? 'var(--color-success)' : 'var(--color-danger)';
    document.getElementById('db-status').textContent = dbOk ? 'Connected (MySQL)' : 'Offline';
    if (dbOk && res.db) {
      document.getElementById('db-host').textContent = res.db;
    }
    // AWS
    var awsOk = res.aws === 'ok' || res.aws === 'configured';
    document.getElementById('aws-dot').style.background = awsOk ? 'var(--color-success)' : 'var(--color-warning)';
    document.getElementById('aws-status').textContent = awsOk ? 'Connected (us-east-1)' : 'Unreachable';
    // Uptime
    if (res.uptime) {
      document.getElementById('uptime-value').textContent = Math.floor(res.uptime / 60) + ' min';
    }
  } catch(e) {
    document.getElementById('db-status').textContent = 'Error';
    document.getElementById('db-dot').style.background = 'var(--color-danger)';
  }
}

async function loadProjects() {
  try {
    var res = await api.get('/api/projects');
    if (res.projects) {
      document.getElementById('projects-count').textContent = res.projects.length + ' Active';
      // Deployment endpoint
      var active = res.projects.find(function(p) { return p.isActive; });
      if (active) {
        var el = document.getElementById('deploy-endpoint');
        el.style.display = 'flex';
        var name = active.name.toLowerCase().replace(/[^a-z0-9]/g, '');
        document.getElementById('deploy-endpoint-text').innerHTML =
          name + '.benevolate.internal:8080 &bull; <span style="color:var(--color-text-tertiary);">Not Deployed / Pending Pipeline Setup</span>';
      }
    }
  } catch(e) {}
}

async function loadPipeline() {
  var container = document.getElementById('pipeline-content');
  if (!container) return;
  try {
    var projRes = await api.get('/api/projects');
    var active = projRes.projects ? projRes.projects.find(function(p) { return p.isActive; }) : null;
    if (active) {
      var projectBlock = '<div style="padding:10px 14px;background:var(--color-bg);border-radius:10px;margin-bottom:14px;">' +
        '<span style="font-size:11px;color:var(--color-text-tertiary);display:block;margin-bottom:2px;">Project</span>' +
        '<span style="font-size:13px;font-weight:700;color:var(--color-text-primary);">' + active.name + '</span>' +
      '</div>';

      try {
        var res = await api.get('/api/pipeline/status?projectId=' + active.id);
        if (res.ok && res.stageStates && res.stageStates.length > 0) {
          var stages = res.stageStates.slice(0, 3).map(function(stg) {
            var succeeded = stg.latestExecution && stg.latestExecution.status === 'Succeeded';
            return '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border:1px solid var(--color-border);border-radius:8px;">' +
              '<span style="font-size:12px;font-weight:600;">' + stg.stageName + '</span>' +
              '<span style="font-size:11px;padding:2px 8px;border-radius:12px;font-weight:700;background:' + (succeeded ? 'rgba(16,185,129,0.12)' : 'var(--color-surface)') + ';color:' + (succeeded ? '#10b981' : 'var(--color-text-secondary)') + ';">' +
                (stg.latestExecution ? stg.latestExecution.status : 'Idle') +
              '</span>' +
            '</div>';
          }).join('');
          container.innerHTML = projectBlock + '<div style="display:flex;flex-direction:column;gap:8px;">' + stages + '</div>';
        } else {
          container.innerHTML = projectBlock + '<div style="text-align:center;padding:32px 12px;color:var(--color-text-tertiary);font-size:12px;">No active execution running for this project.</div>';
        }
      } catch(e) {
        container.innerHTML = projectBlock + '<div style="text-align:center;padding:32px 12px;color:var(--color-text-tertiary);font-size:12px;">No active execution running for this project.</div>';
      }
    } else {
      container.innerHTML = '<div style="padding:40px 12px;text-align:center;color:var(--color-text-tertiary);font-size:12px;">No active pipeline found for this project.</div>';
    }
    if (window.lucide) lucide.createIcons();
  } catch(e) {
    container.innerHTML = '<div style="padding:40px 12px;text-align:center;color:var(--color-text-tertiary);font-size:12px;">No active pipeline found for this project.</div>';
  }
}

async function loadRecentActivity() {
  var container = document.getElementById('recent-activity');
  if (!container) return;
  try {
    var res = await api.get('/api/audit-logs?limit=3');
    if (res.ok && res.logs && res.logs.length > 0) {
      var topLogs = res.logs.slice(0, 3);
      container.innerHTML = topLogs.map(function(log, i) {
        return '<div style="padding:8px 10px;' + (i < topLogs.length - 1 ? 'border-bottom:1px solid var(--color-border);' : '') + 'display:flex;align-items:flex-start;justify-content:space-between;">' +
          '<div>' +
            '<div style="font-size:12px;font-weight:600;color:var(--color-text-primary);">' + (log.action || '') + '</div>' +
            '<div style="font-size:11px;color:var(--color-text-tertiary);margin-top:2px;">' + (log.username || '') + ' &bull; ' + (log.category || 'Login') + '</div>' +
          '</div>' +
          '<span style="font-size:10px;color:var(--color-text-tertiary);flex-shrink:0;margin-left:8px;">' +
            (log.timestamp ? new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '') +
          '</span>' +
        '</div>';
      }).join('');
    } else {
      container.innerHTML = '<div style="padding:40px 12px;text-align:center;color:var(--color-text-tertiary);font-size:12px;">No audit logs recorded yet.</div>';
    }
  } catch(e) {
    container.innerHTML = '<div style="padding:40px 12px;text-align:center;color:var(--color-text-tertiary);font-size:12px;">No audit logs recorded yet.</div>';
  }
}
