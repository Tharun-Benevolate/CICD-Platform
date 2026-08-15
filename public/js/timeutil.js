/**
 * timeutil.js — Client-side timezone utility
 * Detects the user's local timezone automatically via Intl API or
 * respects user's explicit timezone preference (CST, IST, EST, PST, UTC).
 */
(function() {
  var _customTz = localStorage.getItem('user_timezone_pref') || 'Auto';

  var tzMap = {
    'Asia/Kolkata': 'IST',
    'Asia/Calcutta': 'IST',
    'America/Chicago': 'CST',
    'America/Indiana/Knox': 'CST',
    'America/New_York': 'EST',
    'America/Los_Angeles': 'PST',
    'America/Denver': 'MST',
    'Europe/London': 'GMT',
    'UTC': 'UTC',
    'CST': 'America/Chicago',
    'EST': 'America/New_York',
    'PST': 'America/Los_Angeles',
    'MST': 'America/Denver',
    'IST': 'Asia/Kolkata'
  };

  function getEffectiveTz() {
    var pref = localStorage.getItem('user_timezone_pref') || _customTz || 'Auto';
    if (pref && pref !== 'Auto') {
      return tzMap[pref] || pref;
    }
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }

  function getCleanTzAbbrev(tz) {
    var pref = localStorage.getItem('user_timezone_pref') || 'Auto';
    if (pref && pref !== 'Auto' && ['CST', 'EST', 'PST', 'MST', 'IST', 'UTC', 'GMT'].indexOf(pref) !== -1) {
      return pref;
    }

    var abbrevs = {
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
    if (abbrevs[tz]) return abbrevs[tz];

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

  function formatDateTime(ts) {
    if (!ts) return '';
    try {
      var d = new Date(ts);
      if (isNaN(d.getTime())) return String(ts);
      var effTz = getEffectiveTz();
      var abbrev = getCleanTzAbbrev(effTz);
      return d.toLocaleString('en-US', {
        timeZone: effTz,
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      }) + ' ' + abbrev;
    } catch(e) {
      return String(ts);
    }
  }

  function formatDate(ts) {
    if (!ts) return '';
    try {
      var d = new Date(ts);
      if (isNaN(d.getTime())) return String(ts);
      var effTz = getEffectiveTz();
      return d.toLocaleDateString('en-US', {
        timeZone: effTz,
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
    } catch(e) {
      return String(ts);
    }
  }

  function formatTime(ts) {
    if (!ts) return '';
    try {
      var d = new Date(ts);
      if (isNaN(d.getTime())) return '';
      var effTz = getEffectiveTz();
      var abbrev = getCleanTzAbbrev(effTz);
      return d.toLocaleTimeString('en-US', {
        timeZone: effTz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      }) + ' ' + abbrev;
    } catch(e) {
      return '';
    }
  }

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

  function setTimezonePref(pref) {
    localStorage.setItem('user_timezone_pref', pref || 'Auto');
    _customTz = pref || 'Auto';
  }

  window.TimeUtil = {
    getEffectiveTz: getEffectiveTz,
    formatDateTime: formatDateTime,
    formatDate: formatDate,
    formatTime: formatTime,
    relTime: relTime,
    setTimezonePref: setTimezonePref
  };
})();
