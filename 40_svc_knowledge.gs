/**
 * 40_svc_knowledge.gs  —  Hass CMS rebuild  (Stage 5F)
 *
 * Knowledge base articles and categories.
 *
 * knowledge.{listCategories, createCategory, updateCategory,
 *            list, get, create, update, publish, archive}
 *
 * Tables:
 *   knowledge_categories (category_id, name, slug, parent_id,
 *                         country_code, created_at, updated_at)
 *   knowledge_articles   (article_id, category_id, title, slug, content,
 *                         summary, status, view_count, country_code,
 *                         created_by, published_at, created_at, updated_at)
 *
 * Country scope: articles with country_code='' are global (visible to all).
 * Articles in a specific country are only visible in that scope.
 */

// ── Scope helper ───────────────────────────────────────────────────────────────

function _knowledgeScopeData_(session) {
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

function _slugify_(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ── knowledge.listCategories ──────────────────────────────────────────────────

function _knListCategories_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var sql  = 'SELECT * FROM knowledge_categories ORDER BY name';
  return TursoClient.select(sql, []);
}

// ── knowledge.createCategory ──────────────────────────────────────────────────

function _knCreateCategory_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var name        = String(params.name        || '').trim();
  var countryCode = String(params.country_code || '').trim();
  var parentId    = String(params.parent_id   || '').trim() || null;
  if (!name) throw new Errors.Validation('name required.');
  var categoryId = genId('KBC');
  var slug       = _slugify_(name);
  var now        = nowIso();
  TursoClient.write(
    'INSERT INTO knowledge_categories (category_id, name, slug, parent_id, country_code, created_at, updated_at) ' +
    'VALUES (?,?,?,?,?,?,?)',
    [categoryId, name, slug, parentId, countryCode, now, now]
  );
  Audit.log({
    actor: ctx.session.userId, action: 'KNOWLEDGE_CATEGORY_CREATED',
    entity: 'knowledge_categories', entityId: categoryId,
    after: { name: name, country_code: countryCode },
  });
  return { category_id: categoryId, name: name, slug: slug };
}

// ── knowledge.updateCategory ──────────────────────────────────────────────────

function _knUpdateCategory_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var categoryId = String(params.categoryId || '');
  if (!categoryId) throw new Errors.Validation('categoryId required.');
  var rows = TursoClient.select('SELECT * FROM knowledge_categories WHERE category_id = ? LIMIT 1', [categoryId]);
  if (!rows.length) throw new Errors.NotFound('Category not found.');
  var before = rows[0];
  var allowed = ['name', 'parent_id', 'country_code'];
  var setParts = []; var args = [];
  allowed.forEach(function (col) {
    if (params[col] !== undefined) { setParts.push(col + ' = ?'); args.push(params[col]); }
  });
  if (params.name) { setParts.push('slug = ?'); args.push(_slugify_(params.name)); }
  if (!setParts.length) throw new Errors.Validation('No updatable fields.');
  var now = nowIso();
  setParts.push('updated_at = ?'); args.push(now); args.push(categoryId);
  TursoClient.write('UPDATE knowledge_categories SET ' + setParts.join(', ') + ' WHERE category_id = ?', args);
  Audit.log({
    actor: ctx.session.userId, action: 'KNOWLEDGE_CATEGORY_UPDATED',
    entity: 'knowledge_categories', entityId: categoryId,
    before: before, after: params,
  });
  return { success: true, category_id: categoryId };
}

// ── knowledge.list ────────────────────────────────────────────────────────────

function _knList_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var scope  = _knowledgeScopeData_(ctx.session);
  var sql    = 'SELECT ka.*, kc.name AS category_name FROM knowledge_articles ka ' +
               'LEFT JOIN knowledge_categories kc ON kc.category_id = ka.category_id ' +
               'WHERE 1=1';
  var args   = [];

  if (!scope.isGlobal && scope.countries.length) {
    var ph = scope.countries.map(function () { return '?'; }).join(',');
    sql += " AND (ka.country_code IN (" + ph + ") OR ka.country_code = '' OR ka.country_code IS NULL)";
    args = args.concat(scope.countries);
  }
  if (params.status)      { sql += ' AND ka.status = ?';      args.push(params.status); }
  if (params.category_id) { sql += ' AND ka.category_id = ?'; args.push(params.category_id); }
  if (params.search)      {
    sql += ' AND (ka.title LIKE ? OR ka.summary LIKE ?)';
    var q = '%' + params.search + '%';
    args.push(q, q);
  }
  sql += ' ORDER BY ka.created_at DESC LIMIT ' + (parseInt(params.limit, 10) || 50);
  return TursoClient.select(sql, args);
}

// ── knowledge.get ─────────────────────────────────────────────────────────────

function _knGet_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var articleId = String(params.articleId || '');
  if (!articleId) throw new Errors.Validation('articleId required.');
  var rows = TursoClient.select(
    'SELECT ka.*, kc.name AS category_name FROM knowledge_articles ka ' +
    'LEFT JOIN knowledge_categories kc ON kc.category_id = ka.category_id ' +
    'WHERE ka.article_id = ? LIMIT 1',
    [articleId]
  );
  if (!rows.length) throw new Errors.NotFound('Article not found.');
  var article = rows[0];
  var scope   = _knowledgeScopeData_(ctx.session);
  if (!scope.isGlobal && article.country_code &&
      scope.countries.indexOf(article.country_code) === -1) {
    throw new Errors.NotFound('Article not found.');
  }
  // Increment view count.
  try {
    TursoClient.write(
      'UPDATE knowledge_articles SET view_count = COALESCE(view_count,0)+1 WHERE article_id = ?',
      [articleId]
    );
  } catch (_) {}
  return article;
}

// ── knowledge.create ──────────────────────────────────────────────────────────

function _knCreate_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var title       = String(params.title       || '').trim();
  var content     = String(params.content     || '').trim();
  var summary     = String(params.summary     || '').trim();
  var categoryId  = String(params.category_id || '').trim() || null;
  var countryCode = String(params.country_code || '').trim();
  if (!title)   throw new Errors.Validation('title required.');
  if (!content) throw new Errors.Validation('content required.');

  var articleId = genId('KBA');
  var slug      = _slugify_(title);
  var now       = nowIso();
  TursoClient.write(
    'INSERT INTO knowledge_articles ' +
    '(article_id, category_id, title, slug, content, summary, status, view_count, ' +
    'country_code, created_by, created_at, updated_at) ' +
    'VALUES (?,?,?,?,?,?,?,0,?,?,?,?)',
    [articleId, categoryId, title, slug, content, summary, 'DRAFT',
     countryCode, ctx.session.userId, now, now]
  );
  Audit.log({
    actor: ctx.session.userId, action: 'KNOWLEDGE_ARTICLE_CREATED',
    entity: 'knowledge_articles', entityId: articleId,
    after: { title: title, status: 'DRAFT', country_code: countryCode },
  });
  return { article_id: articleId, title: title, slug: slug, status: 'DRAFT' };
}

// ── knowledge.update ──────────────────────────────────────────────────────────

function _knUpdate_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var articleId = String(params.articleId || '');
  if (!articleId) throw new Errors.Validation('articleId required.');
  var rows = TursoClient.select('SELECT * FROM knowledge_articles WHERE article_id = ? LIMIT 1', [articleId]);
  if (!rows.length) throw new Errors.NotFound('Article not found.');
  var before  = rows[0];
  var allowed = ['title', 'content', 'summary', 'category_id', 'country_code'];
  var setParts = []; var args = [];
  allowed.forEach(function (col) {
    if (params[col] !== undefined) { setParts.push(col + ' = ?'); args.push(params[col]); }
  });
  if (params.title) { setParts.push('slug = ?'); args.push(_slugify_(params.title)); }
  if (!setParts.length) throw new Errors.Validation('No updatable fields.');
  var now = nowIso();
  setParts.push('updated_at = ?'); args.push(now); args.push(articleId);
  TursoClient.write('UPDATE knowledge_articles SET ' + setParts.join(', ') + ' WHERE article_id = ?', args);
  Audit.log({
    actor: ctx.session.userId, action: 'KNOWLEDGE_ARTICLE_UPDATED',
    entity: 'knowledge_articles', entityId: articleId,
    before: before, after: params,
  });
  return { success: true, article_id: articleId };
}

// ── knowledge.publish ─────────────────────────────────────────────────────────

function _knPublish_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var articleId = String(params.articleId || '');
  if (!articleId) throw new Errors.Validation('articleId required.');
  var rows = TursoClient.select('SELECT * FROM knowledge_articles WHERE article_id = ? LIMIT 1', [articleId]);
  if (!rows.length) throw new Errors.NotFound('Article not found.');
  var before = rows[0];
  if (before.status === 'PUBLISHED') throw new Errors.Validation('Article is already published.');
  var now = nowIso();
  TursoClient.write(
    'UPDATE knowledge_articles SET status = ?, published_at = ?, updated_at = ? WHERE article_id = ?',
    ['PUBLISHED', now, now, articleId]
  );
  Audit.log({
    actor: ctx.session.userId, action: 'KNOWLEDGE_ARTICLE_PUBLISHED',
    entity: 'knowledge_articles', entityId: articleId,
    before: { status: before.status }, after: { status: 'PUBLISHED' },
  });
  return { success: true, status: 'PUBLISHED' };
}

// ── knowledge.archive ─────────────────────────────────────────────────────────

function _knArchive_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var articleId = String(params.articleId || '');
  if (!articleId) throw new Errors.Validation('articleId required.');
  var rows = TursoClient.select('SELECT * FROM knowledge_articles WHERE article_id = ? LIMIT 1', [articleId]);
  if (!rows.length) throw new Errors.NotFound('Article not found.');
  var before = rows[0];
  if (before.status === 'ARCHIVED') throw new Errors.Validation('Article is already archived.');
  var now = nowIso();
  TursoClient.write(
    'UPDATE knowledge_articles SET status = ?, updated_at = ? WHERE article_id = ?',
    ['ARCHIVED', now, articleId]
  );
  Audit.log({
    actor: ctx.session.userId, action: 'KNOWLEDGE_ARTICLE_ARCHIVED',
    entity: 'knowledge_articles', entityId: articleId,
    before: { status: before.status }, after: { status: 'ARCHIVED' },
  });
  return { success: true, status: 'ARCHIVED' };
}

// ── Registration ───────────────────────────────────────────────────────────────

(function _registerKnowledge_() {
  register({ service: 'knowledge', action: 'listCategories',  permission: 'order.view',   handler: _knListCategories_ });
  register({ service: 'knowledge', action: 'createCategory',  permission: 'order.manage', handler: _knCreateCategory_ });
  register({ service: 'knowledge', action: 'updateCategory',  permission: 'order.manage', handler: _knUpdateCategory_ });
  register({ service: 'knowledge', action: 'list',            permission: 'order.view',   handler: _knList_ });
  register({ service: 'knowledge', action: 'get',             permission: 'order.view',   handler: _knGet_ });
  register({ service: 'knowledge', action: 'create',          permission: 'order.manage', handler: _knCreate_ });
  register({ service: 'knowledge', action: 'update',          permission: 'order.manage', handler: _knUpdate_ });
  register({ service: 'knowledge', action: 'publish',         permission: 'order.manage', handler: _knPublish_ });
  register({ service: 'knowledge', action: 'archive',         permission: 'order.manage', handler: _knArchive_ });
})();
