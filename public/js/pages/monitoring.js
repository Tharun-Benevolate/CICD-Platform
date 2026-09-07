let metricsPollInterval = null;
let metricsPaused = false;

async function initMonitoringPage() {
  // Resolve project ID FIRST — all other fetches depend on it
  try {
    const projRes = await api.get('/api/projects');
    if (projRes && projRes.projects && projRes.projects.length > 0) {
      const activeP = projRes.projects.find(p => p.isActive) || projRes.projects[0];
      _cachedProjectId = activeP.id;
    }
  } catch (e) {
    console.error('[monitor] Failed to resolve active project:', e);
  }

  // Now fire ALL fetches in parallel — no dependencies
  fetchHealthMetrics();
  setupLogViewer();   // Live-mode UI bindings
  setupLogSearch();   // Search-mode UI bindings (moved here so it actually
                       // runs on client-side SPA navigation, not just hard reload)
  fetchEcsMetrics();
  startMetricsPolling();
  startLogPolling();
}

window.initMonitoringPage = initMonitoringPage;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMonitoringPage);
} else {
  initMonitoringPage();
}

async function fetchHealthMetrics() {
  var icon = document.getElementById('refresh-icon');
  if (icon) icon.classList.add('animate-spin');

  try {
    var res = await api.get('/api/health');
    var dbEl = document.getElementById('mon-db-status');
    var awsEl = document.getElementById('mon-aws-status');

    if (dbEl) {
      dbEl.textContent = (res && res.db && res.db !== 'error') ? (res.db || 'Connected') : 'Offline';
      dbEl.style.color = (res && res.db && res.db !== 'error') ? 'var(--color-text-primary)' : 'var(--color-danger)';
    }

    if (awsEl) {
      var isAwsOk = res && (res.aws === 'ok' || res.aws === 'configured');
      awsEl.textContent = isAwsOk ? (res.aws || 'OK') : 'Unconfigured';
      awsEl.style.color = isAwsOk ? 'var(--color-success)' : 'var(--color-warning)';
    }
  } catch (e) {
    var dbEl = document.getElementById('mon-db-status');
    if (dbEl) {
      dbEl.textContent = 'Error';
      dbEl.style.color = 'var(--color-danger)';
    }
  }

  if (icon) {
    setTimeout(function () {
      icon.classList.remove('animate-spin');
    }, 500);
  }
}
window.fetchHealthMetrics = fetchHealthMetrics;

// ─── Shared log-level classifier (used by both Live terminal & Search table) ─
// This is only for visual badges now — the actual All/Application/Warnings/
// Errors filtering happens server-side in CloudWatch (see backend/routes/logs.js),
// which is both faster (smaller payloads) and more accurate (scans the full
// time range, not just whatever page happened to be fetched).
function classifyLogLevel(msg) {
  const m = (msg || '').toLowerCase();
  if (m.includes('error') || m.includes('exception') || m.includes('fatal') || m.includes('fail') || m.includes('panic')) return 'error';
  if (m.includes('warn') || m.includes('deprecated')) return 'warn';
  if (m.includes('info') || m.includes('notice') || m.includes('listening') || m.includes('started') || m.includes('healthy')) return 'info';
  return 'other';
}

// ─── ECS Task Log Viewer Logic (Live Stream mode) ───
let currentLogEnv = 'dev';
let currentLogType = 'all'; // all | info | warn | error
let isLogPaused = false;
let logPollInterval = null;
let nextToken = null;
let _cachedProjectId = null; // Cached once at init to avoid repeated /api/projects DB calls on every poll
let liveLineCount = 0;
let liveErrorCount = 0;

// Setup UI bindings only (no network calls)
function setupLogViewer() {
  const envBtns = document.querySelectorAll('.log-env-btn');
  envBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      envBtns.forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      currentLogEnv = e.target.dataset.env;
      resetLogViewer();
    });
  });

  const typeBtns = document.querySelectorAll('.log-type-btn');
  typeBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      typeBtns.forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      currentLogType = e.target.dataset.type;
      resetLogViewer();
    });
  });

  document.getElementById('logs-play-pause-btn')?.addEventListener('click', (e) => {
    isLogPaused = !isLogPaused;
    const btn = e.target.closest('button');
    if (isLogPaused) {
      btn.innerHTML = '<i data-lucide="play" style="width:14px;height:14px;"></i> Resume';
    } else {
      btn.innerHTML = '<i data-lucide="pause" style="width:14px;height:14px;"></i> Pause';
      fetchLogs();
    }
    if (window.lucide) window.lucide.createIcons();
  });

  document.getElementById('logs-clear-btn')?.addEventListener('click', () => {
    const term = document.getElementById('log-terminal');
    if (term) term.innerHTML = '';
    liveLineCount = 0;
    liveErrorCount = 0;
    updateLiveCountBadge();
  });
}

// Start log polling (called after project ID is resolved)
function startLogPolling() {
  if (logPollInterval) clearInterval(logPollInterval);
  logPollInterval = setInterval(fetchLogs, 3000);
  resetLogViewer();
}

function resetLogViewer() {
  nextToken = null;
  isLogPaused = false;
  liveLineCount = 0;
  liveErrorCount = 0;
  updateLiveCountBadge();
  const term = document.getElementById('log-terminal');
  if (term) term.innerHTML = `<div style="color:#8b949e;text-align:center;margin-top:40px;">Fetching ${logTypeLabel(currentLogType)} logs for ${currentLogEnv.toUpperCase()}...</div>`;
  const btn = document.getElementById('logs-play-pause-btn');
  if (btn) btn.innerHTML = '<i data-lucide="pause" style="width:14px;height:14px;"></i> Pause';
  if (window.lucide) window.lucide.createIcons();
  fetchLogs();
}

function logTypeLabel(type) {
  if (type === 'error') return 'error & fail';
  if (type === 'warn') return 'warning';
  if (type === 'info') return 'application';
  return 'all';
}

function updateLiveCountBadge() {
  const el = document.getElementById('log-line-count');
  if (!el) return;
  el.textContent = liveErrorCount > 0
    ? `${liveLineCount} lines · ${liveErrorCount} errors`
    : (liveLineCount > 0 ? `${liveLineCount} lines` : '');
}

async function fetchLogs() {
  if (isLogPaused) return;

  // Use the project ID resolved once at init — never re-fetch on every cycle
  const projectId = _cachedProjectId;
  if (!projectId) {
    const term = document.getElementById('log-terminal');
    if (term && term.innerHTML.includes("Fetching")) {
      term.innerHTML = `<div style="color:#8b949e;text-align:center;margin-top:40px;">Please create or select a project first.</div>`;
    }
    return;
  }

  const indicator = document.getElementById('log-status-indicator');
  if (indicator) {
    indicator.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:var(--color-primary);display:inline-block;"></span> Fetching...`;
  }

  try {
    let url = `/api/logs/${projectId}/${currentLogEnv}?type=${encodeURIComponent(currentLogType)}`;
    if (nextToken) url += `&nextToken=${encodeURIComponent(nextToken)}`;

    const res = await api.get(url);
    if (res && res.ok) {
      if (res.notFound) {
        const term = document.getElementById('log-terminal');
        term.innerHTML = `<div style="color:#8b949e;text-align:center;margin-top:40px;">No logs found yet. Log group ${res.logGroupName} does not exist or has no events.</div>`;
      } else {
        // BUG FIX: nextToken must advance on every response, even when this
        // particular poll matched zero lines. It used to only advance inside
        // the "events.length > 0" branch, so a single quiet/empty poll left
        // nextToken stuck at null forever — every subsequent 3s poll re-asked
        // CloudWatch the exact same "2h ago → now" question instead of moving
        // the window forward, which is exactly the "stuck on Fetching..."
        // symptom. CloudWatch always hands back a token to continue from,
        // whether or not that particular page had matches.
        if (res.events && res.events.length > 0) {
          appendLogs(res.events);
        } else if (!nextToken) {
          // First poll came back empty — let the person know we're live and
          // simply waiting, rather than leaving a stale "Fetching..." message.
          const term = document.getElementById('log-terminal');
          if (term && term.innerHTML.includes('Fetching')) {
            term.innerHTML = `<div style="color:#8b949e;text-align:center;margin-top:60px;font-size:13px;">Listening for new ${logTypeLabel(currentLogType)} logs on ${currentLogEnv.toUpperCase()}… no matching activity in the last 2 hours yet.</div>`;
          }
        }
        if (res.nextToken) nextToken = res.nextToken;
      }

      if (indicator) {
        indicator.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:var(--color-success);display:inline-block;"></span> Connected`;
      }
    }
  } catch (err) {
    console.error("Log fetch error:", err);
    if (indicator) {
      indicator.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:var(--color-danger);display:inline-block;"></span> Error`;
    }
  }
}

function appendLogs(events) {
  const term = document.getElementById('log-terminal');
  if (!term) return;

  // Clear placeholder text if it exists
  if (term.innerHTML.includes("Fetching") || term.innerHTML.includes("Select an environment") || term.innerHTML.includes("No logs found") || term.innerHTML.includes("Listening for")) {
    term.innerHTML = '';
  }

  const isScrolledToBottom = term.scrollHeight - term.clientHeight <= term.scrollTop + 10;

  events.forEach(e => {
    const level = classifyLogLevel(e.message);
    liveLineCount++;
    if (level === 'error') liveErrorCount++;

    const time = new Date(e.timestamp).toLocaleTimeString();
    const line = document.createElement('div');
    line.style.display = 'flex';
    line.style.gap = '12px';
    line.style.marginBottom = '2px';

    const timeSpan = document.createElement('span');
    timeSpan.style.color = '#8b949e';
    timeSpan.style.flexShrink = '0';
    timeSpan.textContent = `[${time}]`;

    const msgSpan = document.createElement('span');
    msgSpan.style.wordBreak = 'break-all';
    if (level === 'error') msgSpan.style.color = '#ff7b72';
    else if (level === 'warn') msgSpan.style.color = '#d2a8ff';
    else msgSpan.style.color = '#c9d1d9';
    msgSpan.textContent = e.message.trimEnd();

    line.appendChild(timeSpan);
    line.appendChild(msgSpan);
    term.appendChild(line);
  });

  // Keep max 1000 lines to prevent DOM bloat
  while (term.children.length > 1000) {
    term.removeChild(term.firstChild);
  }

  updateLiveCountBadge();

  if (isScrolledToBottom) {
    term.scrollTop = term.scrollHeight;
  }
}

// Override project selector to refresh logs when project changes
document.addEventListener('projectChanged', () => {
  if (window.location.pathname.includes('/monitoring')) {
    resetLogViewer();
    fetchEcsMetrics();
  }
});

// ─── ECS Service Metrics (CPU / Memory per environment) ───────────────────

function startMetricsPolling() {
  if (metricsPollInterval) clearInterval(metricsPollInterval);
  metricsPollInterval = setInterval(() => {
    if (!metricsPaused) fetchEcsMetrics();
  }, 30000); // every 30 seconds
}

function toggleMetricsPause() {
  metricsPaused = !metricsPaused;
  const btn = document.getElementById('metrics-pause-btn');
  if (!btn) return;
  if (metricsPaused) {
    btn.innerHTML = '<i data-lucide="play" style="width:12px;height:12px;"></i> Resume';
  } else {
    btn.innerHTML = '<i data-lucide="pause" style="width:12px;height:12px;"></i> Pause';
    fetchEcsMetrics();
  }
  if (window.lucide) window.lucide.createIcons();
}
window.toggleMetricsPause = toggleMetricsPause;

async function fetchEcsMetrics() {
  const projectId = _cachedProjectId;
  if (!projectId) return;

  try {
    const data = await api.get('/api/monitoring/' + projectId + '/metrics');
    if (!data || !data.ok) return;

    const metrics = data.metrics || {};
    const envs = ['dev', 'uat', 'prod', 'beta'];

    envs.forEach(env => {
      const m = metrics[env];
      const card = document.getElementById('env-card-' + env);
      if (!card) return;

      // Show beta card only if data exists
      if (env === 'beta') {
        card.style.display = m ? '' : 'none';
        if (!m) return;
      }

      // CPU gauge — show as ECS units (256 units = 0.25 vCPU)
      const cpuVal = m.cpu && m.cpu.avg != null ? m.cpu.avg : null;
      const cpuBar = document.getElementById('gauge-cpu-' + env);
      const cpuText = document.getElementById('val-cpu-' + env);
      if (cpuBar) {
        const vcpu = cpuVal != null ? cpuVal / 1024 : 0;
        const pct = Math.min((vcpu / 4) * 100, 100); // scale: 4 vCPU = 100%
        cpuBar.style.width = (cpuVal != null ? Math.max(pct, 3) : 0) + '%';
        cpuBar.style.background = cpuVal != null ? 'var(--color-primary)' : '#6b7280';
      }
      if (cpuText) cpuText.textContent = cpuVal != null ? (cpuVal / 1024).toFixed(2) + ' vCPU' : '—';

      // Memory gauge — show as MiB
      const memVal = m.memory && m.memory.avg != null ? m.memory.avg : null;
      const memBar = document.getElementById('gauge-mem-' + env);
      const memText = document.getElementById('val-mem-' + env);
      if (memBar) {
        const gb = memVal != null ? memVal / 1024 : 0;
        const pct = Math.min((gb / 8) * 100, 100); // scale: 8 GB = 100%
        memBar.style.width = (memVal != null ? Math.max(pct, 3) : 0) + '%';
        memBar.style.background = memVal != null ? '#a78bfa' : '#6b7280';
      }
      if (memText) memText.textContent = memVal != null ? (memVal >= 1024 ? (memVal / 1024).toFixed(1) + ' GB' : memVal + ' MiB') : '—';

      // Service status badge
      const statusEl = document.getElementById('env-status-' + env);
      if (statusEl && m.service) {
        const svc = m.service;
        const isUp = svc.runningCount > 0 && svc.runningCount >= svc.desiredCount;
        const dotColor = isUp ? '#22c55e' : (svc.runningCount > 0 ? '#eab308' : '#ef4444');
        const statusText = isUp ? 'Healthy' : (svc.runningCount > 0 ? 'Degraded' : (svc.status === 'unconfigured' ? 'Not deployed' : 'Down'));
        statusEl.innerHTML = '<span class="status-dot" style="background:' + dotColor + ';"></span> ' + statusText;
      }

      // Footer: task counts
      const footer = document.getElementById('env-footer-' + env);
      if (footer && m.service) {
        const svc = m.service;
        footer.textContent = 'Tasks: ' + (svc.runningCount || 0) + ' / ' + (svc.desiredCount || 0) + ' running' + ((svc.pendingCount || 0) > 0 ? ' (' + svc.pendingCount + ' pending)' : '');
      }
    });

    // Update refresh badge timestamp
    const badge = document.getElementById('metrics-refresh-badge');
    if (badge) {
      const now = new Date();
      badge.textContent = 'Updated: ' + now.toLocaleTimeString();
    }

    if (window.lucide) window.lucide.createIcons();
  } catch (err) {
    console.error('[monitoring] Failed to fetch ECS metrics:', err);
  }
}

function getGaugeColor(value) {
  if (value == null) return '#6b7280';
  if (value < 50) return '#22c55e';     // green
  if (value < 75) return '#eab308';     // yellow
  return '#ef4444';                      // red
}

// ═══════════════════════════════════════════════════════════════════════════
// Search Logs mode
// NOTE: this used to live in an inline <script> at the bottom of the
// monitoring.ejs partial. That worked on a hard page reload, but this app's
// SPA router (public/js/router.js) swaps pages in via `innerHTML`, and
// browsers never execute <script> tags inserted that way — so navigating to
// Monitoring from the sidebar silently left every Search Logs handler
// undefined ("Search Logs is not working"). Living in this page-JS file
// fixes that: the router always loads it with a real <script src="...">,
// which does execute, on every navigation.
// ═══════════════════════════════════════════════════════════════════════════

let _lsEnv = 'dev', _lsNextToken = null, _lsTotalRows = 0, _lsErrorRows = 0;
let _lsBound = false;

function switchLogMode(mode) {
  const live = mode === 'live';
  document.getElementById('panel-live').style.display   = live ? '' : 'none';
  document.getElementById('panel-search').style.display = live ? 'none' : '';
  document.getElementById('mode-live-btn').classList.toggle('active', live);
  document.getElementById('mode-search-btn').classList.toggle('active', !live);
  if (!live) _lsInitDefaults();
}
window.switchLogMode = switchLogMode;

function _lsInitDefaults() {
  const now = new Date(), from = new Date(now - 864e5);
  const fmt = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const fe = document.getElementById('ls-from'), te = document.getElementById('ls-to');
  if (fe && !fe.value) fe.value = fmt(from);
  if (te && !te.value) te.value = fmt(now);
}

function setupLogSearch() {
  if (_lsBound) return; // guard against double-binding if init ever runs twice
  _lsBound = true;

  document.querySelectorAll('.ls-env-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ls-env-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _lsEnv = btn.dataset.env;
    });
  });
  document.getElementById('ls-text')?.addEventListener('keydown', e => { if (e.key === 'Enter') runLogSearch(); });
}

function _lsShowOnly(id) {
  ['ls-placeholder', 'ls-loading', 'ls-table-wrap', 'ls-empty', 'ls-error'].forEach(el => {
    const node = document.getElementById(el);
    if (!node) return;
    const flex = ['ls-loading', 'ls-empty', 'ls-error'].includes(el);
    node.style.display = el === id ? (flex ? 'flex' : '') : 'none';
  });
}

function _lsRenderRows(events, append) {
  const tbody = document.getElementById('ls-table-body');
  if (!tbody) return;
  if (!append) { tbody.innerHTML = ''; }
  // Filtering by category already happened server-side (CloudWatch native
  // filter pattern) — here we only classify for the colored badge, we don't
  // re-filter, so results always match what the count says.
  events.forEach(e => {
    const cat = classifyLogLevel(e.message);
    if (cat === 'error') _lsErrorRows++;
    const ts     = new Date(e.timestamp).toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const stream = (e.logStreamName || '').split('/').pop() || '—';
    const msg    = e.message.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${ts}</td><td><span class="ls-badge ls-badge-${cat}">${cat}</span></td><td><span class="ls-stream" title="${e.logStreamName || ''}">${stream}</span></td><td>${msg}</td>`;
    tbody.appendChild(tr);
    _lsTotalRows++;
  });
}

async function runLogSearch(append) {
  if (!append) { _lsNextToken = null; _lsTotalRows = 0; _lsErrorRows = 0; }
  const projectId = _cachedProjectId;
  if (!projectId) {
    _lsShowOnly('ls-error');
    document.getElementById('ls-error-msg').textContent = 'No active project. Switch from the top-left dropdown.';
    return;
  }
  const fromVal  = document.getElementById('ls-from')?.value;
  const toVal    = document.getElementById('ls-to')?.value;
  const text     = (document.getElementById('ls-text')?.value || '').trim();
  const category = document.getElementById('ls-category')?.value || '';
  const params   = new URLSearchParams();
  if (fromVal)  params.set('startTime', new Date(fromVal).getTime());
  if (toVal)    params.set('endTime', new Date(toVal).getTime());
  if (text)     params.set('filterPattern', text);
  else if (category) params.set('category', category);
  if (_lsNextToken) params.set('nextToken', _lsNextToken);

  const btn = document.getElementById('ls-search-btn');
  const lmb = document.getElementById('ls-load-more-btn');
  if (!append) { _lsShowOnly('ls-loading'); if (btn) btn.disabled = true; }
  if (lmb) { lmb.style.display = 'none'; lmb.disabled = true; }

  try {
    const data = await api.get(`/api/logs/search/${projectId}/${_lsEnv}?${params}`);
    if (!data?.ok) throw new Error(data?.error || 'Server error');
    if (data.notFound || (!data.events?.length && !append)) { _lsShowOnly('ls-empty'); return; }
    _lsNextToken = data.nextToken || null;
    _lsRenderRows(data.events || [], append);
    _lsShowOnly('ls-table-wrap');
    const countEl = document.getElementById('ls-result-count');
    if (countEl) countEl.textContent = `${_lsTotalRows} result${_lsTotalRows !== 1 ? 's' : ''}${_lsNextToken ? ' · more available' : ''}`;
    const errEl = document.getElementById('ls-error-count');
    if (errEl) {
      if (_lsErrorRows > 0) { errEl.style.display = ''; errEl.textContent = `${_lsErrorRows} error${_lsErrorRows !== 1 ? 's' : ''} in view`; }
      else { errEl.style.display = 'none'; }
    }
    if (lmb) { lmb.style.display = _lsNextToken ? '' : 'none'; lmb.disabled = false; }
  } catch (err) {
    _lsShowOnly('ls-error');
    document.getElementById('ls-error-msg').textContent = `Search failed: ${err.message}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}
window.runLogSearch = runLogSearch;

function loadMoreLogs() { if (_lsNextToken) runLogSearch(true); }
window.loadMoreLogs = loadMoreLogs;

function lsReset() {
  ['ls-from', 'ls-to', 'ls-text'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const ca = document.getElementById('ls-category'); if (ca) ca.value = '';
  _lsNextToken = null; _lsTotalRows = 0; _lsErrorRows = 0;
  _lsInitDefaults();
  _lsShowOnly('ls-placeholder');
  const lmb = document.getElementById('ls-load-more-btn'); if (lmb) lmb.style.display = 'none';
  const errEl = document.getElementById('ls-error-count'); if (errEl) errEl.style.display = 'none';
}
window.lsReset = lsReset;

// Export currently-rendered search results as a plain-text .log file
function exportLogResults() {
  const rows = document.querySelectorAll('#ls-table-body tr');
  if (!rows.length) return;
  const lines = Array.from(rows).map(tr => {
    const cells = tr.querySelectorAll('td');
    const when   = cells[0]?.textContent || '';
    const cat    = cells[1]?.textContent.trim() || '';
    const stream = cells[2]?.textContent.trim() || '';
    const msg    = cells[3]?.textContent || '';
    return `[${when}] [${cat.toUpperCase()}] [${stream}] ${msg}`;
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${_lsEnv}-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
window.exportLogResults = exportLogResults;
