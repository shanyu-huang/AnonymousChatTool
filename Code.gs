// ============================================================
// Secure Multi-Project Anonymous Chat Tool — Backend (Code.gs)
// ============================================================

// ==================== ENTRY POINTS ====================

function doGet(e) {
  var mode = (e && e.parameter && e.parameter.mode) || '';
  if (mode === 'admin') {
    var adminTemplate = HtmlService.createTemplateFromFile('admin');
    return adminTemplate.evaluate()
      .setTitle('Consultant Dashboard')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  var pid = (e && e.parameter && e.parameter.pid) || '';
  var sid = (e && e.parameter && e.parameter.s) || '';

  if (!pid || !sid) {
    return HtmlService.createHtmlOutput(
      '<h2>Missing parameters</h2><p>URL must include <code>?pid=...&s=...</code></p>'
    );
  }

  try {
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
  } catch (err) {
    return HtmlService.createHtmlOutput(
      '<h2>Error</h2><p>' + err.message + '</p><p>Stack: ' + (err.stack || 'N/A') + '</p>'
    );
  }
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
      return { success: false, error: 'Session not found. Please use a valid link.' };
    }

    if (session.passcode === '') {
      // First authentication — set passcode, bind device, create session sheet
      var lock = LockService.getScriptLock();
      try {
        lock.waitLock(10000);
        // Re-check after acquiring lock
        session = lookupSession_(masterSheet, params.sid);
        if (session.passcode !== '') {
          lock.releaseLock();
          return verifySession_(session, params);
        }
        var fileId = createSessionSheet_(config.folderId, params.pid, params.sid);
        var now = new Date().toISOString();
        masterSheet.getRange(session.row, 2, 1, 4).setValues([[
          params.passcode, params.clientId, fileId, now
        ]]);
        lock.releaseLock();
        return { success: true, isNew: true };
      } catch (lockErr) {
        try { lock.releaseLock(); } catch (e) {}
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

// ==================== ADMIN PUBLIC FUNCTIONS ====================

/**
 * Verify the admin key.
 * @param {string} adminKey
 * @returns {Object} {success, error?}
 */
function adminAuthenticate(adminKey) {
  var guard = adminGuard_(adminKey);
  if (!guard.ok) return { success: false, error: guard.error };
  return { success: true };
}

/**
 * List all projects from the Global Config Sheet.
 * @param {string} adminKey
 * @returns {Object} {success, projects: [{pid, name, status}], error?}
 */
function adminListProjects(adminKey) {
  var guard = adminGuard_(adminKey);
  if (!guard.ok) return { success: false, error: guard.error };

  try {
    var configSheetId = PropertiesService.getScriptProperties().getProperty('GLOBAL_CONFIG_SHEET_ID');
    if (!configSheetId) return { success: false, error: 'Global Config Sheet not configured.' };

    var ss = SpreadsheetApp.openById(configSheetId);
    var sheet = ss.getSheets()[0];
    var data = sheet.getDataRange().getValues();
    var projects = [];

    for (var i = 1; i < data.length; i++) { // Skip header
      var pid = String(data[i][0]).trim();
      if (!pid) continue;
      var name = (data[i][4] && String(data[i][4]).trim()) ? String(data[i][4]).trim() : pid;
      projects.push({
        pid: pid,
        name: name,
        status: String(data[i][3])
      });
    }

    projects.sort(function(a, b) { return a.pid.localeCompare(b.pid); });
    return { success: true, projects: projects };
  } catch (err) {
    return { success: false, error: 'Failed to list projects: ' + err.message };
  }
}

/**
 * Create a new project: Master Sheet + Drive folder + Global Config row.
 * @param {string} adminKey
 * @param {string} pid
 * @param {string} name  Optional display name.
 * @returns {Object} {success, error?}
 */
function adminCreateProject(adminKey, pid, name) {
  var guard = adminGuard_(adminKey);
  if (!guard.ok) return { success: false, error: guard.error };

  pid = String(pid || '').trim();
  name = String(name || '').trim();

  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(pid)) {
    return { success: false, error: 'Invalid Project ID. Use only letters, numbers, hyphens, and underscores (max 64 chars).' };
  }

  // Check for duplicate before acquiring lock
  if (getProjectConfig_(pid)) {
    return { success: false, error: 'Project ID "' + pid + '" already exists.' };
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);

    // Double-check inside lock
    if (getProjectConfig_(pid)) {
      lock.releaseLock();
      return { success: false, error: 'Project ID "' + pid + '" already exists.' };
    }

    // Create Master Sheet
    var masterSs = SpreadsheetApp.create('MasterSheet-' + pid);
    var masterSheet = masterSs.getSheets()[0];
    masterSheet.appendRow(['SID', 'Passcode', 'Client_ID', 'FileID', 'LastUpdate', 'Name']);

    // Create Drive folder
    var folder = DriveApp.createFolder('ChatFolder-' + pid);

    // Move master sheet into the folder
    var masterFile = DriveApp.getFileById(masterSs.getId());
    masterFile.moveTo(folder);

    // Append to Global Config Sheet
    var configSheetId = PropertiesService.getScriptProperties().getProperty('GLOBAL_CONFIG_SHEET_ID');
    var configSs = SpreadsheetApp.openById(configSheetId);
    var configSheet = configSs.getSheets()[0];
    configSheet.appendRow([pid, masterSs.getId(), folder.getId(), 'Active', name]);

    // Invalidate cache (defensive)
    CacheService.getScriptCache().remove('config_' + pid);

    lock.releaseLock();
    return { success: true };
  } catch (err) {
    try { lock.releaseLock(); } catch (e) {}
    return { success: false, error: 'Failed to create project: ' + err.message };
  }
}

/**
 * List sessions for a project (from Master Sheet only, no per-session file opens).
 * @param {string} adminKey
 * @param {string} pid
 * @returns {Object} {success, sessions: [{sid, lastUpdate}], error?}
 */
function adminListSessions(adminKey, pid) {
  var guard = adminGuard_(adminKey);
  if (!guard.ok) return { success: false, error: guard.error };

  try {
    var config = getProjectConfig_(pid);
    if (!config) return { success: false, error: 'Project not found.' };

    var masterSs = SpreadsheetApp.openById(config.masterSheetId);
    var masterSheet = masterSs.getSheets()[0];
    var data = masterSheet.getDataRange().getValues();
    var sessions = [];

    for (var i = 1; i < data.length; i++) { // Skip header
      var sid = String(data[i][0]).trim();
      if (!sid) continue;
      var lastUpdate = data[i][4];
      if (typeof lastUpdate === 'object' && lastUpdate && lastUpdate.toISOString) {
        lastUpdate = lastUpdate.toISOString();
      } else {
        lastUpdate = String(lastUpdate || '');
      }
      sessions.push({
        sid: sid,
        lastUpdate: lastUpdate,
        name: String(data[i][5] || ''),
        passcode: String(data[i][1] || '')
      });
    }

    // Sort by lastUpdate descending (most recent first)
    sessions.sort(function(a, b) {
      return b.lastUpdate.localeCompare(a.lastUpdate);
    });

    return { success: true, sessions: sessions };
  } catch (err) {
    return { success: false, error: 'Failed to list sessions: ' + err.message };
  }
}

/**
 * Generate a new chat link for a project. Pre-creates a session row in Master Sheet.
 * @param {string} adminKey
 * @param {string} pid
 * @param {string} name  Optional participant label (e.g. "P01").
 * @returns {Object} {success, url, sid, name, error?}
 */
function adminGenerateLink(adminKey, pid, name) {
  var guard = adminGuard_(adminKey);
  if (!guard.ok) return { success: false, error: guard.error };

  try {
    var config = getProjectConfig_(pid);
    if (!config) return { success: false, error: 'Project not found.' };
    if (config.status !== 'Active') return { success: false, error: 'Cannot generate link for an inactive project.' };

    name = String(name || '').trim();
    var sid = Utilities.getUuid();
    var base = PropertiesService.getScriptProperties().getProperty('WEB_APP_URL');
    if (!base) {
        base = (ScriptApp.getService() && ScriptApp.getService().getUrl()) || '';
        if (base && base.endsWith('/dev')) {
            return { success: false, error: '尚未設定部署網址 (WEB_APP_URL)。請至 Script Properties 新增 WEB_APP_URL，並填入您以 "/exec" 結尾的部署網址後再試。目前系統偵測到您正在使用 "/dev" 開發網址，該網址無法供外部參與者使用。' };
        }
    }
    base = base.trim().replace(/[?#].*$/, ''); // strip any query string or hash
    if (!base) {
      return { success: false, error: '尚未設定部署網址。請至 Script Properties 新增 WEB_APP_URL，填入您的 /exec 部署網址後再試。' };
    }

    // Pre-create session row so participant can authenticate on first visit
    var masterSs = SpreadsheetApp.openById(config.masterSheetId);
    var masterSheet = masterSs.getSheets()[0];
    masterSheet.appendRow([sid, '', '', '', new Date().toISOString(), name]);

    var url = base + '?pid=' + encodeURIComponent(pid) + '&s=' + encodeURIComponent(sid);
    return { success: true, sid: sid, url: url, name: name };
  } catch (err) {
    return { success: false, error: 'Failed to generate link: ' + err.message };
  }
}

/**
 * Fetch all messages for a session (admin view, no participant auth required).
 * @param {string} adminKey
 * @param {string} pid
 * @param {string} sid
 * @param {string} since  ISO timestamp — only return messages after this (optional).
 * @returns {Object} {success, messages: [{timestamp, role, content}], error?}
 */
function adminFetchMessages(adminKey, pid, sid, since) {
  var guard = adminGuard_(adminKey);
  if (!guard.ok) return { success: false, error: guard.error };

  try {
    var config = getProjectConfig_(pid);
    if (!config) return { success: false, error: 'Project not found.' };

    var masterSs = SpreadsheetApp.openById(config.masterSheetId);
    var masterSheet = masterSs.getSheets()[0];
    var session = lookupSession_(masterSheet, sid);

    if (!session) return { success: false, error: 'Session not found.' };
    if (!session.fileId) return { success: true, messages: [] }; // not yet activated by participant

    var ss = SpreadsheetApp.openById(session.fileId);
    var sheet = ss.getSheets()[0];
    var data = sheet.getDataRange().getValues();
    var messages = [];
    var sinceStr = since || '';

    for (var i = 1; i < data.length; i++) { // skip header
      var ts = data[i][0];
      if (typeof ts === 'object' && ts.toISOString) {
        ts = ts.toISOString();
      } else {
        ts = String(ts);
      }
      if (!sinceStr || ts > sinceStr) {
        messages.push({ timestamp: ts, role: String(data[i][1]), content: String(data[i][2]) });
      }
    }

    return { success: true, messages: messages };
  } catch (err) {
    return { success: false, error: 'Fetch error: ' + err.message };
  }
}

/**
 * Send a message as consultant into a participant's session.
 * @param {string} adminKey
 * @param {string} pid
 * @param {string} sid
 * @param {string} content
 * @returns {Object} {success, timestamp?, error?}
 */
function adminSendMessage(adminKey, pid, sid, content) {
  var guard = adminGuard_(adminKey);
  if (!guard.ok) return { success: false, error: guard.error };

  try {
    var config = getProjectConfig_(pid);
    if (!config) return { success: false, error: 'Project not found.' };
    if (config.status !== 'Active') return { success: false, error: 'Project is inactive.' };

    var masterSs = SpreadsheetApp.openById(config.masterSheetId);
    var masterSheet = masterSs.getSheets()[0];
    var session = lookupSession_(masterSheet, sid);

    if (!session) return { success: false, error: 'Session not found.' };
    if (!session.fileId) return { success: false, error: 'Session not yet activated by participant.' };

    var sanitized = sanitize_(content || '');
    if (!sanitized) return { success: false, error: 'Message is empty.' };

    var ss = SpreadsheetApp.openById(session.fileId);
    var sheet = ss.getSheets()[0];
    var now = new Date().toISOString();
    sheet.appendRow([now, 'consultant', sanitized]);

    masterSheet.getRange(session.row, 5).setValue(now);

    return { success: true, timestamp: now };
  } catch (err) {
    return { success: false, error: 'Send error: ' + err.message };
  }
}

// ==================== INTERNAL HELPERS ====================

/**
 * Verify an existing session's passcode and clientId.
 */
function verifySession_(session, params) {
  if (params.passcode !== session.passcode) {
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

  if (params.passcode !== session.passcode) {
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
 * @returns {Object|null} {row, passcode, clientId, fileId, name}
 */
function lookupSession_(masterSheet, sid) {
  var data = masterSheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) { // Skip header
    if (String(data[i][0]) === sid) {
      return {
        row: i + 1, // 1-based sheet row
        passcode: String(data[i][1]),
        clientId: String(data[i][2]),
        fileId: String(data[i][3]),
        name: String(data[i][5] || '')
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

/**
 * Shared admin authentication guard.
 * @param {string} adminKey
 * @returns {Object} {ok, error?}
 */
function adminGuard_(adminKey) {
  var stored = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
  if (!stored) return { ok: false, error: 'Admin key not configured. Set ADMIN_KEY in Script Properties.' };
  if (adminKey !== stored) return { ok: false, error: 'Unauthorized.' };
  return { ok: true };
}
