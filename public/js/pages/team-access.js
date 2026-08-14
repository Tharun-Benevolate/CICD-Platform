// Team Access Page — Vanilla JS Logic
var _activeProject = null;
var _allUsers = [];
var _projectMembers = [];
var _tempSelectedUsernames = [];
var _activeGroupTab = 'all';

window.initTeamPage = initTeamPage;
window.initTeamAccessPage = initTeamPage;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initTeamPage);
} else {
  initTeamPage();
}

// ─────────────────────────────────────────────────────────────────
// Init & Data Fetch
// ─────────────────────────────────────────────────────────────────
async function initTeamPage() {
  try {
    var res = await api.get('/api/projects');
    if (res && res.projects) {
      _activeProject = res.projects.find(function(p) { return p.isActive; }) || res.projects[0];
    }
  } catch (e) {}

  var badge = document.getElementById('team-project-badge');
  if (badge && _activeProject) badge.textContent = _activeProject.name;

  fetchTeamData();
}

async function fetchTeamData() {
  var loadingEl = document.getElementById('team-loading');
  var layoutEl  = document.getElementById('team-main-layout');

  if (loadingEl) loadingEl.style.display = 'flex';
  if (layoutEl)  layoutEl.style.display  = 'none';

  try {
    var userRes = await api.get('/api/users');
    _allUsers = (userRes && userRes.ok && userRes.users) ? userRes.users : [];

    if (_activeProject) {
      var memRes = await api.get('/api/projects/' + _activeProject.id + '/members');
      if (memRes && memRes.ok && memRes.members) {
        _projectMembers = memRes.members
          .filter(function(m) { return m.username !== 'admin' && m.userType !== 'super_admin'; })
          .sort(function(a, b) { return (b.isOnline ? 1 : 0) - (a.isOnline ? 1 : 0); });
      } else {
        _projectMembers = [];
      }
    } else {
      _projectMembers = [];
    }
  } catch (e) {
    _projectMembers = [];
  }

  if (loadingEl) loadingEl.style.display = 'none';
  renderTeamPage();
}

// ─────────────────────────────────────────────────────────────────
// Tabs
// ─────────────────────────────────────────────────────────────────
function setTeamGroupTab(tab) {
  _activeGroupTab = tab;

  ['all', 'devops', 'frontend'].forEach(function(t) {
    var btn = document.getElementById('group-tab-' + t);
    if (!btn) return;
    if (t === tab) {
      btn.style.borderColor = '#6366f1';
      btn.style.background  = 'rgba(99,102,241,0.07)';
      btn.style.color       = '#6366f1';
      btn.style.fontWeight  = '700';
    } else {
      btn.style.borderColor = 'var(--color-border)';
      btn.style.background  = 'var(--color-surface)';
      btn.style.color       = 'var(--color-text-secondary)';
      btn.style.fontWeight  = '600';
    }
  });
  renderTeamPage();
}

// ─────────────────────────────────────────────────────────────────
// Avatar helper
// ─────────────────────────────────────────────────────────────────
function makeAvatarHtml(u, size) {
  size = size || 38;
  var githubLogin = u.githubUsername || null;
  var initial = (u.username || 'U').charAt(0).toUpperCase();
  if (githubLogin) {
    return '<img src="https://github.com/' + githubLogin + '.png?size=80" ' +
      'alt="' + initial + '" ' +
      'style="width:' + size + 'px;height:' + size + 'px;border-radius:50%;object-fit:cover;" ' +
      'onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\';" />' +
      '<div style="width:' + size + 'px;height:' + size + 'px;border-radius:50%;background:#6366f1;color:white;display:none;align-items:center;justify-content:center;font-weight:800;font-size:' + Math.round(size * 0.42) + 'px;flex-shrink:0;">' + initial + '</div>';
  }
  return '<div style="width:' + size + 'px;height:' + size + 'px;border-radius:50%;background:#e5e7eb;color:#374151;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:' + Math.round(size * 0.42) + 'px;flex-shrink:0;">' + initial + '</div>';
}

function roleLabel(u) {
  if (u.jobTitle) return u.jobTitle;
  if (u.userType === 'devops') return 'DevOps Engineer';
  if (u.userType === 'super_admin') return 'Super Admin';
  if (u.userType === 'developer') return 'Developer';
  return u.userType || 'Engineer';
}

// ─────────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────────
function renderTeamPage() {
  var layoutEl  = document.getElementById('team-main-layout');
  var listEl    = document.getElementById('team-members-list');
  var emptyEl   = document.getElementById('team-empty');
  var titleEl   = document.getElementById('team-members-title');
  var countAll  = document.getElementById('team-all-count');
  var countDev  = document.getElementById('team-devops-count');
  var countFe   = document.getElementById('team-frontend-count');

  // Filter by tab
  var devopsMembers    = _projectMembers.filter(function(m) { return m.userType === 'devops'; });
  var frontendMembers  = _projectMembers.filter(function(m) { return m.userType === 'developer'; });

  if (countAll) countAll.textContent = '(' + _projectMembers.length + ')';
  if (countDev) countDev.textContent = devopsMembers.length;
  if (countFe)  countFe.textContent  = frontendMembers.length;

  var displayed = _activeGroupTab === 'devops'   ? devopsMembers :
                  _activeGroupTab === 'frontend'  ? frontendMembers :
                  _projectMembers;

  if (titleEl) titleEl.textContent = 'Project Members (' + displayed.length + ')';

  if (!listEl) return;
  listEl.innerHTML = '';

  if (displayed.length === 0) {
    if (emptyEl) emptyEl.style.display = 'block';
  } else {
    if (emptyEl) emptyEl.style.display = 'none';

    displayed.forEach(function(m) {
      var isOnline = !!m.isOnline;
      var role     = roleLabel(m);
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:10px;cursor:pointer;transition:background 0.12s;border:1px solid transparent;';
      row.onmouseenter = function() { this.style.background = 'var(--color-bg)'; this.style.borderColor = 'var(--color-border)'; };
      row.onmouseleave = function() { this.style.background = 'transparent'; this.style.borderColor = 'transparent'; };
      row.onclick      = function() { openMemberDetailsModal(m.username); };

      row.innerHTML =
        '<div style="display:flex;align-items:center;gap:2px;">' + makeAvatarHtml(m, 38) + '</div>' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="display:flex;align-items:center;gap:8px;">' +
            '<span style="font-weight:700;font-size:14px;color:var(--color-text-primary);">' + (m.username) + '</span>' +
            '<span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:' +
              (isOnline ? 'rgba(16,185,129,0.15)' : 'rgba(255,255,255,0.06)') + ';color:' + (isOnline ? '#10b981' : 'var(--color-text-tertiary)') + ';">' +
              (isOnline ? 'Online' : 'Offline') +
            '</span>' +
          '</div>' +
          '<div style="font-size:12px;color:var(--color-text-secondary);margin-top:2px;">' + (m.email || m.username + '@benevolate.com') + '</div>' +
        '</div>' +
        '<span style="font-size:12px;font-weight:600;padding:4px 12px;border-radius:999px;border:1px solid rgba(99,102,241,0.25);color:#6366f1;background:rgba(99,102,241,0.12);white-space:nowrap;">' + role + '</span>' +
        '<i data-lucide="chevron-right" style="width:16px;height:16px;color:var(--color-text-tertiary);flex-shrink:0;"></i>';

      listEl.appendChild(row);
    });
  }

  if (layoutEl) layoutEl.style.display = 'flex';
  renderTeamActivity();
  if (window.lucide) lucide.createIcons();
}

async function renderTeamActivity() {
  var actEl     = document.getElementById('team-activity-list');
  var actEmpty  = document.getElementById('team-activity-empty');
  if (!actEl) return;

  try {
    var res = await api.get('/api/audit-logs?limit=60');
    var rawLogs = (res && res.ok && res.logs) ? res.logs : [];

    // Filter to strictly show: Git operations, Pipeline/Build updates, Deployments, and Team Access/Member notifications
    var allowedKeywords = [
      'branch', 'commit', 'git', 'pull', 'merge', 'cr', 'review',
      'pipeline', 'build', 'deploy', 'webhook',
      'granted', 'access', 'member'
    ];

    var blockedKeywords = [
      'logged', 'login', 'logout', 'sso', 'oauth', 'slack account', 'github account',
      'role for', 'deleted user account', 'user account'
    ];

    var logs = rawLogs.filter(function(l) {
      var act = (l.action || '').toLowerCase();
      for (var b = 0; b < blockedKeywords.length; b++) {
        if (act.includes(blockedKeywords[b])) return false;
      }
      for (var a = 0; a < allowedKeywords.length; a++) {
        if (act.includes(allowedKeywords[a])) return true;
      }
      return false;
    });

    if (logs.length === 0) {
      actEl.style.display = 'none';
      if (actEmpty) actEmpty.style.display = 'block';
      return;
    }
    if (actEmpty) actEmpty.style.display = 'none';
    actEl.style.display = 'flex';
    actEl.innerHTML = '';

    logs.slice(0, 8).forEach(function(log) {
      var actText = log.action || 'Action';
      var userText = log.username || log.user || 'Team Member';
      var timeText = (window.TimeUtil && typeof TimeUtil.formatDateTime === 'function')
        ? TimeUtil.formatDateTime(log.timestamp)
        : (log.timestamp ? new Date(log.timestamp).toLocaleString() : '');
      var icon = 'git-commit';

      var actLower = actText.toLowerCase();
      if (actLower.includes('branch')) icon = 'git-branch';
      else if (actLower.includes('pipeline') || actLower.includes('build')) icon = 'play-circle';
      else if (actLower.includes('deploy') || actLower.includes('ecs')) icon = 'rocket';
      else if (actLower.includes('cr') || actLower.includes('review') || actLower.includes('merge')) icon = 'git-merge';
      else if (actLower.includes('access')) icon = 'user-check';

      var d = document.createElement('div');
      d.style.cssText = 'font-size:12px;color:var(--color-text-secondary);padding:10px 12px;border-radius:10px;background:var(--color-bg);border:1px solid var(--color-border);display:flex;align-items:flex-start;gap:10px;';
      d.innerHTML =
        '<i data-lucide="' + icon + '" style="width:15px;height:15px;color:#6366f1;margin-top:2px;flex-shrink:0;"></i>' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-weight:600;color:var(--color-text-primary);line-height:1.3;">' + actText + '</div>' +
          '<div style="color:var(--color-text-tertiary);margin-top:4px;font-size:11px;">' + userText + ' &bull; ' + timeText + '</div>' +
        '</div>';
      actEl.appendChild(d);
    });
    if (window.lucide) lucide.createIcons();
  } catch (e) {
    if (actEmpty) actEmpty.style.display = 'block';
  }
}

// ─────────────────────────────────────────────────────────────────
// Manage Access Modal
// ─────────────────────────────────────────────────────────────────
function openAccessModal() {
  _tempSelectedUsernames = _projectMembers.map(function(m) { return m.username; });
  document.getElementById('access-search-input').value = '';
  var roleFilter = document.getElementById('access-role-filter');
  if (roleFilter) roleFilter.value = '';
  renderAccessModalList();
  document.getElementById('modal-manage-access').style.display = 'flex';
  if (window.lucide) lucide.createIcons();
}

function closeAccessModal() {
  document.getElementById('modal-manage-access').style.display = 'none';
}

function openGroupMembersModal() {
  // placeholder: show a simple group info alert for now
  alert('Group Members panel — coming soon.\nCurrently groups are: DevOps & Infra, Frontend Engineering Squad.');
}

function renderAccessModalList() {
  var listEl     = document.getElementById('access-modal-list');
  var search     = (document.getElementById('access-search-input') ? document.getElementById('access-search-input').value : '').toLowerCase();
  var roleFilter = document.getElementById('access-role-filter') ? document.getElementById('access-role-filter').value : '';
  if (!listEl) return;

  var candidates = _allUsers.filter(function(u) {
    return u.username !== 'admin' && u.userType !== 'super_admin';
  });

  if (search) {
    candidates = candidates.filter(function(u) {
      return (u.username || '').toLowerCase().includes(search) || (u.email || '').toLowerCase().includes(search);
    });
  }
  if (roleFilter) {
    candidates = candidates.filter(function(u) { return u.userType === roleFilter; });
  }

  listEl.innerHTML = '';
  if (candidates.length === 0) {
    listEl.innerHTML = '<div style="padding:20px;text-align:center;color:#9ca3af;font-size:13px;">No employees found.</div>';
    return;
  }

  candidates.forEach(function(u) {
    var isSelected = _tempSelectedUsernames.indexOf(u.username) !== -1;
    var role = roleLabel(u);
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:10px;border:1px solid ' +
      (isSelected ? '#c7d2fe' : '#e5e7eb') + ';background:' + (isSelected ? '#eef2ff' : 'white') + ';cursor:pointer;transition:all 0.12s;';

    row.onclick = function() {
      var idx = _tempSelectedUsernames.indexOf(u.username);
      if (idx !== -1) { _tempSelectedUsernames.splice(idx, 1); }
      else { _tempSelectedUsernames.push(u.username); }
      renderAccessModalList();
    };

    row.innerHTML =
      '<div style="width:18px;height:18px;border-radius:4px;border:2px solid ' + (isSelected ? '#6366f1' : '#d1d5db') + ';background:' + (isSelected ? '#6366f1' : 'white') + ';display:flex;align-items:center;justify-content:center;flex-shrink:0;">' +
        (isSelected ? '<svg width="10" height="10" viewBox="0 0 10 10"><polyline points="1.5,5 4,7.5 8.5,2.5" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '') +
      '</div>' +
      '<div style="flex:1;min-width:0;">' +
        '<div style="font-weight:700;font-size:13px;color:#111827;">' + u.username + '</div>' +
        '<div style="font-size:12px;color:#6b7280;">' + (u.email || 'No email') + '</div>' +
      '</div>' +
      '<span style="font-size:11px;font-weight:600;padding:3px 10px;border-radius:999px;border:1px solid #e0e7ff;color:#6366f1;background:#f0f3ff;white-space:nowrap;">' + role + '</span>';

    listEl.appendChild(row);
  });
}

async function handleSaveProjectAccess() {
  if (!_activeProject) return;
  var btn    = document.getElementById('btn-save-access');
  var banner = document.getElementById('access-save-banner');

  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
  if (banner) banner.style.display = 'none';

  try {
    var res = await api.post('/api/projects/' + _activeProject.id + '/members', { members: _tempSelectedUsernames });
    if (res && res.ok) {
      if (banner) { banner.style.color = '#10b981'; banner.textContent = '✔ Access list updated!'; banner.style.display = 'block'; }
      fetchTeamData();
      setTimeout(closeAccessModal, 900);
    } else {
      if (banner) { banner.style.color = '#ef4444'; banner.textContent = (res && res.error) || 'Failed to update access'; banner.style.display = 'block'; }
    }
  } catch (err) {
    if (banner) { banner.style.color = '#ef4444'; banner.textContent = err.message || 'Error'; banner.style.display = 'block'; }
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Save Project Access'; }
}

// ─────────────────────────────────────────────────────────────────
// Member Details Modal
// ─────────────────────────────────────────────────────────────────
async function openMemberDetailsModal(username) {
  var titleEl = document.getElementById('detail-modal-title');
  var bodyEl  = document.getElementById('member-details-body');
  if (titleEl) titleEl.textContent = 'Member Details: @' + username;

  bodyEl.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:30px 0;color:#9ca3af;font-size:13px;"><i data-lucide="loader-2" class="animate-spin" style="width:18px;height:18px;color:#6366f1;"></i><span>Loading...</span></div>';
  document.getElementById('modal-member-details').style.display = 'flex';
  if (window.lucide) lucide.createIcons();

  try {
    var member = _allUsers.find(function(u) { return u.username === username; }) || { username: username };
    var res    = await api.get('/api/admin/users/' + encodeURIComponent(username) + '/details');
    var u      = (res && res.ok && res.user) ? res.user : member;
    var logs   = (res && res.activityLogs) ? res.activityLogs : [];

    var isOnline = !!u.isOnline;
    var role     = roleLabel(u);

    var logsHtml = '';
    if (logs.length > 0) {
      logsHtml = '<div style="display:flex;flex-direction:column;gap:6px;max-height:200px;overflow-y:auto;">' +
        logs.slice(0, 10).map(function(log) {
          return '<div style="padding:8px 12px;border:1px solid #f3f4f6;border-radius:8px;background:#f9fafb;font-size:12px;">' +
            '<div style="font-weight:600;color:#111827;">' + (log.action || 'Action') + '</div>' +
            '<div style="color:#9ca3af;margin-top:2px;">' + new Date(log.timestamp).toLocaleString() + '</div>' +
            '</div>';
        }).join('') +
      '</div>';
    } else {
      logsHtml = '<div style="color:#9ca3af;font-size:13px;text-align:center;padding:16px 0;">No audit activity recorded for this member.</div>';
    }

    bodyEl.innerHTML =
      // Profile info card
      '<div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin-bottom:20px;">' +
        '<div style="font-size:13px;color:#374151;line-height:2;">' +
          '<div><strong>Username:</strong> ' + u.username + '</div>' +
          '<div><strong>Email:</strong> ' + (u.email || 'Not configured') + '</div>' +
          '<div><strong>Role:</strong> ' + role + '</div>' +
          '<div><strong>Status:</strong> <span style="display:inline-flex;align-items:center;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;background:' + (isOnline ? '#dcfce7' : '#f1f5f9') + ';color:' + (isOnline ? '#15803d' : '#64748b') + ';">' + (isOnline ? 'Online' : 'Offline') + '</span></div>' +
        '</div>' +
      '</div>' +
      // Activity trail
      '<div style="font-size:15px;font-weight:700;color:#111827;margin-bottom:12px;">Member Activity Trail</div>' +
      logsHtml;
  } catch (e) {
    bodyEl.innerHTML = '<div style="color:#ef4444;font-size:13px;">Failed to load details.</div>';
  }
  if (window.lucide) lucide.createIcons();
}

function closeMemberDetailsModal() {
  document.getElementById('modal-member-details').style.display = 'none';
}
