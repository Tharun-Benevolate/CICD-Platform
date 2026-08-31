async function loadCertificates() {
  const tbody = document.getElementById('certificates-tbody');
  const refreshBtn = document.getElementById('refresh-icon');
  
  if (refreshBtn) refreshBtn.classList.add('spin');

  try {
    const res = await fetch('/api/certificates');
    const data = await res.json();

    if (!data.ok) throw new Error(data.error || 'Failed to load certificates');

    if (data.certificates.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="4" style="padding:40px;text-align:center;color:var(--color-text-tertiary);">
            No SSL certificates found in this region.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = data.certificates.map(cert => {
      // Determine status badge color
      let statusColor = 'var(--color-warning)';
      let statusBg = 'var(--color-warning-light)';
      
      if (cert.status === 'ISSUED') {
        statusColor = 'var(--color-success)';
        statusBg = 'var(--color-success-light)';
      } else if (cert.status === 'FAILED' || cert.status.includes('ERROR')) {
        statusColor = 'var(--color-danger)';
        statusBg = 'var(--color-danger-light)';
      } else if (cert.status === 'PENDING_VALIDATION') {
        statusColor = 'var(--color-info)';
        statusBg = 'var(--color-info-light)';
      }

      const sans = cert.subjectAlternativeNames.length > 0 
        ? `<div style="font-size:11px;color:var(--color-text-tertiary);margin-top:4px;">SANs: ${cert.subjectAlternativeNames.join(', ')}</div>` 
        : '';
        
      const loadBalancers = cert.inUseBy.map(arn => arn.split(':loadbalancer/')[1] || arn).join('<br>');
      const inUseHtml = loadBalancers ? `<span style="font-size:12px;color:var(--color-text-secondary);">${loadBalancers}</span>` : '<span style="font-size:11px;color:var(--color-text-tertiary);">Not in use</span>';

      return `
        <tr style="border-bottom:1px solid var(--color-border);transition:background var(--transition-fast);">
          <td style="padding:16px 20px;">
            <div style="font-weight:600;color:var(--color-text-primary);font-size:14px;">${cert.domainName}</div>
            ${sans}
          </td>
          <td style="padding:16px 20px;">
            <span style="display:inline-flex;align-items:center;padding:4px 10px;border-radius:12px;font-size:11px;font-weight:700;color:${statusColor};background:${statusBg};letter-spacing:0.5px;">
              ${cert.status}
            </span>
          </td>
          <td style="padding:16px 20px;font-size:13px;color:var(--color-text-secondary);">
            ${cert.type}
          </td>
          <td style="padding:16px 20px;">
            ${inUseHtml}
          </td>
        </tr>
      `;
    }).join('');

  } catch (err) {
    console.error(err);
    tbody.innerHTML = `
      <tr>
        <td colspan="4" style="padding:40px;text-align:center;color:var(--color-danger);">
          Failed to load certificates: ${err.message}
        </td>
      </tr>
    `;
  } finally {
    if (refreshBtn) refreshBtn.classList.remove('spin');
    if (window.lucide) lucide.createIcons();
  }
}

// Auto-load on page ready
document.addEventListener('DOMContentLoaded', loadCertificates);

// Also run immediately if loaded via SPA transition
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  loadCertificates();
}
