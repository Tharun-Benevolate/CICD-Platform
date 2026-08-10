// public/js/auth.js — Vanilla JS auth state management
const auth = (function() {
  let currentUser = (typeof window !== 'undefined' && window.__USER__) ? window.__USER__ : null;

  async function checkSession() {
    try {
      const res = await api.get('/api/me');
      if (res.ok) {
        currentUser = {
          username: res.username,
          userType: res.userType,
          email: res.email,
          jobTitle: res.jobTitle || null,
          isProfileCompleted: res.isProfileCompleted === 1 || res.isProfileCompleted === true,
          totpEnabled: !!res.totpEnabled
        };
        window.__USER__ = currentUser;
        return currentUser;
      }
    } catch (e) {
      // Not logged in
    }
    currentUser = null;
    return null;
  }


  async function login(username, password) {
    try {
      const res = await api.post('/api/login', { username, password });
      if (res.ok) {
        if (res.require2FA) {
          return { ok: true, require2FA: true, tempToken: res.tempToken, username: res.username };
        }
        currentUser = {
          username: res.username,
          userType: res.userType,
          email: res.email,
          jobTitle: res.jobTitle || null,
          isProfileCompleted: res.isProfileCompleted === 1 || res.isProfileCompleted === true,
          totpEnabled: !!res.totpEnabled
        };
        return { ok: true, isProfileCompleted: currentUser.isProfileCompleted };
      }
      return { ok: false, error: res.error || 'Login failed' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async function loginWithGoogle(credential) {
    try {
      const res = await api.post('/api/auth/google', { credential });
      if (res.ok) {
        if (res.require2FA) {
          return { ok: true, require2FA: true, tempToken: res.tempToken, username: res.username };
        }
        currentUser = {
          username: res.username,
          userType: res.userType,
          email: res.email,
          jobTitle: res.jobTitle || null,
          isProfileCompleted: res.isProfileCompleted === 1 || res.isProfileCompleted === true,
          totpEnabled: !!res.totpEnabled
        };
        return { ok: true, isProfileCompleted: currentUser.isProfileCompleted };
      }
      return { ok: false, error: res.error || 'Google login failed' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async function verify2FA(tempToken, code) {
    try {
      const res = await api.post('/api/auth/2fa/verify-login', { tempToken, code });
      if (res.ok) {
        currentUser = {
          username: res.username,
          userType: res.userType,
          email: res.email,
          jobTitle: res.jobTitle || null,
          isProfileCompleted: res.isProfileCompleted === 1 || res.isProfileCompleted === true,
          totpEnabled: true
        };
        return { ok: true, isProfileCompleted: currentUser.isProfileCompleted };
      }
      return { ok: false, error: res.error || '2FA verification failed' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async function logout() {
    await api.post('/api/logout');
    currentUser = null;
    window.location.href = '/login';
  }

  function getUser() {
    return currentUser || (typeof window !== 'undefined' && window.__USER__) || null;
  }

  const ROLE_HIERARCHY = ['sales', 'developer', 'devops', 'admin', 'super_admin'];
  const ADMIN_ROLES = ['super_admin', 'admin', 'devops'];

  function hasRole(minRole) {
    const user = getUser();
    if (!user) return false;
    if (user.userType === 'admin' || user.userType === 'super_admin') return true;
    const userLevel = ROLE_HIERARCHY.indexOf(user.userType);
    const requiredLevel = ROLE_HIERARCHY.indexOf(minRole);
    return userLevel >= requiredLevel;
  }

  function isAdmin() {
    const user = getUser();
    return user ? ADMIN_ROLES.includes(user.userType) : false;
  }

  return { checkSession, login, loginWithGoogle, verify2FA, logout, getUser, hasRole, isAdmin };
})();

