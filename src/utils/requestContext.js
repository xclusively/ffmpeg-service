// ARCH-009 — per-request correlation context.
//
// An AsyncLocalStorage store scoped to one HTTP request. The requestId middleware
// seeds it; the logger reads it so every existing logger.* call is stamped with the
// request id automatically, with no call-site changes. The store survives across
// awaits/callbacks for the life of the request.

const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

/** Run `fn` (and everything it awaits) with the given context in scope. */
function runWithContext(ctx, fn) {
  return als.run(ctx, fn);
}

/** Current request id, or undefined when outside a request (e.g. startup logs). */
function getRequestId() {
  return als.getStore()?.requestId;
}

module.exports = { als, runWithContext, getRequestId };
