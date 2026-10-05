// Admin Users Page — Vanilla JS Logic
var _adminUsers = [];
var _adminFilterTab = 'all';

function initAdminUsersPage() {
  fetchAdminUsers();
}

window.initAdminUsersPage = initAdminUsersPage;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAdminUsersPage);
} else {
  initAdminUsersPage();
}

// ─────────────────────────────────────────────────────────────────
// Data Fetch
// ─────────────────────────────────────────────────────────────────
async function fetchAdminUsers() {
  var loadingEl = document.getElementById('admin-users-loading');
  var emptyEl   = document.getElementById('admin-users-empty');
  var listEl    = document.getElementById('admin-users-list');

  if (loadingEl) loadingEl.style.display = 'flex';
  if (emptyEl)   emptyEl.style.display   = 'none';
  if (listEl)    listEl.style.display    = 'none';

  try {
    var res = await api.get('/api/users');
    _adminUsers = (res && res.ok && res.users) ? res.users : [];
  } catch (e) {
    _adminUsers = [];
  }

  if (loadingEl) loadingEl.style.display = 'none';
  renderAdminUsers();
}

// ─────────────────────────────────────────────────────────────────
// Slide-Based Segmented Navigation & Filter Tabs
// ─────────────────────────────────────────────────────────────────
function switchAdminTab(tab) {
  _adminFilterTab = tab;

  var usersView = document.getElementById('admin-users-view');
  var broadcastView = document.getElementById('admin-broadcast-view');

  // Handle segmented buttons visual state
  ['all', 'pending', 'blocked', 'broadcast'].forEach(function(t) {
    var btn = document.getElementById('admin-seg-' + t);
    if (!btn) return;
    if (t === tab) {
      btn.style.background = 'var(--color-surface)';
      btn.style.color = 'var(--color-primary)';
      btn.style.fontWeight = '700';
      btn.style.boxShadow = '0 1px 3px rgba(0,0,0,0.08)';
      var badge = btn.querySelector('#count-' + t + '-users');
      if (badge) { badge.style.background = 'rgba(99,102,241,0.12)'; badge.style.color = 'var(--color-primary)'; }
    } else {
      btn.style.background = 'transparent';
      btn.style.color = 'var(--color-text-secondary)';
      btn.style.fontWeight = '600';
      btn.style.boxShadow = 'none';
      var badge2 = btn.querySelector('#count-' + t + '-users');
      if (badge2) { badge2.style.background = 'var(--color-surface)'; badge2.style.color = 'var(--color-text-tertiary)'; }
    }
  });

  if (tab === 'broadcast') {
    if (usersView) usersView.style.display = 'none';
    if (broadcastView) broadcastView.style.display = 'flex';
    initBroadcastWorkspace();
  } else {
    if (broadcastView) broadcastView.style.display = 'none';
    if (usersView) usersView.style.display = 'block';
    setAdminFilterTab(tab);
  }
}
window.switchAdminTab = switchAdminTab;

window.openBroadcastModal = function() {
  switchAdminTab('broadcast');
};

function setAdminFilterTab(tab) {
  _adminFilterTab = tab;

  var titles = { all: 'Platform User Accounts', pending: 'Fresh Signups Awaiting Moderation', blocked: 'Suspended Accounts' };
  var el = document.getElementById('admin-section-title');
  if (el) el.textContent = titles[tab] || 'Platform User Accounts';

  renderAdminUsers();
}

// ─────────────────────────────────────────────────────────────────
// Avatar helper (GitHub profile picture)
// ─────────────────────────────────────────────────────────────────
function makeAdminAvatar(u) {
  var size = 40;
  var initial = (u.username || 'U').charAt(0).toUpperCase();
  var githubLogin = u.githubUsername || null;

  if (githubLogin) {
    return '<div style="position:relative;flex-shrink:0;width:' + size + 'px;height:' + size + 'px;">' +
      '<img src="https://github.com/' + githubLogin + '.png?size=80" alt="' + initial + '" ' +
      'style="width:' + size + 'px;height:' + size + 'px;border-radius:50%;object-fit:cover;" ' +
      'onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\';" />' +
      '<div style="width:' + size + 'px;height:' + size + 'px;border-radius:50%;background:#6366f1;color:white;display:none;align-items:center;justify-content:center;font-weight:800;font-size:17px;position:absolute;top:0;left:0;">' + initial + '</div>' +
      '</div>';
  }
  var colors = ['#6366f1', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444'];
  var c = colors[(initial.charCodeAt(0) || 65) % colors.length];
  return '<div style="width:' + size + 'px;height:' + size + 'px;border-radius:50%;background:' + c + ';color:white;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:17px;flex-shrink:0;">' + initial + '</div>';
}

function adminRoleLabel(u) {
  if (u.jobTitle) return u.jobTitle;
  if (u.userType === 'devops')       return 'DevOps Engineer';
  if (u.userType === 'admin')        return 'Admin';
  if (u.userType === 'super_admin')  return 'Super Admin';
  if (u.userType === 'developer')    return 'Developer';
  if (u.userType === 'sales')        return 'Sales &amp; Business';
  return u.userType || 'Developer';
}

// ─────────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────────
function renderAdminUsers() {
  var pendingCount = _adminUsers.filter(function(u) { return u.isProfileCompleted === false; }).length;
  var blockedCount = _adminUsers.filter(function(u) { return u.isBlocked === true; }).length;

  var tagAll = document.getElementById('count-all-users');
  var tagPen = document.getElementById('count-pending-users');
  var tagBlo = document.getElementById('count-blocked-users');
  if (tagAll) tagAll.textContent = _adminUsers.length;
  if (tagPen) tagPen.textContent = pendingCount;
  if (tagBlo) tagBlo.textContent = blockedCount;

  var filtered = _adminUsers.filter(function(u) {
    if (_adminFilterTab === 'pending') return u.isProfileCompleted === false;
    if (_adminFilterTab === 'blocked') return u.isBlocked === true;
    return true;
  });
  var sorted = filtered.sort(function(a, b) { return (b.isOnline ? 1 : 0) - (a.isOnline ? 1 : 0); });

  var listEl  = document.getElementById('admin-users-list');
  var emptyEl = document.getElementById('admin-users-empty');
  if (!listEl) return;

  listEl.innerHTML = '';
  if (sorted.length === 0) {
    listEl.style.display = 'none';
    if (emptyEl) emptyEl.style.display = 'block';
    return;
  }

  if (emptyEl) emptyEl.style.display = 'none';
  listEl.style.display = 'flex';

  sorted.forEach(function(u) {
    var isOnline   = !!u.isOnline;
    var isBlocked  = !!u.isBlocked;
    var isPending  = u.isProfileCompleted === false;
    var isSuperAdmin = u.userType === 'super_admin';
    var role       = adminRoleLabel(u);

    var statusBadge = isBlocked  ? '<span style="font-size:11px;font-weight:600;padding:2px 9px;border-radius:999px;background:rgba(239,68,68,0.15);color:#ef4444;">Suspended</span>' :
                      isPending  ? '<span style="font-size:11px;font-weight:600;padding:2px 9px;border-radius:999px;background:rgba(245,158,11,0.15);color:#f59e0b;">Pending</span>' :
                      isOnline   ? '<span style="font-size:11px;font-weight:600;padding:2px 9px;border-radius:999px;background:rgba(16,185,129,0.15);color:#10b981;">Online</span>' :
                                   '<span style="font-size:11px;font-weight:600;padding:2px 9px;border-radius:999px;background:rgba(255,255,255,0.06);color:var(--color-text-tertiary);">Offline</span>';

    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:10px;border:1px solid var(--color-border);transition:background 0.12s;';
    row.onmouseenter = function() { this.style.background = 'var(--color-bg)'; };
    row.onmouseleave = function() { this.style.background = 'transparent'; };

    // Avatar
    row.innerHTML =
      makeAdminAvatar(u) +
      // Name + status + email + role
      '<div style="flex:1;min-width:0;">' +
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
          '<span style="font-weight:700;font-size:15px;color:var(--color-text-primary);">' + u.username + '</span>' +
          statusBadge +
        '</div>' +
        '<div style="font-size:12px;color:var(--color-text-secondary);margin-top:3px;">' +
          'Email: <strong style="color:var(--color-text-primary);">' + (u.email || 'Not configured') + '</strong>' +
          ' &bull; Role / Title: <strong style="color:var(--color-text-primary);">' + role + '</strong>' +
        '</div>' +
      '</div>' +
      // Actions
      '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0;flex-wrap:wrap;">' +
        // Details button
        '<button onclick="openInspectUserModal(\'' + u.username + '\')" ' +
          'style="padding:6px 14px;border-radius:7px;border:1px solid var(--color-border);background:var(--color-bg);color:var(--color-text-primary);font-size:12px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:5px;font-family:inherit;">' +
          '<i data-lucide="eye" style="width:13px;height:13px;"></i> Details' +
        '</button>' +
        // Role select
        '<select onchange="handleRoleChange(\'' + u.username + '\', this.value)" ' +
          'style="padding:6px 10px;border-radius:7px;border:1px solid var(--color-border);background:var(--color-bg);color:var(--color-text-primary);font-size:12px;font-weight:600;cursor:pointer;outline:none;">' +
          '<option value="developer" ' + (u.userType === 'developer' ? 'selected' : '') + '>Developer</option>' +
          '<option value="admin" ' + (u.userType === 'admin' ? 'selected' : '') + '>Admin</option>' +
          '<option value="devops" ' + (u.userType === 'devops' ? 'selected' : '') + '>DevOps Engineer</option>' +
          '<option value="super_admin" ' + (u.userType === 'super_admin' ? 'selected' : '') + '>Super Admin</option>' +
          '<option value="sales" ' + (u.userType === 'sales' ? 'selected' : '') + '>Sales &amp; Business</option>' +
        '</select>' +
        // Suspend/Unblock (not for super_admin)
        (!isSuperAdmin ?
          '<button onclick="handleToggleBlock(\'' + u.username + '\', ' + isBlocked + ')" ' +
            'style="padding:6px 12px;border-radius:7px;border:1px solid ' + (isBlocked ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)') + ';background:' + (isBlocked ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)') + ';color:' + (isBlocked ? '#10b981' : '#ef4444') + ';font-size:12px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:5px;font-family:inherit;">' +
            (isBlocked ? 'Unblock' : '<i data-lucide="slash" style="width:12px;height:12px;"></i> Suspend') +
          '</button>' +
          // Delete icon
          '<button onclick="handleDeleteUser(\'' + u.username + '\')" title="Delete account" ' +
            'style="padding:7px;border-radius:7px;border:1px solid rgba(239,68,68,0.3);background:rgba(239,68,68,0.12);color:#ef4444;cursor:pointer;line-height:0;">' +
            '<i data-lucide="trash-2" style="width:14px;height:14px;"></i>' +
          '</button>'
        : '') +
      '</div>';

    listEl.appendChild(row);
  });

  if (window.lucide) lucide.createIcons();
}

// ─────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────
async function handleRoleChange(username, userType) {
  try { await api.patch('/api/users/' + encodeURIComponent(username) + '/role', { userType: userType }); fetchAdminUsers(); } catch (e) {}
}

async function handleToggleBlock(username, currentBlocked) {
  try {
    var res = await api.patch('/api/users/' + encodeURIComponent(username) + '/block', { isBlocked: !currentBlocked });
    if (res && res.ok) fetchAdminUsers();
  } catch (e) {}
}

async function handleApproveUser(username) {
  try { var res = await api.patch('/api/users/' + encodeURIComponent(username) + '/approve', {}); if (res && res.ok) fetchAdminUsers(); } catch (e) {}
}

async function handleDeleteUser(username) {
  if (!confirm('Permanently delete user "' + username + '"? This cannot be undone.')) return;
  try { var res = await api.delete('/api/users/' + encodeURIComponent(username)); if (res && res.ok) fetchAdminUsers(); } catch (e) {}
}

// ─────────────────────────────────────────────────────────────────
// Create User Modal
// ─────────────────────────────────────────────────────────────────
function openCreateUserModal() {
  ['new-user-username', 'new-user-password', 'new-user-email'].forEach(function(id) {
    var el = document.getElementById(id); if (el) el.value = '';
  });
  var roleEl = document.getElementById('new-user-role'); if (roleEl) roleEl.value = 'developer';
  var errEl = document.getElementById('create-user-error'); if (errEl) errEl.style.display = 'none';
  document.getElementById('modal-create-user').style.display = 'flex';
  if (window.lucide) lucide.createIcons();
}

function closeCreateUserModal() { document.getElementById('modal-create-user').style.display = 'none'; }

async function handleCreateUser(e) {
  e.preventDefault();
  var u = document.getElementById('new-user-username').value.trim();
  var p = document.getElementById('new-user-password').value.trim();
  var em = document.getElementById('new-user-email').value.trim();
  var r = document.getElementById('new-user-role').value;
  var btn = document.getElementById('btn-submit-create-user');
  var errEl = document.getElementById('create-user-error');
  if (!u || !p) return;
  if (btn) btn.disabled = true;
  if (errEl) errEl.style.display = 'none';
  try {
    var res = await api.post('/api/register', { username: u, password: p, userType: r, email: em || null });
    if (res && res.ok) { closeCreateUserModal(); fetchAdminUsers(); }
    else { if (errEl) { errEl.textContent = (res && res.error) || 'Failed to create user'; errEl.style.display = 'block'; } }
  } catch (err) { if (errEl) { errEl.textContent = err.message || 'Error'; errEl.style.display = 'block'; } }
  if (btn) btn.disabled = false;
}

// ─────────────────────────────────────────────────────────────────
// Inspect User Modal (Profile & RBAC Details)
// ─────────────────────────────────────────────────────────────────
async function openInspectUserModal(username) {
  document.getElementById('inspect-modal-title').textContent = 'Profile & RBAC Details';
  var bodyEl = document.getElementById('inspect-modal-body');
  bodyEl.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:40px 0;color:#9ca3af;font-size:13px;"><i data-lucide="loader-2" class="animate-spin" style="width:20px;height:20px;color:#6366f1;flex-shrink:0;"></i><span>Loading profile...</span></div>';
  document.getElementById('modal-inspect-user').style.display = 'flex';
  if (window.lucide) lucide.createIcons();

  try {
    var res  = await api.get('/api/admin/users/' + encodeURIComponent(username) + '/details');
    if (!res || !res.ok || !res.user) { bodyEl.innerHTML = '<div style="color:#ef4444;font-size:13px;padding:20px 0;">Could not load user details.</div>'; return; }

    var u    = res.user;
    var logs = res.activityLogs || [];
    var isOnline   = !!u.isOnline;
    var isBlocked  = !!u.isBlocked;
    var role       = adminRoleLabel(u);
    var githubLogin = u.githubUsername || null;
    var avatarSize  = 52;
    var initial     = (u.username || 'U').charAt(0).toUpperCase();

    // Avatar HTML
    var avatarHtml;
    if (githubLogin) {
      avatarHtml = '<div style="position:relative;width:' + avatarSize + 'px;height:' + avatarSize + 'px;flex-shrink:0;">' +
        '<img src="https://github.com/' + githubLogin + '.png?size=100" style="width:' + avatarSize + 'px;height:' + avatarSize + 'px;border-radius:10px;object-fit:cover;" ' +
        'onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\';" />' +
        '<div style="width:' + avatarSize + 'px;height:' + avatarSize + 'px;border-radius:10px;background:#6366f1;color:white;display:none;align-items:center;justify-content:center;font-weight:800;font-size:22px;position:absolute;top:0;left:0;">' + initial + '</div>' +
        '</div>';
    } else {
      var colors = ['#6366f1','#8b5cf6','#06b6d4','#10b981','#f59e0b'];
      var c = colors[(initial.charCodeAt(0)||65) % colors.length];
      avatarHtml = '<div style="width:' + avatarSize + 'px;height:' + avatarSize + 'px;border-radius:10px;background:' + c + ';color:white;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:22px;flex-shrink:0;">' + initial + '</div>';
    }

    function formatTimestamp(ts) {
      if (!ts) return 'N/A';
      return (window.TimeUtil && typeof TimeUtil.formatDateTime === 'function')
        ? TimeUtil.formatDateTime(ts)
        : (new Date(ts).toLocaleString());
    }

    var logsHtml = '';
    if (logs.length > 0) {
      logsHtml = '<div style="display:flex;flex-direction:column;gap:6px;max-height:220px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:10px;padding:2px;">' +
        logs.slice(0, 20).map(function(log) {
          return '<div style="padding:10px 14px;border-bottom:1px solid #f3f4f6;font-size:12px;">' +
            '<div style="font-weight:600;color:#111827;margin-bottom:4px;">' + (log.action || 'Action') + '</div>' +
            '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;color:#9ca3af;">' +
              '<span>Target: <strong style="color:#374151;">' + (log.target || log.projectName || 'System') + '</strong> &bull; IP: <strong style="color:#374151;">' + (log.ipAddress || '127.0.0.1') + '</strong></span>' +
              '<span style="white-space:nowrap;">' + formatTimestamp(log.timestamp) + '</span>' +
            '</div>' +
          '</div>';
        }).join('') +
      '</div>';
    } else {
      logsHtml = '<div style="font-size:13px;color:#9ca3af;padding:16px;text-align:center;background:#f9fafb;border-radius:8px;border:1px solid #f3f4f6;">No audit log records found for this user.</div>';
    }

    bodyEl.innerHTML =
      // Profile banner
      '<div style="border:1px solid #e5e7eb;border-radius:12px;padding:16px;display:flex;align-items:center;gap:14px;margin-bottom:14px;background:#f9fafb;">' +
        avatarHtml +
        '<div style="flex:1;min-width:0;">' +
          '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
            '<span style="font-size:17px;font-weight:800;color:#111827;">@' + u.username + '</span>' +
            (isBlocked  ? '<span style="font-size:11px;font-weight:600;padding:2px 9px;border-radius:999px;background:#fef2f2;color:#ef4444;">Suspended</span>' :
             isOnline   ? '<span style="font-size:11px;font-weight:600;padding:2px 9px;border-radius:999px;background:#dcfce7;color:#15803d;">Online</span>' :
                          '<span style="font-size:11px;font-weight:600;padding:2px 9px;border-radius:999px;background:#f1f5f9;color:#64748b;">Offline</span>') +
          '</div>' +
          '<div style="font-size:12px;color:#6b7280;margin-top:4px;display:flex;align-items:center;gap:5px;">' +
            '<i data-lucide="mail" style="width:12px;height:12px;"></i>' +
            (u.email ? u.email : 'No email configured') +
          '</div>' +
        '</div>' +
      '</div>' +
      // Info grid (2x2)
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">' +
        // RBAC
        '<div style="border:1px solid #e5e7eb;border-radius:10px;padding:14px;">' +
          '<div style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px;display:flex;align-items:center;gap:5px;">' +
            '<i data-lucide="shield" style="width:11px;height:11px;"></i> RBAC ACCESS LEVEL' +
          '</div>' +
          '<span style="display:inline-block;font-size:12px;font-weight:600;padding:4px 12px;border-radius:999px;border:1px solid #e0e7ff;color:#6366f1;background:#eef2ff;">' + (u.userType || role) + '</span>' +
        '</div>' +
        // 2FA
        '<div style="border:1px solid #e5e7eb;border-radius:10px;padding:14px;">' +
          '<div style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px;display:flex;align-items:center;gap:5px;">' +
            '<i data-lucide="lock" style="width:11px;height:11px;"></i> 2FA SECURITY STATUS' +
          '</div>' +
          (u.totpEnabled ?
            '<span style="display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:600;padding:4px 12px;border-radius:999px;background:#dcfce7;color:#15803d;">✓ 2FA Active &amp; Verified</span>' :
            '<span style="display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:600;padding:4px 12px;border-radius:999px;background:#fffbeb;color:#d97706;">⚠ 2FA Not Set / Inactive</span>') +
        '</div>' +
        // Moderation Status
        '<div style="border:1px solid #e5e7eb;border-radius:10px;padding:14px;">' +
          '<div style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px;display:flex;align-items:center;gap:5px;">' +
            '<i data-lucide="check-circle" style="width:11px;height:11px;"></i> MODERATION STATUS' +
          '</div>' +
          (u.isProfileCompleted !== false ?
            '<span style="display:inline-block;font-size:12px;font-weight:600;padding:4px 12px;border-radius:999px;background:#dcfce7;color:#15803d;">✓ Approved</span>' :
            '<span style="display:inline-block;font-size:12px;font-weight:600;padding:4px 12px;border-radius:999px;background:#fffbeb;color:#d97706;">⏳ Pending Approval</span>') +
        '</div>' +
        // Joined Date
        '<div style="border:1px solid #e5e7eb;border-radius:10px;padding:14px;">' +
          '<div style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px;display:flex;align-items:center;gap:5px;">' +
            '<i data-lucide="calendar" style="width:11px;height:11px;"></i> JOINED DATE' +
          '</div>' +
          '<div style="font-size:13px;font-weight:600;color:#111827;">' + (u.createdAt ? new Date(u.createdAt).toLocaleDateString('en-IN') : 'N/A') + '</div>' +
        '</div>' +
      '</div>' +
      // Activity Trail
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">' +
        '<i data-lucide="activity" style="width:16px;height:16px;color:#6366f1;"></i>' +
        '<span style="font-size:15px;font-weight:700;color:#111827;">Recent Activity Trail</span>' +
      '</div>' +
      logsHtml;

    if (window.lucide) lucide.createIcons();
  } catch (e) {
    bodyEl.innerHTML = '<div style="color:#ef4444;font-size:13px;padding:20px 0;">Failed to load user details: ' + (e.message || e) + '</div>';
  }
}

function closeInspectUserModal() {
  document.getElementById('modal-inspect-user').style.display = 'none';
}

// ─────────────────────────────────────────────────────────────────
// Broadcast Announcement Workspace Logic
// ─────────────────────────────────────────────────────────────────
var _broadcastWorkspaceMeta = null;
var _slackTargetMode = 'all';

async function initBroadcastWorkspace() {
  updateBroadcastPreview();
  if (window.lucide) lucide.createIcons();
  await loadBroadcastWorkspaceMeta();
}
window.initBroadcastWorkspace = initBroadcastWorkspace;

async function loadBroadcastWorkspaceMeta() {
  try {
    var res = await api.get('/api/admin/broadcast/meta');
    if (!res || !res.ok) return;

    _broadcastWorkspaceMeta = res;

    // Audience count
    var countEl = document.getElementById('broadcast-meta-user-count');
    if (countEl) countEl.textContent = res.totalUsers || '0';

    // Email SMTP status
    var emailEl = document.getElementById('broadcast-email-status-badge');
    if (emailEl) {
      if (res.email && res.email.configured) {
        emailEl.innerHTML = '<span style="color:#10b981;font-weight:700;">✔ SMTP Active (' + res.email.host + ')</span>';
      } else {
        emailEl.innerHTML = '<span style="color:#f59e0b;font-weight:600;">⚠ SMTP Inactive (Log only)</span>';
      }
    }

    // Slack status
    var slackEl = document.getElementById('broadcast-slack-status-badge');
    var slackCb = document.getElementById('broadcast-chan-slack');
    if (slackEl) {
      if (res.slack && res.slack.connected) {
        slackEl.innerHTML = '<span style="color:#10b981;font-weight:700;">✔ Slack Connected (' + (res.slack.channels ? res.slack.channels.length : 0) + ' channels)</span>';
      } else {
        slackEl.innerHTML = '<span style="color:#ef4444;font-weight:600;">✘ Slack Not Connected</span>';
        if (slackCb) slackCb.checked = false;
        toggleSlackTargetSection();
      }
    }

    // Project channels
    var projListEl = document.getElementById('broadcast-projects-list');
    if (projListEl) {
      var projs = res.projects || [];
      if (projs.length === 0) {
        projListEl.innerHTML = '<div style="font-size:12px;color:var(--color-text-tertiary);text-align:center;padding:12px;">No active projects found.</div>';
      } else {
        projListEl.innerHTML = projs.map(function(p) {
          var hasSlack = Boolean(p.slack_channel_id);
          var channelLabel = hasSlack ? '#' + (p.slack_channel_name || 'proj-' + p.name) : 'No channel linked';
          return '<label style="display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border-radius:6px;background:var(--color-bg);cursor:' + (hasSlack ? 'pointer' : 'not-allowed') + ';opacity:' + (hasSlack ? '1' : '0.6') + ';">' +
            '<div style="display:flex;align-items:center;gap:8px;">' +
              '<input type="checkbox" class="broadcast-project-checkbox" value="' + p.id + '" ' + (hasSlack ? '' : 'disabled') + ' style="accent-color:#6366f1;" />' +
              '<span style="font-size:12px;font-weight:600;color:var(--color-text-primary);">' + p.name + '</span>' +
            '</div>' +
            '<span style="font-size:11px;font-family:monospace;padding:1px 6px;border-radius:4px;background:var(--color-surface);color:' + (hasSlack ? '#10b981' : 'var(--color-text-tertiary)') + ';">' +
              channelLabel +
            '</span>' +
          '</label>';
        }).join('');
      }
    }

    // All channels list
    var chanListEl = document.getElementById('broadcast-channels-list');
    if (chanListEl) {
      var chans = (res.slack && res.slack.channels) || [];
      if (chans.length === 0) {
        chanListEl.innerHTML = '<div style="font-size:12px;color:var(--color-text-tertiary);text-align:center;padding:12px;">No Slack channels found.</div>';
      } else {
        chanListEl.innerHTML = chans.map(function(c) {
          return '<label style="display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border-radius:6px;background:var(--color-bg);cursor:pointer;">' +
            '<div style="display:flex;align-items:center;gap:8px;">' +
              '<input type="checkbox" class="broadcast-channel-checkbox" value="' + c.id + '" style="accent-color:#6366f1;" />' +
              '<span style="font-size:12px;font-weight:600;color:var(--color-text-primary);">#' + c.name + '</span>' +
            '</div>' +
            '<span style="font-size:11px;color:var(--color-text-tertiary);">' + (c.is_private ? '🔒 private' : '🌐 public') + '</span>' +
          '</label>';
        }).join('');
      }
    }

    if (window.lucide) lucide.createIcons();
  } catch (err) {
    console.error("[loadBroadcastWorkspaceMeta]", err);
  }
}

function selectUrgency(urgency) {
  var cards = ['normal', 'high', 'urgent'];
  cards.forEach(function(u) {
    var card = document.getElementById('card-urgency-' + u);
    var radio = card ? card.querySelector('input[type="radio"]') : null;
    if (!card) return;
    if (u === urgency) {
      if (radio) radio.checked = true;
      var activeColors = {
        normal: { border: '#10b981', bg: 'rgba(16,185,129,0.08)' },
        high: { border: '#f59e0b', bg: 'rgba(245,158,11,0.08)' },
        urgent: { border: '#ef4444', bg: 'rgba(239,68,68,0.08)' }
      };
      card.style.borderColor = activeColors[u].border;
      card.style.background = activeColors[u].bg;
      card.style.boxShadow = '0 0 0 1px ' + activeColors[u].border;
    } else {
      if (radio) radio.checked = false;
      card.style.borderColor = 'var(--color-border)';
      card.style.background = 'var(--color-bg)';
      card.style.boxShadow = 'none';
    }
  });
  updateBroadcastPreview();
}
window.selectUrgency = selectUrgency;

function toggleSlackTargetSection() {
  var slackCb = document.getElementById('broadcast-chan-slack');
  var targetBox = document.getElementById('broadcast-slack-target-container');
  if (targetBox) {
    targetBox.style.display = (slackCb && slackCb.checked) ? 'block' : 'none';
  }
}
window.toggleSlackTargetSection = toggleSlackTargetSection;

function setSlackTargetMode(mode) {
  _slackTargetMode = mode;
  var modes = ['all', 'projects', 'select'];
  modes.forEach(function(m) {
    var btn = document.getElementById('btn-slack-mode-' + m);
    if (!btn) return;
    if (m === mode) {
      btn.style.borderColor = '#6366f1';
      btn.style.background = 'rgba(99,102,241,0.1)';
      btn.style.color = '#6366f1';
      btn.style.fontWeight = '700';
    } else {
      btn.style.borderColor = 'var(--color-border)';
      btn.style.background = 'var(--color-surface)';
      btn.style.color = 'var(--color-text-secondary)';
      btn.style.fontWeight = '600';
    }
  });

  var descEl = document.getElementById('broadcast-slack-mode-desc');
  var projsContainer = document.getElementById('broadcast-projects-container');
  var chansContainer = document.getElementById('broadcast-channels-container');

  if (mode === 'all') {
    if (descEl) descEl.textContent = 'Broadcasts message to every public Slack channel in the connected workspace.';
    if (projsContainer) projsContainer.style.display = 'none';
    if (chansContainer) chansContainer.style.display = 'none';
  } else if (mode === 'projects') {
    if (descEl) descEl.textContent = 'Delivers exclusively to the dedicated Slack channels connected to your active projects:';
    if (projsContainer) projsContainer.style.display = 'block';
    if (chansContainer) chansContainer.style.display = 'none';
  } else if (mode === 'select') {
    if (descEl) descEl.textContent = 'Pick specific Slack channels from your connected workspace below:';
    if (projsContainer) projsContainer.style.display = 'none';
    if (chansContainer) chansContainer.style.display = 'block';
  }
}
window.setSlackTargetMode = setSlackTargetMode;

function selectQuickTemplate(type) {
  var titleInput = document.getElementById('broadcast-input-title');
  var contentInput = document.getElementById('broadcast-input-content');

  var templates = {
    maintenance: {
      urgency: 'high',
      title: 'Scheduled Infrastructure Maintenance Window',
      content: 'Hello Team,\n\nPlease be advised that scheduled maintenance on our core CI/CD infrastructure will take place tonight from 22:00 UTC to 23:30 UTC.\n\n• Expected downtime: 15-20 minutes for build runners\n• Affected services: AWS CodePipeline webhooks, container deployments\n• Recommended action: Please wrap up urgent PR merges prior to 21:45 UTC.'
    },
    release: {
      urgency: 'normal',
      title: 'New Platform Capabilities & Release Deployed',
      content: 'Team,\n\nWe have deployed a new version of the platform featuring enhanced multi-channel notifications, slide-based navigation, and high-density dashboards.\n\nCheck out the updated dashboards and reach out in #devops if you experience any issues.'
    },
    incident: {
      urgency: 'urgent',
      title: 'CRITICAL ALERT: Buildspec Dispatch & API Degraded',
      content: 'ATTENTION ALL ENGINEERS:\n\nWe are currently investigating elevated latency and transient timeouts affecting AWS CodeBuild job triggers.\n\n• Status: Active Investigation\n• Severity: P1 - Urgent\n• Incident Lead: DevOps On-Call\n\nUpdates will follow every 15 minutes.'
    },
    policy: {
      urgency: 'normal',
      title: 'Organization Security & Branch Protection Reminder',
      content: 'Hi everyone,\n\nAs a reminder, all pull requests merging into protected branches require a minimum of 1 peer approval and passing automated test suites.\n\nDirect commits to production branches remain strictly disabled.'
    }
  };

  var tpl = templates[type];
  if (!tpl) return;

  if (titleInput) titleInput.value = tpl.title;
  if (contentInput) contentInput.value = tpl.content;

  selectUrgency(tpl.urgency);
}
window.selectQuickTemplate = selectQuickTemplate;

function updateBroadcastPreview() {
  var titleInput = document.getElementById('broadcast-input-title');
  var contentInput = document.getElementById('broadcast-input-content');
  var title = (titleInput && titleInput.value.trim()) || 'Scheduled Core Database Maintenance Window Tonight';
  var body = (contentInput && contentInput.value.trim()) || 'Write your announcement in the composer to inspect live preview…';

  var urgency = 'normal';
  var radios = document.getElementsByName('broadcast_urgency');
  for (var i = 0; i < radios.length; i++) {
    if (radios[i].checked) { urgency = radios[i].value; break; }
  }

  var urgencyConfig = {
    normal: { color: '#10b981', icon: '📢', label: '🟢 Normal', bg: 'rgba(16,185,129,0.15)' },
    high:   { color: '#f59e0b', icon: '⚠️', label: '🟡 Elevated', bg: 'rgba(245,158,11,0.15)' },
    urgent: { color: '#ef4444', icon: '🚨', label: '🔴 Critical', bg: 'rgba(239,68,68,0.15)' }
  };
  var cfg = urgencyConfig[urgency] || urgencyConfig.normal;

  // Slack preview updates
  var slackBox = document.getElementById('preview-slack-box');
  if (slackBox) slackBox.style.borderLeftColor = cfg.color;

  var statusIcon = document.getElementById('preview-status-icon');
  if (statusIcon) statusIcon.textContent = cfg.icon;

  var slackTitle = document.getElementById('preview-slack-title');
  if (slackTitle) slackTitle.textContent = title;

  var slackBody = document.getElementById('preview-slack-body');
  if (slackBody) slackBody.textContent = body;

  var timeEl = document.getElementById('preview-slack-time');
  if (timeEl) {
    var now = new Date();
    timeEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // In-App preview updates
  var inAppTitle = document.getElementById('preview-inapp-title');
  if (inAppTitle) inAppTitle.textContent = title;

  var inAppBody = document.getElementById('preview-inapp-snippet');
  if (inAppBody) inAppBody.textContent = body;
}
window.updateBroadcastPreview = updateBroadcastPreview;

async function handleSendBroadcast(e) {
  if (e) e.preventDefault();

  var titleInput = document.getElementById('broadcast-input-title');
  var contentInput = document.getElementById('broadcast-input-content');
  var feedbackEl = document.getElementById('broadcast-feedback-banner');
  var sendBtn = document.getElementById('btn-submit-broadcast');

  var title = titleInput ? titleInput.value.trim() : '';
  var message = contentInput ? contentInput.value.trim() : '';

  if (!title) {
    if (feedbackEl) {
      feedbackEl.style.display = 'block';
      feedbackEl.style.background = 'rgba(239,68,68,0.1)';
      feedbackEl.style.color = '#ef4444';
      feedbackEl.style.border = '1px solid rgba(239,68,68,0.3)';
      feedbackEl.textContent = 'Please provide an announcement title.';
    }
    if (titleInput) titleInput.focus();
    return;
  }

  if (!message) {
    if (feedbackEl) {
      feedbackEl.style.display = 'block';
      feedbackEl.style.background = 'rgba(239,68,68,0.1)';
      feedbackEl.style.color = '#ef4444';
      feedbackEl.style.border = '1px solid rgba(239,68,68,0.3)';
      feedbackEl.textContent = 'Please provide announcement message content.';
    }
    if (contentInput) contentInput.focus();
    return;
  }

  var chanInApp = document.getElementById('broadcast-chan-inapp');
  var chanSlack = document.getElementById('broadcast-chan-slack');
  var chanEmail = document.getElementById('broadcast-chan-email');

  var channels = [];
  if (chanInApp && chanInApp.checked) channels.push('in_app');
  if (chanSlack && chanSlack.checked) channels.push('slack');
  if (chanEmail && chanEmail.checked) channels.push('email');

  if (channels.length === 0) {
    if (feedbackEl) {
      feedbackEl.style.display = 'block';
      feedbackEl.style.background = 'rgba(239,68,68,0.1)';
      feedbackEl.style.color = '#ef4444';
      feedbackEl.style.border = '1px solid rgba(239,68,68,0.3)';
      feedbackEl.textContent = 'Please select at least one delivery channel (In-App, Slack, or Email).';
    }
    return;
  }

  var urgency = 'normal';
  var radios = document.getElementsByName('broadcast_urgency');
  for (var i = 0; i < radios.length; i++) {
    if (radios[i].checked) { urgency = radios[i].value; break; }
  }

  var targetChannelIds = [];
  var targetProjectIds = [];

  if (channels.includes('slack')) {
    if (_slackTargetMode === 'projects') {
      var pCbs = document.querySelectorAll('.broadcast-project-checkbox:checked');
      pCbs.forEach(function(cb) { targetProjectIds.push(cb.value); });
    } else if (_slackTargetMode === 'select') {
      var cCbs = document.querySelectorAll('.broadcast-channel-checkbox:checked');
      cCbs.forEach(function(cb) { targetChannelIds.push(cb.value); });
    }
  }

  // Confirmation dialog
  var confirmMsg = 'Confirm broadcast announcement to entire organization across selected channels (' + channels.join(', ') + ')?';
  if (!confirm(confirmMsg)) return;

  if (sendBtn) {
    sendBtn.disabled = true;
    sendBtn.innerHTML = '<i data-lucide="loader-2" class="animate-spin" style="width:15px;height:15px;"></i> <span>Broadcasting...</span>';
    if (window.lucide) lucide.createIcons();
  }
  if (feedbackEl) feedbackEl.style.display = 'none';

  try {
    var res = await api.post('/api/admin/broadcast', {
      title: title,
      message: message,
      urgency: urgency,
      channels: {
        inApp: channels.includes('in_app'),
        email: channels.includes('email'),
        slack: {
          enabled: channels.includes('slack'),
          mode: _slackTargetMode,
          channelIds: targetChannelIds,
          projectIds: targetProjectIds
        }
      },
      slackTargetMode: _slackTargetMode,
      targetChannelIds: targetChannelIds,
      targetProjectIds: targetProjectIds
    });

    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.innerHTML = '<i data-lucide="send" style="width:15px;height:15px;"></i> <span>Broadcast Announcement Now</span>';
      if (window.lucide) lucide.createIcons();
    }

    if (res && res.ok) {
      if (feedbackEl) {
        feedbackEl.style.display = 'block';
        feedbackEl.style.background = 'rgba(16,185,129,0.1)';
        feedbackEl.style.color = '#10b981';
        feedbackEl.style.border = '1px solid rgba(16,185,129,0.3)';
        var details = [];
        var inAppNum = (res.summary && res.summary.inAppSent != null) ? res.summary.inAppSent : (res.inAppCount || 0);
        var slackNum = (res.summary && res.summary.slack && res.summary.slack.sent != null) ? res.summary.slack.sent : (res.slackDispatched || 0);
        var emailNum = (res.summary && res.summary.email && res.summary.email.sent != null) ? res.summary.email.sent : 0;
        if (channels.includes('in_app')) details.push(inAppNum + ' users notified in-app');
        if (channels.includes('slack')) details.push(slackNum + ' Slack message(s) posted');
        if (channels.includes('email')) details.push(emailNum + ' emails sent');
        feedbackEl.innerHTML = '✔ <strong>Broadcast sent successfully!</strong> (' + details.join(', ') + ')';
      }

      // Reset fields
      if (titleInput) titleInput.value = '';
      if (contentInput) contentInput.value = '';
      updateBroadcastPreview();

      // Return to All Accounts view after short delay
      setTimeout(function() {
        switchAdminTab('all');
      }, 2500);
    } else {
      if (feedbackEl) {
        feedbackEl.style.display = 'block';
        feedbackEl.style.background = 'rgba(239,68,68,0.1)';
        feedbackEl.style.color = '#ef4444';
        feedbackEl.style.border = '1px solid rgba(239,68,68,0.3)';
        feedbackEl.innerHTML = '<strong>Broadcast failed:</strong> ' + ((res && res.error) || 'Failed to dispatch broadcast.');
      }
    }
  } catch (err) {
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.innerHTML = '<i data-lucide="send" style="width:15px;height:15px;"></i> <span>Broadcast Announcement Now</span>';
      if (window.lucide) lucide.createIcons();
    }
    if (feedbackEl) {
      feedbackEl.style.display = 'block';
      feedbackEl.style.background = 'rgba(239,68,68,0.1)';
      feedbackEl.style.color = '#ef4444';
      feedbackEl.style.border = '1px solid rgba(239,68,68,0.3)';
      feedbackEl.textContent = 'Network error while broadcasting: ' + (err.message || err);
    }
  }
}
window.handleSendBroadcast = handleSendBroadcast;

