/**
 * HASS PETROLEUM CMS - DOCUMENT SERVICE
 * Version: 1.0.0
 * 
 * Handles:
 * - Customer document (KYC) management
 * - Document upload to Google Drive
 * - Document verification and approval workflow
 * - Expiry tracking and notifications
 * - Document categories and templates
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const DOCUMENT_CONFIG = {
  MAX_FILE_SIZE_MB: 10,
  ALLOWED_MIME_TYPES: [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/gif',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  EXPIRY_WARNING_DAYS: [30, 14, 7, 1],
  FOLDER_STRUCTURE: 'CRM/Documents/{country}/{customer_id}',
};

/**
 * Document type definitions with required fields.
 */
const DOCUMENT_TYPES = {
  'KRA_PIN': {
    name: 'KRA PIN Certificate',
    countries: ['KE'],
    required_for_onboarding: true,
    has_expiry: false,
  },
  'TAX_CERTIFICATE': {
    name: 'Tax Compliance Certificate',
    countries: ['KE', 'UG', 'TZ', 'RW', 'ZM', 'MW'],
    required_for_onboarding: true,
    has_expiry: true,
    default_validity_months: 12,
  },
  'CERTIFICATE_OF_INCORPORATION': {
    name: 'Certificate of Incorporation',
    countries: ['ALL'],
    required_for_onboarding: true,
    has_expiry: false,
  },
  'BUSINESS_LICENSE': {
    name: 'Business License',
    countries: ['ALL'],
    required_for_onboarding: true,
    has_expiry: true,
    default_validity_months: 12,
  },
  'ID_COPY': {
    name: 'Director/Owner ID Copy',
    countries: ['ALL'],
    required_for_onboarding: true,
    has_expiry: true,
    default_validity_months: 120, // 10 years
  },
  'MEMORANDUM': {
    name: 'Memorandum of Association',
    countries: ['ALL'],
    required_for_onboarding: false,
    has_expiry: false,
  },
  'BANK_STATEMENT': {
    name: 'Bank Statement',
    countries: ['ALL'],
    required_for_onboarding: false,
    has_expiry: true,
    default_validity_months: 3,
  },
  'CREDIT_APPLICATION': {
    name: 'Credit Application Form',
    countries: ['ALL'],
    required_for_onboarding: false,
    has_expiry: false,
  },
  'CONTRACT': {
    name: 'Signed Contract',
    countries: ['ALL'],
    required_for_onboarding: true,
    has_expiry: true,
    default_validity_months: 12,
  },
  'INSURANCE': {
    name: 'Insurance Certificate',
    countries: ['ALL'],
    required_for_onboarding: false,
    has_expiry: true,
    default_validity_months: 12,
  },
  'OTHER': {
    name: 'Other Document',
    countries: ['ALL'],
    required_for_onboarding: false,
    has_expiry: false,
  },
};

// ============================================================================
// DOCUMENT UPLOAD
// ============================================================================

/**
 * Uploads a document for a customer.
 * @param {Object} documentData - Document metadata
 * @param {string} fileContent - Base64 encoded file content
 * @param {Object} context - Actor context
 * @returns {Object} Upload result
 */
function uploadDocument(documentData, fileContent, context) {
  try {
    // Validate required fields
    if (!documentData.customer_id) {
      return { success: false, error: 'Customer ID is required' };
    }
    
    if (!documentData.document_type) {
      return { success: false, error: 'Document type is required' };
    }
    
    if (!documentData.file_name) {
      return { success: false, error: 'File name is required' };
    }
    
    if (!fileContent) {
      return { success: false, error: 'File content is required' };
    }
    
    // Get customer
    const customer = getById('Customers', documentData.customer_id);
    if (!customer) {
      return { success: false, error: 'Customer not found' };
    }
    
    // Validate document type
    const docTypeConfig = DOCUMENT_TYPES[documentData.document_type];
    if (!docTypeConfig) {
      return { success: false, error: 'Invalid document type' };
    }
    
    // Validate MIME type
    const mimeType = documentData.mime_type || getMimeType(documentData.file_name);
    if (!DOCUMENT_CONFIG.ALLOWED_MIME_TYPES.includes(mimeType)) {
      return { success: false, error: 'File type not allowed. Please upload PDF, Word, or image files.' };
    }
    
    // Decode and check file size
    const fileBlob = Utilities.newBlob(Utilities.base64Decode(fileContent), mimeType, documentData.file_name);
    const fileSizeMB = fileBlob.getBytes().length / (1024 * 1024);
    
    if (fileSizeMB > DOCUMENT_CONFIG.MAX_FILE_SIZE_MB) {
      return { success: false, error: `File size exceeds ${DOCUMENT_CONFIG.MAX_FILE_SIZE_MB}MB limit` };
    }
    
    // Get or create customer folder
    const folder = getOrCreateCustomerFolder(documentData.customer_id, customer.country_code);
    
    // Create file in Drive
    const file = folder.createFile(fileBlob);
    file.setDescription(`${docTypeConfig.name} for ${customer.company_name}`);
    
    // Calculate expiry date if applicable
    let expiryDate = documentData.expiry_date || '';
    if (!expiryDate && docTypeConfig.has_expiry && docTypeConfig.default_validity_months) {
      expiryDate = new Date();
      expiryDate.setMonth(expiryDate.getMonth() + docTypeConfig.default_validity_months);
    }
    
    // Create document record
    const documentId = generateId('DOC');
    const now = new Date();
    
    const document = {
      document_id: documentId,
      customer_id: documentData.customer_id,
      document_type: documentData.document_type,
      document_name: documentData.document_name || docTypeConfig.name,
      file_name: documentData.file_name,
      file_path: file.getUrl(),
      file_id: file.getId(),
      file_size: fileBlob.getBytes().length,
      mime_type: mimeType,
      issue_date: documentData.issue_date || '',
      expiry_date: expiryDate,
      issuing_authority: documentData.issuing_authority || '',
      document_number: documentData.document_number || '',
      status: 'PENDING_REVIEW',
      verification_notes: '',
      verified_by: '',
      verified_at: '',
      is_archived: false,
      version: 1,
      previous_version_id: '',
      uploaded_by_type: context.actorType || 'CUSTOMER',
      uploaded_by_id: context.actorId || '',
      created_at: now,
      updated_at: now,
    };
    
    appendRow('Documents', document);
    clearSheetCache('Documents');
    
    // Log audit
    logAudit('Document', documentId, 'UPLOAD',
      context.actorType, context.actorId, context.actorEmail,
      { document_type: documentData.document_type, file_name: documentData.file_name },
      { countryCode: customer.country_code });
    
    // Notify staff for review
    notifyDocumentUpload(documentId, customer);
    
    return {
      success: true,
      documentId: documentId,
      fileUrl: file.getUrl(),
    };
    
  } catch (e) {
    Logger.log('uploadDocument error: ' + e.message);
    return { success: false, error: 'Failed to upload document' };
  }
}

/**
 * Gets or creates folder for customer documents.
 * @param {string} customerId - Customer ID
 * @param {string} countryCode - Country code
 * @returns {Folder} Google Drive folder
 */
function getOrCreateCustomerFolder(customerId, countryCode) {
  const props = PropertiesService.getScriptProperties();
  let rootFolderId = props.getProperty('DOCUMENTS_ROOT_FOLDER_ID');
  
  let rootFolder;
  
  if (rootFolderId) {
    try {
      rootFolder = DriveApp.getFolderById(rootFolderId);
    } catch (e) {
      rootFolder = null;
    }
  }
  
  // Create root folder if not exists
  if (!rootFolder) {
    rootFolder = DriveApp.createFolder('CRM Documents');
    props.setProperty('DOCUMENTS_ROOT_FOLDER_ID', rootFolder.getId());
  }
  
  // Get or create country folder
  let countryFolder;
  const countryFolders = rootFolder.getFoldersByName(countryCode);
  
  if (countryFolders.hasNext()) {
    countryFolder = countryFolders.next();
  } else {
    countryFolder = rootFolder.createFolder(countryCode);
  }
  
  // Get or create customer folder
  let customerFolder;
  const customerFolders = countryFolder.getFoldersByName(customerId);
  
  if (customerFolders.hasNext()) {
    customerFolder = customerFolders.next();
  } else {
    customerFolder = countryFolder.createFolder(customerId);
  }
  
  return customerFolder;
}

/**
 * Gets MIME type from file name.
 * @param {string} fileName - File name
 * @returns {string} MIME type
 */
function getMimeType(fileName) {
  const extension = fileName.split('.').pop().toLowerCase();
  
  const mimeTypes = {
    'pdf': 'application/pdf',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  
  return mimeTypes[extension] || 'application/octet-stream';
}

// ============================================================================
// DOCUMENT RETRIEVAL
// ============================================================================

/**
 * Gets documents for a customer.
 * @param {string} customerId - Customer ID
 * @param {Object} options - Query options
 * @returns {Object} Documents list
 */
function getCustomerDocuments(customerId, options = {}) {
  try {
    const conditions = { customer_id: customerId };
    
    if (options.status) {
      conditions.status = options.status;
    }
    
    if (options.documentType) {
      conditions.document_type = options.documentType;
    }
    
    if (!options.includeArchived) {
      conditions.is_archived = false;
    }
    
    const result = findWhere('Documents', conditions, {
      sortBy: options.sortBy || 'created_at',
      sortOrder: options.sortOrder || 'desc',
      limit: options.limit || 100,
    });
    
    // Enrich with document type info
    if (result.data) {
      result.data = result.data.map(doc => ({
        ...doc,
        type_info: DOCUMENT_TYPES[doc.document_type] || {},
      }));
    }
    
    return result;
    
  } catch (e) {
    Logger.log('getCustomerDocuments error: ' + e.message);
    return { success: false, error: 'Failed to get documents' };
  }
}

/**
 * Gets a document by ID.
 * @param {string} documentId - Document ID
 * @returns {Object} Document
 */
function getDocument(documentId) {
  try {
    const document = getById('Documents', documentId);
    
    if (!document) {
      return { success: false, error: 'Document not found' };
    }
    
    // Get customer info
    const customer = getById('Customers', document.customer_id);
    
    return {
      success: true,
      document: document,
      type_info: DOCUMENT_TYPES[document.document_type] || {},
      customer: customer ? {
        customer_id: customer.customer_id,
        company_name: customer.company_name,
        account_number: customer.account_number,
      } : null,
    };
    
  } catch (e) {
    Logger.log('getDocument error: ' + e.message);
    return { success: false, error: 'Failed to get document' };
  }
}

/**
 * Gets required documents for customer onboarding.
 * @param {string} countryCode - Country code
 * @returns {Object} Required document types
 */
function getRequiredDocuments(countryCode) {
  const required = [];
  
  for (const [typeCode, config] of Object.entries(DOCUMENT_TYPES)) {
    if (config.required_for_onboarding) {
      if (config.countries.includes('ALL') || config.countries.includes(countryCode)) {
        required.push({
          type_code: typeCode,
          name: config.name,
          has_expiry: config.has_expiry,
        });
      }
    }
  }
  
  return {
    success: true,
    data: required,
    country_code: countryCode,
  };
}

/**
 * Gets document completion status for a customer.
 * @param {string} customerId - Customer ID
 * @returns {Object} Completion status
 */
function getDocumentCompletionStatus(customerId) {
  try {
    const customer = getById('Customers', customerId);
    if (!customer) {
      return { success: false, error: 'Customer not found' };
    }
    
    const requiredDocs = getRequiredDocuments(customer.country_code).data || [];
    const customerDocs = findWhere('Documents', {
      customer_id: customerId,
      status: 'APPROVED',
      is_archived: false,
    }).data || [];
    
    const uploadedTypes = new Set(customerDocs.map(d => d.document_type));
    
    const status = requiredDocs.map(req => {
      const uploaded = uploadedTypes.has(req.type_code);
      const doc = customerDocs.find(d => d.document_type === req.type_code);
      
      return {
        type_code: req.type_code,
        name: req.name,
        required: true,
        uploaded: uploaded,
        document_id: doc ? doc.document_id : null,
        status: doc ? doc.status : 'NOT_UPLOADED',
        expiry_date: doc ? doc.expiry_date : null,
        is_expired: doc && doc.expiry_date ? new Date(doc.expiry_date) < new Date() : false,
      };
    });
    
    const completedCount = status.filter(s => s.uploaded && !s.is_expired).length;
    const totalRequired = status.length;
    const completionPercentage = totalRequired > 0 ? 
      Math.round((completedCount / totalRequired) * 100) : 0;
    
    return {
      success: true,
      documents: status,
      completed: completedCount,
      total: totalRequired,
      percentage: completionPercentage,
      isComplete: completedCount === totalRequired,
    };
    
  } catch (e) {
    Logger.log('getDocumentCompletionStatus error: ' + e.message);
    return { success: false, error: 'Failed to get completion status' };
  }
}

// ============================================================================
// DOCUMENT VERIFICATION WORKFLOW
// ============================================================================

/**
 * Approves a document.
 * @param {string} documentId - Document ID
 * @param {Object} verificationData - Verification notes
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function approveDocument(documentId, verificationData, context) {
  try {
    const document = getById('Documents', documentId);
    
    if (!document) {
      return { success: false, error: 'Document not found' };
    }
    
    if (document.status === 'APPROVED') {
      return { success: true, message: 'Document already approved' };
    }
    
    const now = new Date();
    
    updateRow('Documents', 'document_id', documentId, {
      status: 'APPROVED',
      verification_notes: verificationData.notes || '',
      verified_by: context.actorId,
      verified_at: now,
      updated_at: now,
    });
    
    clearSheetCache('Documents');
    
    // Log audit
    logAudit('Document', documentId, 'APPROVE',
      context.actorType, context.actorId, context.actorEmail,
      { notes: verificationData.notes }, {});
    
    // Check if all required docs complete - update onboarding status
    checkOnboardingCompletion(document.customer_id);
    
    // Notify customer
    notifyDocumentApproved(documentId, document.customer_id);
    
    return { success: true };
    
  } catch (e) {
    Logger.log('approveDocument error: ' + e.message);
    return { success: false, error: 'Failed to approve document' };
  }
}

/**
 * Rejects a document.
 * @param {string} documentId - Document ID
 * @param {string} reason - Rejection reason
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function rejectDocument(documentId, reason, context) {
  try {
    const document = getById('Documents', documentId);
    
    if (!document) {
      return { success: false, error: 'Document not found' };
    }
    
    if (!reason) {
      return { success: false, error: 'Rejection reason is required' };
    }
    
    const now = new Date();
    
    updateRow('Documents', 'document_id', documentId, {
      status: 'REJECTED',
      verification_notes: reason,
      verified_by: context.actorId,
      verified_at: now,
      updated_at: now,
    });
    
    clearSheetCache('Documents');
    
    logAudit('Document', documentId, 'REJECT',
      context.actorType, context.actorId, context.actorEmail,
      { reason: reason }, {});
    
    // Notify customer to resubmit
    notifyDocumentRejected(documentId, document.customer_id, reason);
    
    return { success: true };
    
  } catch (e) {
    Logger.log('rejectDocument error: ' + e.message);
    return { success: false, error: 'Failed to reject document' };
  }
}

/**
 * Requests document revision.
 * @param {string} documentId - Document ID
 * @param {string} requestNotes - What needs to be fixed
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function requestDocumentRevision(documentId, requestNotes, context) {
  try {
    const document = getById('Documents', documentId);
    
    if (!document) {
      return { success: false, error: 'Document not found' };
    }
    
    const now = new Date();
    
    updateRow('Documents', 'document_id', documentId, {
      status: 'REVISION_REQUESTED',
      verification_notes: requestNotes,
      verified_by: context.actorId,
      updated_at: now,
    });
    
    clearSheetCache('Documents');
    
    logAudit('Document', documentId, 'REQUEST_REVISION',
      context.actorType, context.actorId, context.actorEmail,
      { notes: requestNotes }, {});
    
    // Notify customer
    notifyDocumentRevisionRequested(documentId, document.customer_id, requestNotes);
    
    return { success: true };
    
  } catch (e) {
    Logger.log('requestDocumentRevision error: ' + e.message);
    return { success: false, error: 'Failed to request revision' };
  }
}

/**
 * Archives a document (replaced by newer version).
 * @param {string} documentId - Document ID
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function archiveDocument(documentId, context) {
  try {
    updateRow('Documents', 'document_id', documentId, {
      is_archived: true,
      updated_at: new Date(),
    });
    
    clearSheetCache('Documents');
    
    logAudit('Document', documentId, 'ARCHIVE',
      context.actorType, context.actorId, context.actorEmail,
      {}, {});
    
    return { success: true };
    
  } catch (e) {
    Logger.log('archiveDocument error: ' + e.message);
    return { success: false, error: 'Failed to archive document' };
  }
}

/**
 * Uploads a new version of a document.
 * @param {string} existingDocumentId - Existing document to replace
 * @param {Object} documentData - New document metadata
 * @param {string} fileContent - Base64 file content
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function uploadDocumentVersion(existingDocumentId, documentData, fileContent, context) {
  try {
    const existingDoc = getById('Documents', existingDocumentId);
    
    if (!existingDoc) {
      return { success: false, error: 'Existing document not found' };
    }
    
    // Upload new document
    const uploadResult = uploadDocument({
      ...documentData,
      customer_id: existingDoc.customer_id,
      document_type: existingDoc.document_type,
    }, fileContent, context);
    
    if (!uploadResult.success) {
      return uploadResult;
    }
    
    // Link to previous version
    updateRow('Documents', 'document_id', uploadResult.documentId, {
      version: (existingDoc.version || 1) + 1,
      previous_version_id: existingDocumentId,
    });
    
    // Archive old document
    archiveDocument(existingDocumentId, context);
    
    return {
      success: true,
      documentId: uploadResult.documentId,
      previousVersionId: existingDocumentId,
      version: (existingDoc.version || 1) + 1,
    };
    
  } catch (e) {
    Logger.log('uploadDocumentVersion error: ' + e.message);
    return { success: false, error: 'Failed to upload new version' };
  }
}

// ============================================================================
// EXPIRY MANAGEMENT
// ============================================================================

/**
 * Gets documents expiring within specified days.
 * @param {number} withinDays - Days until expiry
 * @param {string} countryCode - Optional country filter
 * @returns {Object} Expiring documents
 */
function getExpiringDocuments(withinDays = 30, countryCode) {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() + withinDays);
    
    const documents = getSheetData('Documents')
      .filter(d => {
        if (d.status !== 'APPROVED' || d.is_archived) return false;
        if (!d.expiry_date) return false;
        
        const expiryDate = new Date(d.expiry_date);
        return expiryDate <= cutoffDate && expiryDate >= new Date();
      });
    
    // Filter by country if specified
    let filteredDocs = documents;
    if (countryCode) {
      const customerIds = getSheetData('Customers')
        .filter(c => c.country_code === countryCode)
        .map(c => c.customer_id);
      
      filteredDocs = documents.filter(d => customerIds.includes(d.customer_id));
    }
    
    // Enrich with customer and days until expiry
    const customers = getSheetData('Customers');
    const customerMap = new Map(customers.map(c => [c.customer_id, c]));
    
    const enriched = filteredDocs.map(doc => {
      const customer = customerMap.get(doc.customer_id);
      const daysUntilExpiry = Math.ceil(
        (new Date(doc.expiry_date) - new Date()) / (1000 * 60 * 60 * 24)
      );
      
      return {
        ...doc,
        days_until_expiry: daysUntilExpiry,
        customer_name: customer ? customer.company_name : '',
        customer_country: customer ? customer.country_code : '',
      };
    });
    
    // Sort by expiry date
    enriched.sort((a, b) => new Date(a.expiry_date) - new Date(b.expiry_date));
    
    return {
      success: true,
      data: enriched,
      total: enriched.length,
    };
    
  } catch (e) {
    Logger.log('getExpiringDocuments error: ' + e.message);
    return { success: false, error: 'Failed to get expiring documents' };
  }
}

/**
 * Gets expired documents.
 * @param {string} countryCode - Optional country filter
 * @returns {Object} Expired documents
 */
function getExpiredDocuments(countryCode) {
  try {
    const today = new Date();
    
    const documents = getSheetData('Documents')
      .filter(d => {
        if (d.status !== 'APPROVED' || d.is_archived) return false;
        if (!d.expiry_date) return false;
        
        return new Date(d.expiry_date) < today;
      });
    
    // Filter by country if specified
    let filteredDocs = documents;
    if (countryCode) {
      const customerIds = getSheetData('Customers')
        .filter(c => c.country_code === countryCode)
        .map(c => c.customer_id);
      
      filteredDocs = documents.filter(d => customerIds.includes(d.customer_id));
    }
    
    // Mark as expired in database
    for (const doc of filteredDocs) {
      if (doc.status !== 'EXPIRED') {
        updateRow('Documents', 'document_id', doc.document_id, {
          status: 'EXPIRED',
        });
      }
    }
    
    if (filteredDocs.length > 0) {
      clearSheetCache('Documents');
    }
    
    return {
      success: true,
      data: filteredDocs,
      total: filteredDocs.length,
    };
    
  } catch (e) {
    Logger.log('getExpiredDocuments error: ' + e.message);
    return { success: false, error: 'Failed to get expired documents' };
  }
}

/**
 * Sends expiry reminder notifications.
 * Run via daily trigger.
 */
function sendExpiryReminders() {
  try {
    let notificationsSent = 0;
    
    for (const daysAhead of DOCUMENT_CONFIG.EXPIRY_WARNING_DAYS) {
      const targetDate = new Date();
      targetDate.setDate(targetDate.getDate() + daysAhead);
      targetDate.setHours(0, 0, 0, 0);
      
      const nextDay = new Date(targetDate);
      nextDay.setDate(nextDay.getDate() + 1);
      
      // Find documents expiring on this date
      const documents = getSheetData('Documents').filter(d => {
        if (d.status !== 'APPROVED' || d.is_archived) return false;
        if (!d.expiry_date) return false;
        
        const expiryDate = new Date(d.expiry_date);
        expiryDate.setHours(0, 0, 0, 0);
        
        return expiryDate >= targetDate && expiryDate < nextDay;
      });
      
      // Send notifications
      for (const doc of documents) {
        const customer = getById('Customers', doc.customer_id);
        if (!customer) continue;
        
        // Get primary contact
        const contacts = findWhere('Contacts', {
          customer_id: doc.customer_id,
          contact_type: 'PRIMARY',
          status: 'ACTIVE',
        }).data || [];
        
        for (const contact of contacts) {
          createNotification({
            recipient_type: 'CUSTOMER_CONTACT',
            recipient_id: contact.contact_id,
            notification_type: 'DOCUMENT_EXPIRING',
            reference_type: 'Document',
            reference_id: doc.document_id,
            title: `Document Expiring in ${daysAhead} Day${daysAhead !== 1 ? 's' : ''}`,
            message: `Your ${doc.document_name} is expiring on ${new Date(doc.expiry_date).toLocaleDateString()}. Please upload an updated document.`,
            action_url: `/portal/documents`,
            priority: daysAhead <= 7 ? 'HIGH' : 'NORMAL',
            data: {
              document_name: doc.document_name,
              expiry_date: doc.expiry_date,
              days_until_expiry: daysAhead,
            },
          });
          notificationsSent++;
        }
      }
    }
    
    return {
      success: true,
      notificationsSent: notificationsSent,
    };
    
  } catch (e) {
    Logger.log('sendExpiryReminders error: ' + e.message);
    return { success: false, error: e.message };
  }
}

// ============================================================================
// ONBOARDING HELPERS
// ============================================================================

/**
 * Checks if customer onboarding documents are complete.
 * @param {string} customerId - Customer ID
 */
function checkOnboardingCompletion(customerId) {
  try {
    const status = getDocumentCompletionStatus(customerId);
    
    if (status.success && status.isComplete) {
      const customer = getById('Customers', customerId);
      
      if (customer && customer.onboarding_status === 'DOCUMENTS_PENDING') {
        updateRow('Customers', 'customer_id', customerId, {
          onboarding_status: 'DOCUMENTS_COMPLETE',
        });
        clearSheetCache('Customers');
        
        // Notify for next step
        Logger.log(`Customer ${customerId} documents complete - ready for approval`);
      }
    }
  } catch (e) {
    Logger.log('checkOnboardingCompletion error: ' + e.message);
  }
}

/**
 * Gets onboarding progress for a customer.
 * @param {string} customerId - Customer ID
 * @returns {Object} Onboarding progress
 */
function getOnboardingProgress(customerId) {
  try {
    const customer = getById('Customers', customerId);
    if (!customer) {
      return { success: false, error: 'Customer not found' };
    }
    
    const documentStatus = getDocumentCompletionStatus(customerId);
    
    const stages = [
      { stage: 'PROFILE', name: 'Company Profile', complete: true },
      { stage: 'DOCUMENTS', name: 'KYC Documents', complete: documentStatus.isComplete },
      { stage: 'REVIEW', name: 'Account Review', complete: customer.onboarding_status === 'APPROVED' },
      { stage: 'ACTIVE', name: 'Account Active', complete: customer.status === 'ACTIVE' },
    ];
    
    const currentStage = stages.find(s => !s.complete)?.stage || 'ACTIVE';
    const progress = Math.round((stages.filter(s => s.complete).length / stages.length) * 100);
    
    return {
      success: true,
      customer_id: customerId,
      onboarding_status: customer.onboarding_status,
      current_stage: currentStage,
      stages: stages,
      progress: progress,
      documents: documentStatus,
    };
    
  } catch (e) {
    Logger.log('getOnboardingProgress error: ' + e.message);
    return { success: false, error: 'Failed to get onboarding progress' };
  }
}

// ============================================================================
// NOTIFICATION HELPERS
// ============================================================================

function notifyDocumentUpload(documentId, customer) {
  // Notify relationship owner or CS team
  if (customer.relationship_owner_id) {
    createNotification({
      recipient_type: 'INTERNAL_USER',
      recipient_id: customer.relationship_owner_id,
      notification_type: 'DOCUMENT_UPLOADED',
      reference_type: 'Document',
      reference_id: documentId,
      title: 'New Document Uploaded',
      message: `${customer.company_name} has uploaded a new document for review.`,
      action_url: `/customers/${customer.customer_id}/documents`,
      priority: 'NORMAL',
    });
  }
}

function notifyDocumentApproved(documentId, customerId) {
  const contacts = findWhere('Contacts', {
    customer_id: customerId,
    contact_type: 'PRIMARY',
    status: 'ACTIVE',
  }).data || [];
  
  for (const contact of contacts) {
    createNotification({
      recipient_type: 'CUSTOMER_CONTACT',
      recipient_id: contact.contact_id,
      notification_type: 'DOCUMENT_APPROVED',
      reference_type: 'Document',
      reference_id: documentId,
      title: 'Document Approved',
      message: 'Your document has been reviewed and approved.',
      action_url: '/portal/documents',
      priority: 'NORMAL',
    });
  }
}

function notifyDocumentRejected(documentId, customerId, reason) {
  const contacts = findWhere('Contacts', {
    customer_id: customerId,
    contact_type: 'PRIMARY',
    status: 'ACTIVE',
  }).data || [];
  
  for (const contact of contacts) {
    createNotification({
      recipient_type: 'CUSTOMER_CONTACT',
      recipient_id: contact.contact_id,
      notification_type: 'DOCUMENT_REJECTED',
      reference_type: 'Document',
      reference_id: documentId,
      title: 'Document Rejected',
      message: `Your document was not accepted. Reason: ${reason}. Please upload a new document.`,
      action_url: '/portal/documents',
      priority: 'HIGH',
    });
  }
}

function notifyDocumentRevisionRequested(documentId, customerId, notes) {
  const contacts = findWhere('Contacts', {
    customer_id: customerId,
    contact_type: 'PRIMARY',
    status: 'ACTIVE',
  }).data || [];
  
  for (const contact of contacts) {
    createNotification({
      recipient_type: 'CUSTOMER_CONTACT',
      recipient_id: contact.contact_id,
      notification_type: 'DOCUMENT_REVISION_REQUESTED',
      reference_type: 'Document',
      reference_id: documentId,
      title: 'Document Revision Requested',
      message: `Please review and resubmit your document. Notes: ${notes}`,
      action_url: '/portal/documents',
      priority: 'HIGH',
    });
  }
}

// ============================================================================
// WEB APP HANDLER
// ============================================================================

/**
 * Handles document API requests.
 * @param {Object} params - Request parameters
 * @returns {Object} Response
 */
function handleDocumentRequest(params) {
  const action = params.action;
  
  switch (action) {
    case 'upload':
      return uploadDocument(params.data, params.fileContent, params.context);
      
    case 'uploadVersion':
      return uploadDocumentVersion(params.existingDocumentId, params.data, params.fileContent, params.context);
      
    case 'get':
      return getDocument(params.documentId);
      
    case 'getCustomerDocuments':
      return getCustomerDocuments(params.customerId, params.options);
      
    case 'getRequired':
      return getRequiredDocuments(params.countryCode);
      
    case 'getCompletionStatus':
      return getDocumentCompletionStatus(params.customerId);
      
    case 'approve':
      return approveDocument(params.documentId, params.data, params.context);
      
    case 'reject':
      return rejectDocument(params.documentId, params.reason, params.context);
      
    case 'requestRevision':
      return requestDocumentRevision(params.documentId, params.notes, params.context);
      
    case 'archive':
      return archiveDocument(params.documentId, params.context);
      
    case 'getExpiring':
      return getExpiringDocuments(params.days, params.countryCode);
      
    case 'getExpired':
      return getExpiredDocuments(params.countryCode);
      
    case 'getOnboardingProgress':
      return getOnboardingProgress(params.customerId);
      
    case 'getDocumentTypes':
      return { success: true, data: DOCUMENT_TYPES };
      
    default:
      return { success: false, error: 'Unknown action: ' + action };
  }
}
