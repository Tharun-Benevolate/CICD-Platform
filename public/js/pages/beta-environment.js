var _activeProject = null;
var _betaPollInterval = null;

window.initBetaPage = async function() {
  if (typeof api === 'undefined') {
    console.error('API helper not found. Make sure api.js is loaded.');
    return;
  }

  // Look up project ID from URL if provided (standard pattern in Project-Integr8)
  const urlParams = new URLSearchParams(window.location.search);
  const projectId = urlParams.get('project');

  const loader = document.getElementById('beta-page-loader');

  try {
    const res = await api.get('/api/projects');
    if (res.projects && res.projects.length > 0) {
      if (projectId) {
        _activeProject = res.projects.find(p => String(p.id) === String(projectId));
      }
      if (!_activeProject) {
        _activeProject = res.projects[0];
      }
    }

    if (_activeProject) {
      await renderBlueGreen();
    } else {
      const content = document.getElementById('content');
      if (content) content.innerHTML = '<div style="padding:40px;text-align:center;color:var(--color-text-tertiary);">No project found. Please configure a project first.</div>';
    }
  } catch (err) {
    if (!_activeProject) {
      const content = document.getElementById('content');
      if (content) content.innerHTML = `<div style="padding:40px;text-align:center;color:var(--color-text-tertiary);">Failed to load project: ${escapeHTML(err.message)}</div>`;
    }
  } finally {
    if (loader) loader.style.display = 'none';
  }
};

// Helper functions (common across Project-Integr8 pages)
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
    // Fallback toast
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

async function betaProvision() {
  const log = document.getElementById('beta-provision-log');
  if (log) log.textContent = 'Provisioning beta environment... this may take 30-60 seconds';
  try {
    const res = await api.post(withProject('/api/bluegreen/beta/provision'), {});
    toast('Beta environment enabled');
    await reloadCurrentProject();
    renderBlueGreen();
  } catch (err) {
    if (log) log.textContent = 'Error: ' + err.message;
    toast('Beta provision failed: ' + err.message);
  }
}

async function betaTeardown() {
  if (!confirm('Tear down the Beta environment?\n\nThis will delete the beta ECS service, ALB rule, and target group. You can re-provision at any time.')) return;
  const log = document.getElementById('beta-teardown-log');
  if (log) log.textContent = 'Tearing down...';
  try {
    const res = await api.post(withProject('/api/bluegreen/beta/teardown'), {});
    toast('Beta environment torn down');
    await reloadCurrentProject();
    renderBlueGreen();
  } catch (err) {
    toast('Teardown failed: ' + err.message);
    if (log) log.textContent = '';
  }
}

async function renderBlueGreen() {
  const project = _activeProject;
  const content = document.getElementById('content');
  if (!content) return;

  if (!project.prodBetaServiceName) {
    content.innerHTML = `
      <div style="margin-bottom:24px;">
        <h1 style="font-size:22px;font-weight:700;margin-bottom:4px;color:var(--color-text-primary);">Beta Environment</h1>
        <p style="font-size:13px;color:var(--color-text-secondary);">${escapeHTML(project.name)}</p>
      </div>
      <div style="max-width:520px;margin:0 auto;background:var(--color-surface);border:1px solid var(--color-border);border-radius:16px;padding:28px;">
        <div style="font-size:15px;font-weight:700;margin-bottom:12px;color:var(--color-text-primary);">Beta Environment Not Provisioned</div>
        <p style="font-size:13px;color:var(--color-text-secondary);margin-bottom:16px;line-height:1.6;">
          Beta is created on demand — no Terraform needed.<br>
          Clicking <strong>Enable Beta</strong> will:
        </p>
        <ul style="font-size:13px;color:var(--color-text-secondary);line-height:1.9;padding-left:20px;margin-bottom:24px;">
          <li>Create a Beta ECS service (<code>${escapeHTML((project.prodServiceName||'').replace(/-prod$/,'')+'-prod-beta')}</code>) at 0 tasks</li>
          <li>Create a target group for it on the shared ALB</li>
          <li>Add a listener rule: host-header=<code>${escapeHTML((project.prodUrl||'').replace(/^https?:\/\//,'').split('/')[0]||'prod-domain')}</code> + cookie <code>__env=beta</code></li>
        </ul>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button onclick="betaProvision()" style="padding:10px 20px;background:#6366f1;color:white;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-size:13px;">
            Enable Beta Environment
          </button>
        </div>
        <div id="beta-provision-log" style="font-size:13px;color:var(--color-text-tertiary);margin-top:14px;"></div>
      </div>
    `;
    return;
  }

  content.innerHTML = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:24px;">
      <div>
        <h1 style="font-size:22px;font-weight:700;margin-bottom:4px;color:var(--color-text-primary);">Beta Environment</h1>
        <p style="font-size:13px;color:var(--color-text-secondary);">Manage cookie-based beta access for <strong>${escapeHTML(project.name)}</strong></p>
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        <button onclick="betaTeardown()" style="padding:8px 16px;background:transparent;color:var(--color-danger, #ef4444);border:1px solid var(--color-danger, #ef4444);border-radius:8px;font-weight:600;cursor:pointer;font-size:13px;">
          Tear Down Beta
        </button>
      </div>
    </div>
    <div id="beta-teardown-log" style="font-size:13px;color:var(--color-text-tertiary);margin-bottom:12px;"></div>
    <div id="beta-dashboard-area">
      <div style="padding:24px;color:var(--color-text-tertiary);">Loading beta status...</div>
    </div>
  `;

  await _refreshBetaPanel(project);
}

async function _refreshBetaPanel(project) {
  const area = document.getElementById('beta-dashboard-area');
  if (!area) return;

  try {
    const res = await api.get(withProject('/api/bluegreen/status'));
    
    const betaActive = res.betaActive;
    const desiredCount = res.desiredCount;
    const runningCount = res.runningCount;
    const betaImage = res.betaImage;
    const betaOrgs = res.betaOrgs || [];

    let statusBadge = '';
    if (betaActive) {
      statusBadge = `<span style="background:var(--color-success-bg, #dcfce7);color:var(--color-success-text, #166534);padding:4px 10px;border-radius:12px;font-size:12px;font-weight:700;">Active (${runningCount}/${desiredCount} tasks)</span>`;
    } else {
      statusBadge = `<span style="background:var(--color-bg, #f1f5f9);color:var(--color-text-secondary, #64748b);border:1px solid var(--color-border);padding:4px 10px;border-radius:12px;font-size:12px;font-weight:700;">Inactive (0 tasks)</span>`;
    }

    const orgsRows = betaOrgs.map(org => `
      <tr style="border-bottom:1px solid var(--color-border);">
        <td style="padding:12px 16px;color:var(--color-text-primary);font-size:13px;">${escapeHTML(org.orgId)}</td>
        <td style="padding:12px 16px;color:var(--color-text-primary);font-size:13px;">${escapeHTML(org.orgName || '—')}</td>
        <td style="padding:12px 16px;color:var(--color-text-primary);font-size:13px;">${org.orgDomain ? `<code style="background:var(--color-bg);padding:2px 6px;border-radius:4px;">${escapeHTML(org.orgDomain)}</code>` : '<span style="color:var(--color-text-tertiary);">— (legacy row, unreachable by login)</span>'}</td>
        <td style="padding:12px 16px;color:var(--color-text-primary);font-size:13px;">${escapeHTML(org.notes || '—')}</td>
        <td style="padding:12px 16px;">
          <button onclick="removeBetaOrg('${escapeHTML(org.orgId)}')" style="padding:6px 12px;background:var(--color-danger, #ef4444);color:white;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;">Remove</button>
        </td>
      </tr>
    `).join('');

    area.innerHTML = `
      <div style="display:grid;gap:20px;">
        <div style="background:var(--color-surface);border:1px solid var(--color-border);border-radius:16px;overflow:hidden;">
          <div style="padding:16px 24px;border-bottom:1px solid var(--color-border);display:flex;justify-content:space-between;align-items:center;">
            <h3 style="font-size:15px;font-weight:700;margin:0;color:var(--color-text-primary);">Beta Service Status</h3>
            ${statusBadge}
          </div>
          <div style="padding:24px;">
            <p style="margin:0 0 16px 0;font-size:13px;color:var(--color-text-primary);">
              <strong>Current Beta Image:</strong> 
              ${betaImage ? `<code style="background:var(--color-bg);padding:4px 8px;border-radius:4px;border:1px solid var(--color-border);">${escapeHTML(betaImage)}</code>` : '<span style="color:var(--color-text-tertiary);">None (or checking...)</span>'}
            </p>
            ${betaActive ? `
              <div style="display:flex;gap:12px;flex-wrap:wrap;">
                <button onclick="promoteBeta()" style="padding:10px 20px;background:#6366f1;color:white;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-size:13px;">Promote to Production</button>
                <button onclick="stopBeta()" style="padding:10px 20px;background:var(--color-surface);color:var(--color-text-primary);border:1px solid var(--color-border);border-radius:8px;font-weight:700;cursor:pointer;font-size:13px;">Stop Beta Service (Scale to 0)</button>
              </div>
            ` : `
              <p style="color:var(--color-text-secondary);font-size:13px;margin:0;">The beta service is scaled to 0. Deploys via CodePipeline to the Beta stage will automatically start it, or you can start it manually.</p>
            `}
          </div>
        </div>

        <div style="background:var(--color-bg);border:1px solid var(--color-border);border-radius:16px;overflow:hidden;">
          <div style="padding:16px 24px;border-bottom:1px solid var(--color-border);">
            <h3 style="font-size:15px;font-weight:700;margin:0;color:var(--color-text-primary);">How Org ID Routing Works</h3>
          </div>
          <div style="padding:24px;font-size:13px;line-height:1.6;color:var(--color-text-secondary);">
            <p style="margin:0 0 12px 0;">
              An <strong>Org ID</strong> is a plain string your app assigns to a group of users, and the
              <strong>Email Domain</strong> is what actually maps a real login to that ID — every user
              whose email ends in that domain (e.g. everyone <code>@benevolate.com</code>) resolves to
              the same org. This panel compares Org IDs as an <strong>exact string match</strong> — no
              format is enforced, so <code>1</code>, <code>78</code>, and <code>48-md</code> are all valid.
            </p>
            <p style="margin:0 0 12px 0;">
              When you click <strong>+ Add Org</strong>, you'll be asked for the raw Org ID and then the
              Email Domain (e.g. <code>benevolate.com</code>, no <code>@</code>). Both are required —
              the domain isn't a label, it's the only mechanism that turns a logged-in user's email into
              this Org ID in the first place.
            </p>
            <p style="margin:0;color:var(--color-text-tertiary);">
              At login, your app splits the user's email at <code>@</code> and calls this panel's
              <code>GET /api/public/org-for-domain?domain=X</code> to resolve the Org ID. Only then does
              it check that Org ID against this list. If it matches, the app sets <code>__env=beta</code>
              and the ALB routes that request to the Beta (green) service below. If the domain isn't
              mapped to any org, or the resulting Org ID isn't in this list, the request has no beta
              cookie and falls through to normal Production (blue) routing.
            </p>
          </div>
        </div>

        <div style="background:var(--color-surface);border:1px solid var(--color-border);border-radius:16px;overflow:hidden;">
          <div style="padding:16px 24px;border-bottom:1px solid var(--color-border);display:flex;justify-content:space-between;align-items:center;">
            <h3 style="font-size:15px;font-weight:700;margin:0;color:var(--color-text-primary);">Authorized Beta Organizations</h3>
            <button onclick="addBetaOrgPrompt()" style="padding:8px 16px;background:var(--color-surface);color:var(--color-text-primary);border:1px solid var(--color-border);border-radius:8px;font-weight:600;cursor:pointer;font-size:13px;">+ Add Org</button>
          </div>
          <div style="padding:24px;">
            <p style="font-size:13px;color:var(--color-text-secondary);margin:0 0 16px 0;">
              Users whose email domain matches one of these orgs will receive the <code>__env=beta</code> cookie upon login and be routed to the Beta ECS service.
            </p>
            <div style="overflow-x:auto;">
              <table style="width:100%;border-collapse:collapse;text-align:left;">
                <thead>
                  <tr style="border-bottom:2px solid var(--color-border);">
                    <th style="padding:12px 16px;color:var(--color-text-secondary);font-size:12px;font-weight:700;text-transform:uppercase;">Org ID</th>
                    <th style="padding:12px 16px;color:var(--color-text-secondary);font-size:12px;font-weight:700;text-transform:uppercase;">Name</th>
                    <th style="padding:12px 16px;color:var(--color-text-secondary);font-size:12px;font-weight:700;text-transform:uppercase;">Email Domain</th>
                    <th style="padding:12px 16px;color:var(--color-text-secondary);font-size:12px;font-weight:700;text-transform:uppercase;">Notes</th>
                    <th style="padding:12px 16px;color:var(--color-text-secondary);font-size:12px;font-weight:700;text-transform:uppercase;">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${orgsRows || `<tr><td colspan="5" style="padding:16px;text-align:center;color:var(--color-text-tertiary);font-size:13px;">No organizations authorized for beta access.</td></tr>`}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div style="background:var(--color-surface);border:1px solid var(--color-border);border-radius:16px;overflow:hidden;">
          <div style="padding:16px 24px;border-bottom:1px solid var(--color-border);">
            <h3 style="font-size:15px;font-weight:700;margin:0;color:var(--color-text-primary);">Cookie Routing Configuration</h3>
          </div>
          <div style="padding:24px;">
            <p style="font-size:13px;color:var(--color-text-secondary);margin:0 0 20px 0;">
              Controls which HTTP cookie triggers routing to the Beta environment. Changes are applied
              immediately to the AWS ALB listener rule — no Terraform apply required.
            </p>
            <div id="cookie-config-body"><span style="color:var(--color-text-tertiary);font-size:13px;">Loading...</span></div>
          </div>
        </div>
      </div>
    `;
    await _loadCookieConfig();
  } catch (err) {
    area.innerHTML = `<div style="padding:24px;background:var(--color-surface);border:1px solid var(--color-danger, #ef4444);border-radius:16px;color:var(--color-danger, #ef4444);">Failed to load: ${escapeHTML(err.message)}</div>`;
  }
}

async function _loadCookieConfig() {
  const el = document.getElementById('cookie-config-body');
  if (!el) return;
  try {
    const res = await api.get(withProject('/api/bluegreen/cookie-config'));
    const name = res.cookieName || '__env';
    const val = res.cookieValue || 'beta';
    el.innerHTML = `
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end;">
        <div>
          <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--color-text-tertiary);margin-bottom:6px;">Cookie Name</label>
          <input id="cookie-name-input" value="${escapeHTML(name)}" style="padding:10px 14px;border:1px solid var(--color-border);border-radius:8px;font-size:13px;width:160px;background:var(--color-bg);color:var(--color-text-primary);outline:none;">
        </div>
        <div>
          <label style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--color-text-tertiary);margin-bottom:6px;">Cookie Value</label>
          <input id="cookie-val-input" value="${escapeHTML(val)}" style="padding:10px 14px;border:1px solid var(--color-border);border-radius:8px;font-size:13px;width:160px;background:var(--color-bg);color:var(--color-text-primary);outline:none;">
        </div>
        <button onclick="saveCookieConfig()" style="height:39px;padding:0 20px;background:#6366f1;color:white;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-size:13px;">Apply to AWS</button>
        <span id="cookie-save-status" style="font-size:13px;color:var(--color-text-tertiary);align-self:center;"></span>
      </div>
      <p style="font-size:12px;color:var(--color-text-tertiary);margin-top:16px;margin-bottom:0;">
        Current pattern applied on ALB: <code style="background:var(--color-bg);padding:2px 6px;border-radius:4px;border:1px solid var(--color-border);">*${escapeHTML(name)}=${escapeHTML(val)}*</code>
        ${!res.configured ? ' <span style="color:var(--color-warning, #f59e0b);">(Terraform not yet applied — showing defaults)</span>' : ''}
      </p>
    `;
  } catch (err) {
    el.innerHTML = `<span style="color:var(--color-danger, #ef4444);font-size:13px;">Failed to load cookie config: ${escapeHTML(err.message)}</span>`;
  }
}

async function saveCookieConfig() {
  const cookieName = (document.getElementById('cookie-name-input')?.value || '').trim();
  const cookieValue = (document.getElementById('cookie-val-input')?.value || '').trim();
  const status = document.getElementById('cookie-save-status');
  if (!cookieName || !cookieValue) { toast('Cookie name and value are required'); return; }
  if (status) status.textContent = 'Applying...';
  
  try {
    const res = await api.post(withProject('/api/bluegreen/cookie-config'), { cookieName, cookieValue });
    if (status) status.innerHTML = '<span style="color:var(--color-success-text, #166534);">Applied to AWS ALB</span>';
    await _loadCookieConfig();
  } catch (err) {
    if (status) status.innerHTML = `<span style="color:var(--color-danger, #ef4444);">${escapeHTML(err.message)}</span>`;
  }
}

async function promoteBeta() {
  if (!confirm("Are you sure you want to promote the current Beta image to Production (Stable)?\n\nThis will trigger a rolling update of the main prod ECS service.")) return;
  try {
    const res = await api.post(withProject("/api/bluegreen/beta/promote"), {});
    toast(`Promoted successfully! ${res.promotedImage}`);
    _refreshBetaPanel(_activeProject);
  } catch (err) {
    toast("Error: " + err.message);
  }
}

async function stopBeta() {
  if (!confirm("Stop the beta service? This scales the beta ECS tasks down to 0 to save costs.")) return;
  try {
    const res = await api.post(withProject("/api/bluegreen/beta/stop"), {});
    toast("Beta service stopped.");
    _refreshBetaPanel(_activeProject);
  } catch (err) {
    toast("Error: " + err.message);
  }
}

async function addBetaOrgPrompt() {
  const orgId = prompt("Enter just the raw Org ID (exact string your app uses) — e.g. 2, 48-md, acme-corp. No labels, no prefixes:");
  if (!orgId) return;

  let orgDomain = "";
  while (!orgDomain) {
    orgDomain = (prompt("Enter the company Email Domain for this org (required) — e.g. benevolate.com, no @:") || "").trim();
    if (!orgDomain) {
      if (!confirm("Email Domain is required — every user at this domain will resolve to this Org ID. Try again?")) return;
    }
  }

  const orgName = prompt("Enter Organization Name (optional, just a display label):") || "";
  const notes = prompt("Enter Notes (optional):") || "";

  try {
    const res = await api.post(withProject("/api/beta-orgs"), { orgId, orgName, orgDomain, notes });
    toast(`Added ${orgId} (${orgDomain}) to beta list`);
    _refreshBetaPanel(_activeProject);
  } catch (err) {
    toast("Error: " + err.message);
  }
}

async function removeBetaOrg(orgId) {
  if (!confirm(`Remove ${orgId} from the beta list? Users in this org will lose beta access.`)) return;
  try {
    // Note: this endpoint historically didn't need projectId if it deletes by PK globally,
    // but the `withProject` won't hurt if we prepend it or use standard api.del
    const res = await api.del(`/api/beta-orgs/${encodeURIComponent(orgId)}`);
    toast(`Removed ${orgId}`);
    _refreshBetaPanel(_activeProject);
  } catch (err) {
    toast("Error: " + err.message);
  }
}
