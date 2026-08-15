var _activeProject = null;

var _releaseState = {
  selectedBranch: null,
  buildId: null,
  buildStatus: null,
  builtImage: null,
  betaDeploying: false,
  betaDeployed: false,
  promoting: false,
  promoted: false,
  promotedImage: null,
  mergeNote: null,
  pipelineExecutionId: null,
  pollTimer: null,
  betaPollTimer: null
};

window.initReleasePage = async function() {
  if (typeof api === 'undefined') {
    console.error('API helper not found. Make sure api.js is loaded.');
    return;
  }

  const urlParams = new URLSearchParams(window.location.search);
  const projectId = urlParams.get('project');

  try {
    const res = await api.get('/api/projects');
    if (res.projects && res.projects.length > 0) {
      if (projectId) {
        _activeProject = res.projects.find(p => String(p.id) === String(projectId));
      }
      if (!_activeProject) {
        _activeProject = res.projects.find(p => p.isActive) || res.projects[0];
      }
    }

    if (_activeProject) {
      await renderRelease();
    } else {
      const content = document.getElementById('content');
      if (content) content.innerHTML = '<div style="padding:40px;text-align:center;color:var(--color-text-tertiary);">No project found. Please configure a project first.</div>';
    }
  } catch (err) {
    if (!_activeProject) {
      const content = document.getElementById('content');
      if (content) content.innerHTML = `<div style="padding:40px;text-align:center;color:var(--color-text-tertiary);">Failed to load project: ${escapeHTML(err.message)}</div>`;
    }
  }
};

// Helper functions
function escapeHTML(str) {
  if (!str) return '';
  return String(str).replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

function toast(msg) {
  if (typeof window.showToast === 'function') {
    window.showToast(msg);
  } else {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.position = 'fixed';
    el.style.bottom = '20px';
    el.style.right = '20px';
    el.style.background = 'var(--color-text-primary, #333)';
    el.style.color = 'var(--color-bg, #fff)';
    el.style.padding = '10px 20px';
    el.style.borderRadius = '8px';
    el.style.zIndex = '9999';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }
}

function withProject(url) {
  if (!_activeProject) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}projectId=${_activeProject.id}`;
}

async function reloadCurrentProject() {
  try {
    const data = await api.get('/api/projects');
    const p = (data.projects || []).find(x => x.id === _activeProject.id);
    if (p) _activeProject = p;
  } catch (_) {}
}

function _releaseStorageKey() {
  const id = _activeProject ? _activeProject.id : "default";
  return `cicd_release_state_${id}`;
}

function _saveReleaseState() {
  try {
    const { pollTimer, betaPollTimer, ...persistable } = _releaseState;
    localStorage.setItem(_releaseStorageKey(), JSON.stringify({
      ...persistable,
      savedAt: Date.now()
    }));
  } catch (_) {}
}

function _loadReleaseState() {
  try {
    const raw = localStorage.getItem(_releaseStorageKey());
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data.savedAt && Date.now() - data.savedAt > 7 * 24 * 60 * 60 * 1000) {
      localStorage.removeItem(_releaseStorageKey());
      return null;
    }
    return data;
  } catch (_) {
    return null;
  }
}

function _clearReleaseState() {
  _stopReleasePoll();
  _stopBetaPoll();
  _releaseState = {
    selectedBranch: null,
    buildId: null,
    buildStatus: null,
    builtImage: null,
    betaDeploying: false,
    betaDeployed: false,
    promoting: false,
    promoted: false,
    promotedImage: null,
    mergeNote: null,
    pipelineExecutionId: null,
    pollTimer: null,
    betaPollTimer: null
  };
  try { localStorage.removeItem(_releaseStorageKey()); } catch (_) {}
}

function _stopReleasePoll() {
  if (_releaseState.pollTimer) { clearInterval(_releaseState.pollTimer); _releaseState.pollTimer = null; }
}

function _stopBetaPoll() {
  if (_releaseState.betaPollTimer) { clearInterval(_releaseState.betaPollTimer); _releaseState.betaPollTimer = null; }
}

async function renderRelease() {
  _stopReleasePoll();
  const project = _activeProject;
  const content = document.getElementById('content');
  if (!content) return;

  const saved = _loadReleaseState();
  if (saved) {
    _releaseState = {
      ..._releaseState,
      selectedBranch: saved.selectedBranch || null,
      buildId: saved.buildId || null,
      buildStatus: saved.buildStatus || null,
      builtImage: saved.builtImage || null,
      betaDeploying: !!saved.betaDeploying,
      betaDeployed: !!saved.betaDeployed,
      promoting: !!saved.promoting,
      promoted: !!saved.promoted,
      promotedImage: saved.promotedImage || null,
      mergeNote: saved.mergeNote || null,
      pipelineExecutionId: saved.pipelineExecutionId || null,
      pollTimer: null,
      betaPollTimer: null
    };
  }

  if (!project.githubOwner || !project.githubRepo) {
    content.innerHTML = `
      <div style="margin-bottom:24px;">
        <h1 style="font-size:22px;font-weight:700;margin-bottom:4px;color:var(--color-text-primary);">Release Management</h1>
        <p style="font-size:13px;color:var(--color-text-secondary);">${escapeHTML(project.name)}</p>
      </div>
      <div style="padding:40px;text-align:center;color:var(--color-text-tertiary);">No GitHub repository connected. Configure the project in the Setup wizard first.</div>
    `;
    return;
  }

  content.innerHTML = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:24px;">
      <div>
        <h1 style="font-size:22px;font-weight:700;margin-bottom:4px;color:var(--color-text-primary);">Release Management</h1>
        <p style="font-size:13px;color:var(--color-text-secondary);">Build a branch, deploy to Beta for testing, then promote by merging to main — the 7-stage pipeline deploys to prod through approvals</p>
      </div>
      <button onclick="releaseStartNew()" style="padding:8px 16px;background:transparent;color:var(--color-text-primary);border:1px solid var(--color-border);border-radius:8px;font-weight:600;cursor:pointer;font-size:13px;" title="Clear current release progress and start fresh">Start New Release</button>
    </div>
    
    <div class="release-layout">
      <div class="release-branch-panel">
        <div style="padding:16px 20px;border-bottom:1px solid var(--color-border);display:flex;justify-content:space-between;align-items:center;">
          <h3 style="font-size:14px;font-weight:700;margin:0;color:var(--color-text-primary);">Source Branch</h3>
          <button onclick="releaseCreateBranch()" style="padding:4px 10px;background:var(--color-bg);color:var(--color-text-primary);border:1px solid var(--color-border);border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;">New Branch</button>
        </div>
        <div id="release-branch-list"><div style="padding:16px 20px;font-size:13px;color:var(--color-text-tertiary);">Loading branches...</div></div>
      </div>

      <div class="release-steps-col">
        <div class="release-step-card" id="release-step-1">
          <div class="release-step-header">
            <span class="release-step-num">1</span>
            <div style="flex:1;">
              <div class="release-step-title">Build</div>
              <div class="release-step-sub">Compile selected branch via CodeBuild</div>
            </div>
            <div id="release-build-badge"></div>
          </div>
          <div id="release-build-body" class="release-step-body">
            <span style="font-size:13px;color:var(--color-text-tertiary);">Select a branch from the left panel to begin.</span>
          </div>
        </div>

        <div class="release-step-card release-step-disabled" id="release-step-2">
          <div class="release-step-header">
            <span class="release-step-num">2</span>
            <div style="flex:1;">
              <div class="release-step-title">Deploy to Beta</div>
              <div class="release-step-sub">Push built image to the Beta ECS service</div>
            </div>
            <div id="release-beta-badge"></div>
          </div>
          <div id="release-beta-body" class="release-step-body">
            <span style="font-size:13px;color:var(--color-text-tertiary);">Build must succeed first.</span>
          </div>
        </div>

        <div class="release-step-card release-step-disabled" id="release-step-3">
          <div class="release-step-header">
            <span class="release-step-num">3</span>
            <div style="flex:1;">
              <div class="release-step-title">Promote to Production</div>
              <div class="release-step-sub">Merge release branch into main — pipeline runs Dev → UAT (approval) → Prod (approval)</div>
            </div>
            <div id="release-promote-badge"></div>
          </div>
          <div id="release-promote-body" class="release-step-body">
            <span style="font-size:13px;color:var(--color-text-tertiary);">Deploy to Beta first.</span>
          </div>
        </div>
      </div>
    </div>
  `;

  await _loadReleaseBranches(project);
  await _restoreReleaseUI();
}

function releaseStartNew() {
  if (_releaseState.buildId || _releaseState.builtImage || _releaseState.betaDeployed || _releaseState.betaDeploying) {
    if (!confirm("Clear the current release progress and start a new one?")) return;
  }
  _clearReleaseState();
  renderRelease();
}

async function _restoreReleaseUI() {
  const branch = _releaseState.selectedBranch;
  if (!branch) return;

  document.querySelectorAll('.release-branch-row').forEach(r => {
    const name = r.querySelector('span')?.textContent.trim();
    r.classList.toggle('selected', name === branch);
  });

  if (_releaseState.promoted) {
    _showBuildSucceededUI();
    _showBetaDeployedUI();
    _showPromotedUI();
    return;
  }

  if (_releaseState.buildId && !['SUCCEEDED','FAILED','STOPPED','FAULT','TIMED_OUT'].includes(_releaseState.buildStatus)) {
    const buildBody = document.getElementById('release-build-body');
    if (buildBody) {
      buildBody.innerHTML = `<div style="font-size:13px;color:var(--color-text-secondary);">Resuming build for <strong>${escapeHTML(branch)}</strong>…</div>`;
    }
    _pollReleaseBuild();
    return;
  }

  if (_releaseState.buildStatus === 'SUCCEEDED' && _releaseState.builtImage) {
    _showBuildSucceededUI();

    await _syncBetaFromAws();

    if (_releaseState.promoting) {
      _showBetaDeployedUI();
      _showPromotingUI();
      return;
    }
    if (_releaseState.betaDeployed) {
      _showBetaDeployedUI();
      return;
    }
    if (_releaseState.betaDeploying) {
      _showBetaDeployingUI();
      _pollBetaDeployStatus();
      return;
    }
    _showBetaReadyUI();
    return;
  }

  if (['FAILED','STOPPED','TIMED_OUT','FAULT'].includes(_releaseState.buildStatus)) {
    if (_releaseState.buildId) await _refreshReleaseBuildStatus();
    else {
      const buildBody = document.getElementById('release-build-body');
      if (buildBody) {
        buildBody.innerHTML = `
          <div style="font-size:13px;">Branch: <strong>${escapeHTML(branch)}</strong></div>
          <button onclick="releaseBuildBranch()" style="margin-top:10px;padding:6px 14px;background:#6366f1;color:white;border:none;border-radius:6px;font-weight:700;cursor:pointer;font-size:12px;">Start Build</button>`;
      }
    }
    return;
  }

  const buildBody = document.getElementById('release-build-body');
  if (buildBody) {
    buildBody.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <span style="font-size:13px;">Branch: <strong>${escapeHTML(branch)}</strong></span>
        <button onclick="releaseBuildBranch()" style="padding:6px 14px;background:#6366f1;color:white;border:none;border-radius:6px;font-weight:700;cursor:pointer;font-size:12px;">Start Build</button>
      </div>`;
  }
}

async function _syncBetaFromAws() {
  if (!_releaseState.builtImage) return;
  try {
    const res = await api.get(withProject('/api/bluegreen/status'));
    const imageMatch = res.betaImage && res.betaImage === _releaseState.builtImage;
    const healthy = (res.desiredCount || 0) > 0 && (res.runningCount || 0) > 0;
    const starting = (res.desiredCount || 0) > 0 && (res.runningCount || 0) === 0;

    if (imageMatch && healthy) {
      _releaseState.betaDeploying = false;
      _releaseState.betaDeployed = true;
      _saveReleaseState();
    } else if (imageMatch && starting) {
      _releaseState.betaDeploying = true;
      _releaseState.betaDeployed = false;
      _saveReleaseState();
    } else if (_releaseState.betaDeploying && (res.desiredCount || 0) > 0) {
      _releaseState.betaDeployed = false;
      _saveReleaseState();
    }
  } catch (_) {}
}

function _showBetaDeployingUI() {
  const image = _releaseState.builtImage;
  document.getElementById('release-step-2')?.classList.remove('release-step-disabled');
  document.getElementById('release-step-3')?.classList.add('release-step-disabled');
  const badge = document.getElementById('release-beta-badge');
  if (badge) badge.innerHTML = '<span style="background:var(--color-bg);border:1px solid var(--color-border);padding:4px 10px;border-radius:12px;font-size:11px;font-weight:700;">Waiting for ECS…</span>';
  const betaBody = document.getElementById('release-beta-body');
  if (betaBody) {
    betaBody.innerHTML = `
      <div style="font-size:13px;color:var(--color-text-secondary);">Deploying to Beta and waiting for ECS task to become healthy…</div>
      <p style="font-size:12px;color:var(--color-text-tertiary);margin-top:8px;">
        Image: <code style="background:var(--color-bg);padding:2px 4px;border-radius:4px;border:1px solid var(--color-border);font-size:11px;">${escapeHTML(image || '')}</code><br>
        Safe to leave this page — progress is saved. This can take 1–3 minutes.
      </p>`;
  }
  const promoteBody = document.getElementById('release-promote-body');
  if (promoteBody) promoteBody.innerHTML = '<span style="font-size:13px;color:var(--color-text-tertiary);">Waiting for Beta to become healthy…</span>';
  document.getElementById('release-promote-badge')?.replaceChildren();
}

function _showPromotingUI() {
  document.getElementById('release-step-3')?.classList.remove('release-step-disabled');
  const badge = document.getElementById('release-promote-badge');
  if (badge) badge.innerHTML = '<span style="background:var(--color-bg);border:1px solid var(--color-border);padding:4px 10px;border-radius:12px;font-size:11px;font-weight:700;">Pipeline starting…</span>';
  const promoteBody = document.getElementById('release-promote-body');
  if (promoteBody) {
    promoteBody.innerHTML = `
      <div style="font-size:13px;color:var(--color-text-secondary);">Merging into main and waiting for the pipeline to start…</div>
      <p style="font-size:12px;color:var(--color-text-tertiary);margin-top:8px;">Progress is saved if you leave this page. Approve UAT and Production on the Approvals page.</p>`;
  }
}

function _pollBetaDeployStatus() {
  _stopBetaPoll();
  _releaseState.betaPollTimer = setInterval(async () => {
    await _syncBetaFromAws();
    if (_releaseState.betaDeployed) {
      _stopBetaPoll();
      _showBetaDeployedUI();
      toast('Beta is up and healthy.');
      return;
    }
    if (_releaseState.betaDeploying) {
      _showBetaDeployingUI();
    }
  }, 8000);
}

function _showBuildSucceededUI() {
  const image = _releaseState.builtImage;
  const branch = _releaseState.selectedBranch;
  const badge = document.getElementById('release-build-badge');
  if (badge) badge.innerHTML = `<span style="background:var(--color-success-bg, #dcfce7);color:var(--color-success-text, #166534);border:1px solid rgba(22, 163, 74, 0.2);padding:4px 10px;border-radius:12px;font-size:11px;font-weight:700;">Succeeded</span>`;
  const buildBody = document.getElementById('release-build-body');
  if (buildBody) {
    buildBody.innerHTML = `
      <div style="font-size:12px;color:var(--color-text-secondary);margin-bottom:6px;">
        Branch: <strong>${escapeHTML(branch || '')}</strong>
      </div>
      <div style="margin-top:4px;padding:8px 10px;background:var(--color-bg);border:1px solid var(--color-border);border-radius:6px;font-size:12px;">
        <span style="color:var(--color-text-tertiary);">Image:</span> <code style="font-size:11px;">${escapeHTML(image || '')}</code>
      </div>`;
  }
  document.getElementById('release-step-2')?.classList.remove('release-step-disabled');
}

function _showBetaReadyUI() {
  const image = _releaseState.builtImage;
  document.getElementById('release-step-2')?.classList.remove('release-step-disabled');
  document.getElementById('release-beta-badge')?.replaceChildren();
  const betaBody = document.getElementById('release-beta-body');
  if (betaBody) {
    betaBody.innerHTML = `
      <div style="font-size:13px;margin-bottom:10px;">
        Ready to deploy <code style="font-size:11px;background:var(--color-bg);padding:2px 4px;border-radius:4px;border:1px solid var(--color-border);">${escapeHTML(image || '')}</code> to the Beta environment.
      </div>
      <button onclick="releaseDeployToBeta()" style="padding:6px 14px;background:#6366f1;color:white;border:none;border-radius:6px;font-weight:700;cursor:pointer;font-size:12px;">Deploy to Beta</button>`;
  }
  document.getElementById('release-step-3')?.classList.add('release-step-disabled');
  const promoteBody = document.getElementById('release-promote-body');
  if (promoteBody) promoteBody.innerHTML = '<span style="font-size:13px;color:var(--color-text-tertiary);">Deploy to Beta first.</span>';
  document.getElementById('release-promote-badge')?.replaceChildren();
}

function _showBetaDeployedUI() {
  const image = _releaseState.builtImage;
  const branch = _releaseState.selectedBranch;
  const defaultBranch = _activeProject.githubBranch || 'main';
  document.getElementById('release-step-2')?.classList.remove('release-step-disabled');
  document.getElementById('release-step-3')?.classList.remove('release-step-disabled');
  const badge = document.getElementById('release-beta-badge');
  if (badge) badge.innerHTML = '<span style="background:var(--color-success-bg, #dcfce7);color:var(--color-success-text, #166534);border:1px solid rgba(22, 163, 74, 0.2);padding:4px 10px;border-radius:12px;font-size:11px;font-weight:700;">Healthy</span>';
  const betaBody = document.getElementById('release-beta-body');
  if (betaBody) {
    betaBody.innerHTML = `
      <div style="font-size:13px;margin-bottom:10px;">
        Beta ECS is <strong>running</strong> with <code style="font-size:11px;background:var(--color-bg);padding:2px 4px;border-radius:4px;border:1px solid var(--color-border);">${escapeHTML(image || '')}</code>.
      </div>
      <p style="font-size:12px;color:var(--color-text-secondary);margin-bottom:12px;">
        Test with the beta cookie (<code>__env=beta</code>) on prod.<br>
        When satisfied, promote to Production below.
      </p>`;
  }
  const promoteBody = document.getElementById('release-promote-body');
  if (promoteBody && !_releaseState.promoted) {
    promoteBody.innerHTML = `
      <div style="font-size:13px;margin-bottom:12px;line-height:1.6;">
        Beta verified with <code style="font-size:11px;background:var(--color-bg);padding:2px 4px;border-radius:4px;border:1px solid var(--color-border);">${escapeHTML(image || '')}</code>.<br>
        Promoting merges <code>${escapeHTML(branch || '')}</code> into <code>${escapeHTML(defaultBranch)}</code>
        and triggers the full pipeline — <strong>not</strong> a direct image copy to prod.
      </div>
      <button onclick="releasePromote()" style="padding:10px 20px;background:#6366f1;color:white;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-size:13px;">Merge &amp; Start Pipeline</button>`;
  }
}

function _showPromotedUI() {
  document.getElementById('release-step-2')?.classList.remove('release-step-disabled');
  document.getElementById('release-step-3')?.classList.remove('release-step-disabled');
  const betaBadge = document.getElementById('release-beta-badge');
  if (betaBadge) betaBadge.innerHTML = '<span style="background:var(--color-bg);border:1px solid var(--color-border);padding:4px 10px;border-radius:12px;font-size:11px;font-weight:700;">Scaled to 0</span>';
  const betaBody = document.getElementById('release-beta-body');
  if (betaBody) {
    betaBody.innerHTML = `<p style="font-size:13px;color:var(--color-text-secondary);">Beta was scaled to 0 after promotion.</p>`;
  }
  const badge = document.getElementById('release-promote-badge');
  if (badge) badge.innerHTML = '<span style="background:var(--color-success-bg, #dcfce7);color:var(--color-success-text, #166534);border:1px solid rgba(22, 163, 74, 0.2);padding:4px 10px;border-radius:12px;font-size:11px;font-weight:700;">Live</span>';
  const promoteBody = document.getElementById('release-promote-body');
  if (promoteBody) {
    promoteBody.innerHTML = `
      <p style="font-size:13px;color:var(--color-success-text, #166534);font-weight:600;margin-bottom:8px;">Release merged and pipeline started.</p>
      <p style="font-size:12px;color:var(--color-text-secondary);margin-top:4px;line-height:1.6;">
        ${_releaseState.mergeNote ? escapeHTML(_releaseState.mergeNote) : 'Approve UAT and Production on the Approvals page.'}
        ${_releaseState.pipelineExecutionId ? `<br>Pipeline run: <code style="font-size:11px;background:var(--color-bg);padding:2px 4px;border-radius:4px;border:1px solid var(--color-border);">${escapeHTML(_releaseState.pipelineExecutionId.slice(0, 8))}…</code>` : ''}
      </p>
      <div style="margin-top:16px;display:flex;gap:8px;">
        <button onclick="window.location.href='/approvals'" style="padding:6px 14px;background:var(--color-bg);color:var(--color-text-primary);border:1px solid var(--color-border);border-radius:6px;font-weight:600;cursor:pointer;font-size:12px;">Go to Approvals</button>
        <button onclick="releaseStartNew()" style="padding:6px 14px;background:var(--color-bg);color:var(--color-text-primary);border:1px solid var(--color-border);border-radius:6px;font-weight:600;cursor:pointer;font-size:12px;">Start New Release</button>
      </div>`;
  }
}

async function _loadReleaseBranches(project) {
  const listEl = document.getElementById('release-branch-list');
  if (!listEl) return;
  try {
    const data = await api.get(withProject('/api/github/branches'));
    const branches = data.branches || [];

    if (branches.length === 0) {
      listEl.innerHTML = '<div style="font-size:13px;padding:16px 20px;color:var(--color-text-tertiary);">No branches found.</div>';
      return;
    }

    listEl.innerHTML = branches.map(b => {
      const isDefault = b.isDefault;
      const aheadBehind = !isDefault
        ? `<span style="color:var(--color-success-text, #16a34a);font-size:11px;font-weight:600;">+${b.aheadBy}</span> <span style="color:var(--color-danger, #ef4444);font-size:11px;font-weight:600;">-${b.behindBy}</span>`
        : '<span style="font-size:11px;color:var(--color-text-tertiary);font-weight:600;">default</span>';
      const isSelected = _releaseState.selectedBranch === b.name;
      return `
        <div class="release-branch-row ${isSelected ? 'selected' : ''}" onclick='releaseSelectBranch(${JSON.stringify(b.name)})'>
          <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--color-text-tertiary);flex-shrink:0;"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
            <span style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHTML(b.name)}</span>
          </div>
          <div style="display:flex;gap:5px;flex-shrink:0;">${aheadBehind}</div>
        </div>
      `;
    }).join('');
  } catch (e) {
    listEl.innerHTML = `<div style="color:var(--color-danger, #ef4444);font-size:13px;padding:16px 20px;">${escapeHTML(e.message)}</div>`;
  }
}

async function releaseSelectBranch(branchName) {
  if (
    _releaseState.selectedBranch &&
    _releaseState.selectedBranch !== branchName &&
    (_releaseState.buildId || _releaseState.builtImage || _releaseState.betaDeployed || _releaseState.betaDeploying) &&
    !_releaseState.promoted
  ) {
    if (!confirm(`Switch to "${branchName}"? This clears the current release progress for "${_releaseState.selectedBranch}".`)) {
      return;
    }
  }

  if (_releaseState.selectedBranch === branchName && (_releaseState.buildId || _releaseState.builtImage)) {
    document.querySelectorAll('.release-branch-row').forEach(r => {
      r.classList.toggle('selected', r.querySelector('span')?.textContent.trim() === branchName);
    });
    return;
  }

  _releaseState.selectedBranch = branchName;
  _releaseState.buildId = null;
  _releaseState.buildStatus = null;
  _releaseState.builtImage = null;
  _releaseState.betaDeploying = false;
  _releaseState.betaDeployed = false;
  _releaseState.promoting = false;
  _releaseState.promoted = false;
  _releaseState.promotedImage = null;
  _releaseState.mergeNote = null;
  _stopReleasePoll();
  _stopBetaPoll();
  _saveReleaseState();

  document.querySelectorAll('.release-branch-row').forEach(r => {
    r.classList.toggle('selected', r.querySelector('span')?.textContent.trim() === branchName);
  });

  const buildBody = document.getElementById('release-build-body');
  const badge = document.getElementById('release-build-badge');
  if (buildBody) {
    buildBody.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <span style="font-size:13px;">Branch: <strong>${escapeHTML(branchName)}</strong></span>
        <button onclick="releaseBuildBranch()" style="padding:6px 14px;background:#6366f1;color:white;border:none;border-radius:6px;font-weight:700;cursor:pointer;font-size:12px;">Start Build</button>
      </div>
    `;
  }
  if (badge) badge.innerHTML = '';

  ['release-step-2','release-step-3'].forEach(id => {
    document.getElementById(id)?.classList.add('release-step-disabled');
  });
  const betaBody = document.getElementById('release-beta-body');
  if (betaBody) betaBody.innerHTML = '<span style="font-size:13px;color:var(--color-text-tertiary);">Build must succeed first.</span>';
  const promoteBody = document.getElementById('release-promote-body');
  if (promoteBody) promoteBody.innerHTML = '<span style="font-size:13px;color:var(--color-text-tertiary);">Deploy to Beta first.</span>';
  document.getElementById('release-beta-badge')?.replaceChildren();
  document.getElementById('release-promote-badge')?.replaceChildren();
}

async function releaseBuildBranch() {
  const branchName = _releaseState.selectedBranch;
  if (!branchName) { toast('Select a branch first'); return; }

  const buildBody = document.getElementById('release-build-body');
  if (buildBody) buildBody.innerHTML = `<div style="font-size:13px;color:var(--color-text-secondary);">Starting build for <strong>${escapeHTML(branchName)}</strong>...</div>`;

  try {
    const res = await api.post(withProject('/api/release/build-branch'), { branchName });
    _releaseState.buildId = res.buildId;
    _releaseState.buildStatus = res.buildStatus;
    _saveReleaseState();
    toast('Build started — polling for progress...');
    _pollReleaseBuild();
  } catch (err) {
    toast('Build failed to start: ' + err.message);
  }
}

function _pollReleaseBuild() {
  _stopReleasePoll();
  _releaseState.pollTimer = setInterval(async () => {
    await _refreshReleaseBuildStatus();
    if (['SUCCEEDED','FAILED','STOPPED','FAULT','TIMED_OUT'].includes(_releaseState.buildStatus)) {
      _stopReleasePoll();
    }
  }, 5000);
  _refreshReleaseBuildStatus();
}

async function _refreshReleaseBuildStatus() {
  const buildId = _releaseState.buildId;
  if (!buildId) return;
  try {
    const res = await api.get(withProject(`/api/release/build-status?buildId=${encodeURIComponent(buildId)}`));
    
    _releaseState.buildStatus = res.buildStatus;
    if (res.builtImage) _releaseState.builtImage = res.builtImage;
    _saveReleaseState();

    const buildBody = document.getElementById('release-build-body');
    const badge = document.getElementById('release-build-badge');
    const statusColors = { SUCCEEDED: 'var(--color-success-text, #16a34a)', FAILED: 'var(--color-danger, #ef4444)', IN_PROGRESS: 'var(--color-primary, #6366f1)', STOPPED: 'var(--color-text-tertiary, #94a3b8)' };
    const statusBg = { SUCCEEDED: 'var(--color-success-bg, #dcfce7)', FAILED: 'rgba(239,68,68,0.1)', IN_PROGRESS: 'rgba(99,102,241,0.1)', STOPPED: 'rgba(148,163,184,0.1)' };
    const statusColor = statusColors[res.buildStatus] || 'var(--color-text-tertiary)';
    const bgColor = statusBg[res.buildStatus] || 'var(--color-bg)';
    const statusLabel = { SUCCEEDED: 'Succeeded', FAILED: 'Failed', IN_PROGRESS: 'In Progress', STOPPED: 'Stopped', TIMED_OUT: 'Timed Out' }[res.buildStatus] || res.buildStatus;

    if (badge) badge.innerHTML = `<span style="background:${bgColor};color:${statusColor};border:1px solid ${statusColor}40;padding:4px 10px;border-radius:12px;font-size:11px;font-weight:700;">${statusLabel}</span>`;

    const logs = (res.logs || []).slice(-8);
    const logHtml = logs.length > 0
      ? `<pre class="release-build-log">${logs.map(l => escapeHTML(l.message || '')).join('')}</pre>`
      : '<div style="font-size:12px;color:var(--color-text-tertiary);">Waiting for log output...</div>';

    const imageInfo = res.builtImage
      ? `<div style="margin-top:10px;padding:8px 10px;background:var(--color-bg);border:1px solid var(--color-border);border-radius:6px;font-size:12px;">
          <span style="color:var(--color-text-tertiary);">Image:</span> <code style="font-size:11px;">${escapeHTML(res.builtImage)}</code>
         </div>`
      : '';

    const retryBtn = ['FAILED','STOPPED','TIMED_OUT'].includes(res.buildStatus)
      ? `<button onclick="releaseBuildBranch()" style="margin-top:10px;padding:6px 14px;background:var(--color-bg);color:var(--color-text-primary);border:1px solid var(--color-border);border-radius:6px;font-weight:600;cursor:pointer;font-size:12px;">Retry Build</button>`
      : '';

    if (buildBody) buildBody.innerHTML = `
      <div style="font-size:12px;color:var(--color-text-secondary);margin-bottom:6px;">
        Branch: <strong>${escapeHTML(_releaseState.selectedBranch)}</strong>
        ${res.resolvedSourceVersion ? ' — commit: <code style="font-size:11px;">' + res.resolvedSourceVersion.slice(0,8) + '</code>' : ''}
      </div>
      ${logHtml}
      ${imageInfo}
      ${retryBtn}
    `;

    if (res.buildStatus === 'SUCCEEDED' && res.builtImage) {
      document.getElementById('release-step-2')?.classList.remove('release-step-disabled');
      const betaBody = document.getElementById('release-beta-body');
      if (betaBody) {
        betaBody.innerHTML = `
          <div style="font-size:13px;margin-bottom:10px;">
            Ready to deploy <code style="font-size:11px;background:var(--color-bg);padding:2px 4px;border-radius:4px;border:1px solid var(--color-border);">${escapeHTML(res.builtImage)}</code> to the Beta environment.
          </div>
          <button onclick="releaseDeployToBeta()" style="padding:6px 14px;background:#6366f1;color:white;border:none;border-radius:6px;font-weight:700;cursor:pointer;font-size:12px;">Deploy to Beta</button>
        `;
      }
    }
  } catch (err) {}
}

async function releaseDeployToBeta() {
  const imageUri = _releaseState.builtImage;
  if (!imageUri) { toast('No built image available'); return; }
  if (_releaseState.betaDeploying) {
    toast('Beta deploy already in progress — waiting for ECS…');
    _showBetaDeployingUI();
    _pollBetaDeployStatus();
    return;
  }

  _releaseState.betaDeploying = true;
  _releaseState.betaDeployed = false;
  _saveReleaseState();
  _showBetaDeployingUI();
  _pollBetaDeployStatus();

  var project = _activeProject;
  if (!project.prodBetaServiceName) {
    try {
      await api.post(withProject('/api/bluegreen/beta/provision'), {});
      await reloadCurrentProject();
    } catch (err) {
      _releaseState.betaDeploying = false;
      _saveReleaseState();
      _stopBetaPoll();
      toast('Beta provisioning failed: ' + err.message);
      return;
    }
  }

  try {
    await api.post(withProject('/api/bluegreen/beta/start'), { imageUri });
    _stopBetaPoll();
    _releaseState.betaDeploying = false;
    _releaseState.betaDeployed = true;
    _saveReleaseState();
    toast('Beta is up and healthy.');
    _showBetaDeployedUI();
  } catch (err) {
    _releaseState.betaDeploying = false;
    _saveReleaseState();
    _stopBetaPoll();
    toast('Deploy failed: ' + err.message);
    const badge = document.getElementById('release-beta-badge');
    const betaBody = document.getElementById('release-beta-body');
    if (badge) badge.innerHTML = '<span style="background:rgba(239,68,68,0.1);color:var(--color-danger, #ef4444);border:1px solid rgba(239,68,68,0.4);padding:4px 10px;border-radius:12px;font-size:11px;font-weight:700;">Failed</span>';
    if (betaBody) {
      betaBody.innerHTML = `
        <div style="font-size:13px;color:var(--color-danger, #ef4444);">Beta deploy failed: ${escapeHTML(err.message)}</div>
        <button onclick="releaseDeployToBeta()" style="margin-top:10px;padding:6px 14px;background:var(--color-bg);color:var(--color-text-primary);border:1px solid var(--color-border);border-radius:6px;font-weight:600;cursor:pointer;font-size:12px;">Retry Deploy to Beta</button>`;
    }
  }
}

async function releasePromote() {
  const branch = _releaseState.selectedBranch;
  const defaultBranch = _activeProject.githubBranch || 'main';
  if (!branch) { toast('Select a release branch first'); return; }
  if (!confirm(`Promote to Production?\n\nThis will merge "${branch}" into "${defaultBranch}", trigger the 7-stage pipeline, and scale Beta to 0.\n\nProduction deploy happens only after UAT and Production approvals — not by copying the Beta image.`)) return;

  _releaseState.promoting = true;
  _saveReleaseState();
  _showPromotingUI();

  try {
    const res = await api.post(withProject('/api/release/promote-to-prod'), { branchName: branch });
    const mergeNote = res.message || (res.alreadyUpToDate
      ? `${branch} already up to date with ${defaultBranch}.`
      : `Merged ${branch} → ${defaultBranch}. Pipeline is running — approve on the Approvals page.`);

    toast(mergeNote);
    _releaseState.promoting = false;
    _releaseState.promoted = true;
    _releaseState.promotedImage = _releaseState.builtImage;
    _releaseState.betaDeployed = false;
    _releaseState.betaDeploying = false;
    _releaseState.mergeNote = mergeNote;
    _releaseState.pipelineExecutionId = res.pipelineExecutionId || null;
    _saveReleaseState();

    _showPromotedUI();
  } catch (err) {
    _releaseState.promoting = false;
    _saveReleaseState();
    toast('Promotion failed: ' + err.message);
    const badge = document.getElementById('release-promote-badge');
    const promoteBody = document.getElementById('release-promote-body');
    if (badge) badge.innerHTML = '<span style="background:rgba(239,68,68,0.1);color:var(--color-danger, #ef4444);border:1px solid rgba(239,68,68,0.4);padding:4px 10px;border-radius:12px;font-size:11px;font-weight:700;">Failed</span>';
    if (promoteBody) {
      promoteBody.innerHTML = `
        <div style="font-size:13px;color:var(--color-danger, #ef4444);">Promote failed: ${escapeHTML(err.message)}</div>
        <button onclick="releasePromote()" style="margin-top:10px;padding:6px 14px;background:var(--color-bg);color:var(--color-text-primary);border:1px solid var(--color-border);border-radius:6px;font-weight:600;cursor:pointer;font-size:12px;">Retry Promote</button>`;
    }
  }
}

async function releaseCreateBranch() {
  const branchName = prompt('Enter new branch name (e.g. feature/my-change):');
  if (!branchName) return;
  const baseBranch = prompt('Base branch to branch from:', _activeProject.githubBranch || 'main') || 'main';

  try {
    await api.post(withProject('/api/github/branches'), { branchName, baseBranch });
    toast(`Branch "${branchName}" created`);
    await _loadReleaseBranches(_activeProject);
  } catch (err) {
    toast('Error: ' + err.message);
  }
}
