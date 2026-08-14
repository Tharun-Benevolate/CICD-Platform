// Audit Logs Page — Vanilla JS Logic
var _auditLogs = [];
var _auditCategory = 'All';

window.initAuditLogsPage = initAuditLogsPage;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAuditLogsPage);
} else {
  initAuditLogsPage();
}

function initAuditLogsPage() {
  fetchAuditLogs();
}

function setAuditCategory(cat) {
  _auditCategory = cat;
  ['All', 'Login', 'Approvals', 'Pipeline Executions', 'Terraform', 'User Management', 'Other'].forEach(function(c) {
    var btn = document.getElementById('audit-cat-' + c);
    if (!btn) return;
    if (c === cat) {
      btn.className = 'audit-cat-btn active';
      btn.style.background = '#6366f1';
      btn.style.borderColor = '#6366f1';
      btn.style.color = 'white';
      btn.style.fontWeight = '600';
    } else {
      btn.className = 'audit-cat-btn';
      btn.style.background = 'var(--color-surface)';
      btn.style.borderColor = 'var(--color-border)';
      btn.style.color = 'var(--color-text-secondary)';
      btn.style.fontWeight = '';
    }
  });
  fetchAuditLogs();
}

async function fetchAuditLogs() {
  var loadingEl = document.getElementById('audit-loading');
  var emptyEl = document.getElementById('audit-empty');
  var listEl = document.getElementById('audit-logs-list');
  var iconRefresh = document.getElementById('btn-refresh-audit-icon');

  if (iconRefresh) iconRefresh.classList.add('animate-spin');
  if (loadingEl) loadingEl.style.display = 'flex';
  if (emptyEl) emptyEl.style.display = 'none';
  if (listEl) listEl.style.display = 'none';

  try {
    var url = '/api/audit-logs?limit=100';
    if (_auditCategory !== 'All') {
      url += '&category=' + encodeURIComponent(_auditCategory);
    }
    var res = await api.get(url);
    if (res && res.ok && res.logs) {
      _auditLogs = res.logs;
    } else {
      _auditLogs = [];
    }
  } catch (e) {
    _auditLogs = [];
  }

  if (loadingEl) loadingEl.style.display = 'none';
  if (iconRefresh) {
    setTimeout(function() { iconRefresh.classList.remove('animate-spin'); }, 400);
  }

  filterAuditLogs();
}

function filterAuditLogs() {
  var query = (document.getElementById('audit-search-input')?.value || '').toLowerCase();
  var filtered = _auditLogs.filter(function(l) {
    if (!query) return true;
    var act = (l.action || '').toLowerCase();
    var user = (l.username || l.user || '').toLowerCase();
    var cat = (l.category || '').toLowerCase();
    return act.includes(query) || user.includes(query) || cat.includes(query);
  });

  var listEl = document.getElementById('audit-logs-list');
  var emptyEl = document.getElementById('audit-empty');

  if (!listEl) return;

  listEl.innerHTML = '';
  if (filtered.length === 0) {
    if (listEl) listEl.style.display = 'none';
    if (emptyEl) emptyEl.style.display = 'block';
    return;
  }

  if (emptyEl) emptyEl.style.display = 'none';
  listEl.style.display = 'flex';

  filtered.forEach(function(log) {
    var row = document.createElement('div');
    row.className = 'audit-log-row';

    var isOk = log.result === 'Success' || log.result === 'ok';
    var badgeClass = isOk ? 'badge-ok' : 'badge-fail';
    var dateStr = log.timestamp ? (window.TimeUtil ? TimeUtil.formatDateTime(log.timestamp) : new Date(log.timestamp).toLocaleString()) : '';

    var html =
      '<div>' +
        '<div style="font-weight:600;font-size:14px;color:var(--color-text-primary);">' + (log.action || 'Action') + '</div>' +
        '<div style="font-size:12px;color:var(--color-text-tertiary);margin-top:2px;">' +
          'User: <b style="color:var(--color-text-secondary);">' + (log.username || log.user || 'system') + '</b> &bull; IP: <b style="color:var(--color-text-secondary);">' + (log.ipAddress || log.ip_address || '127.0.0.1') + '</b> &bull; Category: ' + (log.category || 'General') + ' &bull; Project: ' + (log.project_name || log.projectName || 'N/A') +
        '</div>' +
      '</div>' +
      '<div style="text-align:right;">' +
        '<span class="badge ' + badgeClass + '">' + (log.result || 'Success') + '</span>' +
        (dateStr ? '<div style="font-size:11px;color:var(--color-text-tertiary);margin-top:4px;">' + dateStr + '</div>' : '') +
      '</div>';

    row.innerHTML = html;
    listEl.appendChild(row);
  });

  if (window.lucide) lucide.createIcons();
}
