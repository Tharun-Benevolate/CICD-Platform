// public/js/theme.js — Dark/Light theme toggle
(function() {
  function getPreferred() {
    const saved = localStorage.getItem('benevolate-theme');
    if (saved) return saved;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function updateIcon(theme) {
    // Run after DOM ready so lucide icons exist
    var btn = document.getElementById('btn-theme-toggle');
    if (!btn) return;
    // In dark mode, show moon (current = dark). In light mode, show sun (current = light).
    btn.innerHTML = theme === 'dark'
      ? '<i data-lucide="moon" style="width:18px;height:18px;"></i>'
      : '<i data-lucide="sun" style="width:18px;height:18px;"></i>';
    if (window.lucide) lucide.createIcons();
  }

  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('benevolate-theme', theme);
    updateIcon(theme);
  }

  // Apply on load
  apply(getPreferred());

  // Re-run icon update after DOM is ready (lucide may not be loaded yet)
  document.addEventListener('DOMContentLoaded', function() {
    updateIcon(document.documentElement.getAttribute('data-theme') || 'dark');
  });

  // Expose toggle for topbar button
  window.toggleTheme = function() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    apply(current === 'dark' ? 'light' : 'dark');
  };
})();
