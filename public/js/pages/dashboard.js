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

  var headerBox = '<div class="dash-pipeline-meta-bar">' +
    '<div class="dash-pipeline-meta-left">' +
      '<i data-lucide="folder-git-2" class="dash-pipeline-meta-icon"></i>' +
      '<div>' +
        '<span class="dash-pipeline-meta-label">Assigned Project</span>' +
        '<span class="dash-pipeline-meta-name">' + project.name + '</span>' +
      '</div>' +
    '</div>' +
    '<a href="/file-browser" class="dash-panel-link">Browse Files <i data-lucide="arrow-right" style="width:12px;height:12px;"></i></a>' +
  '</div>';

  try {
    var res = await api.get('/api/pipeline/status?projectId=' + project.id);
    if (res && res.ok && res.stageStates && res.stageStates.length > 0) {
      var succeededCount = 0;
      var stagesHtml = res.stageStates.slice(0, 4).map(function(stg, i) {
        var status = stg.latestExecution ? stg.latestExecution.status : 'Idle';
        if (status === 'Succeeded') succeededCount++;
        var isSucc = status === 'Succeeded';
        return '<div class="dash-pipeline-stage-item">' +
          '<div class="dash-stage-left">' +
            '<span class="dash-stage-step-index">' + (i + 1) + '</span>' +
            '<span class="dash-stage-name">' + stg.stageName + '</span>' +
          '</div>' +
          '<span class="dash-stage-badge ' + (isSucc ? 'is-success' : 'is-idle') + '">' +
            '<i data-lucide="' + (isSucc ? 'check' : 'clock') + '" style="width:12px;height:12px;"></i>' +
            status +
          '</span>' +
        '</div>';
      }).join('');

      container.innerHTML = headerBox + '<div class="dash-pipeline-stages-list">' + stagesHtml + '</div>';

      if (statusText) statusText.textContent = succeededCount === res.stageStates.length ? 'Healthy' : 'Idle / Ready';
      if (statusDot) statusDot.style.background = succeededCount === res.stageStates.length ? '#10b981' : 'var(--color-primary)';
    } else {
      container.innerHTML = headerBox + '<div class="dash-empty-state"><i data-lucide="info" class="dash-empty-icon"></i><span>Pipeline configured and idle on default branch.</span></div>';
      if (statusText) statusText.textContent = 'Idle / Ready';
      if (statusDot) statusDot.style.background = '#10b981';
    }
  } catch(e) {
    container.innerHTML = headerBox + '<div class="dash-empty-state"><i data-lucide="alert-circle" class="dash-empty-icon"></i><span>Unable to load pipeline status.</span></div>';
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
      container.innerHTML = '<div style="display:flex;flex-direction:column;gap:8px;">' + commits.map(function(c) {
        var sha = (c.sha || c.commitId || '').substring(0, 7);
        var msg = c.message || (c.commit && c.commit.message) || 'No message';
        var firstLine = msg.split('\n')[0];
        if (firstLine.length > 42) firstLine = firstLine.substring(0, 42) + '…';
        var author = c.authorName || c.authorLogin || (c.author && (c.author.login || c.author.name || (typeof c.author === 'string' ? c.author : null))) || (c.commit && c.commit.author && (c.commit.author.name || c.commit.author.login)) || c.committerName || 'Unknown';
        var dateStr = c.date ? new Date(c.date).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Recent';

        return '<div class="dash-commit-item">' +
          '<div class="dash-commit-info">' +
            '<div class="dash-commit-msg">' + firstLine + '</div>' +
            '<div class="dash-commit-meta">' +
              '<span>' + author + '</span> &bull; <span>' + dateStr + '</span>' +
            '</div>' +
          '</div>' +
          '<span class="dash-commit-sha font-mono">' + sha + '</span>' +
        '</div>';
      }).join('') + '</div>';
    } else {
      container.innerHTML = '<div class="dash-empty-state"><i data-lucide="git-commit" class="dash-empty-icon"></i><span>No recent commits recorded.</span></div>';
    }
  } catch(e) {
    container.innerHTML = '<div class="dash-empty-state"><i data-lucide="alert-circle" class="dash-empty-icon"></i><span>Unable to load recent commits.</span></div>';
  }
  if (window.lucide) lucide.createIcons();
}


async function loadHealth() {
  try {
    var res = await api.get('/api/health');
    // Database
    var dbOk = res.db && res.db !== 'error';
    document.getElementById('db-dot').style.background = dbOk ? 'var(--color-success)' : 'var(--color-danger)';
    document.getElementById('db-status').textContent = dbOk ? 'Connected (MySQL)' : 'Offline';
    if (dbOk && res.db) {
      var dbHostLabel = res.db;
      if (typeof dbHostLabel === 'string' && (dbHostLabel.includes('.rds.amazonaws.com') || dbHostLabel.includes(':3306') || /^\d+\.\d+\.\d+\.\d+/.test(dbHostLabel))) {
        dbHostLabel = 'ONLINE (ACTIVE)';
      }
      document.getElementById('db-host').textContent = dbHostLabel;
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
      var active = res.projects.find(function(p) { return p.isActive; });
      if (active) {
        var el = document.getElementById('deploy-endpoint');
        el.style.display = 'flex';
        loadEnvStatus(active);
      }
    }
  } catch(e) {}
}

async function loadEnvStatus(project) {
  var container = document.getElementById('deploy-endpoint-text');
  if (!container) return;

  var ecsSvg = '<svg class="dash-ecs-logo-icon" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<rect width="40" height="40" rx="8" fill="#1e293b"/>' +
    '<path d="M8 12h24M8 20h24M8 28h24" stroke="#f59e0b" stroke-width="2.5" stroke-linecap="round"/>' +
    '<circle cx="13" cy="12" r="2.5" fill="#f59e0b"/>' +
    '<circle cx="13" cy="20" r="2.5" fill="#f59e0b"/>' +
    '<circle cx="13" cy="28" r="2.5" fill="#f59e0b"/>' +
    '</svg>';

  // Skeleton placeholders
  container.innerHTML = ['DEV', 'UAT', 'PROD'].map(function() {
    return '<div class="dash-ecs-tile" style="min-height:104px;opacity:0.6;animation:pulse 1.5s ease-in-out infinite;"></div>';
  }).join('');

  try {
    var res = await api.get('/api/ecs/all-envs?projectId=' + project.id);
    if (!res || !res.ok || !res.envs) {
      container.innerHTML = '<div class="dash-empty-state"><i data-lucide="info" class="dash-empty-icon"></i><span>No environment telemetry available</span></div>';
      if (window.lucide) lucide.createIcons();
      return;
    }

    var deployClassMap = {
      deployed: 'status-deployed',
      failed: 'status-failed',
      'in-progress': 'status-deploying',
      'not-deployed': 'status-not-deployed',
      'no-pipeline': 'status-not-deployed'
    };
    var deployLabelMap = {
      deployed: 'Deployed',
      failed: 'Deploy Failed',
      'in-progress': 'Deploying',
      'not-deployed': 'Not Deployed',
      'no-pipeline': 'No Pipeline'
    };

    var cards = res.envs.map(function(env) {
      var ds = env.deployStatus || 'not-deployed';
      var statusClass = deployClassMap[ds] || 'status-not-deployed';
      var label = deployLabelMap[ds] || ds;
      var isActive = ds === 'deployed';
      var envLabel = env.env.toUpperCase();

      var taskText = env.configured ? (env.running + '/' + env.desired + ' Active Tasks') : 'Not Configured';

      var displayUrl = env.url ? env.url.replace(/^https?:\/\//, '').replace(/\/$/, '') : null;
      var shortUrl = displayUrl && displayUrl.length > 28 ? displayUrl.slice(0, 26) + '…' : (displayUrl || 'No Endpoint');
      var hrefUrl = env.url ? (env.url.startsWith('http') ? env.url : 'https://' + env.url) : '#';

      var targetAttr = (env.url && isActive) ? 'target="_blank" rel="noopener"' : '';
      var tileTag = (env.url && isActive) ? 'a' : 'div';

      return '<' + tileTag + ' href="' + hrefUrl + '" ' + targetAttr + ' class="dash-ecs-tile ' + (isActive ? 'is-deployed' : '') + '">' +
        '<div class="dash-ecs-tile-top">' +
          '<div class="dash-ecs-badge-tag">' +
            ecsSvg +
            '<span class="dash-ecs-env-title">' + envLabel + '</span>' +
          '</div>' +
          '<span class="dash-ecs-beacon ' + (isActive ? 'is-active' : '') + '"></span>' +
        '</div>' +
        '<div class="dash-ecs-tile-mid">' +
          '<div class="dash-ecs-status-pill ' + statusClass + '">' +
            '<i data-lucide="' + (isActive ? 'check' : (ds === 'failed' ? 'alert-triangle' : 'circle-dashed')) + '" style="width:12px;height:12px;"></i>' +
            '<span>' + label + '</span>' +
          '</div>' +
          '<div class="dash-ecs-tasks">' + taskText + '</div>' +
        '</div>' +
        '<div class="dash-ecs-tile-bottom" title="' + (displayUrl || '') + '">' +
          '<i data-lucide="globe"></i>' +
          '<span>' + shortUrl + '</span>' +
        '</div>' +
      '</' + tileTag + '>';
    }).join('');

    container.innerHTML = cards;
    if (window.lucide) lucide.createIcons();
  } catch(e) {
    container.innerHTML = '<div class="dash-empty-state"><i data-lucide="alert-circle" class="dash-empty-icon"></i><span>Unable to load container environments</span></div>';
    if (window.lucide) lucide.createIcons();
  }
}

async function loadPipeline() {
  var container = document.getElementById('pipeline-content');
  if (!container) return;
  try {
    var projRes = await api.get('/api/projects');
    var active = projRes.projects ? projRes.projects.find(function(p) { return p.isActive; }) : null;
    if (active) {
      var projectBlock = '<div class="dash-pipeline-meta-bar">' +
        '<div class="dash-pipeline-meta-left">' +
          '<i data-lucide="folder-git-2" class="dash-pipeline-meta-icon"></i>' +
          '<div>' +
            '<span class="dash-pipeline-meta-label">Active Project</span>' +
            '<span class="dash-pipeline-meta-name">' + active.name + '</span>' +
          '</div>' +
        '</div>' +
        '<span class="dash-pipeline-meta-badge">Default Branch</span>' +
      '</div>';

      try {
        var res = await api.get('/api/pipeline/status?projectId=' + active.id);
        if (res.ok && res.stageStates && res.stageStates.length > 0) {
          var stages = res.stageStates.slice(0, 3).map(function(stg, i) {
            var succeeded = stg.latestExecution && stg.latestExecution.status === 'Succeeded';
            var statusLabel = stg.latestExecution ? stg.latestExecution.status : 'Idle';
            return '<div class="dash-pipeline-stage-item">' +
              '<div class="dash-stage-left">' +
                '<span class="dash-stage-step-index">' + (i + 1) + '</span>' +
                '<span class="dash-stage-name">' + stg.stageName + '</span>' +
              '</div>' +
              '<span class="dash-stage-badge ' + (succeeded ? 'is-success' : 'is-idle') + '">' +
                '<i data-lucide="' + (succeeded ? 'check' : 'clock') + '" style="width:12px;height:12px;"></i>' +
                statusLabel +
              '</span>' +
            '</div>';
          }).join('');
          container.innerHTML = projectBlock + '<div class="dash-pipeline-stages-list">' + stages + '</div>';
        } else {
          container.innerHTML = projectBlock + '<div class="dash-empty-state"><i data-lucide="info" class="dash-empty-icon"></i><span>No active execution running for this project.</span></div>';
        }
      } catch(e) {
        container.innerHTML = projectBlock + '<div class="dash-empty-state"><i data-lucide="info" class="dash-empty-icon"></i><span>No active execution running for this project.</span></div>';
      }
    } else {
      container.innerHTML = '<div class="dash-empty-state"><i data-lucide="folder-x" class="dash-empty-icon"></i><span>No active pipeline found for this project.</span></div>';
    }
    if (window.lucide) lucide.createIcons();
  } catch(e) {
    container.innerHTML = '<div class="dash-empty-state"><i data-lucide="alert-circle" class="dash-empty-icon"></i><span>No active pipeline found for this project.</span></div>';
    if (window.lucide) lucide.createIcons();
  }
}

async function loadRecentActivity() {
  var container = document.getElementById('recent-activity');
  if (!container) return;
  try {
    var res = await api.get('/api/audit-logs?limit=4');
    if (res.ok && res.logs && res.logs.length > 0) {
      var topLogs = res.logs.slice(0, 4);
      var rows = topLogs.map(function(log) {
        var action = log.action || 'User activity';
        var isLogin = action.toLowerCase().includes('login') || action.toLowerCase().includes('logged');
        var iconName = isLogin ? 'log-in' : 'shield';
        var timeStr = log.timestamp ? new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        return '<div class="dash-activity-item">' +
          '<div class="dash-activity-left">' +
            '<div class="dash-activity-icon-wrap">' +
              '<i data-lucide="' + iconName + '"></i>' +
            '</div>' +
            '<div class="dash-activity-info">' +
              '<span class="dash-activity-title">' + action + '</span>' +
              '<span class="dash-activity-meta">' + (log.username || 'System') + ' &bull; ' + (log.category || 'Audit') + '</span>' +
            '</div>' +
          '</div>' +
          '<span class="dash-activity-time">' + timeStr + '</span>' +
        '</div>';
      }).join('');
      container.innerHTML = '<div class="dash-activity-list">' + rows + '</div>';
    } else {
      container.innerHTML = '<div class="dash-empty-state"><i data-lucide="shield-check" class="dash-empty-icon"></i><span>No audit logs recorded yet.</span></div>';
    }
    if (window.lucide) lucide.createIcons();
  } catch(e) {
    container.innerHTML = '<div class="dash-empty-state"><i data-lucide="alert-circle" class="dash-empty-icon"></i><span>Unable to load recent activity.</span></div>';
    if (window.lucide) lucide.createIcons();
  }
}
