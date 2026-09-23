// Training Adoption Tracker Page — Vanilla JS Logic

var _activeProject = null;

function initTrainingPage() {
  loadProjectThenStats();
}

window.initTrainingPage = initTrainingPage;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initTrainingPage);
} else {
  initTrainingPage();
}

async function loadProjectThenStats() {
  // Resolve active project (same pattern as team-access, dashboard etc.)
  try {
    var res = await api.get('/api/projects');
    if (res && res.projects) {
      _activeProject = res.projects.find(function(p) { return p.isActive; }) || res.projects[0];
    }
  } catch (e) {}
  await loadAdoptionStats();
}

async function loadAdoptionStats() {
  var btn = document.getElementById('refreshBtn');
  var list = document.getElementById('userList');
  var summary = document.getElementById('summaryGrid');
  var projectBadge = document.getElementById('projectNameBadge');

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-2" style="width:15px;height:15px;animation:spin 1s linear infinite;"></i> Loading...';
    if (window.lucide) lucide.createIcons();
  }

  // Show skeleton
  if (list) {
    list.innerHTML =
      '<div class="user-card" style="opacity:0.5;">' +
        '<div class="user-card-header">' +
          '<div class="user-info">' +
            '<div class="avatar skeleton" style="width:42px;height:42px;"></div>' +
            '<div>' +
              '<div class="skeleton" style="height:15px;width:130px;margin-bottom:6px;border-radius:4px;"></div>' +
              '<div class="skeleton" style="height:11px;width:90px;border-radius:4px;"></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="tasks-grid">' +
          '<div class="task-item"><div class="skeleton" style="height:20px;width:20px;border-radius:50%;"></div></div>'.repeat(5) +
        '</div>' +
      '</div>';
  }

  try {
    var url = '/api/adoption/stats';
    if (_activeProject) url += '?projectId=' + encodeURIComponent(_activeProject.id);

    var res = await api.get(url);
    if (!res || !res.ok) throw new Error(res && res.error ? res.error : 'Failed to fetch stats');

    var stats = res.stats || [];

    // Project name badge
    if (projectBadge) projectBadge.textContent = res.projectName || (_activeProject && _activeProject.name) || 'Project';

    // GitHub repo badge
    var repoBadge = document.getElementById('githubRepoBadge');
    if (repoBadge) {
      if (res.githubRepo) {
        repoBadge.style.display = 'inline-flex';
        repoBadge.querySelector('span').textContent = res.githubRepo;
      } else {
        repoBadge.style.display = 'none';
      }
    }

    // Tracking-since badge
    var badge = document.getElementById('trackingSinceBadge');
    var sinceLabel = document.getElementById('trackingSinceLabel');
    if (badge && sinceLabel) {
      if (res.since) {
        sinceLabel.textContent = 'Tracking since: ' + new Date(res.since).toLocaleString();
        badge.style.display = 'inline-flex';
      } else {
        badge.style.display = 'none';
      }
    }

    // Summary cards
    var totalUsers  = stats.length;
    var fullyDone   = stats.filter(function(s) { return s.progress === 100; }).length;
    var avgProgress = totalUsers > 0
      ? Math.round(stats.reduce(function(acc, s) { return acc + s.progress; }, 0) / totalUsers)
      : 0;

    if (summary) {
      summary.innerHTML =
        summaryCard('users', totalUsers, 'Total Members', '#6366f1') +
        summaryCard('check-circle-2', fullyDone, 'Fully Adopted', '#10b981') +
        summaryCard('trending-up', avgProgress + '%', 'Avg Progress', avgProgress >= 60 ? '#10b981' : avgProgress >= 40 ? '#f59e0b' : '#ef4444');
    }

    // User list
    if (!list) return;
    if (totalUsers === 0) {
      list.innerHTML = '<div style="text-align:center;padding:60px;color:var(--color-text-tertiary);font-size:13px;">No members found for this project.</div>';
      return;
    }

    list.innerHTML = stats.map(function(u) { return renderUserCard(u); }).join('');

    if (window.lucide) lucide.createIcons();

  } catch (err) {
    console.error('[training]', err);
    if (list) list.innerHTML = '<div style="color:#ef4444;padding:24px;text-align:center;font-size:13px;">' + escapeHtml(err.message) + '</div>';
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="refresh-cw" style="width:15px;height:15px;"></i> Refresh Data';
      if (window.lucide) lucide.createIcons();
    }
  }
}

function summaryCard(icon, value, label, color) {
  return '<div class="summary-card">' +
    '<div class="header">' +
      '<span class="label">' + label.toUpperCase() + '</span>' +
      '<i data-lucide="' + icon + '" style="width:16px;height:16px;color:' + color + ';"></i>' +
    '</div>' +
    '<div class="value" style="color:' + color + ';">' + value + '</div>' +
  '</div>';
}

function renderUserCard(u) {
  var initials = (u.username || '?').charAt(0).toUpperCase();
  var avatar = u.avatarUrl
    ? '<img src="' + u.avatarUrl + '" alt="" onerror="this.parentNode.textContent=\'' + initials + '\'">'
    : initials;

  var t = u.tasks;

  var progressColor = u.progress === 100 ? '#10b981' : u.progress >= 60 ? '#6366f1' : u.progress >= 40 ? '#f59e0b' : '#ef4444';

  var onlineDot = u.isOnline
    ? '<span style="width:7px;height:7px;border-radius:50%;background:#10b981;display:inline-block;box-shadow:0 0 5px #10b981;" title="Online"></span>'
    : '';

  var roleTag = u.userType
    ? '<span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;background:rgba(99,102,241,0.12);color:#818cf8;letter-spacing:0.3px;">' + escapeHtml(u.userType.replace('_', ' ')) + '</span>'
    : '';

  var ghLink = u.githubUsername
    ? '<a href="https://github.com/' + escapeHtml(u.githubUsername) + '" target="_blank" style="font-size:11px;color:#6366f1;text-decoration:none;">@' + escapeHtml(u.githubUsername) + '</a>'
    : '<span style="font-size:11px;color:#ef4444;">GitHub not linked</span>';

  return '<div class="user-card">' +
    '<div class="user-card-header">' +
      '<div class="user-info">' +
        '<div class="avatar">' + avatar + '</div>' +
        '<div class="user-details">' +
          '<h3>' + escapeHtml(u.username) + ' ' + onlineDot + ' ' + roleTag + '</h3>' +
          '<p>' + ghLink + '</p>' +
        '</div>' +
      '</div>' +
      '<div class="progress-section">' +
        '<div class="progress-text" style="color:' + progressColor + ';">' + u.progress + '% Complete</div>' +
        '<div class="progress-bar-bg">' +
          '<div class="progress-bar-fill" style="width:' + u.progress + '%;background:linear-gradient(90deg,' + progressColor + ',' + progressColor + 'aa);"></div>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '</div>' +
    '<div class="tasks-timeline">' +
      '<div class="timeline-connector"></div>' +
      '<div class="timeline-connector-fill" style="position:absolute;top:42.5px;left:48px;height:3px;width:calc(' + u.progress + '% * 0.86);max-width:calc(100% - 96px);"></div>' +
      taskNode(t.profile, 'Setup Profile',    'user-check') +
      taskNode(t.branch,  'Create Branch',    'git-branch') +
      taskNode(t.commit,  'Commit / Merge',   'git-commit') +
      taskNode(t.pr,      'Pull Request',     'git-pull-request') +
      taskNode(t.deploy,  'Deployment',       'rocket') +
    '</div>' +
  '</div>';
}

function taskNode(isDone, label, icon) {
  var cls = isDone ? 'completed' : 'pending';
  var statusIcon = isDone 
    ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>'
    : '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>';

  return '<div class="task-node ' + cls + '">' +
    '<div class="task-icon-wrap">' +
      '<i data-lucide="' + icon + '" style="width:20px;height:20px;"></i>' +
      '<div class="task-status-badge">' + statusIcon + '</div>' +
    '</div>' +
    '<div class="task-label">' + label + '</div>' +
  '</div>';
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function resetTracking() {
  if (!confirm('Reset adoption tracking for ALL users?\n\nThis sets a new start date — only activity AFTER this point will count.\n\nNo data is deleted.')) return;
  var btn = document.getElementById('resetBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Resetting…'; }
  try {
    var res = await api.post('/api/adoption/reset', {});
    if (!res || !res.ok) throw new Error(res?.error || 'Reset failed');
    alert('✅ Reset successful!\n\nNew tracking start: ' + new Date(res.resetAt).toLocaleString());
    await loadAdoptionStats();
  } catch (err) {
    alert('❌ Reset failed: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="rotate-ccw" style="width:15px;height:15px;"></i> Reset Fresh Start'; if (window.lucide) lucide.createIcons(); }
  }
}
