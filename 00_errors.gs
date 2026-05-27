/**
 * 00_errors.gs  —  Hass CMS rebuild foundation
 *
 * Custom error hierarchy. Each class carries a stable `code` string that
 * clients can switch on without parsing the message text.
 *
 * Hierarchy:
 *   Error
 *   └─ AppError              (code: 'APP_ERROR')
 *      ├─ PermissionDeniedError  (code: 'PERMISSION_DENIED')
 *      ├─ NotFoundError          (code: 'NOT_FOUND')
 *      ├─ ValidationError        (code: 'VALIDATION_ERROR')
 *      └─ IntegrationError       (code: 'INTEGRATION_ERROR')
 */

class AppError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AppError';
    this.code = code || 'APP_ERROR';
  }
}

class PermissionDeniedError extends AppError {
  constructor(message) {
    super(message || 'Permission denied', 'PERMISSION_DENIED');
    this.name = 'PermissionDeniedError';
  }
}

class NotFoundError extends AppError {
  constructor(message) {
    super(message || 'Not found', 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

class ValidationError extends AppError {
  constructor(message) {
    super(message || 'Validation failed', 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}

class IntegrationError extends AppError {
  constructor(message) {
    super(message || 'Integration error', 'INTEGRATION_ERROR');
    this.name = 'IntegrationError';
  }
}
