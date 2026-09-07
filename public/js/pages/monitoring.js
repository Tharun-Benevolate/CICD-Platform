let metricsPollInterval = null;
let metricsPaused = false;

function initMonitoringPage() {
  fetchHealthMetrics();
  initLogViewer();
  fetchEcsMetrics();
  startMetricsPolling();
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

// ─── ECS Task Log Viewer Logic ───
let currentLogEnv = 'dev';
let currentLogType = 'all';
let isLogPaused = false;
let logPollInterval = null;
let nextToken = null;
let _cachedProjectId = null; // Cached once at init to avoid repeated /api/projects DB calls on every poll

async function initLogViewer() {
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
      fetchLogs(); // immediately fetch when resumed
    }
    if (window.lucide) window.lucide.createIcons();
  });

  document.getElementById('logs-clear-btn')?.addEventListener('click', () => {
    const term = document.getElementById('log-terminal');
    if (term) term.innerHTML = '';
  });

  // Resolve project ID once at init — do NOT re-fetch on every poll cycle
  // This prevents a /api/projects DB call firing every 3 seconds and
  // clogging the Node.js event loop (which was causing Terraform SSE to stutter).
  try {
    const projRes = await api.get('/api/projects');
    if (projRes && projRes.projects && projRes.projects.length > 0) {
      const activeP = projRes.projects.find(p => p.isActive) || projRes.projects[0];
      _cachedProjectId = activeP.id;
    }
  } catch (e) {
    console.error('[monitor] Failed to resolve active project:', e);
  }

  // Start polling
  if (logPollInterval) clearInterval(logPollInterval);
  logPollInterval = setInterval(fetchLogs, 3000);
  resetLogViewer();
}

function resetLogViewer() {
  nextToken = null;
  isLogPaused = false;
  const term = document.getElementById('log-terminal');
  if (term) term.innerHTML = `<div style="color:#8b949e;text-align:center;margin-top:40px;">Fetching logs for ${currentLogEnv.toUpperCase()}...</div>`;
  const btn = document.getElementById('logs-play-pause-btn');
  if (btn) btn.innerHTML = '<i data-lucide="pause" style="width:14px;height:14px;"></i> Pause';
  if (window.lucide) window.lucide.createIcons();
  fetchLogs();
}

async function fetchLogs() {
  if (isLogPaused) return;

  // Use the project ID resolved once at init — never re-fetch on every cycle
  const projectId = _cachedProjectId;
  if (!projectId) {
    const term = document.getElementById('log-terminal');
    if (term && term.innerHTML.includes("Fetching logs")) {
      term.innerHTML = `<div style="color:#8b949e;text-align:center;margin-top:40px;">Please create or select a project first.</div>`;
    }
    return;
  }

  const indicator = document.getElementById('log-status-indicator');
  if (indicator) {
    indicator.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:var(--color-primary);display:inline-block;"></span> Fetching...`;
  }

  try {
    let url = `/api/logs/${projectId}/${currentLogEnv}`;
    if (nextToken) url += `?nextToken=${encodeURIComponent(nextToken)}`;

    const res = await api.get(url);
    if (res && res.ok) {
      if (res.notFound) {
        const term = document.getElementById('log-terminal');
        term.innerHTML = `<div style="color:#8b949e;text-align:center;margin-top:40px;">No logs found yet. Log group ${res.logGroupName} does not exist or has no events.</div>`;
      } else if (res.events && res.events.length > 0) {
        appendLogs(res.events);
        nextToken = res.nextToken;
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

  // Clear "Fetching..." placeholder if it exists
  if (term.innerHTML.includes("Fetching logs") || term.innerHTML.includes("Select an environment") || term.innerHTML.includes("No logs found")) {
    term.innerHTML = '';
  }

  const isScrolledToBottom = term.scrollHeight - term.clientHeight <= term.scrollTop + 10;

  events.forEach(e => {
    const msgLower = e.message.toLowerCase();

    // Client-side filtering for App Errors
    if (currentLogType === 'error') {
      if (!msgLower.includes('error') && !msgLower.includes('exception') && !msgLower.includes('fail')) {
        return; // skip non-errors
      }
    }

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
    msgSpan.style.color = '#c9d1d9';
    msgSpan.style.wordBreak = 'break-all';

    // Simple color coding for errors
    if (msgLower.includes('error') || msgLower.includes('exception') || msgLower.includes('fail')) {
      msgSpan.style.color = '#ff7b72';
    } else if (msgLower.includes('warn')) {
      msgSpan.style.color = '#d2a8ff';
    }

    msgSpan.textContent = e.message.trimEnd();

    line.appendChild(timeSpan);
    line.appendChild(msgSpan);
    term.appendChild(line);
  });

  // Keep max 1000 lines to prevent DOM bloat
  while (term.children.length > 1000) {
    term.removeChild(term.firstChild);
  }

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
