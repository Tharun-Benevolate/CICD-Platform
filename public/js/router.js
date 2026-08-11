// Enterprise-Grade Client-Side SPA Router (No Full Page Refresh)
(function() {
  var loadedCSS = {};
  var loadedJS = {};

  document.addEventListener('DOMContentLoaded', function() {
    initRouter();
  });

  function initRouter() {
    // Intercept clicks on links
    document.addEventListener('click', function(e) {
      var link = e.target.closest('a');
      if (!link) return;

      var href = link.getAttribute('href');
      var target = link.getAttribute('target');

      // Ignore external, anchor, javascript, or blank links
      if (!href || href.startsWith('http') || href.startsWith('//') || href.startsWith('#') || href.startsWith('javascript:') || target === '_blank') {
        return;
      }

      // Ignore API routes
      if (href.startsWith('/api/')) return;

      e.preventDefault();
      navigateTo(href);
    });

    // Handle back/forward buttons
    window.addEventListener('popstate', function() {
      loadPage(window.location.pathname + window.location.search, false);
    });
  }

  async function navigateTo(url) {
    if (window.location.pathname + window.location.search === url) return;
    history.pushState(null, '', url);
    await loadPage(url, true);
  }

  async function loadPage(url, pushHistory) {
    var contentArea = document.querySelector('.content-area');
    var overlay = document.getElementById('page-loading-overlay');
    var innerContainer = document.getElementById('page-content-inner') || contentArea;

    if (!contentArea) {
      window.location.href = url;
      return;
    }

    // Show loading overlay during transition
    if (overlay) overlay.classList.remove('hidden');
    if (innerContainer) innerContainer.classList.remove('revealed');

    try {
      var res = await fetch(url, {
        headers: {
          'X-Requested-With': 'XMLHttpRequest'
        }
      });

      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }

      var data = await res.json();
      if (data && data.redirect) {
        window.location.href = data.redirect;
        return;
      }

      if (data && data.ok && data.html) {
        if (data.user) window.__USER__ = data.user;

        // 1. Swap HTML into inner container
        innerContainer.innerHTML = data.html;

        // 2. Load Page CSS if needed
        if (data.pageCSS) {
          loadCSS('/css/pages/' + data.pageCSS + '.css');
        }

        // 3. Update Sidebar active class immediately for instant visual response
        updateSidebarActive(data.activePage || data.page);

        // 4. Update Topbar Breadcrumb
        updateBreadcrumb(data.activePage || data.page);

        // 5. Load & Run Page JS
        if (data.pageJS) {
          var jsPath = '/js/pages/' + data.pageJS + '.js';
          loadJS(jsPath, function() {
            var fnName = 'init' + capitalize(data.pageJS) + 'Page';
            var aliases = {
              'team-access':      'initTeamPage',
              'change-requests':  'initCrPage',
              'build-history':    'initBuildsPage',
              'beta-environment': 'initBetaPage',
              'branches':         'initBranchesPageRunner',
              'build-logs':       'initBuildLogsPage',
              'admin-users':      'initAdminUsersPage',
              'audit-logs':       'initAuditLogsPage',
              'setup-wizard':     'initSetupWizardPage',
              'file-browser':     'initFileBrowserPage',
              'new-project':      'initNewProjectPage',
              'settings':         'initSettingsPage',
              'repositories':     'initRepositoriesPage'
            };
            var fn = window[fnName] || window[aliases[data.pageJS]];
            if (typeof fn === 'function') {
              try { fn(); } catch (e) { console.warn('Page init notice:', e); }
            }
          });
        }

        // 6. Refresh Lucide Icons & Scroll content area to top
        if (window.lucide) lucide.createIcons();
        contentArea.scrollTop = 0;

        // 7. Smoothly reveal content once loaded
        if (typeof window.__revealPage === 'function') {
          window.__revealPage();
        } else {
          if (overlay) overlay.classList.add('hidden');
          if (innerContainer) innerContainer.classList.add('revealed');
        }
      } else {
        window.location.href = url;
      }
    } catch (err) {
      window.location.href = url;
    }
  }

  function capitalize(str) {
    if (!str) return '';
    return str.split('-').map(function(p) {
      return p.charAt(0).toUpperCase() + p.slice(1);
    }).join('');
  }

  function loadCSS(href) {
    if (loadedCSS[href]) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
    loadedCSS[href] = true;
  }

  function loadJS(src, callback) {
    var cleanSrc = src.split('?')[0] + '?t=' + Date.now();
    var script = document.createElement('script');
    script.src = cleanSrc;
    script.onload = function() {
      if (callback) callback();
    };
    document.body.appendChild(script);
  }

  function updateSidebarActive(page) {
    document.querySelectorAll('.nav-item').forEach(function(el) {
      var href = el.getAttribute('href');
      if (!href) return;
      
      var pageFromHref = href.replace('/', '');
      if (pageFromHref === '') pageFromHref = 'dashboard';

      if (pageFromHref === page) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    });
  }

  function updateBreadcrumb(page) {
    var container = document.getElementById('breadcrumbs-container');
    if (!container) return;

    var section = 'Overview';
    var pageTitle = page;

    if (['repositories', 'branches', 'change-requests', 'file-browser'].indexOf(page) !== -1) {
      section = 'Source';
    } else if (['approvals', 'build-history', 'scaling', 'beta-environment', 'release'].indexOf(page) !== -1) {
      section = 'Deployment';
    } else if (['monitoring', 'audit-logs', 'pipelines'].indexOf(page) !== -1) {
      section = 'Overview';
    } else {
      section = '';
    }

    if (page === 'repositories') pageTitle = 'Repositories';
    else if (page === 'branches') pageTitle = 'Branches';
    else if (page === 'change-requests') pageTitle = 'Change Requests';
    else if (page === 'file-browser') pageTitle = 'File Browser';
    else if (page === 'approvals') pageTitle = 'Approvals';
    else if (page === 'build-history') pageTitle = 'Build History';
    else if (page === 'scaling') pageTitle = 'Auto-scaling';
    else if (page === 'beta-environment') pageTitle = 'Beta Environment';
    else if (page === 'release') pageTitle = 'Release';
    else if (page === 'monitoring') pageTitle = 'Monitoring';
    else if (page === 'audit-logs') pageTitle = 'Audit Logs';
    else if (page === 'pipelines') pageTitle = 'Pipelines';
    else if (page === 'dashboard') pageTitle = 'Dashboard';
    else if (page === 'settings') pageTitle = 'Settings';
    else if (page === 'setup-wizard') pageTitle = 'Setup Wizard';
    else if (page === 'team-access') pageTitle = 'Team Access';

    if (section) {
      container.innerHTML =
        '<span style="color:var(--color-text-secondary);font-size:13px;">' + section + '</span>' +
        '<span style="color:var(--color-text-tertiary);margin:0 6px;">&gt;</span>' +
        '<span style="color:var(--color-text-primary);font-weight:600;font-size:13px;">' + pageTitle + '</span>';
    } else {
      container.innerHTML =
        '<span class="breadcrumb-item" style="color:var(--color-text-primary);font-weight:600;font-size:13px;">' + pageTitle + '</span>';
    }
  }

  // Export globally
  window.spaRouter = {
    navigateTo: navigateTo
  };
})();
