// backend/middleware/ipContext.js
// Captures HTTP request context in AsyncLocalStorage so logAction can always extract the client IP
const { AsyncLocalStorage } = require("async_hooks");
const asyncLocalStorage = new AsyncLocalStorage();

function ipContextMiddleware(req, res, next) {
  asyncLocalStorage.run(req, () => {
    next();
  });
}

function getStoreReq() {
  return asyncLocalStorage.getStore();
}

module.exports = {
  ipContextMiddleware,
  getStoreReq
};
