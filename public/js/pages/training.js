// Training Adoption Tracker Page — Vanilla JS Logic

var _activeProject = null;
var _syncTimer = null;

function initTrainingPage() {
  loadProjectThenStats();
  if (!_syncTimer) {
    _syncTimer = setInterval(function() {
      if (document.visibilityState === 'visible') {
        loadAdoptionStats(true);
      }
    }, 45000);
  }
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

async function loadAdoptionStats(isBackground) {
  var btn = document.getElementById('refreshBtn');
  var list = document.getElementById('userList');
  var summary = document.getElementById('summaryGrid');
  var projectBadge = document.getElementById('projectNameBadge');

  if (btn && !isBackground) {
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-2" style="width:15px;height:15px;animation:spin 1s linear infinite;"></i> Loading...';
    if (window.lucide) lucide.createIcons();
  }

  // Save expanded states if background sync
  var expandedUsernames = [];
  if (isBackground && list) {
    var cards = list.querySelectorAll('.user-card.expanded h3');
    for (var i = 0; i < cards.length; i++) {
      expandedUsernames.push(cards[i].textContent.trim().split(' ')[0]);
    }
  }

  // Show skeleton
  if (list && !isBackground && (!window._allStats || window._allStats.length === 0)) {
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
    window._allStats = stats;

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

    applyFilters(expandedUsernames);

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

function applyFilters(expandedUsernames) {
  expandedUsernames = expandedUsernames || [];
  if (!window._allStats) return;
  var list = document.getElementById('userList');
  if (!list) return;

  var searchQ = (document.getElementById('filterSearch') ? document.getElementById('filterSearch').value.toLowerCase().trim() : '');
  var roleQ   = (document.getElementById('filterRole')   ? document.getElementById('filterRole').value : '');
  var statusQ = (document.getElementById('filterStatus') ? document.getElementById('filterStatus').value : '');
  var sortQ   = (document.getElementById('sortProgress') ? document.getElementById('sortProgress').value : 'desc');

  var filtered = window._allStats.filter(function(u) {
    var matchSearch = !searchQ || 
                      u.username.toLowerCase().includes(searchQ) || 
                      (u.githubUsername && u.githubUsername.toLowerCase().includes(searchQ));
    var matchRole = !roleQ || u.userType === roleQ;
    
    var matchStatus = true;
    if (statusQ === '100') matchStatus = u.progress === 100;
    else if (statusQ === 'progress') matchStatus = u.progress > 0 && u.progress < 100;
    else if (statusQ === '0') matchStatus = u.progress === 0;

    return matchSearch && matchRole && matchStatus;
  });

  filtered.sort(function(a, b) {
    if (sortQ === 'desc') return b.progress - a.progress;
    if (sortQ === 'asc') return a.progress - b.progress;
    if (sortQ === 'name') return a.username.localeCompare(b.username);
    return 0;
  });

  if (filtered.length === 0) {
    list.innerHTML = '<div style="text-align:center;padding:60px;color:var(--color-text-tertiary);font-size:13px;">No users match your filters.</div>';
  } else {
    list.innerHTML = filtered.map(function(u) {
      var isExpanded = expandedUsernames.includes(u.username);
      return renderUserCard(u, isExpanded);
    }).join('');
    if (window.lucide) lucide.createIcons();
  }
}
window.applyFilters = applyFilters;

function renderUserCard(u, isExpanded) {
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

  var commitHtml = '';
  if (u.details && u.details.commits && u.details.commits.length > 0) {
    commitHtml = u.details.commits.map(function(c) {
      return '<div class="feed-item">' +
        '<span class="feed-hash">' + escapeHtml((c.sha || '').substring(0, 7)) + '</span>' +
        '<div class="feed-msg">' + escapeHtml(c.message) + '</div>' +
        '<div class="feed-date">' + new Date(c.date).toLocaleString() + '</div>' +
      '</div>';
    }).join('');
  } else {
    commitHtml = '<div class="feed-msg" style="opacity:0.5;">No GitHub commits found for this user in this project since tracking started.</div>';
  }

  var auditHtml = '';
  if (u.details && u.details.auditLogs && u.details.auditLogs.length > 0) {
    auditHtml = u.details.auditLogs.map(function(l) {
      return '<div class="feed-item">' +
        '<div class="feed-msg">' + escapeHtml(l.action) + '</div>' +
        '<div class="feed-date">' + new Date(l.timestamp).toLocaleString() + '</div>' +
      '</div>';
    }).join('');
  } else {
    auditHtml = '<div class="feed-msg" style="opacity:0.5;">No terminal logs found for git commits.</div>';
  }

  var panelHtml = '<div class="user-details-panel" onclick="event.stopPropagation()">' +
    '<div class="details-grid">' +
      '<div class="feed-section">' +
        '<div class="feed-title"><i data-lucide="github" style="width:14px;height:14px;"></i> GitHub Commits Feed</div>' +
        commitHtml +
      '</div>' +
      '<div class="feed-section">' +
        '<div class="feed-title"><i data-lucide="terminal" style="width:14px;height:14px;"></i> Platform Audit Logs (Proof)</div>' +
        auditHtml +
      '</div>' +
    '</div>' +
    '<div style="margin-top:20px;text-align:right;">' +
      '<button class="btn-secondary" onclick="resetUserTracking(\'' + escapeHtml(u.username) + '\')" style="font-size:12px;padding:6px 12px;border-color:rgba(239,68,68,0.3);color:#ef4444;background:rgba(239,68,68,0.05);">' +
        '<i data-lucide="rotate-ccw" style="width:12px;height:12px;margin-right:4px;"></i> Reset User Timeline' +
      '</button>' +
    '</div>' +
  '</div>';

  var expandedCls = isExpanded ? ' expanded' : '';
  return '<div class="user-card' + expandedCls + '" onclick="this.classList.toggle(\'expanded\')">' +
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
    '<div class="tasks-timeline">' +
      taskNode(t.profile, 'Setup Profile',    'user-check') +
      '<div class="timeline-segment ' + (t.profile && t.branch ? 'done' : '') + '"></div>' +
      taskNode(t.branch,  'Create Branch',    'git-branch') +
      '<div class="timeline-segment ' + (t.branch && t.commit ? 'done' : '') + '"></div>' +
      taskNode(t.commit,  'Commit / Merge',   'git-commit') +
      '<div class="timeline-segment ' + (t.commit && t.pr ? 'done' : '') + '"></div>' +
      taskNode(t.pr,      'Pull Request',     'git-pull-request') +
      '<div class="timeline-segment ' + (t.pr && t.deploy ? 'done' : '') + '"></div>' +
      taskNode(t.deploy,  'Deployment',       'rocket') +
    '</div>' +
    panelHtml +
  '</div>';
}

async function resetUserTracking(username) {
  if (!confirm('Are you sure you want to reset GitHub tracking data for ' + username + '?')) return;
  try {
    var res = await api.post('/api/adoption/reset', { username: username });
    if (res.ok) {
      loadAdoptionStats();
    } else {
      alert(res.error || 'Failed to reset user tracking');
    }
  } catch (err) {
    alert(err.message);
  }
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
