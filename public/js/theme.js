// public/js/theme.js — 4-Palette Multi-Theme System
(function() {
  var PALETTES = ['indigo', 'crimson', 'monolith', 'sandstone'];
  var PALETTE_ICONS = {
    sandstone: 'sun',
    indigo: 'moon',
    crimson: 'sparkles',
    monolith: 'box'
  };

  function getPreferredPalette() {
    try {
      var savedPalette = localStorage.getItem('benevolate-palette');
      if (savedPalette && PALETTES.indexOf(savedPalette) !== -1) return savedPalette;
      var savedTheme = localStorage.getItem('benevolate-theme');
      if (savedTheme === 'light') return 'sandstone';
    } catch(e) {}
    return 'indigo';
  }

  function updateIcon(palette) {
    var btn = document.getElementById('btn-theme-toggle');
    if (!btn) return;
    var iconName = PALETTE_ICONS[palette] || 'moon';
    btn.setAttribute('title', 'Theme: ' + palette.charAt(0).toUpperCase() + palette.slice(1) + ' (click to switch)');
    btn.innerHTML = '<i data-lucide="' + iconName + '" style="width:18px;height:18px;"></i>';
    if (window.lucide) lucide.createIcons();
  }

  function applyPalette(palette) {
    var theme = palette === 'sandstone' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-palette', palette);
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('benevolate-palette', palette);
      localStorage.setItem('benevolate-theme', theme);
    } catch(e) {}
    updateIcon(palette);
  }

  // Apply on load
  var currentPalette = getPreferredPalette();
  applyPalette(currentPalette);

  document.addEventListener('DOMContentLoaded', function() {
    updateIcon(document.documentElement.getAttribute('data-palette') || 'indigo');
  });

  // Expose toggle for topbar button
  window.toggleTheme = function() {
    var active = document.documentElement.getAttribute('data-palette') || 'indigo';
    var nextIdx = (PALETTES.indexOf(active) + 1) % PALETTES.length;
    var nextPalette = PALETTES[nextIdx];
    applyPalette(nextPalette);
  };

  window.setPalette = function(palette) {
    if (PALETTES.indexOf(palette) !== -1) {
      applyPalette(palette);
    }
  };
})();
