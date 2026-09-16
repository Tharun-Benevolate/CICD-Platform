// Audit Logs Page — Vanilla JS Logic
var _auditLogs = [];
var _auditCategory = 'All';
var _auditPage = 1;
var _auditPageSize = 50;
var _auditPagination = { page: 1, limit: 50, total: 0, totalPages: 1, hasPrevious: false, hasNext: false };
var _auditSearchTimer = null;

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
  _auditPage = 1;
  ['All', 'Security', 'Login', 'Approvals', 'Pipeline Executions', 'Terraform', 'User Management', 'Other'].forEach(function(c) {
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
    var query = (document.getElementById('audit-search-input')?.value || '').trim();
    var url = '/api/audit-logs?limit=' + _auditPageSize + '&page=' + _auditPage;
    if (_auditCategory !== 'All') {
      if (_auditCategory === 'Security') {
        url += '&security=true';
      } else {
        url += '&category=' + encodeURIComponent(_auditCategory);
      }
    }
    if (query) url += '&search=' + encodeURIComponent(query);
    var res = await api.get(url);
    if (res && res.ok && res.logs) {
      _auditLogs = res.logs;
      _auditPagination = res.pagination || _auditPagination;
      _auditPage = _auditPagination.page || _auditPage;
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

  renderAuditLogs();
}

function filterAuditLogs() {
  _auditPage = 1;
  clearTimeout(_auditSearchTimer);
  _auditSearchTimer = setTimeout(fetchAuditLogs, 250);
}

function changeAuditPage(nextPage) {
  if (nextPage < 1 || nextPage > (_auditPagination.totalPages || 1) || nextPage === _auditPage) return;
  _auditPage = nextPage;
  fetchAuditLogs();
}

function escapeAuditHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderAuditLogs() {
  var filtered = _auditLogs;

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
        '<div style="font-weight:600;font-size:14px;color:var(--color-text-primary);">' + escapeAuditHtml(log.action || 'Action') + '</div>' +
        '<div style="font-size:12px;color:var(--color-text-tertiary);margin-top:2px;">' +
          'User: <b style="color:var(--color-text-secondary);">' + escapeAuditHtml(log.username || log.user || 'system') + '</b> &bull; IP: <b style="color:var(--color-text-secondary);">' + escapeAuditHtml(log.ipAddress || log.ip_address || '127.0.0.1') + '</b> &bull; Category: ' + escapeAuditHtml(log.category || 'General') + ' &bull; Project: ' + escapeAuditHtml(log.project_name || log.projectName || 'N/A') +
        '</div>' +
      '</div>' +
      '<div style="text-align:right;">' +
        '<span class="badge ' + badgeClass + '">' + escapeAuditHtml(log.result || 'Success') + '</span>' +
        (dateStr ? '<div style="font-size:11px;color:var(--color-text-tertiary);margin-top:4px;">' + dateStr + '</div>' : '') +
      '</div>';

    row.innerHTML = html;
    listEl.appendChild(row);
  });

  if (window.lucide) lucide.createIcons();
  renderAuditPagination();
}

function renderAuditPagination() {
  var paginationEl = document.getElementById('audit-pagination');
  if (!paginationEl) return;
  var total = _auditPagination.total || 0;
  if (!total) {
    paginationEl.style.display = 'none';
    return;
  }
  var page = _auditPagination.page || 1;
  var limit = _auditPagination.limit || _auditPageSize;
  var first = (page - 1) * limit + 1;
  var last = Math.min(page * limit, total);
  paginationEl.style.display = 'flex';
  document.getElementById('audit-pagination-summary').textContent = 'Showing ' + first + '–' + last + ' of ' + total + ' events';
  var previous = document.getElementById('audit-page-previous');
  var next = document.getElementById('audit-page-next');
  if (previous) previous.disabled = !_auditPagination.hasPrevious;
  if (next) next.disabled = !_auditPagination.hasNext;

  // Keep a compact, forward-looking five-page window. For example, page 5
  // shows 5–9; near the final page the window shifts back to stay in range.
  var numbers = document.getElementById('audit-page-numbers');
  if (!numbers) return;
  var totalPages = _auditPagination.totalPages || 1;
  var firstPage = Math.min(page, Math.max(totalPages - 4, 1));
  var lastPage = Math.min(firstPage + 4, totalPages);
  numbers.innerHTML = '';
  for (var number = firstPage; number <= lastPage; number++) {
    var button = document.createElement('button');
    var active = number === page;
    button.type = 'button';
    button.textContent = number;
    button.setAttribute('aria-label', 'Go to audit-log page ' + number);
    button.setAttribute('aria-current', active ? 'page' : 'false');
    button.disabled = active;
    button.style.cssText = 'min-width:31px;padding:7px 8px;border-radius:6px;border:1px solid ' + (active ? '#6366f1' : 'var(--color-border)') + ';background:' + (active ? '#6366f1' : 'var(--color-surface)') + ';color:' + (active ? '#fff' : 'var(--color-text-secondary)') + ';font-size:12px;font-weight:' + (active ? '700' : '500') + ';cursor:' + (active ? 'default' : 'pointer') + ';';
    if (!active) {
      (function(targetPage) {
        button.addEventListener('click', function() { changeAuditPage(targetPage); });
      })(number);
    }
    numbers.appendChild(button);
  }
}
