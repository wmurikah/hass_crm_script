/**
 * HASS PETROLEUM CMS - KNOWLEDGE SERVICE
 * Version: 1.0.0
 * 
 * Handles:
 * - Knowledge base categories and articles
 * - Article search and retrieval
 * - Article versioning and publishing
 * - View tracking and analytics
 * - Related articles suggestions
 * - FAQ management
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

var KNOWLEDGE_CONFIG = {
  MAX_SEARCH_RESULTS: 50,
  EXCERPT_LENGTH: 200,
  MIN_SEARCH_LENGTH: 2,
  POPULAR_ARTICLES_LIMIT: 10,
  RELATED_ARTICLES_LIMIT: 5,
};

// ============================================================================
// CATEGORY MANAGEMENT
// ============================================================================

/**
 * Gets all active categories.
 * @param {boolean} includeArticleCounts - Whether to include article counts
 * @returns {Object} Categories list
 */
function getCategories(includeArticleCounts = false) {
  try {
    const categories = getCachedSheetData('KnowledgeCategories')
      .filter(c => c.is_active !== false)
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    
    if (includeArticleCounts) {
      const articles = getSheetData('KnowledgeArticles');
      
      for (const category of categories) {
        category.articleCount = articles.filter(a => 
          a.category_id === category.category_id && 
          a.status === 'PUBLISHED'
        ).length;
      }
    }
    
    return {
      success: true,
      data: categories,
    };
    
  } catch (e) {
    Logger.log('getCategories error: ' + e.message);
    return { success: false, error: 'Failed to get categories' };
  }
}

/**
 * Gets a category with its articles.
 * @param {string} categoryId - Category ID
 * @param {Object} options - Query options
 * @returns {Object} Category with articles
 */
function getCategoryWithArticles(categoryId, options = {}) {
  try {
    const category = getCachedSheetData('KnowledgeCategories')
      .find(c => c.category_id === categoryId);
    
    if (!category) {
      return { success: false, error: 'Category not found' };
    }
    
    // Get published articles in this category
    const conditions = {
      category_id: categoryId,
      status: 'PUBLISHED',
    };
    
    // Filter by audience if specified
    if (options.audience) {
      conditions.audience = [options.audience, 'ALL'];
    }
    
    const articles = findWhere('KnowledgeArticles', conditions, {
      sortBy: options.sortBy || 'sort_order',
      sortOrder: options.sortOrder || 'asc',
      limit: options.limit || 50,
    });
    
    // Add excerpts to articles
    if (articles.data) {
      articles.data = articles.data.map(article => ({
        ...article,
        excerpt: createExcerpt(article.content_text, KNOWLEDGE_CONFIG.EXCERPT_LENGTH),
        content: undefined, // Don't send full content in list
        content_html: undefined,
        content_text: undefined,
      }));
    }
    
    return {
      success: true,
      category: category,
      articles: articles.data || [],
      total: articles.total || 0,
    };
    
  } catch (e) {
    Logger.log('getCategoryWithArticles error: ' + e.message);
    return { success: false, error: 'Failed to get category' };
  }
}

/**
 * Creates a new category.
 * @param {Object} data - Category data
 * @param {Object} context - Actor context
 * @returns {Object} Created category
 */
function createCategory(data, context) {
  try {
    if (!data.name) {
      return { success: false, error: 'Category name is required' };
    }
    
    // Check for duplicate name
    const existing = getCachedSheetData('KnowledgeCategories')
      .find(c => c.name.toLowerCase() === data.name.toLowerCase());
    
    if (existing) {
      return { success: false, error: 'A category with this name already exists' };
    }
    
    const categoryId = generateId('KCAT');
    const now = new Date();
    
    // Get max sort order
    const categories = getCachedSheetData('KnowledgeCategories');
    const maxOrder = Math.max(...categories.map(c => c.sort_order || 0), 0);
    
    const category = {
      category_id: categoryId,
      name: data.name,
      slug: createSlug(data.name),
      description: data.description || '',
      icon: data.icon || 'folder',
      parent_id: data.parent_id || '',
      sort_order: data.sort_order || maxOrder + 1,
      audience: data.audience || 'ALL',
      is_active: true,
      created_by: context.actorId || '',
      created_at: now,
      updated_at: now,
    };
    
    appendRow('KnowledgeCategories', category);
    clearSheetCache('KnowledgeCategories');
    
    logAudit('KnowledgeCategory', categoryId, 'CREATE', 
      context.actorType, context.actorId, context.actorEmail,
      { name: data.name }, {});
    
    return {
      success: true,
      categoryId: categoryId,
    };
    
  } catch (e) {
    Logger.log('createCategory error: ' + e.message);
    return { success: false, error: 'Failed to create category' };
  }
}

/**
 * Updates a category.
 * @param {string} categoryId - Category ID
 * @param {Object} updates - Fields to update
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function updateCategory(categoryId, updates, context) {
  try {
    const category = getCachedSheetData('KnowledgeCategories')
      .find(c => c.category_id === categoryId);
    
    if (!category) {
      return { success: false, error: 'Category not found' };
    }
    
    // Update slug if name changed
    if (updates.name && updates.name !== category.name) {
      updates.slug = createSlug(updates.name);
    }
    
    updates.updated_at = new Date();
    
    updateRow('KnowledgeCategories', 'category_id', categoryId, updates);
    clearSheetCache('KnowledgeCategories');
    
    logAudit('KnowledgeCategory', categoryId, 'UPDATE',
      context.actorType, context.actorId, context.actorEmail,
      { updates: Object.keys(updates) }, {});
    
    return { success: true };
    
  } catch (e) {
    Logger.log('updateCategory error: ' + e.message);
    return { success: false, error: 'Failed to update category' };
  }
}

// ============================================================================
// ARTICLE MANAGEMENT
// ============================================================================

/**
 * Gets an article by ID.
 * @param {string} articleId - Article ID
 * @param {boolean} trackView - Whether to track view
 * @param {Object} viewer - Viewer info for tracking
 * @returns {Object} Article
 */
function getArticle(articleId, trackView = false, viewer = {}) {
  try {
    const article = getById('KnowledgeArticles', articleId);
    
    if (!article) {
      return { success: false, error: 'Article not found' };
    }
    
    // Get category
    const category = getCachedSheetData('KnowledgeCategories')
      .find(c => c.category_id === article.category_id);
    
    // Get author
    const author = article.author_id ? getById('Users', article.author_id) : null;
    
    // Track view
    if (trackView && article.status === 'PUBLISHED') {
      trackArticleView(articleId, viewer);
    }
    
    // Get related articles
    const relatedArticles = getRelatedArticles(articleId, article.category_id, article.tags);
    
    return {
      success: true,
      article: article,
      category: category,
      author: author ? {
        user_id: author.user_id,
        name: `${author.first_name} ${author.last_name}`,
      } : null,
      relatedArticles: relatedArticles,
    };
    
  } catch (e) {
    Logger.log('getArticle error: ' + e.message);
    return { success: false, error: 'Failed to get article' };
  }
}

/**
 * Gets an article by slug.
 * @param {string} slug - Article slug
 * @param {boolean} trackView - Whether to track view
 * @param {Object} viewer - Viewer info
 * @returns {Object} Article
 */
function getArticleBySlug(slug, trackView = false, viewer = {}) {
  try {
    const articles = getSheetData('KnowledgeArticles');
    const article = articles.find(a => a.slug === slug && a.status === 'PUBLISHED');
    
    if (!article) {
      return { success: false, error: 'Article not found' };
    }
    
    return getArticle(article.article_id, trackView, viewer);
    
  } catch (e) {
    Logger.log('getArticleBySlug error: ' + e.message);
    return { success: false, error: 'Failed to get article' };
  }
}

/**
 * Creates a new article.
 * @param {Object} data - Article data
 * @param {Object} context - Actor context
 * @returns {Object} Created article
 */
function createArticle(data, context) {
  try {
    if (!data.title) {
      return { success: false, error: 'Title is required' };
    }
    
    if (!data.category_id) {
      return { success: false, error: 'Category is required' };
    }
    
    // Verify category exists
    const category = getCachedSheetData('KnowledgeCategories')
      .find(c => c.category_id === data.category_id);
    
    if (!category) {
      return { success: false, error: 'Category not found' };
    }
    
    const articleId = generateId('KART');
    const now = new Date();
    
    // Create unique slug
    let slug = createSlug(data.title);
    const existingSlugs = getSheetData('KnowledgeArticles').map(a => a.slug);
    if (existingSlugs.includes(slug)) {
      slug = `${slug}-${Date.now()}`;
    }
    
    const article = {
      article_id: articleId,
      category_id: data.category_id,
      title: data.title,
      slug: slug,
      content: data.content || '',
      content_html: data.content_html || '',
      content_text: stripHtml(data.content_html || data.content || ''),
      excerpt: data.excerpt || createExcerpt(data.content || '', KNOWLEDGE_CONFIG.EXCERPT_LENGTH),
      featured_image: data.featured_image || '',
      tags: data.tags || '',
      audience: data.audience || 'ALL',
      language: data.language || 'en',
      status: 'DRAFT',
      version: 1,
      author_id: context.actorId || '',
      sort_order: data.sort_order || 0,
      view_count: 0,
      helpful_yes: 0,
      helpful_no: 0,
      is_featured: data.is_featured || false,
      is_pinned: data.is_pinned || false,
      meta_title: data.meta_title || data.title,
      meta_description: data.meta_description || '',
      created_at: now,
      updated_at: now,
    };
    
    appendRow('KnowledgeArticles', article);
    clearSheetCache('KnowledgeArticles');
    
    logAudit('KnowledgeArticle', articleId, 'CREATE',
      context.actorType, context.actorId, context.actorEmail,
      { title: data.title, category_id: data.category_id }, {});
    
    return {
      success: true,
      articleId: articleId,
      slug: slug,
    };
    
  } catch (e) {
    Logger.log('createArticle error: ' + e.message);
    return { success: false, error: 'Failed to create article' };
  }
}

/**
 * Updates an article.
 * @param {string} articleId - Article ID
 * @param {Object} updates - Fields to update
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function updateArticle(articleId, updates, context) {
  try {
    const article = getById('KnowledgeArticles', articleId);
    
    if (!article) {
      return { success: false, error: 'Article not found' };
    }
    
    // Update slug if title changed
    if (updates.title && updates.title !== article.title) {
      let newSlug = createSlug(updates.title);
      const existingSlugs = getSheetData('KnowledgeArticles')
        .filter(a => a.article_id !== articleId)
        .map(a => a.slug);
      
      if (existingSlugs.includes(newSlug)) {
        newSlug = `${newSlug}-${Date.now()}`;
      }
      updates.slug = newSlug;
    }
    
    // Update content text if content changed
    if (updates.content_html || updates.content) {
      updates.content_text = stripHtml(updates.content_html || updates.content || article.content);
      
      // Auto-generate excerpt if not provided
      if (!updates.excerpt) {
        updates.excerpt = createExcerpt(updates.content_text, KNOWLEDGE_CONFIG.EXCERPT_LENGTH);
      }
    }
    
    // Increment version if content changed
    if (updates.content || updates.content_html) {
      updates.version = (article.version || 1) + 1;
    }
    
    updates.updated_at = new Date();
    updates.last_updated_by = context.actorId;
    
    updateRow('KnowledgeArticles', 'article_id', articleId, updates);
    clearSheetCache('KnowledgeArticles');
    
    logAudit('KnowledgeArticle', articleId, 'UPDATE',
      context.actorType, context.actorId, context.actorEmail,
      { updates: Object.keys(updates), version: updates.version }, {});
    
    return { success: true };
    
  } catch (e) {
    Logger.log('updateArticle error: ' + e.message);
    return { success: false, error: 'Failed to update article' };
  }
}

/**
 * Publishes an article.
 * @param {string} articleId - Article ID
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function publishArticle(articleId, context) {
  const article = getById('KnowledgeArticles', articleId);
  
  if (!article) {
    return { success: false, error: 'Article not found' };
  }
  
  if (article.status === 'PUBLISHED') {
    return { success: true, message: 'Article already published' };
  }
  
  // Validate article has required content
  if (!article.title || !article.content) {
    return { success: false, error: 'Article must have title and content before publishing' };
  }
  
  const result = updateArticle(articleId, {
    status: 'PUBLISHED',
    published_at: new Date(),
    published_by: context.actorId,
  }, context);
  
  if (result.success) {
    logAudit('KnowledgeArticle', articleId, 'PUBLISH',
      context.actorType, context.actorId, context.actorEmail,
      {}, {});
  }
  
  return result;
}

/**
 * Unpublishes an article (moves to draft).
 * @param {string} articleId - Article ID
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function unpublishArticle(articleId, context) {
  return updateArticle(articleId, {
    status: 'DRAFT',
    published_at: '',
    published_by: '',
  }, context);
}

/**
 * Archives an article.
 * @param {string} articleId - Article ID
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function archiveArticle(articleId, context) {
  return updateArticle(articleId, {
    status: 'ARCHIVED',
    archived_at: new Date(),
    archived_by: context.actorId,
  }, context);
}

// ============================================================================
// SEARCH
// ============================================================================

/**
 * Searches knowledge base articles.
 * @param {string} searchText - Search query
 * @param {Object} options - Search options
 * @returns {Object} Search results
 */
function searchKnowledgeBase(searchText, options = {}) {
  try {
    if (!searchText || searchText.trim().length < KNOWLEDGE_CONFIG.MIN_SEARCH_LENGTH) {
      return { 
        success: false, 
        error: `Search query must be at least ${KNOWLEDGE_CONFIG.MIN_SEARCH_LENGTH} characters` 
      };
    }
    
    const searchLower = searchText.toLowerCase().trim();
    const searchTerms = searchLower.split(/\s+/);
    
    // Get published articles
    let articles = getSheetData('KnowledgeArticles')
      .filter(a => a.status === 'PUBLISHED');
    
    // Filter by audience if specified
    if (options.audience) {
      articles = articles.filter(a => 
        a.audience === options.audience || a.audience === 'ALL'
      );
    }
    
    // Filter by category if specified
    if (options.categoryId) {
      articles = articles.filter(a => a.category_id === options.categoryId);
    }
    
    // Score and filter articles
    const scoredArticles = articles.map(article => {
      let score = 0;
      const titleLower = (article.title || '').toLowerCase();
      const contentLower = (article.content_text || '').toLowerCase();
      const tagsLower = (article.tags || '').toLowerCase();
      
      for (const term of searchTerms) {
        // Title matches (highest weight)
        if (titleLower.includes(term)) {
          score += titleLower.startsWith(term) ? 20 : 10;
        }
        
        // Tag matches (high weight)
        if (tagsLower.includes(term)) {
          score += 8;
        }
        
        // Content matches
        if (contentLower.includes(term)) {
          // Count occurrences (max 5 points)
          const occurrences = (contentLower.match(new RegExp(term, 'g')) || []).length;
          score += Math.min(occurrences, 5);
        }
      }
      
      return { article, score };
    });
    
    // Filter articles with matches and sort by score
    const matchedArticles = scoredArticles
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, options.limit || KNOWLEDGE_CONFIG.MAX_SEARCH_RESULTS)
      .map(item => ({
        article_id: item.article.article_id,
        title: item.article.title,
        slug: item.article.slug,
        category_id: item.article.category_id,
        excerpt: item.article.excerpt || createExcerpt(item.article.content_text, KNOWLEDGE_CONFIG.EXCERPT_LENGTH),
        tags: item.article.tags,
        view_count: item.article.view_count,
        score: item.score,
      }));
    
    // Get category names
    const categories = getCachedSheetData('KnowledgeCategories');
    const categoryMap = new Map(categories.map(c => [c.category_id, c.name]));
    
    for (const article of matchedArticles) {
      article.category_name = categoryMap.get(article.category_id) || '';
    }
    
    return {
      success: true,
      data: matchedArticles,
      total: matchedArticles.length,
      searchText: searchText,
    };
    
  } catch (e) {
    Logger.log('searchKnowledgeBase error: ' + e.message);
    return { success: false, error: 'Search failed' };
  }
}

/**
 * Gets suggested articles based on ticket/inquiry context.
 * @param {string} subject - Ticket subject
 * @param {string} category - Ticket category
 * @param {number} limit - Max results
 * @returns {Object} Suggested articles
 */
function getSuggestedArticles(subject, category, limit = 5) {
  try {
    // Extract keywords from subject
    const keywords = extractKeywords(subject);
    
    if (keywords.length === 0) {
      // Return popular articles in category
      return getPopularArticles(category, limit);
    }
    
    // Search with extracted keywords
    const searchResults = searchKnowledgeBase(keywords.join(' '), { limit: limit });
    
    if (searchResults.success && searchResults.data.length > 0) {
      return searchResults;
    }
    
    // Fall back to popular articles
    return getPopularArticles(category, limit);
    
  } catch (e) {
    Logger.log('getSuggestedArticles error: ' + e.message);
    return { success: false, error: 'Failed to get suggestions' };
  }
}

/**
 * Extracts keywords from text.
 * @param {string} text - Text to extract from
 * @returns {string[]} Keywords
 */
function extractKeywords(text) {
  if (!text) return [];
  
  // Common stop words to exclude
  const stopWords = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
    'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
    'from', 'up', 'about', 'into', 'through', 'during', 'before', 'after',
    'above', 'below', 'between', 'under', 'again', 'further', 'then',
    'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
    'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not',
    'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'and',
    'but', 'if', 'or', 'because', 'as', 'until', 'while', 'this', 'that',
    'these', 'those', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he',
    'him', 'his', 'she', 'her', 'it', 'its', 'they', 'them', 'their',
    'what', 'which', 'who', 'whom', 'please', 'help', 'want', 'need',
  ]);
  
  const words = text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word));
  
  // Return unique words
  return [...new Set(words)].slice(0, 5);
}

// ============================================================================
// POPULAR & RELATED ARTICLES
// ============================================================================

/**
 * Gets popular articles.
 * @param {string} categoryId - Optional category filter
 * @param {number} limit - Max results
 * @returns {Object} Popular articles
 */
function getPopularArticles(categoryId, limit = KNOWLEDGE_CONFIG.POPULAR_ARTICLES_LIMIT) {
  try {
    let articles = getSheetData('KnowledgeArticles')
      .filter(a => a.status === 'PUBLISHED');
    
    if (categoryId) {
      articles = articles.filter(a => a.category_id === categoryId);
    }
    
    // Sort by view count
    articles.sort((a, b) => (b.view_count || 0) - (a.view_count || 0));
    
    const popular = articles.slice(0, limit).map(a => ({
      article_id: a.article_id,
      title: a.title,
      slug: a.slug,
      category_id: a.category_id,
      excerpt: a.excerpt,
      view_count: a.view_count,
    }));
    
    return {
      success: true,
      data: popular,
    };
    
  } catch (e) {
    Logger.log('getPopularArticles error: ' + e.message);
    return { success: false, error: 'Failed to get popular articles' };
  }
}

/**
 * Gets featured articles.
 * @param {number} limit - Max results
 * @returns {Object} Featured articles
 */
function getFeaturedArticles(limit = 5) {
  try {
    const articles = getSheetData('KnowledgeArticles')
      .filter(a => a.status === 'PUBLISHED' && a.is_featured)
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
      .slice(0, limit)
      .map(a => ({
        article_id: a.article_id,
        title: a.title,
        slug: a.slug,
        category_id: a.category_id,
        excerpt: a.excerpt,
        featured_image: a.featured_image,
      }));
    
    return {
      success: true,
      data: articles,
    };
    
  } catch (e) {
    Logger.log('getFeaturedArticles error: ' + e.message);
    return { success: false, error: 'Failed to get featured articles' };
  }
}

/**
 * Gets related articles based on category and tags.
 * @param {string} articleId - Current article ID
 * @param {string} categoryId - Article category
 * @param {string} tags - Article tags
 * @returns {Object[]} Related articles
 */
function getRelatedArticles(articleId, categoryId, tags) {
  try {
    const tagList = (tags || '').split(',').map(t => t.trim().toLowerCase()).filter(t => t);
    
    let articles = getSheetData('KnowledgeArticles')
      .filter(a => a.status === 'PUBLISHED' && a.article_id !== articleId);
    
    // Score articles by relevance
    const scoredArticles = articles.map(article => {
      let score = 0;
      
      // Same category
      if (article.category_id === categoryId) {
        score += 5;
      }
      
      // Matching tags
      const articleTags = (article.tags || '').split(',').map(t => t.trim().toLowerCase());
      for (const tag of tagList) {
        if (articleTags.includes(tag)) {
          score += 3;
        }
      }
      
      return { article, score };
    });
    
    // Return top related
    return scoredArticles
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, KNOWLEDGE_CONFIG.RELATED_ARTICLES_LIMIT)
      .map(item => ({
        article_id: item.article.article_id,
        title: item.article.title,
        slug: item.article.slug,
        excerpt: item.article.excerpt,
      }));
    
  } catch (e) {
    Logger.log('getRelatedArticles error: ' + e.message);
    return [];
  }
}

// ============================================================================
// FEEDBACK & ANALYTICS
// ============================================================================

/**
 * Tracks article view.
 * @param {string} articleId - Article ID
 * @param {Object} viewer - Viewer info { type, id }
 */
function trackArticleView(articleId, viewer = {}) {
  try {
    // Increment view count
    const article = getById('KnowledgeArticles', articleId);
    if (article) {
      updateRow('KnowledgeArticles', 'article_id', articleId, {
        view_count: (article.view_count || 0) + 1,
      });
    }
    
    // Could also log to a separate analytics table for detailed tracking
    
  } catch (e) {
    Logger.log('trackArticleView error: ' + e.message);
  }
}

/**
 * Records article helpfulness feedback.
 * @param {string} articleId - Article ID
 * @param {boolean} wasHelpful - Whether article was helpful
 * @param {Object} feedback - Additional feedback
 * @returns {Object} Result
 */
function recordArticleFeedback(articleId, wasHelpful, feedback = {}) {
  try {
    const article = getById('KnowledgeArticles', articleId);
    
    if (!article) {
      return { success: false, error: 'Article not found' };
    }
    
    const updates = {};
    
    if (wasHelpful) {
      updates.helpful_yes = (article.helpful_yes || 0) + 1;
    } else {
      updates.helpful_no = (article.helpful_no || 0) + 1;
    }
    
    updateRow('KnowledgeArticles', 'article_id', articleId, updates);
    clearSheetCache('KnowledgeArticles');
    
    // Log feedback for review
    if (feedback.comment) {
      Logger.log(`Article feedback for ${articleId}: ${wasHelpful ? 'Helpful' : 'Not helpful'} - ${feedback.comment}`);
    }
    
    return { success: true };
    
  } catch (e) {
    Logger.log('recordArticleFeedback error: ' + e.message);
    return { success: false, error: 'Failed to record feedback' };
  }
}

/**
 * Gets article analytics.
 * @param {string} articleId - Article ID
 * @returns {Object} Analytics data
 */
function getArticleAnalytics(articleId) {
  try {
    const article = getById('KnowledgeArticles', articleId);
    
    if (!article) {
      return { success: false, error: 'Article not found' };
    }
    
    const totalFeedback = (article.helpful_yes || 0) + (article.helpful_no || 0);
    const helpfulRate = totalFeedback > 0 ? 
      Math.round((article.helpful_yes / totalFeedback) * 100) : null;
    
    return {
      success: true,
      data: {
        article_id: articleId,
        view_count: article.view_count || 0,
        helpful_yes: article.helpful_yes || 0,
        helpful_no: article.helpful_no || 0,
        helpful_rate: helpfulRate,
        version: article.version || 1,
        published_at: article.published_at,
        updated_at: article.updated_at,
      },
    };
    
  } catch (e) {
    Logger.log('getArticleAnalytics error: ' + e.message);
    return { success: false, error: 'Failed to get analytics' };
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Creates a URL-friendly slug from text.
 * @param {string} text - Text to slugify
 * @returns {string} Slug
 */
function createSlug(text) {
  return (text || '')
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 100);
}

/**
 * Creates an excerpt from content.
 * @param {string} content - Full content
 * @param {number} length - Max length
 * @returns {string} Excerpt
 */
function createExcerpt(content, length) {
  if (!content) return '';
  
  const stripped = stripHtml(content);
  
  if (stripped.length <= length) {
    return stripped;
  }
  
  // Cut at word boundary
  const truncated = stripped.substring(0, length);
  const lastSpace = truncated.lastIndexOf(' ');
  
  return (lastSpace > 0 ? truncated.substring(0, lastSpace) : truncated) + '...';
}

/**
 * Strips HTML tags from content.
 * @param {string} html - HTML content
 * @returns {string} Plain text
 */
function stripHtml(html) {
  if (!html) return '';
  
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================================================
// WEB APP HANDLER
// ============================================================================

/**
 * Handles knowledge base API requests.
 * @param {Object} params - Request parameters
 * @returns {Object} Response
 */
function handleKnowledgeRequest(params) {
  const action = params.action;
  
  switch (action) {
    // Categories
    case 'getCategories':
      return getCategories(params.includeArticleCounts);
      
    case 'getCategoryWithArticles':
      return getCategoryWithArticles(params.categoryId, params.options);
      
    case 'createCategory':
      return createCategory(params.data, params.context);
      
    case 'updateCategory':
      return updateCategory(params.categoryId, params.data, params.context);
      
    // Articles
    case 'getArticle':
      return getArticle(params.articleId, params.trackView, params.viewer);
      
    case 'getArticleBySlug':
      return getArticleBySlug(params.slug, params.trackView, params.viewer);
      
    case 'createArticle':
      return createArticle(params.data, params.context);
      
    case 'updateArticle':
      return updateArticle(params.articleId, params.data, params.context);
      
    case 'publishArticle':
      return publishArticle(params.articleId, params.context);
      
    case 'unpublishArticle':
      return unpublishArticle(params.articleId, params.context);
      
    case 'archiveArticle':
      return archiveArticle(params.articleId, params.context);
      
    // Search & Discovery
    case 'search':
      return searchKnowledgeBase(params.searchText, params.options);
      
    case 'getSuggestions':
      return getSuggestedArticles(params.subject, params.category, params.limit);
      
    case 'getPopular':
      return getPopularArticles(params.categoryId, params.limit);
      
    case 'getFeatured':
      return getFeaturedArticles(params.limit);
      
    // Feedback & Analytics
    case 'recordFeedback':
      return recordArticleFeedback(params.articleId, params.wasHelpful, params.feedback);
      
    case 'getAnalytics':
      return getArticleAnalytics(params.articleId);
      
    default:
      return { success: false, error: 'Unknown action: ' + action };
  }
}
