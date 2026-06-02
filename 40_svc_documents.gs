/**
 * 40_svc_documents.gs  —  Hass CMS rebuild  (Stage 5F)
 *
 * KYC document management for customers.
 * Scoped to customer country. file_url stored externally (GDrive).
 */

var Documents = (function () {

  function _scopeCustomer_(session, customerId) {
    var rows = TursoClient.select(
      'SELECT country_code FROM customers WHERE customer_id = ? LIMIT 1',
      [customerId]
    );
    if (!rows.length) throw new Errors.NotFound('Customer not found.');
    var cc = rows[0].country_code;

    var scopeRows = TursoClient.select(
      'SELECT scope FROM roles WHERE role_code = ? LIMIT 1',
      [session.role || '']
    );
    var isGlobal = scopeRows.length &&
                   String(scopeRows[0].scope || '').toUpperCase() === 'GLOBAL';
    if (isGlobal) return cc;

    var allowed = [session.countryCode || ''];
    try {
      var uRows = TursoClient.select(
        'SELECT countries_access FROM users WHERE user_id = ? LIMIT 1',
        [session.userId]
      );
      if (uRows.length && uRows[0].countries_access) {
        String(uRows[0].countries_access).split(',').forEach(function (c) {
          var t = c.trim();
          if (t && allowed.indexOf(t) === -1) allowed.push(t);
        });
      }
    } catch (_) {}

    if (allowed.indexOf(cc) === -1) throw new Errors.NotFound('Customer not found.');
    return cc;
  }

  // ── country scope (for unfiltered listing) ────────────────────────────────────

  function _scopeData_(session) {
    if (!session) return { isGlobal: false, countries: [] };
    var isGlobal = false;
    try {
      var r = TursoClient.select(
        'SELECT scope FROM roles WHERE role_code = ? LIMIT 1', [session.role || '']
      );
      isGlobal = r.length && String(r[0].scope || '').toUpperCase() === 'GLOBAL';
    } catch (_) {}
    if (isGlobal) return { isGlobal: true, countries: [] };
    var countries = [String(session.countryCode || '').trim()].filter(Boolean);
    try {
      var u = TursoClient.select(
        'SELECT countries_access FROM users WHERE user_id = ? LIMIT 1', [session.userId]
      );
      if (u.length && u[0].countries_access) {
        String(u[0].countries_access).split(',').forEach(function (c) {
          var t = c.trim();
          if (t && countries.indexOf(t) === -1) countries.push(t);
        });
      }
    } catch (_) {}
    return { isGlobal: false, countries: countries };
  }

  // ── list ─────────────────────────────────────────────────────────────────────
  //
  // KYC Documents page calls documents.list with no customerId → return all
  // documents within the caller's country scope. A specific customerId narrows
  // to that customer (after the existing per-customer scope check).
  function _list_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'customer.view');
    var customerId = String(params.customerId || params.customer_id || '');

    if (customerId) {
      _scopeCustomer_(ctx.session, customerId);
      var sql  = 'SELECT d.*, c.country_code FROM documents d ' +
                 'LEFT JOIN customers c ON c.customer_id = d.customer_id ' +
                 'WHERE d.customer_id = ?';
      var args = [customerId];
      if (params.document_type) { sql += ' AND d.document_type = ?'; args.push(params.document_type); }
      if (params.status)        { sql += ' AND d.status = ?';        args.push(params.status); }
      sql += ' ORDER BY d.issue_date DESC';
      return TursoClient.select(sql, args);
    }

    var scope = _scopeData_(ctx.session);
    var sql2  = 'SELECT d.*, c.country_code FROM documents d ' +
                'LEFT JOIN customers c ON c.customer_id = d.customer_id WHERE 1=1';
    var args2 = [];
    if (!scope.isGlobal) {
      if (!scope.countries.length) return [];
      var ph = scope.countries.map(function () { return '?'; }).join(',');
      sql2 += ' AND c.country_code IN (' + ph + ')';
      args2 = args2.concat(scope.countries);
    }
    if (params.document_type) { sql2 += ' AND d.document_type = ?'; args2.push(params.document_type); }
    if (params.status)        { sql2 += ' AND d.status = ?';        args2.push(params.status); }
    sql2 += ' ORDER BY d.issue_date DESC LIMIT ' + (parseInt(params.limit, 10) || 100);
    return TursoClient.select(sql2, args2);
  }

  // ── get ──────────────────────────────────────────────────────────────────────

  function _get_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'customer.view');
    var docId = String(params.documentId || '');
    if (!docId) throw new Errors.Validation('documentId required.');
    var rows = TursoClient.select(
      'SELECT * FROM documents WHERE document_id = ? LIMIT 1', [docId]
    );
    if (!rows.length) throw new Errors.NotFound('Document not found.');
    _scopeCustomer_(ctx.session, rows[0].customer_id);
    return rows[0];
  }

  // ── upload (create) ───────────────────────────────────────────────────────────

  function _upload_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'customer.manage');
    var customerId    = String(params.customerId    || '');
    var documentType  = String(params.document_type || '').trim().toUpperCase();
    var fileName      = String(params.file_name     || '').trim();
    var fileUrl       = String(params.file_url      || '').trim();
    if (!customerId)   throw new Errors.Validation('customerId required.');
    if (!documentType) throw new Errors.Validation('document_type required.');
    if (!fileName)     throw new Errors.Validation('file_name required.');
    if (!fileUrl)      throw new Errors.Validation('file_url required.');

    _scopeCustomer_(ctx.session, customerId);
    var documentId = genId('DOC');
    var now        = nowIso();

    TursoClient.write(
      'INSERT INTO documents ' +
      '(document_id, customer_id, document_type, file_name, file_url, mime_type, ' +
      'expiry_date, status, uploaded_by, created_at, updated_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [
        documentId, customerId, documentType, fileName, fileUrl,
        String(params.mime_type   || ''),
        params.expiry_date        || null,
        'PENDING_REVIEW',
        ctx.session.userId,
        now, now,
      ]
    );

    Audit.log({
      actor: ctx.session.userId, action: 'DOCUMENT_UPLOADED',
      entity: 'documents', entityId: documentId,
      after: { customer_id: customerId, document_type: documentType, file_name: fileName },
    });
    return { document_id: documentId, status: 'PENDING_REVIEW' };
  }

  // ── verify ───────────────────────────────────────────────────────────────────

  function _verify_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'customer.manage');
    var docId  = String(params.documentId || '');
    var action = String(params.action     || '').toUpperCase(); // APPROVE | REJECT
    if (!docId)  throw new Errors.Validation('documentId required.');
    if (action !== 'APPROVE' && action !== 'REJECT') {
      throw new Errors.Validation('action must be APPROVE or REJECT.');
    }
    var rows = TursoClient.select(
      'SELECT * FROM documents WHERE document_id = ? LIMIT 1', [docId]
    );
    if (!rows.length) throw new Errors.NotFound('Document not found.');
    var before = rows[0];
    _scopeCustomer_(ctx.session, before.customer_id);

    var newStatus = action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    var now       = nowIso();
    TursoClient.write(
      'UPDATE documents SET status = ?, verified_by = ?, verified_at = ?, ' +
      'rejection_reason = ?, updated_at = ? WHERE document_id = ?',
      [newStatus, ctx.session.userId, now,
       action === 'REJECT' ? String(params.rejection_reason || '') : null,
       now, docId]
    );

    Audit.log({
      actor: ctx.session.userId, action: 'DOCUMENT_' + action + 'D',
      entity: 'documents', entityId: docId,
      before: before, after: { status: newStatus, verified_by: ctx.session.userId },
    });
    return { success: true, status: newStatus };
  }

  return { _list_: _list_, _get_: _get_, _upload_: _upload_, _verify_: _verify_ };

})();

// ── Registration ──────────────────────────────────────────────────────────────

(function _registerDocuments_() {
  register({ service: 'documents', action: 'list',   permission: 'customer.view',   handler: Documents._list_ });
  register({ service: 'documents', action: 'get',    permission: 'customer.view',   handler: Documents._get_ });
  register({ service: 'documents', action: 'upload', permission: 'customer.manage', handler: Documents._upload_ });
  register({ service: 'documents', action: 'verify', permission: 'customer.manage', handler: Documents._verify_ });
})();
