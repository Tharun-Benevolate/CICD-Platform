// Training Adoption Tracker Page — Vanilla JS Logic

function initTrainingPage() {
  loadAdoptionStats();
}

// Expose for SPA router to call on client-side navigation
window.initTrainingPage = initTrainingPage;

// Also handle direct/hard-refresh page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initTrainingPage);
} else {
  initTrainingPage();
}

async function loadAdoptionStats() {
  var btn = document.getElementById('refreshBtn');
  var list = document.getElementById('userList');
  var summary = document.getElementById('summaryGrid');

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-2" style="width:14px;height:14px;margin-right:6px;animation:spin 1s linear infinite;"></i> Loading...';
  }

  try {
    var res = await api.get('/api/adoption/stats');
    if (!res || !res.ok) throw new Error(res?.error || 'Failed to fetch adoption stats');

    // Show tracking-since badge if a reset has been applied
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

    var stats = res.stats || [];

    // Summary stats
    var totalUsers = stats.length;
    var fullyAdopted = stats.filter(function(s) { return s.progress === 100; }).length;
    var avgProgress = totalUsers > 0 ? Math.round(stats.reduce(function(acc, s) { return acc + s.progress; }, 0) / totalUsers) : 0;

    if (summary) {
      summary.innerHTML =
        '<div class="summary-card">' +
          '<div class="value">' + totalUsers + '</div>' +
          '<div class="label">Total Team</div>' +
        '</div>' +
        '<div class="summary-card">' +
          '<div class="value" style="color: #10b981;">' + fullyAdopted + '</div>' +
          '<div class="label">Fully Adopted</div>' +
        '</div>' +
        '<div class="summary-card">' +
          '<div class="value" style="color: #60a5fa;">' + avgProgress + '%</div>' +
          '<div class="label">Average Progress</div>' +
        '</div>';
    }

    // User cards
    if (!list) return;
    if (totalUsers === 0) {
      list.innerHTML = '<div style="text-align:center;padding:40px;color:var(--color-text-secondary);">No users found.</div>';
      return;
    }

    var html = '';
    stats.forEach(function(u) {
      var initials = (u.username || '?').charAt(0).toUpperCase();
      var avatar = u.avatarUrl
        ? '<img src="' + u.avatarUrl + '" alt="avatar" onerror="this.parentNode.innerHTML=\'' + initials + '\'">'
        : initials;

      var t = u.tasks;

      function taskBox(isDone, label) {
        var cls = isDone ? 'completed' : 'pending';
        var icon = isDone
          ? '<svg width="22" height="22" fill="none" stroke="#10b981" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>'
          : '<svg width="22" height="22" fill="none" stroke="#ef4444" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>';
        return '<div class="task-item ' + cls + '">' +
          '<div class="task-icon">' + icon + '</div>' +
          '<div class="task-label">' + label + '</div>' +
          '</div>';
      }

      var progressColor = u.progress === 100 ? '#10b981' : u.progress >= 60 ? '#60a5fa' : u.progress >= 40 ? '#f59e0b' : '#ef4444';
      var onlineDot = u.isOnline
        ? '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#10b981;margin-left:6px;box-shadow:0 0 4px #10b981;" title="Online"></span>'
        : '';

      html +=
        '<div class="user-card">' +
          '<div class="user-card-header">' +
            '<div class="user-info">' +
              '<div class="avatar">' + avatar + '</div>' +
              '<div class="user-details">' +
                '<h3>' + escapeHtml(u.username) + onlineDot +
                  ' <span style="font-size:10px;font-weight:600;padding:2px 7px;border-radius:4px;background:var(--color-border);color:var(--color-text-secondary);margin-left:6px;">' + escapeHtml(u.userType || '') + '</span>' +
                '</h3>' +
                '<p>' + (u.githubUsername ? '&#64;' + escapeHtml(u.githubUsername) : '<span style="color:#ef4444;">GitHub not linked</span>') + '</p>' +
              '</div>' +
            '</div>' +
            '<div class="progress-section">' +
              '<div class="progress-text" style="color:' + progressColor + ';">' + u.progress + '% Complete</div>' +
              '<div class="progress-bar-bg">' +
                '<div class="progress-bar-fill" style="width:' + u.progress + '%;background:linear-gradient(90deg,' + progressColor + ',' + progressColor + 'aa);"></div>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="tasks-grid">' +
            taskBox(t.profile, 'Setup Profile') +
            taskBox(t.branch, 'Create Branch') +
            taskBox(t.commit, 'Commit / Merge') +
            taskBox(t.pr, 'Pull Request') +
            taskBox(t.deploy, 'Deployment') +
          '</div>' +
        '</div>';
    });

    list.innerHTML = html;

    // Re-run lucide icons if available
    if (window.lucide) lucide.createIcons();

  } catch (err) {
    console.error('[training]', err);
    if (list) list.innerHTML = '<div style="color:var(--color-error);padding:20px;text-align:center;">' + escapeHtml(err.message) + '</div>';
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="refresh-cw" style="width:14px;height:14px;margin-right:6px;"></i> Refresh Data';
      if (window.lucide) lucide.createIcons();
    }
  }
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function resetTracking() {
  if (!confirm('Reset adoption tracking for ALL users?\n\nThis sets a new start date — only GitHub activity AFTER this point will count as completed.\n\nThis does NOT delete any branches, commits or pull requests.')) return;
  var btn = document.getElementById('resetBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Resetting…'; }
  try {
    var res = await api.post('/api/adoption/reset', {});
    if (!res || !res.ok) throw new Error(res?.error || 'Reset failed');
    alert('\u2705 Tracking reset successfully!\n\nNew start date: ' + new Date(res.resetAt).toLocaleString() + '\n\nRefreshing dashboard…');
    await loadAdoptionStats();
  } catch (err) {
    alert('\u274C Reset failed: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="rotate-ccw" style="width:14px;height:14px;margin-right:6px;"></i> Reset Fresh Start'; if (window.lucide) lucide.createIcons(); }
  }
}
