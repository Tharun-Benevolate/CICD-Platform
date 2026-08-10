// public/js/api.js — Vanilla JS API client (no imports/exports)
const api = (function() {
  async function request(path, options = {}) {
    const { method = 'GET', body, headers: extraHeaders = {} } = options;
    const headers = {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...extraHeaders,
    };
    const res = await fetch(path, {
      method,
      headers,
      credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
    });
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      if (!res.ok) throw new Error('Request failed: ' + res.status);
      return { ok: true, status: res.status, raw: res };
    }
    const data = await res.json();
    if (res.status === 401 && data.sessionExpired) {
      window.location.href = '/login';
    }
    return data;
  }
  return {
    get:    (path)       => request(path),
    post:   (path, body) => request(path, { method: 'POST', body }),
    put:    (path, body) => request(path, { method: 'PUT', body }),
    patch:  (path, body) => request(path, { method: 'PATCH', body }),
    delete: (path, body) => request(path, { method: 'DELETE', body }),
  };
})();
