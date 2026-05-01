/**
 * SeedData.gs
 * Run seedAdminUser() ONCE from the GAS editor to create the first admin account.
 * After running, delete or disable this function so it cannot be run again accidentally.
 */

function seedAdminUser() {
  var email     = 'admin@hassgroup.com';   // change if needed
  var password  = 'HassAdmin2024!';        // change before running
  var firstName = 'System';
  var lastName  = 'Administrator';

  // Hash password using SHA-256 (same algorithm AuthService uses to verify)
  var rawHash = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    password,
    Utilities.Charset.UTF_8
  );
  var passwordHash = rawHash.map(function(b) {
    return ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2);
  }).join('');

  var userId = generateUUID();
  var now    = new Date().toISOString();

  try {
    tursoWrite(
      'INSERT INTO users (user_id, email, first_name, last_name, phone, role, ' +
      'team_id, country_code, countries_access, reports_to, can_approve_orders, ' +
      'approval_limit, max_tickets, status, password_hash, created_at, updated_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        userId,
        email,
        firstName,
        lastName,
        '',
        'SUPER_ADMIN',
        '',
        'KE',
        'KE,UG,TZ,RW,SS,ZM,DRC',
        '',
        1,
        999999999,
        999,
        'ACTIVE',
        passwordHash,
        now,
        now
      ]
    );
    Logger.log('SUCCESS: Admin user created.');
    Logger.log('Email: ' + email);
    Logger.log('Password: ' + password);
    Logger.log('User ID: ' + userId);
  } catch(e) {
    Logger.log('ERROR creating admin user: ' + e.message);
  }
}

function seedTestCustomer() {
  var email     = 'test.customer@acme.com';
  var password  = 'Customer2024!';
  var customerId = generateUUID();
  var contactId  = generateUUID();
  var now        = new Date().toISOString();

  // Hash password
  var rawHash = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    password,
    Utilities.Charset.UTF_8
  );
  var passwordHash = rawHash.map(function(b) {
    return ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2);
  }).join('');

  try {
    // Create customer record first
    tursoWrite(
      'INSERT INTO customers (customer_id, account_number, company_name, trading_name, ' +
      'country_code, status, onboarding_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [customerId, 'HASS-KE-000001', 'Acme Kenya Ltd', 'Acme', 'KE', 'ACTIVE', 'COMPLETED', now, now]
    );

    // Create contact (portal login user) linked to customer
    tursoWrite(
      'INSERT INTO contacts (contact_id, customer_id, first_name, last_name, email, ' +
      'contact_type, is_portal_user, password_hash, status, created_at, updated_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [contactId, customerId, 'Test', 'Customer', email,
       'PRIMARY', 1, passwordHash, 'ACTIVE', now, now]
    );

    Logger.log('SUCCESS: Test customer created.');
    Logger.log('Email: ' + email);
    Logger.log('Password: ' + password);
  } catch(e) {
    Logger.log('ERROR creating test customer: ' + e.message);
  }
}
