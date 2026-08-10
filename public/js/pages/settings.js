// Settings Page — Vanilla JS Logic
var _totpTimer = null;
var _totpTimeLeft = 300;
var _totpSecret = '';

function initSettingsPage() {
  // Sync tab from URL
  var path = window.location.pathname;
  var search = window.location.search;
  var currentTab = 'profile';

  if (path.includes('/settings/notifications')) currentTab = 'notifications';
  if (path.includes('/settings/integrations') || search.includes('github_connected') || search.includes('slack_connected') || search.includes('oauth_error') || search.includes('slack_error')) {
    currentTab = 'integrations';
  }
  switchSettingsTab(currentTab, false);

  // Load active theme button highlight
  var currentTheme = localStorage.getItem('benevolate-theme') || 'auto';
  highlightThemeButton(currentTheme);

  // Check URL Query parameters for OAuth callback banners
  var alertEl = document.getElementById('oauth-alert-msg');
  if (search.includes('github_connected=1')) {
    showMsg(alertEl, '✔ GitHub account connected successfully!', false);
  } else if (search.includes('slack_connected=1')) {
    showMsg(alertEl, '✔ Slack workspace connected successfully!', false);
  } else if (search.includes('oauth_error=')) {
    var errMatch = search.match(/oauth_error=([^&]+)/);
    var errMsg = errMatch ? decodeURIComponent(errMatch[1]) : 'GitHub OAuth authorization failed';
    showMsg(alertEl, '✖ GitHub Error: ' + errMsg, true);
  } else if (search.includes('slack_error=')) {
    var errMatch = search.match(/slack_error=([^&]+)/);
    var errMsg = errMatch ? decodeURIComponent(errMatch[1]) : 'Slack OAuth authorization failed';
    showMsg(alertEl, '✖ Slack Error: ' + errMsg, true);
  }

  // Clean query string from browser URL bar without page reload
  if (search && (search.includes('_connected=') || search.includes('_error='))) {
    try {
      history.replaceState(null, '', window.location.pathname);
    } catch (e) {}
  }

  // Load connections & notifications if needed
  checkOAuthConnections();
  loadNotificationSettings();
}

window.initSettingsPage = initSettingsPage;
window.switchSettingsTab = switchSettingsTab;
window.checkPasswordStrength = checkPasswordStrength;
window.updateSetupPwdStrength = updateSetupPwdStrength;
window.updateChangePwdStrength = updateChangePwdStrength;
window.handleProfileSubmit = handleProfileSubmit;
window.handleStart2FASetup = handleStart2FASetup;
window.handleVerify2FA = handleVerify2FA;
window.handleDisable2FA = handleDisable2FA;
window.handleCopySecretCode = handleCopySecretCode;
window.handleChangePasswordSubmit = handleChangePasswordSubmit;
window.promptDisconnectGithub = promptDisconnectGithub;
window.cancelDisconnectGithub = cancelDisconnectGithub;
window.confirmDisconnectGithub = confirmDisconnectGithub;
window.promptDisconnectSlack = promptDisconnectSlack;
window.cancelDisconnectSlack = cancelDisconnectSlack;
window.confirmDisconnectSlack = confirmDisconnectSlack;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSettingsPage);
} else {
  initSettingsPage();
}

// ── OAuth Status & Custom Inline Disconnect ────────────────────────────────
async function checkOAuthConnections() {
  try {
    var res = await api.get('/api/my/credentials?t=' + Date.now());
    if (res && res.ok && Array.isArray(res.credentials)) {
      var gh = res.credentials.find(function(c) {
        return (c.provider && c.provider.toLowerCase() === 'github') || (c.label && c.label.toLowerCase().includes('github'));
      });
      var sl = res.credentials.find(function(c) {
        return (c.provider && c.provider.toLowerCase() === 'slack') || (c.label && c.label.toLowerCase().includes('slack'));
      });

      // GitHub UI State
      var ghBadge = document.getElementById('gh-badge');
      var ghConn = document.getElementById('gh-actions-connected');
      var ghDisconn = document.getElementById('gh-actions-disconnected');
      if (ghBadge) ghBadge.style.display = gh ? 'inline-block' : 'none';
      if (ghConn) ghConn.style.display = gh ? 'flex' : 'none';
      if (ghDisconn) ghDisconn.style.display = gh ? 'none' : 'block';

      // Slack UI State
      var slackBadge = document.getElementById('slack-badge');
      var slackConn = document.getElementById('slack-actions-connected');
      var slackDisconn = document.getElementById('slack-actions-disconnected');
      if (slackBadge) slackBadge.style.display = sl ? 'inline-block' : 'none';
      if (slackConn) slackConn.style.display = sl ? 'flex' : 'none';
      if (slackDisconn) slackDisconn.style.display = sl ? 'none' : 'block';
    }
  } catch (e) {}
}

function promptDisconnectGithub() {
  var confirmBanner = document.getElementById('gh-disconnect-confirm');
  if (confirmBanner) confirmBanner.style.display = 'flex';
}

function cancelDisconnectGithub() {
  var confirmBanner = document.getElementById('gh-disconnect-confirm');
  if (confirmBanner) confirmBanner.style.display = 'none';
}

async function confirmDisconnectGithub() {
  cancelDisconnectGithub();
  var alertEl = document.getElementById('oauth-alert-msg');

  try {
    var res = await api.delete('/api/oauth/github/disconnect');
    if (res && res.ok) {
      showMsg(alertEl, '✔ GitHub account disconnected successfully.', false);
      checkOAuthConnections();
    } else {
      showMsg(alertEl, (res && res.error) || 'Failed to disconnect GitHub account.', true);
    }
  } catch (err) {
    showMsg(alertEl, err.message || 'Server error', true);
  }
}

function promptDisconnectSlack() {
  var confirmBanner = document.getElementById('slack-disconnect-confirm');
  if (confirmBanner) confirmBanner.style.display = 'flex';
}

function cancelDisconnectSlack() {
  var confirmBanner = document.getElementById('slack-disconnect-confirm');
  if (confirmBanner) confirmBanner.style.display = 'none';
}

async function confirmDisconnectSlack() {
  cancelDisconnectSlack();
  var alertEl = document.getElementById('oauth-alert-msg');

  try {
    var res = await api.delete('/api/oauth/slack/disconnect');
    if (res && res.ok) {
      showMsg(alertEl, '✔ Slack workspace disconnected successfully.', false);
      checkOAuthConnections();
    } else {
      showMsg(alertEl, (res && res.error) || 'Failed to disconnect Slack workspace.', true);
    }
  } catch (err) {
    showMsg(alertEl, err.message || 'Server error', true);
  }
}

// Helper: Show Message Box
function showMsg(el, text, isError) {
  if (!el) return;
  el.className = 'msg-box ' + (isError ? 'error' : 'success');
  el.textContent = text;
  el.style.display = 'block';
}
function switchSettingsTab(tabName, updateUrl) {
  if (updateUrl !== false) {
    history.pushState(null, '', '/settings/' + tabName);
  }

  var tabLabelMap = {
    'profile': 'Profile & Security',
    'notifications': 'Notifications',
    'integrations': 'Integrations'
  };

  // Update topbar breadcrumbs (e.g. Settings > Integrations)
  var breadcrumbsContainer = document.getElementById('breadcrumbs-container');
  if (breadcrumbsContainer) {
    var subLabel = tabLabelMap[tabName] || 'Profile & Security';
    breadcrumbsContainer.innerHTML =
      '<a href="/settings" style="color:var(--color-primary);text-decoration:none;font-weight:600;">Settings</a>' +
      '<span style="color:var(--color-text-tertiary);margin:0 6px;">&gt;</span>' +
      '<span style="color:var(--color-text-primary);font-weight:600;">' + subLabel + '</span>';
  }

  var tabs = ['profile', 'notifications', 'integrations'];
  tabs.forEach(function(t) {
    var btn = document.getElementById('tab-btn-' + t);
    var content = document.getElementById('tab-content-' + t);
    if (btn) {
      if (t === tabName) btn.classList.add('active');
      else btn.classList.remove('active');
    }
    if (content) {
      if (t === tabName) {
        content.style.display = (t === 'notifications') ? 'block' : 'flex';
      } else {
        content.style.display = 'none';
      }
    }
  });
}

// ── Password Strength Validator ───────────────────────────────────────────
function checkPasswordStrength(pwd) {
  return {
    length: pwd.length >= 7,
    hasUpper: /[A-Z]/.test(pwd),
    hasLower: /[a-z]/.test(pwd),
    hasNumber: /[0-9]/.test(pwd),
    hasSpecial: /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(pwd),
    isValid: pwd.length >= 7 && /[A-Z]/.test(pwd) && /[a-z]/.test(pwd) && /[0-9]/.test(pwd) && /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(pwd)
  };
}

function updateSetupPwdStrength() {
  var pwd = document.getElementById('setup-password').value;
  var checklist = document.getElementById('setup-pwd-checklist');
  if (!pwd) {
    checklist.style.display = 'none';
    return;
  }
  checklist.style.display = 'grid';
  var s = checkPasswordStrength(pwd);
  setChk('setup-chk-length', s.length, 'Min 7 chars');
  setChk('setup-chk-upper', s.hasUpper, 'Uppercase (A-Z)');
  setChk('setup-chk-lower', s.hasLower, 'Lowercase (a-z)');
  setChk('setup-chk-number', s.hasNumber, 'Number (0-9)');
  setChk('setup-chk-special', s.hasSpecial, 'Special char (!@#$%^&*)');
}

function updateChangePwdStrength() {
  var pwd = document.getElementById('change-new-pwd').value;
  var checklist = document.getElementById('change-pwd-checklist');
  if (!pwd) {
    checklist.style.display = 'none';
    return;
  }
  checklist.style.display = 'grid';
  var s = checkPasswordStrength(pwd);
  setChk('change-chk-length', s.length, 'Min 7 chars');
  setChk('change-chk-upper', s.hasUpper, 'Uppercase (A-Z)');
  setChk('change-chk-lower', s.hasLower, 'Lowercase (a-z)');
  setChk('change-chk-number', s.hasNumber, 'Number (0-9)');
  setChk('change-chk-special', s.hasSpecial, 'Special char (!@#$%^&*)');
}

function setChk(id, isValid, labelText) {
  var el = document.getElementById(id);
  if (!el) return;
  if (isValid) {
    el.className = 'pwd-item valid';
    el.textContent = '✔ ' + labelText;
  } else {
    el.className = 'pwd-item';
    el.textContent = '✖ ' + labelText;
  }
}

// ── Profile Submission ───────────────────────────────────────────────────
async function handleProfileSubmit(e) {
  e.preventDefault();
  var email = document.getElementById('profile-email').value;
  var username = document.getElementById('profile-username').value;
  var jobTitle = document.getElementById('profile-jobtitle').value;
  var setupPwdEl = document.getElementById('setup-password');
  var setupConfirmEl = document.getElementById('setup-confirm-password');

  var password = setupPwdEl ? setupPwdEl.value : '';
  var confirmPwd = setupConfirmEl ? setupConfirmEl.value : '';

  var msgEl = document.getElementById('profile-msg');
  msgEl.style.display = 'none';

  if (password) {
    var strength = checkPasswordStrength(password);
    if (!strength.isValid) {
      showMsg(msgEl, 'Password must be at least 7 characters with uppercase, lowercase, number, and special character.', true);
      return;
    }
    if (password !== confirmPwd) {
      showMsg(msgEl, 'Passwords do not match.', true);
      return;
    }
  }

  var submitBtn = document.getElementById('profile-submit-btn');
  submitBtn.disabled = true;

  try {
    var res;
    var onboardingBanner = document.getElementById('onboarding-banner');
    var isLocked = onboardingBanner && onboardingBanner.style.display !== 'none';

    if (isLocked) {
      res = await api.post('/api/profile/complete', {
        username: username,
        email: email,
        jobTitle: jobTitle,
        password: password || undefined
      });
    } else {
      res = await api.post('/api/me/profile', {
        username: username,
        email: email,
        jobTitle: jobTitle
      });
    }

    if (res.ok) {
      showMsg(msgEl, 'Profile saved successfully!', false);
      if (auth && auth.checkSession) await auth.checkSession();
      setTimeout(function() { window.location.reload(); }, 1000);
    } else {
      showMsg(msgEl, res.error || 'Failed to update profile.', true);
    }
  } catch (err) {
    showMsg(msgEl, err.message || 'Server error', true);
  }
  submitBtn.disabled = false;
}

var _totpTimer = null;
var _totpTimeLeft = 300;
var _totpSecret = '';
var _totpRefreshInterval = null;
var _totpRefreshSeconds = 10;

// ── 2FA Setup & Verification ─────────────────────────────────────────────
async function handleStart2FASetup(isAutoRefresh) {
  var btn = document.getElementById('btn-start-2fa');
  var refreshBtn = document.getElementById('btn-refresh-totp');
  if (btn && !isAutoRefresh) btn.disabled = true;
  if (refreshBtn) refreshBtn.disabled = true;

  var msgEl = document.getElementById('totp-msg');
  if (msgEl && !isAutoRefresh) msgEl.style.display = 'none';

  try {
    var res = await api.post('/api/auth/2fa/setup');
    if (res.ok) {
      _totpSecret = res.secret;
      document.getElementById('totp-secret-code').textContent = res.secret;
      document.getElementById('totp-qr-img').src = res.qrCodeUrl;
      
      document.getElementById('totp-qr-container').style.display = 'block';
      document.getElementById('totp-expired-container').style.display = 'none';
      document.getElementById('totp-key-row').style.opacity = '1';
      document.getElementById('totp-code-input').disabled = false;
      document.getElementById('totp-verify-btn').disabled = false;

      // Show setup panel
      var panel = document.getElementById('panel-2fa-setup');
      panel.style.display = 'grid';

      if (!isAutoRefresh) {
        var contentArea = document.querySelector('.content-area');
        if (contentArea && panel) {
          setTimeout(function() {
            panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 100);
        }
      }

      // Start 5-minute session countdown timer
      startTotpCountdown(300);

      // Start 10-second auto-refresh cycle
      start10SecAutoRefresh();
    } else {
      if (msgEl) showMsg(msgEl, res.error || 'Failed to generate 2FA key', true);
    }
  } catch (err) {
    if (msgEl) showMsg(msgEl, err.message || 'Error generating 2FA', true);
  }

  if (btn) btn.disabled = false;
  if (refreshBtn) refreshBtn.disabled = false;
}

function start10SecAutoRefresh() {
  if (_totpRefreshInterval) clearInterval(_totpRefreshInterval);
  _totpRefreshSeconds = 10;

  function updateRefreshBadge() {
    var badge = document.getElementById('totp-auto-refresh-badge');
    if (badge) {
      badge.textContent = 'Auto-refreshes in ' + _totpRefreshSeconds + 's';
    }
  }

  updateRefreshBadge();
  _totpRefreshInterval = setInterval(function() {
    _totpRefreshSeconds--;
    if (_totpRefreshSeconds <= 0) {
      clearInterval(_totpRefreshInterval);
      // Auto-fetch fresh QR & secret
      handleStart2FASetup(true);
    } else {
      updateRefreshBadge();
    }
  }, 1000);
}

function stop10SecAutoRefresh() {
  if (_totpRefreshInterval) {
    clearInterval(_totpRefreshInterval);
    _totpRefreshInterval = null;
  }
}

function startTotpCountdown(seconds) {
  if (_totpTimer) clearInterval(_totpTimer);
  _totpTimeLeft = seconds;

  function updateDisplay() {
    var m = Math.floor(_totpTimeLeft / 60);
    var s = _totpTimeLeft % 60;
    var formatted = (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
    var timerText = document.getElementById('totp-timer-text');
    var timerBadge = document.getElementById('totp-timer-badge');

    if (_totpTimeLeft > 0) {
      if (timerText) timerText.textContent = 'Expires in ' + formatted;
      if (timerBadge) timerBadge.style.color = _totpTimeLeft > 60 ? '#64748b' : '#ef4444';
    } else {
      if (timerText) timerText.textContent = 'Expired';
      if (timerBadge) timerBadge.style.color = '#ef4444';
      document.getElementById('totp-qr-container').style.display = 'none';
      document.getElementById('totp-expired-container').style.display = 'block';
      document.getElementById('totp-secret-code').textContent = '••••••••••••••••••••••••';
      document.getElementById('totp-key-row').style.opacity = '0.5';
      document.getElementById('totp-code-input').disabled = true;
      document.getElementById('totp-verify-btn').disabled = true;
      clearInterval(_totpTimer);
      stop10SecAutoRefresh();
    }
  }

  updateDisplay();
  _totpTimer = setInterval(function() {
    _totpTimeLeft--;
    updateDisplay();
  }, 1000);
}

function handleCopySecretCode() {
  if (!_totpSecret || _totpTimeLeft <= 0) return;
  navigator.clipboard.writeText(_totpSecret);
  var btnText = document.getElementById('copy-btn-text');
  var icon = document.getElementById('copy-icon');
  if (btnText) btnText.textContent = 'Copied!';
  if (icon) {
    icon.setAttribute('data-lucide', 'check');
    icon.style.color = '#10b981';
    if (window.lucide) lucide.createIcons();
  }
  setTimeout(function() {
    if (btnText) btnText.textContent = 'Copy Code';
    if (icon) {
      icon.setAttribute('data-lucide', 'copy');
      icon.style.color = 'inherit';
      if (window.lucide) lucide.createIcons();
    }
  }, 2000);
}

async function handleVerify2FASetup(e) {
  e.preventDefault();
  var code = document.getElementById('totp-code-input').value;
  var msgEl = document.getElementById('totp-msg');
  msgEl.style.display = 'none';

  if (_totpTimeLeft <= 0) {
    showMsg(msgEl, 'Setup session expired. Please click Refresh QR Code.', true);
    return;
  }
  if (!code || code.length !== 6) {
    showMsg(msgEl, 'Please enter a valid 6-digit code', true);
    return;
  }

  var btn = document.getElementById('totp-verify-btn');
  btn.disabled = true;

  try {
    var res = await api.post('/api/auth/2fa/verify-setup', { code: code });
    if (res.ok) {
      showMsg(msgEl, '2FA Authenticator activated successfully!', false);
      stop10SecAutoRefresh();
      document.getElementById('totp-status-badge').textContent = '✔ ACTIVE';
      document.getElementById('totp-status-badge').style.background = 'rgba(16,185,129,0.12)';
      document.getElementById('totp-status-badge').style.color = '#10b981';
      document.getElementById('totp-icon').style.color = '#10b981';
      document.getElementById('btn-start-2fa').style.display = 'none';
      document.getElementById('panel-2fa-setup').style.display = 'none';

      if (auth && auth.checkSession) await auth.checkSession();
      setTimeout(function() { window.location.reload(); }, 1200);
    } else {
      showMsg(msgEl, res.error || 'Invalid 6-digit code', true);
    }
  } catch (err) {
    showMsg(msgEl, err.message || 'Verification error', true);
  }
  btn.disabled = false;
}

// ── Change Password Submit ───────────────────────────────────────────────
async function handleChangePassword(e) {
  e.preventDefault();
  var oldPwd = document.getElementById('change-old-pwd').value;
  var newPwd = document.getElementById('change-new-pwd').value;
  var confirmPwd = document.getElementById('change-confirm-pwd').value;
  var msgEl = document.getElementById('change-pwd-msg');
  msgEl.style.display = 'none';

  var strength = checkPasswordStrength(newPwd);
  if (!strength.isValid) {
    showMsg(msgEl, 'New password must be at least 7 characters with uppercase, lowercase, number, and special character.', true);
    return;
  }
  if (newPwd !== confirmPwd) {
    showMsg(msgEl, 'New passwords do not match.', true);
    return;
  }

  var btn = document.getElementById('change-pwd-btn');
  btn.disabled = true;

  try {
    var res = await api.patch('/api/profile/password', {
      oldPassword: oldPwd,
      newPassword: newPwd
    });
    if (res.ok) {
      showMsg(msgEl, 'Password changed successfully!', false);
      document.getElementById('change-old-pwd').value = '';
      document.getElementById('change-new-pwd').value = '';
      document.getElementById('change-confirm-pwd').value = '';
      document.getElementById('change-pwd-checklist').style.display = 'none';
    } else {
      showMsg(msgEl, res.error || 'Failed to change password.', true);
    }
  } catch (err) {
    showMsg(msgEl, err.message || 'Error updating password', true);
  }
  btn.disabled = false;
}

// ── Notification Preferences ─────────────────────────────────────────────
async function loadNotificationSettings() {
  try {
    var res = await api.get('/api/notifications/settings');
    if (res.ok && res.settings) {
      document.getElementById('notif-inapp').checked = !!res.settings.inApp;
      document.getElementById('notif-email').checked = !!res.settings.email;
      document.getElementById('notif-slack').checked = !!res.settings.slack;
    }
  } catch (e) {}
}

async function handleSaveNotifications() {
  var btn = document.getElementById('notif-save-btn');
  btn.disabled = true;
  var msgEl = document.getElementById('notif-msg');
  msgEl.style.display = 'none';

  try {
    var res = await api.put('/api/notifications/settings', {
      inApp: document.getElementById('notif-inapp').checked,
      email: document.getElementById('notif-email').checked,
      slack: document.getElementById('notif-slack').checked
    });
    if (res.ok) {
      showMsg(msgEl, 'Notification preferences saved.', false);
    }
  } catch (e) {}
  btn.disabled = false;
}

// ── Theme Selection ───────────────────────────────────────────────────────
function selectThemeMode(mode) {
  if (window.theme && window.theme.setTheme) {
    window.theme.setTheme(mode);
  } else {
    document.documentElement.setAttribute('data-theme', mode === 'auto' ? 'dark' : mode);
    localStorage.setItem('benevolate-theme', mode);
  }
  highlightThemeButton(mode);
}

function highlightThemeButton(mode) {
  var modes = ['light', 'dark', 'auto'];
  modes.forEach(function(m) {
    var btn = document.getElementById('theme-btn-' + m);
    if (btn) {
      if (m === mode) {
        btn.style.border = '2px solid var(--color-primary)';
        btn.style.background = 'var(--color-primary-light)';
        btn.style.color = 'var(--color-primary)';
      } else {
        btn.style.border = '1px solid var(--color-border)';
        btn.style.background = 'var(--color-bg)';
        btn.style.color = 'var(--color-text-primary)';
      }
    }
  });
}

// ── OAuth Status & Custom Inline Disconnect ────────────────────────────────
async function checkOAuthConnections() {
  try {
    var res = await api.get('/api/my/credentials');
    if (res.ok && Array.isArray(res.credentials)) {
      var gh = res.credentials.find(function(c) { return c.provider === 'github'; });
      var sl = res.credentials.find(function(c) { return c.provider === 'slack'; });

      if (gh) {
        document.getElementById('gh-badge').style.display = 'inline-block';
        document.getElementById('gh-actions-connected').style.display = 'flex';
        document.getElementById('gh-actions-disconnected').style.display = 'none';
      } else {
        document.getElementById('gh-badge').style.display = 'none';
        document.getElementById('gh-actions-connected').style.display = 'none';
        document.getElementById('gh-actions-disconnected').style.display = 'block';
      }

      if (sl) {
        document.getElementById('slack-badge').style.display = 'inline-block';
        document.getElementById('slack-connect-text').textContent = 'Reconnect Slack OAuth';
      } else {
        document.getElementById('slack-badge').style.display = 'none';
        document.getElementById('slack-connect-text').textContent = 'Connect Slack Account';
      }
    }
  } catch (e) {}
}

function promptDisconnectGithub() {
  var confirmBanner = document.getElementById('gh-disconnect-confirm');
  if (confirmBanner) confirmBanner.style.display = 'flex';
}

function cancelDisconnectGithub() {
  var confirmBanner = document.getElementById('gh-disconnect-confirm');
  if (confirmBanner) confirmBanner.style.display = 'none';
}

async function confirmDisconnectGithub() {
  cancelDisconnectGithub();
  var alertEl = document.getElementById('oauth-alert-msg');

  try {
    var res = await api.delete('/api/oauth/github/disconnect');
    if (res.ok) {
      showMsg(alertEl, '✔ GitHub account disconnected successfully.', false);
      checkOAuthConnections();
    } else {
      showMsg(alertEl, res.error || 'Failed to disconnect GitHub account.', true);
    }
  } catch (err) {
    showMsg(alertEl, err.message || 'Server error', true);
  }
}

// Helper: Show Message Box
function showMsg(el, text, isError) {
  if (!el) return;
  el.className = 'msg-box ' + (isError ? 'error' : 'success');
  el.textContent = text;
  el.style.display = 'block';
}
