function initMonitoringPage() {
  fetchHealthMetrics();
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
