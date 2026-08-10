const fs = require('fs');
const content = fs.readFileSync('public/app.js', 'utf-8');

const startMarker = "// --- Blue-Green Deployment (prod only) ---";
const endMarker = "// --- Build history (replaces Deployments / EC2 picker) ---";

const startIndex = content.indexOf(startMarker);
const endIndex = content.indexOf(endMarker);

if (startIndex === -1 || endIndex === -1) {
  console.error("Markers not found");
  process.exit(1);
}

const newCode = `// --- Beta Environment Management ---

async function renderBlueGreen() {
  const project = currentProject();
  const content = document.getElementById("content");

  if (!project.prodBetaServiceName) {
    content.innerHTML = \`
      <div class="page-header"><h1>Beta Environment</h1><p>\${escapeHTML(project.name)}</p></div>
      <div class="empty">
        <p>Beta routing infrastructure isn't deployed for this project yet.</p>
        <p class="muted" style="margin-top:6px;font-size:12px;">Run the Deployment Terraform to create the beta target group and ALB listener rules.</p>
      </div>
    \`;
    return;
  }

  content.innerHTML = \`
    <div class="page-header" style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px;">
      <div>
        <h1>Beta Environment</h1>
        <p>Manage cookie-based beta access for <strong>\${escapeHTML(project.name)}</strong></p>
      </div>
    </div>
    <div id="beta-dashboard-area"><div class="muted" style="padding:24px">Loading beta status...</div></div>
  \`;

  await _refreshBetaPanel(project);
}

async function _refreshBetaPanel(project) {
  const area = document.getElementById("beta-dashboard-area");
  if (!area) return;

  try {
    const res = await get(withProject("/api/bluegreen/status"));
    if (!res.ok) {
      area.innerHTML = \`<div class="card" style="color:var(--danger)">Error: \${escapeHTML(res.error)}</div>\`;
      return;
    }

    const { betaActive, desiredCount, runningCount, betaImage, betaOrgs } = res;

    let statusBadge = '';
    if (betaActive) {
      statusBadge = \`<span class="badge badge-success">Active (\${runningCount}/\${desiredCount} tasks)</span>\`;
    } else {
      statusBadge = \`<span class="badge badge-secondary">Inactive (0 tasks)</span>\`;
    }

    const orgsRows = (betaOrgs || []).map(org => \`
      <tr>
        <td>\${escapeHTML(org.orgId)}</td>
        <td>\${escapeHTML(org.orgName || '—')}</td>
        <td>\${escapeHTML(org.notes || '—')}</td>
        <td>
          <button class="btn btn-danger btn-sm" onclick="removeBetaOrg('\${org.orgId}')">Remove</button>
        </td>
      </tr>
    \`).join('');

    area.innerHTML = \`
      <div class="scaling-grid">
        <div class="card scaling-card" style="grid-column: 1 / -1;">
          <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;">
            <h3>Beta Service Status</h3>
            \${statusBadge}
          </div>
          <div style="padding:16px 0;">
            <p style="margin:0 0 10px 0;"><strong>Current Beta Image:</strong> \${betaImage ? \`<code>\${escapeHTML(betaImage)}</code>\` : '<span class="muted">None (or checking...)</span>'}</p>
            \${betaActive ? \`
              <button class="btn btn-primary" onclick="promoteBeta()">🚀 Promote to Production</button>
              <button class="btn" onclick="stopBeta()" style="margin-left:8px;">Stop Beta Service (Scale to 0)</button>
            \` : \`
              <p class="muted" style="font-size:12px;margin-bottom:12px;">The beta service is scaled to 0. Deploys via CodePipeline to the Beta stage will automatically start it, or you can start it manually.</p>
            \`}
          </div>
        </div>

        <div class="card scaling-card" style="grid-column: 1 / -1;">
          <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;">
            <h3>Authorized Beta Organizations</h3>
            <button class="btn btn-sm" onclick="addBetaOrgPrompt()">+ Add Org</button>
          </div>
          <p style="font-size:12px;color:var(--muted);margin-bottom:12px;">
            Users belonging to these organizations will receive the <code>__env=beta</code> cookie upon login and be routed to the Beta ECS service.
          </p>
          <table class="table" style="font-size:13px;">
            <thead>
              <tr><th>Org ID</th><th>Name</th><th>Notes</th><th>Actions</th></tr>
            </thead>
            <tbody>
              \${orgsRows || '<tr><td colspan="4" class="muted">No organizations authorized for beta access.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    \`;
  } catch (e) {
    area.innerHTML = \`<div class="card" style="color:var(--danger)">Failed to load: \${escapeHTML(e.message)}</div>\`;
  }
}

async function promoteBeta() {
  if (!confirm("Are you sure you want to promote the current Beta image to Production (Stable)?\\n\\nThis will trigger a rolling update of the main prod ECS service.")) return;
  const res = await post(withProject("/api/bluegreen/beta/promote"), {});
  if (res.ok) {
    toast(\`Promoted successfully! \${res.promotedImage}\`);
    _refreshBetaPanel(currentProject());
  } else {
    toast("Error: " + res.error);
  }
}

async function stopBeta() {
  if (!confirm("Stop the beta service? This scales the beta ECS tasks down to 0 to save costs.")) return;
  const res = await post(withProject("/api/bluegreen/beta/stop"), {});
  if (res.ok) {
    toast("Beta service stopped.");
    _refreshBetaPanel(currentProject());
  } else {
    toast("Error: " + res.error);
  }
}

async function addBetaOrgPrompt() {
  const orgId = prompt("Enter the Organization ID (must match your app's ID format):");
  if (!orgId) return;
  const orgName = prompt("Enter Organization Name (optional):") || "";
  const notes = prompt("Enter Notes (optional):") || "";

  const res = await post(withProject("/api/beta-orgs"), { orgId, orgName, notes }, false);
  if (res.ok) {
    toast(\`Added \${orgId} to beta list\`);
    _refreshBetaPanel(currentProject());
  } else {
    toast("Error: " + res.error);
  }
}

async function removeBetaOrg(orgId) {
  if (!confirm(\`Remove \${orgId} from the beta list? Users in this org will lose beta access.\`)) return;
  const res = await fetch(\`/api/beta-orgs/\${encodeURIComponent(orgId)}\`, { method: "DELETE" }).then(r => r.json());
  if (res.ok) {
    toast(\`Removed \${orgId}\`);
    _refreshBetaPanel(currentProject());
  } else {
    toast("Error: " + res.error);
  }
}

`;

const finalContent = content.slice(0, startIndex) + newCode + content.slice(endIndex);
fs.writeFileSync('public/app.js', finalContent);
console.log("Replaced successfully!");
