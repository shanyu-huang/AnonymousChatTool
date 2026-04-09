// ============================================================
// Secure Multi-Project Anonymous Chat Tool — Backend (Code.gs)
// ============================================================

// ==================== ENTRY POINTS ====================

function doGet(e) {
  var pid = (e && e.parameter && e.parameter.pid) || '';
  var sid = (e && e.parameter && e.parameter.sid) || '';

  if (!pid || !sid) {
    return HtmlService.createHtmlOutput(
      '<h2>Missing parameters</h2><p>URL must include <code>?pid=...&sid=...</code></p>'
    );
  }

  var config = getProjectConfig_(pid);
  if (!config) {
    return HtmlService.createHtmlOutput('<h2>Project not found</h2>');
  }
  if (config.status !== 'Active') {
    return HtmlService.createHtmlOutput('<h2>Project is inactive</h2>');
  }

  var template = HtmlService.createTemplateFromFile('index');
  template.pid = pid;
  template.sid = sid;

  return template.evaluate()
    .setTitle('Anonymous Chat')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ==================== PUBLIC FUNCTIONS ====================

/**
 * The Guard — authenticate or register a session.
 * @param {Object} params {pid, sid, passcode, clientId}
 * @returns {Object} {success, isNew?, error?}
 */
function authenticate(params) {
  try {
    var config = getProjectConfig_(params.pid);
    if (!config) return { success: false, error: 'Project not found.' };
    if (config.status !== 'Active') return { success: false, error: 'Project is inactive.' };

    var masterSs = SpreadsheetApp.openById(config.masterSheetId);
    var masterSheet = masterSs.getSheets()[0];
    var session = lookupSession_(masterSheet, params.sid);

    if (!session) {
      // New session — register with lock to prevent race condition
      var lock = LockService.getScriptLock();
      try {
        lock.waitLock(10000);
        // Re-check after acquiring lock
        session = lookupSession_(masterSheet, params.sid);
        if (session) {
          lock.releaseLock();
          return verifySession_(session, params);
        }
        var fileId = createSessionSheet_(config.folderId, params.pid, params.sid);
        var hash = hashPasscode_(params.passcode);
        var now = new Date().toISOString();
        masterSheet.appendRow([params.sid, hash, params.clientId, fileId, now]);
        lock.releaseLock();
        return { success: true, isNew: true };
      } catch (lockErr) {
        return { success: false, error: 'Server busy. Please retry.' };
      }
    }

    return verifySession_(session, params);
  } catch (err) {
    return { success: false, error: 'Authentication error: ' + err.message };
  }
}

/**
 * Send a message after authentication.
 * @param {Object} params {pid, sid, passcode, clientId, role, content}
 * @returns {Object} {success, error?}
 */
function sendMessage(params) {
  try {
    var auth = authGuard_(params);
    if (!auth.authorized) return { success: false, error: auth.error };

    var allowedRoles = ['consultant', 'client'];
    var role = allowedRoles.indexOf(params.role) !== -1 ? params.role : 'client';
    var content = sanitize_(params.content || '');
    if (!content) return { success: false, error: 'Message is empty.' };

    var ss = SpreadsheetApp.openById(auth.session.fileId);
    var sheet = ss.getSheets()[0];
    var now = new Date().toISOString();
    sheet.appendRow([now, role, content]);

    // Update LastUpdate in master
    var masterSs = SpreadsheetApp.openById(auth.config.masterSheetId);
    var masterSheet = masterSs.getSheets()[0];
    var session = lookupSession_(masterSheet, params.sid);
    if (session) {
      masterSheet.getRange(session.row, 5).setValue(now);
    }

    return { success: true, timestamp: now };
  } catch (err) {
    return { success: false, error: 'Send error: ' + err.message };
  }
}

/**
 * Fetch messages after a given timestamp.
 * @param {Object} params {pid, sid, passcode, clientId, since}
 * @returns {Object} {success, messages[], error?}
 */
function fetchMessages(params) {
  try {
    var auth = authGuard_(params);
    if (!auth.authorized) return { success: false, error: auth.error };

    var ss = SpreadsheetApp.openById(auth.session.fileId);
    var sheet = ss.getSheets()[0];
    var data = sheet.getDataRange().getValues();
    var messages = [];
    var since = params.since || '';

    for (var i = 1; i < data.length; i++) { // Skip header row
      var ts = data[i][0];
      if (typeof ts === 'object' && ts.toISOString) {
        ts = ts.toISOString();
      } else {
        ts = String(ts);
      }
      if (ts > since) {
        messages.push({
          timestamp: ts,
          role: String(data[i][1]),
          content: String(data[i][2])
        });
      }
    }

    return { success: true, messages: messages };
  } catch (err) {
    return { success: false, error: 'Fetch error: ' + err.message };
  }
}

// ==================== INTERNAL HELPERS ====================

/**
 * Verify an existing session's passcode and clientId.
 */
function verifySession_(session, params) {
  var hash = hashPasscode_(params.passcode);
  if (hash !== session.passcodeHash) {
    return { success: false, error: 'Invalid passcode.' };
  }
  if (params.clientId !== session.clientId) {
    return { success: false, error: 'Access Denied: Session locked to another device.' };
  }
  return { success: true, isNew: false };
}

/**
 * Shared auth guard used by sendMessage and fetchMessages.
 * @returns {Object} {authorized, config?, session?, error?}
 */
function authGuard_(params) {
  var config = getProjectConfig_(params.pid);
  if (!config) return { authorized: false, error: 'Project not found.' };
  if (config.status !== 'Active') return { authorized: false, error: 'Project is inactive.' };

  var masterSs = SpreadsheetApp.openById(config.masterSheetId);
  var masterSheet = masterSs.getSheets()[0];
  var session = lookupSession_(masterSheet, params.sid);

  if (!session) return { authorized: false, error: 'Session not found. Please authenticate first.' };

  var hash = hashPasscode_(params.passcode);
  if (hash !== session.passcodeHash) {
    return { authorized: false, error: 'Invalid passcode.' };
  }
  if (params.clientId !== session.clientId) {
    return { authorized: false, error: 'Access Denied: Session locked to another device.' };
  }

  return { authorized: true, config: config, session: session };
}

/**
 * Read project config from Global Config Sheet, with 5-minute cache.
 * @param {string} pid
 * @returns {Object|null} {masterSheetId, folderId, status}
 */
function getProjectConfig_(pid) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'config_' + pid;
  var cached = cache.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  var configSheetId = PropertiesService.getScriptProperties().getProperty('GLOBAL_CONFIG_SHEET_ID');
  if (!configSheetId) return null;

  var ss = SpreadsheetApp.openById(configSheetId);
  var sheet = ss.getSheets()[0];
  var data = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) { // Skip header
    if (String(data[i][0]) === pid) {
      var config = {
        masterSheetId: String(data[i][1]),
        folderId: String(data[i][2]),
        status: String(data[i][3])
      };
      cache.put(cacheKey, JSON.stringify(config), 300); // 5 min TTL
      return config;
    }
  }

  return null;
}

/**
 * Look up a session row in the Master Sheet.
 * @param {Sheet} masterSheet
 * @param {string} sid
 * @returns {Object|null} {row, passcodeHash, clientId, fileId}
 */
function lookupSession_(masterSheet, sid) {
  var data = masterSheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) { // Skip header
    if (String(data[i][0]) === sid) {
      return {
        row: i + 1, // 1-based sheet row
        passcodeHash: String(data[i][1]),
        clientId: String(data[i][2]),
        fileId: String(data[i][3])
      };
    }
  }
  return null;
}

/**
 * Create a new individual session Spreadsheet in the project folder.
 * @param {string} folderId
 * @param {string} pid
 * @param {string} sid
 * @returns {string} The new spreadsheet's file ID.
 */
function createSessionSheet_(folderId, pid, sid) {
  var name = 'Chat-' + pid + '-' + sid;
  var ss = SpreadsheetApp.create(name);
  var sheet = ss.getSheets()[0];
  sheet.appendRow(['Timestamp', 'Role', 'Content']);

  // Move to project folder
  var file = DriveApp.getFileById(ss.getId());
  var folder = DriveApp.getFolderById(folderId);
  file.moveTo(folder);

  return ss.getId();
}

/**
 * SHA-256 hash a passcode string.
 * @param {string} passcode
 * @returns {string} Hex-encoded hash.
 */
function hashPasscode_(passcode) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, passcode);
  var hex = '';
  for (var i = 0; i < raw.length; i++) {
    var b = (raw[i] + 256) % 256; // Convert signed byte to unsigned
    hex += ('0' + b.toString(16)).slice(-2);
  }
  return hex;
}

/**
 * Sanitize text to prevent XSS. Escapes HTML entities and truncates.
 * @param {string} text
 * @returns {string}
 */
function sanitize_(text) {
  if (!text) return '';
  var str = String(text).substring(0, 2000);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
