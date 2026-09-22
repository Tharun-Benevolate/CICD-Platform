document.addEventListener('DOMContentLoaded', function() {
  loadAdoptionStats();
});

async function loadAdoptionStats() {
  var btn = document.getElementById('refreshBtn');
  var list = document.getElementById('userList');
  var summary = document.getElementById('summaryGrid');
  
  if (btn) btn.classList.add('loading');

  try {
    var res = await api.get('/api/adoption/stats');
    if (!res || !res.ok) throw new Error(res?.error || 'Failed to fetch adoption stats');
    
    var stats = res.stats || [];
    
    // Calculate summaries
    var totalUsers = stats.length;
    var fullyAdopted = stats.filter(function(s) { return s.progress === 100; }).length;
    var avgProgress = totalUsers > 0 ? Math.round(stats.reduce(function(acc, s) { return acc + s.progress; }, 0) / totalUsers) : 0;
    
    // Render Summary
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
      
    // Render Users
    if (totalUsers === 0) {
      list.innerHTML = '<div style="text-align:center;padding:40px;color:var(--color-text-secondary);">No users found.</div>';
      return;
    }

    var html = '';
    stats.forEach(function(u) {
      var avatar = u.avatarUrl 
        ? '<img src="' + u.avatarUrl + '" alt="avatar" />'
        : (u.username ? u.username.charAt(0).toUpperCase() : '?');
        
      var t = u.tasks;
      var taskHtml = function(isDone, icon, label) {
        var cls = isDone ? 'completed' : 'pending';
        var checkIcon = isDone 
          ? '<svg width="24" height="24" fill="none" stroke="#10b981" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>'
          : '<svg width="24" height="24" fill="none" stroke="#ef4444" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>';
          
        return '<div class="task-item ' + cls + '">' +
                 '<div class="task-icon">' + checkIcon + '</div>' +
                 '<div class="task-label">' + label + '</div>' +
               '</div>';
      };

      html += 
        '<div class="user-card">' +
          '<div class="user-card-header">' +
            '<div class="user-info">' +
              '<div class="avatar">' + avatar + '</div>' +
              '<div class="user-details">' +
                '<h3>' + escapeHtml(u.username) + ' <span style="font-size:10px;font-weight:normal;padding:2px 6px;border-radius:4px;background:var(--color-border);margin-left:8px;">' + u.userType + '</span></h3>' +
                '<p>' + (u.githubUsername ? '@' + escapeHtml(u.githubUsername) : 'GitHub not linked') + '</p>' +
              '</div>' +
            '</div>' +
            '<div class="progress-section">' +
              '<div class="progress-text">' + u.progress + '% Complete</div>' +
              '<div class="progress-bar-bg">' +
                '<div class="progress-bar-fill" style="width: ' + u.progress + '%;"></div>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="tasks-grid">' +
            taskHtml(t.profile, '', 'Setup Profile') +
            taskHtml(t.branch, '', 'Create Branch') +
            taskHtml(t.commit, '', 'Local Commit/Merge') +
            taskHtml(t.pr, '', 'Pull Request') +
            taskHtml(t.deploy, '', 'Deployment') +
          '</div>' +
        '</div>';
    });
    
    list.innerHTML = html;
  } catch (err) {
    console.error(err);
    list.innerHTML = '<div style="color:var(--color-error);padding:20px;">' + escapeHtml(err.message) + '</div>';
  } finally {
    if (btn) btn.classList.remove('loading');
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
