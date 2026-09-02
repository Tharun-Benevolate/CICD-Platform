function initMonitoringPage() {
  fetchHealthMetrics();
  initLogViewer();
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
    setTimeout(function() {
      icon.classList.remove('animate-spin');
    }, 500);
  }
}

// ─── ECS Task Log Viewer Logic ───
let currentLogEnv = 'dev';
let isLogPaused = false;
let logPollInterval = null;
let nextToken = null;

function initLogViewer() {
  const envBtns = document.querySelectorAll('.log-env-btn');
  envBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      envBtns.forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      currentLogEnv = e.target.dataset.env;
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

  const projectId = document.getElementById('project-select')?.value;
  if (!projectId) return;

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
    if (e.message.toLowerCase().includes('error') || e.message.toLowerCase().includes('exception')) {
      msgSpan.style.color = '#ff7b72';
    } else if (e.message.toLowerCase().includes('warn')) {
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
  }
});
