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
// Filter Tabs
// ─────────────────────────────────────────────────────────────────
function setAdminFilterTab(tab) {
  _adminFilterTab = tab;

  var titles = { all: 'Platform User Accounts', pending: 'Fresh Signups Awaiting Moderation', blocked: 'Suspended Accounts' };
  var el = document.getElementById('admin-section-title');
  if (el) el.textContent = titles[tab] || 'Platform User Accounts';

  ['all', 'pending', 'blocked'].forEach(function(t) {
    var btn = document.getElementById('admin-tab-' + t);
    if (!btn) return;
    if (t === tab) {
      btn.style.borderColor = '#6366f1';
      btn.style.background  = 'rgba(99,102,241,0.07)';
      btn.style.color       = '#6366f1';
      btn.style.fontWeight  = '700';
      var badge = btn.querySelector('span');
      if (badge) { badge.style.background = '#e0e7ff'; badge.style.color = '#6366f1'; }
    } else {
      btn.style.borderColor = 'var(--color-border)';
      btn.style.background  = 'var(--color-surface)';
      btn.style.color       = 'var(--color-text-secondary)';
      btn.style.fontWeight  = '600';
      var badge2 = btn.querySelector('span');
      if (badge2) { badge2.style.background = 'var(--color-bg)'; badge2.style.color = 'var(--color-text-secondary)'; }
    }
  });
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
      var d = new Date(ts);
      if (isNaN(d.getTime())) return String(ts);
      // Show local with timezone offset label (IST = +5:30 from GMT)
      return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', year:'numeric', month:'numeric', day:'numeric', hour:'numeric', minute:'2-digit', second:'2-digit', hour12:false }) + ' GMT+5:30';
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
