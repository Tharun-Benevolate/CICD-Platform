// public/js/broadcast-modal.js — Super Admin Multi-Channel Broadcast Controller

var _broadcastMeta = null;

async function openBroadcastModal() {
  var modal = document.getElementById('broadcast-modal');
  if (!modal) return;
  modal.style.display = 'flex';

  var errBox = document.getElementById('broadcast-modal-error');
  if (errBox) errBox.style.display = 'none';

  updateBroadcastPreview();
  if (window.lucide) lucide.createIcons();

  await loadBroadcastMeta();
}
window.openBroadcastModal = openBroadcastModal;

function closeBroadcastModal() {
  var modal = document.getElementById('broadcast-modal');
  if (modal) modal.style.display = 'none';
}
window.closeBroadcastModal = closeBroadcastModal;

async function loadBroadcastMeta() {
  try {
    var res = await api.get('/api/admin/broadcast/meta');
    if (!res || !res.ok) return;

    _broadcastMeta = res;

    // 1. Total users badge
    var userCountEl = document.getElementById('broadcast-meta-user-count');
    if (userCountEl) userCountEl.textContent = res.totalUsers || '0';

    // 2. Email status badge
    var emailBadgeEl = document.getElementById('broadcast-email-status-badge');
    var emailCheckbox = document.getElementById('broadcast-chan-email');
    if (emailBadgeEl) {
      if (res.email && res.email.configured) {
        emailBadgeEl.innerHTML = '<span style="color:var(--color-success);font-weight:600;">✔ SMTP Configured (' + res.email.host + ')</span>';
      } else {
        emailBadgeEl.innerHTML = '<span style="color:var(--color-warning);font-weight:600;">⚠ SMTP Not Configured (Logs only)</span>';
      }
    }

    // 3. Slack status badge
    var slackBadgeEl = document.getElementById('broadcast-slack-status-badge');
    var slackCheckbox = document.getElementById('broadcast-chan-slack');
    if (slackBadgeEl) {
      if (res.slack && res.slack.connected) {
        slackBadgeEl.innerHTML = '<span style="color:var(--color-success);font-weight:600;">✔ Connected (' + (res.slack.channels ? res.slack.channels.length : 0) + ' channels)</span>';
      } else {
        slackBadgeEl.innerHTML = '<span style="color:var(--color-danger);font-weight:600;">✘ Slack Not Connected</span>';
        if (slackCheckbox) slackCheckbox.checked = false;
        toggleSlackTargetSection();
      }
    }

    // 4. Render Project Channels List
    var projListEl = document.getElementById('broadcast-projects-list');
    if (projListEl) {
      var projs = res.projects || [];
      if (projs.length === 0) {
        projListEl.innerHTML = '<div style="font-size:12px;color:var(--color-text-tertiary);text-align:center;padding:12px;">No active projects found.</div>';
      } else {
        projListEl.innerHTML = projs.map(function(p) {
          var hasSlack = Boolean(p.slack_channel_id);
          var channelLabel = hasSlack ? '#' + (p.slack_channel_name || 'proj-' + p.name) : 'No channel linked';
          return '<label style="display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border-radius:6px;background:var(--color-bg);cursor:' + (hasSlack ? 'pointer' : 'not-allowed') + ';opacity:' + (hasSlack ? '1' : '0.6') + ';">' +
            '<div style="display:flex;align-items:center;gap:8px;">' +
              '<input type="checkbox" class="broadcast-project-checkbox" value="' + p.id + '" ' + (hasSlack ? 'checked' : 'disabled') + ' style="accent-color:#6366f1;" />' +
              '<span style="font-size:12px;font-weight:600;color:var(--color-text-primary);">' + p.name + '</span>' +
            '</div>' +
            '<span style="font-size:11px;font-family:monospace;padding:1px 6px;border-radius:4px;background:var(--color-surface);color:' + (hasSlack ? '#10b981' : 'var(--color-text-tertiary)') + ';">' +
              channelLabel +
            '</span>' +
          '</label>';
        }).join('');
      }
    }

    // 5. Render All Workspace Channels List
    renderSlackChannelsList((res.slack && res.slack.channels) || []);

    if (window.lucide) lucide.createIcons();
  } catch (err) {
    console.error("[loadBroadcastMeta]", err);
  }
}

function renderSlackChannelsList(channels) {
  var listEl = document.getElementById('broadcast-channels-list');
  if (!listEl) return;

  if (!channels || channels.length === 0) {
    listEl.innerHTML = '<div style="font-size:12px;color:var(--color-text-tertiary);text-align:center;padding:12px;">No Slack channels found in connected workspace.</div>';
    return;
  }

  listEl.innerHTML = channels.map(function(ch) {
    return '<label class="broadcast-channel-item" data-name="' + ch.name.toLowerCase() + '" style="display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border-radius:6px;background:var(--color-bg);cursor:pointer;">' +
      '<div style="display:flex;align-items:center;gap:8px;">' +
        '<input type="checkbox" class="broadcast-channel-checkbox" value="' + ch.id + '" style="accent-color:#6366f1;" />' +
        '<span style="font-size:12px;font-weight:600;color:var(--color-text-primary);">' + (ch.is_private ? '🔒 #' : '#') + ch.name + '</span>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:6px;">' +
        (ch.linked && ch.linked !== 'None' ? '<span style="font-size:10px;padding:1px 5px;border-radius:4px;background:rgba(99,102,241,0.1);color:#6366f1;">' + ch.linked + '</span>' : '') +
        '<span style="font-size:11px;color:var(--color-text-tertiary);">' + (ch.num_members || 0) + ' members</span>' +
      '</div>' +
    '</label>';
  }).join('');
}

function filterSlackChannelList() {
  var q = (document.getElementById('broadcast-channel-search').value || '').toLowerCase().trim();
  var items = document.querySelectorAll('.broadcast-channel-item');
  items.forEach(function(item) {
    var name = item.getAttribute('data-name') || '';
    item.style.display = (!q || name.includes(q)) ? 'flex' : 'none';
  });
}
window.filterSlackChannelList = filterSlackChannelList;

function toggleSlackTargetSection() {
  var isChecked = document.getElementById('broadcast-chan-slack').checked;
  var sec = document.getElementById('broadcast-slack-options');
  if (sec) sec.style.display = isChecked ? 'flex' : 'none';
}
window.toggleSlackTargetSection = toggleSlackTargetSection;

function switchSlackMode(mode) {
  var allBox = document.getElementById('slack-mode-all-box');
  var projBox = document.getElementById('slack-mode-projects-box');
  var indBox = document.getElementById('slack-mode-individual-box');

  if (allBox) allBox.style.display = (mode === 'all') ? 'block' : 'none';
  if (projBox) projBox.style.display = (mode === 'projects') ? 'block' : 'none';
  if (indBox) indBox.style.display = (mode === 'individual') ? 'block' : 'none';

  if (window.lucide) lucide.createIcons();
}
window.switchSlackMode = switchSlackMode;

function updateBroadcastPreview() {
  var title = document.getElementById('broadcast-title')?.value || '';
  var body = document.getElementById('broadcast-message')?.value || '';
  var urgency = document.getElementById('broadcast-urgency')?.value || 'normal';
  var link = document.getElementById('broadcast-link')?.value || '';

  var previewTitle = document.getElementById('preview-title');
  var previewBody = document.getElementById('preview-body');
  var previewCard = document.getElementById('preview-card-box');
  var previewBadge = document.getElementById('preview-urgency-badge');
  var previewLinkBox = document.getElementById('preview-link-box');
  var previewLinkText = document.getElementById('preview-link-text');

  if (previewTitle) previewTitle.textContent = title.trim() || '[Announcement Title will appear here]';
  if (previewBody) previewBody.textContent = body.trim() || '[Announcement message text will appear here]';

  var colorMap = {
    normal: { border: '#6366f1', bg: 'rgba(99,102,241,0.1)', text: '#6366f1', label: '📢 NORMAL ANNOUNCEMENT' },
    important: { border: '#f59e0b', bg: 'rgba(245,158,11,0.1)', text: '#f59e0b', label: '⚠️ IMPORTANT NOTICE' },
    urgent: { border: '#ef4444', bg: 'rgba(239,68,68,0.1)', text: '#ef4444', label: '🚨 URGENT BROADCAST' }
  };
  var chosen = colorMap[urgency] || colorMap.normal;

  if (previewCard) previewCard.style.borderLeftColor = chosen.border;
  if (previewBadge) {
    previewBadge.textContent = chosen.label;
    previewBadge.style.color = chosen.text;
    previewBadge.style.background = chosen.bg;
  }

  if (previewLinkBox && previewLinkText) {
    if (link && link.trim()) {
      previewLinkBox.style.display = 'block';
      previewLinkText.textContent = link.trim();
    } else {
      previewLinkBox.style.display = 'none';
    }
  }
}
window.updateBroadcastPreview = updateBroadcastPreview;

async function submitBroadcastAnnouncement() {
  var errBox = document.getElementById('broadcast-modal-error');
  var submitBtn = document.getElementById('broadcast-submit-btn');
  if (errBox) errBox.style.display = 'none';

  var title = (document.getElementById('broadcast-title')?.value || '').trim();
  var message = (document.getElementById('broadcast-message')?.value || '').trim();
  var urgency = document.getElementById('broadcast-urgency')?.value || 'normal';
  var link = (document.getElementById('broadcast-link')?.value || '').trim();

  if (!title) {
    showBroadcastError('Please provide an announcement title.');
    return;
  }
  if (!message) {
    showBroadcastError('Please enter the announcement message body.');
    return;
  }

  var inApp = document.getElementById('broadcast-chan-inapp')?.checked;
  var email = document.getElementById('broadcast-chan-email')?.checked;
  var slackEnabled = document.getElementById('broadcast-chan-slack')?.checked;

  if (!inApp && !email && !slackEnabled) {
    showBroadcastError('Please select at least one delivery channel (In-App, Email, or Slack).');
    return;
  }

  var slackMode = 'all';
  var selectedChannelIds = [];
  var selectedProjectIds = [];
  var excludeSystem = true;

  if (slackEnabled) {
    var modeRadio = document.querySelector('input[name="broadcast-slack-mode"]:checked');
    slackMode = modeRadio ? modeRadio.value : 'all';

    if (slackMode === 'all') {
      excludeSystem = document.getElementById('broadcast-slack-exclude-system')?.checked ?? true;
    } else if (slackMode === 'projects') {
      var projBoxes = document.querySelectorAll('.broadcast-project-checkbox:checked');
      projBoxes.forEach(function(b) { selectedProjectIds.push(b.value); });
      if (selectedProjectIds.length === 0) {
        showBroadcastError('Please check at least one project for Slack routing, or select a different Slack mode.');
        return;
      }
    } else if (slackMode === 'individual') {
      var chanBoxes = document.querySelectorAll('.broadcast-channel-checkbox:checked');
      chanBoxes.forEach(function(b) { selectedChannelIds.push(b.value); });
      if (selectedChannelIds.length === 0) {
        showBroadcastError('Please select at least one Slack channel, or choose "All Channels".');
        return;
      }
    }
  }

  // Confirmation
  var targets = [];
  if (inApp) targets.push('All Platform Users (In-App Bell)');
  if (email) targets.push('User Email Inboxes');
  if (slackEnabled) {
    if (slackMode === 'all') targets.push('All Workspace Slack Channels');
    else if (slackMode === 'projects') targets.push(selectedProjectIds.length + ' Project-Connected Slack Channels');
    else if (slackMode === 'individual') targets.push(selectedChannelIds.length + ' Selected Slack Channels');
  }

  var confirmed = confirm(
    'Dispatch Broadcast Announcement?\n\n' +
    'Title: "' + title + '"\n' +
    'Urgency: ' + urgency.toUpperCase() + '\n' +
    'Targets:\n - ' + targets.join('\n - ') + '\n\n' +
    'Are you sure you want to send this broadcast now?'
  );

  if (!confirmed) return;

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i data-lucide="loader-2" class="animate-spin" style="width:15px;height:15px;"></i> Dispatching...';
    if (window.lucide) lucide.createIcons();
  }

  try {
    var payload = {
      title: title,
      message: message,
      urgency: urgency,
      link: link || null,
      channels: {
        inApp: inApp,
        email: email,
        slack: {
          enabled: slackEnabled,
          mode: slackMode,
          channelIds: selectedChannelIds,
          projectIds: selectedProjectIds,
          excludeSystem: excludeSystem
        }
      }
    };

    var res = await api.post('/api/admin/broadcast', payload);

    if (res && res.ok) {
      alert(
        '✔ Announcement Broadcast Dispatched Successfully!\n\n' +
        '• In-App Notifications: ' + (res.summary?.inAppSent || 0) + ' sent\n' +
        '• Slack Channels: ' + (res.summary?.slack?.sent || 0) + ' sent' +
        (res.summary?.slack?.channels?.length ? ' (' + res.summary.slack.channels.slice(0, 3).join(', ') + (res.summary.slack.channels.length > 3 ? '...' : '') + ')' : '') + '\n' +
        '• Email: ' + (res.summary?.email?.status || 'N/A')
      );

      // Reset form
      document.getElementById('broadcast-title').value = '';
      document.getElementById('broadcast-message').value = '';
      document.getElementById('broadcast-link').value = '';
      closeBroadcastModal();
    } else {
      showBroadcastError(res?.error || 'Failed to dispatch broadcast announcement.');
    }
  } catch (err) {
    showBroadcastError(err.message || 'Error communicating with broadcast API.');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i data-lucide="send" style="width:15px;height:15px;"></i> Send Broadcast';
      if (window.lucide) lucide.createIcons();
    }
  }
}
window.submitBroadcastAnnouncement = submitBroadcastAnnouncement;

function showBroadcastError(msg) {
  var errBox = document.getElementById('broadcast-modal-error');
  if (errBox) {
    errBox.textContent = msg;
    errBox.style.display = 'block';
  } else {
    alert(msg);
  }
}
