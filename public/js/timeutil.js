/**
 * timeutil.js — Client-side timezone utility
 * Detects the user's local timezone automatically via Intl API
 * and formats all timestamps in local time with a timezone label.
 */
(function() {
  // Detect the client's IANA timezone
  var _tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  var _tzAbbrev = '';

  // Compute clean timezone abbreviation (e.g. "IST", "CST", "EST", "PST", "UTC")
  function getCleanTzAbbrev(tz) {
    var tzMap = {
      'Asia/Kolkata': 'IST',
      'Asia/Calcutta': 'IST',
      'America/Chicago': 'CST',
      'America/Indiana/Knox': 'CST',
      'America/New_York': 'EST',
      'America/Los_Angeles': 'PST',
      'America/Denver': 'MST',
      'Europe/London': 'GMT',
      'UTC': 'UTC'
    };
    if (tzMap[tz]) return tzMap[tz];

    try {
      var raw = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        timeZoneName: 'short'
      }).formatToParts(new Date()).find(function(p) {
        return p.type === 'timeZoneName';
      }).value || '';

      if (raw === 'GMT+5:30' || raw === 'GMT+5.5') return 'IST';
      if (raw === 'GMT-6' || raw === 'GMT-5') return 'CST';
      if (raw.indexOf('GMT+') !== -1 || raw.indexOf('GMT-') !== -1) {
        if (raw.indexOf('+5:30') !== -1) return 'IST';
        if (raw.indexOf('-6') !== -1 || raw.indexOf('-5') !== -1) return 'CST';
      }
      return raw || tz;
    } catch(e) {
      return tz;
    }
  }

  var _tzAbbrev = getCleanTzAbbrev(_tz);

  /**
   * Format a timestamp (string or Date) as a full local datetime string
   * e.g. "Aug 7, 2026, 2:43 PM IST"
   */
  function formatDateTime(ts) {
    if (!ts) return '';
    try {
      var d = new Date(ts);
      if (isNaN(d.getTime())) return String(ts);
      return d.toLocaleString(undefined, {
        timeZone: _tz,
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      }) + ' ' + _tzAbbrev;
    } catch(e) {
      return String(ts);
    }
  }

  /**
   * Format a timestamp as date only e.g. "Aug 7, 2026"
   */
  function formatDate(ts) {
    if (!ts) return '';
    try {
      var d = new Date(ts);
      if (isNaN(d.getTime())) return String(ts);
      return d.toLocaleDateString(undefined, {
        timeZone: _tz,
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
    } catch(e) {
      return String(ts);
    }
  }

  /**
   * Format a timestamp as time only e.g. "2:43 PM IST"
   */
  function formatTime(ts) {
    if (!ts) return '';
    try {
      var d = new Date(ts);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleTimeString(undefined, {
        timeZone: _tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      }) + ' ' + _tzAbbrev;
    } catch(e) {
      return '';
    }
  }

  /**
   * Relative time: "2m ago", "3h ago", "2d ago" etc
   * Falls back to formatDateTime for older timestamps
   */
  function relTime(ts) {
    if (!ts) return '';
    try {
      var d = new Date(ts);
      var diff = Date.now() - d.getTime();
      var m = Math.floor(diff / 60000);
      if (m < 1) return 'just now';
      if (m < 60) return m + 'm ago';
      var h = Math.floor(m / 60);
      if (h < 24) return h + 'h ago';
      var days = Math.floor(h / 24);
      if (days < 7) return days + 'd ago';
      return formatDate(ts);
    } catch(e) {
      return '';
    }
  }

  // Expose globally
  window.TimeUtil = {
    tz: _tz,
    tzAbbrev: _tzAbbrev,
    formatDateTime: formatDateTime,
    formatDate: formatDate,
    formatTime: formatTime,
    relTime: relTime
  };
})();
