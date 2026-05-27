/**
 * 00_errors.gs  —  Hass CMS rebuild foundation
 *
 * Custom error hierarchy wrapped in the Errors namespace to avoid collisions
 * with legacy global error classes that remain until Stage 10 cutover.
 *
 * Hierarchy:
 *   Error
 *   └─ Errors.AppError              (code: 'APP_ERROR')
 *      ├─ Errors.PermissionDenied   (code: 'PERMISSION_DENIED')
 *      ├─ Errors.NotFound           (code: 'NOT_FOUND')
 *      ├─ Errors.Validation         (code: 'VALIDATION_ERROR')
 *      └─ Errors.Integration        (code: 'INTEGRATION_ERROR')
 *
 * Usage: throw new Errors.NotFound('User not found');
 */

var Errors = (function () {

  class AppError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'AppError';
      this.code = code || 'APP_ERROR';
    }
  }

  class PermissionDenied extends AppError {
    constructor(message) {
      super(message || 'Permission denied', 'PERMISSION_DENIED');
      this.name = 'PermissionDenied';
    }
  }

  class NotFound extends AppError {
    constructor(message) {
      super(message || 'Not found', 'NOT_FOUND');
      this.name = 'NotFound';
    }
  }

  class Validation extends AppError {
    constructor(message) {
      super(message || 'Validation failed', 'VALIDATION_ERROR');
      this.name = 'Validation';
    }
  }

  class Integration extends AppError {
    constructor(message) {
      super(message || 'Integration error', 'INTEGRATION_ERROR');
      this.name = 'Integration';
    }
  }

  return { AppError: AppError, PermissionDenied: PermissionDenied,
           NotFound: NotFound, Validation: Validation, Integration: Integration };

})();
