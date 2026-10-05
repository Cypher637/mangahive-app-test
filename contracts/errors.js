/**
 * MangaHive Phase 0 — Standard error model
 *
 * Never expose stack traces, SQL, tokens, or infrastructure details to clients.
 */

'use strict';

const ErrorCode = Object.freeze({
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  AUTHENTICATION_REQUIRED: 'AUTHENTICATION_REQUIRED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  SOURCE_ERROR: 'SOURCE_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
  EXTENSION_ERROR: 'EXTENSION_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

/**
 * @param {string} code
 * @param {string} message
 * @param {object} [details]
 * @param {string} [requestId]
 */
function apiError(code, message, details, requestId) {
  if (!ErrorCode[code] && !Object.values(ErrorCode).includes(code)) {
    code = ErrorCode.INTERNAL_ERROR;
  }
  const err = {
    code,
    message: String(message || 'An error occurred'),
  };
  if (details && typeof details === 'object') {
    // Strip any accidental sensitive keys
    const safe = { ...details };
    delete safe.stack;
    delete safe.sql;
    delete safe.token;
    delete safe.password;
    delete safe.service_role;
    err.details = safe;
  }
  if (requestId) err.requestId = String(requestId);
  return err;
}

function validationError(message, details, requestId) {
  return apiError(ErrorCode.VALIDATION_ERROR, message, details, requestId);
}
function authRequired(message, requestId) {
  return apiError(ErrorCode.AUTHENTICATION_REQUIRED, message || 'Authentication required', null, requestId);
}
function forbidden(message, requestId) {
  return apiError(ErrorCode.FORBIDDEN, message || 'Forbidden', null, requestId);
}
function notFound(message, requestId) {
  return apiError(ErrorCode.NOT_FOUND, message || 'Not found', null, requestId);
}
function conflict(message, details, requestId) {
  return apiError(ErrorCode.CONFLICT, message, details, requestId);
}
function rateLimited(message, retryAfterSeconds, requestId) {
  return apiError(
    ErrorCode.RATE_LIMITED,
    message || 'Rate limit exceeded',
    retryAfterSeconds != null ? { retryAfterSeconds } : null,
    requestId,
  );
}

module.exports = {
  ErrorCode,
  apiError,
  validationError,
  authRequired,
  forbidden,
  notFound,
  conflict,
  rateLimited,
};
