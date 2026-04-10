# Development Log — Anonymous Chat Tool

## v1.1 — Consultant Dashboard (2026-04-09)

### New Files
- `admin.html` — Consultant Dashboard SPA (3 screens: Login, Project List, Session List)

### Code.gs Additions
- `doGet`: added `?mode=admin` routing branch
- New public functions: `adminAuthenticate`, `adminListProjects`, `adminCreateProject`, `adminListSessions`, `adminGenerateLink`
- New helper: `adminGuard_(adminKey)` — stateless admin auth on every privileged call
- Script Property added: `ADMIN_KEY`

### Data Architecture Change
Global Config Sheet gains optional column E `Name`.
`getProjectConfig_` is unchanged (reads columns 0–3 only). Zero regression on existing chat sessions.

### Admin Flow Diagrams

#### Page Load — Dashboard
```
Browser GET ?mode=admin
  │
  ▼
doGet(e)
  └── mode === 'admin' → serve admin.html
        (no pid/sid validation, no project lookup)
```

#### Admin Authentication
```
Frontend: localStorage.getItem('consultant_auth')
  │
  ├── Key found → silent adminAuthenticate(key)
  │     ├── PASS → show Project List
  │     └── FAIL → clear localStorage, show Login screen
  │
  └── No key → show Login screen
        │
        └── User enters key → adminAuthenticate(key)
              ├── PASS → localStorage.setItem + show Project List
              └── FAIL → inline error, nothing stored
```

#### Create Project
```
Frontend: adminCreateProject(key, pid, name)
  │
  ▼
adminGuard_(key) → verify ADMIN_KEY property
  │
  ├── FAIL → {error: 'Unauthorized'}
  └── PASS
        ├── Validate pid regex: /^[a-zA-Z0-9_-]{1,64}$/
        ├── getProjectConfig_(pid) → duplicate check
        ├── Acquire LockService
        │     └── Re-check inside lock (double-check pattern)
        ├── SpreadsheetApp.create('MasterSheet-{pid}') + set headers
        ├── DriveApp.createFolder('ChatFolder-{pid}')
        ├── masterFile.moveTo(folder)
        ├── configSheet.appendRow([pid, masterSheetId, folderId, 'Active', name])
        ├── CacheService.remove('config_' + pid)
        └── Return {success: true}
```

#### Generate Link
```
Frontend: adminGenerateLink(key, pid)
  │
  ▼
adminGuard_(key) → verify ADMIN_KEY
getProjectConfig_(pid) → must be Active
  │
  └── sid = Utilities.getUuid()
      base = ScriptApp.getService().getUrl()
      url = base + '?pid=...&s=...'
      Return {success, url, sid}
      (NO Master Sheet write — session created lazily on first authenticate())
```

### Security Model Addition

```
┌──────────────────────────────────────────────────┐
│              ADMIN SECURITY LAYER                │
├──────────────────────────────────────────────────┤
│                                                  │
│  Admin key:  ADMIN_KEY Script Property           │
│              Verified server-side on every call  │
│              localStorage copy = convenience     │
│              only, never trusted by server       │
│                                                  │
│  Responses:  pid, name, status, sid, lastUpdate  │
│              only — no MasterSheetID, FolderID,  │
│              or FileID sent to client            │
│                                                  │
│  ?mode=admin URL is not secret — key gate        │
│  protects data. Only use on trusted devices.     │
│                                                  │
└──────────────────────────────────────────────────┘
```

### Updated File Map

```
AnonymousChatTool/
├── Code.gs          Backend: doGet (+admin branch), chat functions, admin functions
├── index.html       Participant chat UI (unchanged)
├── admin.html       Consultant Dashboard — Login, Project List, Session List
├── README.md        Setup and usage (updated with dashboard instructions)
└── DEVELOPMENT.md   This file
```

### Testing Scenarios (v1.1 additions)

| # | Scenario | Expected Result |
|---|----------|-----------------|
| 9 | Open `?mode=admin` | Dashboard login screen |
| 10 | Enter wrong admin key | Inline error, no localStorage write |
| 11 | Enter correct admin key | Project list loads |
| 12 | Create project with duplicate pid | Error shown in modal, modal stays open |
| 13 | Create project with invalid pid (spaces/special chars) | Client-side error before server call |
| 14 | Generate link for active project | URL appears with correct pid/sid |
| 15 | Open generated URL in browser | Chat auth screen with correct pid/sid |
| 16 | Generate link for inactive project | Server returns error "Cannot generate link for an inactive project." |
| 17 | Sign out | localStorage cleared, returns to login |
| 18 | Dev vs prod deployment | Note: `ScriptApp.getService().getUrl()` returns the URL of the current deployment. Use production deployment URL for participant links. |

---

## v1.0 — Initial Implementation (2026-04-09)

### Data Flow Diagrams

#### Page Load

```
Browser GET ?pid=X&s=Y
  │
  ▼
doGet(e)
  ├── getProjectConfig_(pid)
  │     └── Global Config Sheet (cached 5min)
  ├── Status != "Active"? → Error page
  └── Serve index.html template
        └── Inject pid, sid as template variables
```

#### Authentication (The Guard)

```
Frontend: google.script.run.authenticate({pid, sid, passcode, clientId})
  │
  ▼
getProjectConfig_(pid) → validate Active
  │
  ▼
lookupSession_(masterSheet, sid)
  │
  ├── SID NOT found (new session):
  │     ├── Acquire LockService (prevent race)
  │     ├── Re-check SID (double-check after lock)
  │     ├── hashPasscode_(passcode) → SHA-256
  │     ├── createSessionSheet_(folderId, pid, sid)
  │     │     ├── SpreadsheetApp.create("Chat-{pid}-{sid}")
  │     │     ├── Set headers [Timestamp, Role, Content]
  │     │     └── file.moveTo(folder)
  │     ├── masterSheet.appendRow([sid, hash, clientId, fileId, now])
  │     └── Return {success: true, isNew: true}
  │
  └── SID found (returning user):
        ├── hash(passcode) == stored_hash?
        │     └── NO → {error: "Invalid passcode"}
        ├── clientId == stored_clientId?
        │     └── NO → {error: "Access Denied: Session locked to another device."}
        └── BOTH match → {success: true, isNew: false}
```

#### Send Message

```
Frontend: google.script.run.sendMessage({pid, sid, passcode, clientId, role, content})
  │
  ▼
authGuard_(params) → verify credentials
  │
  ├── FAIL → return error
  └── PASS
        ├── sanitize_(content) → escape HTML, truncate 2000 chars
        ├── Open session sheet by FileID
        ├── sheet.appendRow([now, role, sanitizedContent])
        ├── Update LastUpdate in Master Sheet
        └── Return {success: true, timestamp}
```

#### Fetch Messages (Polling)

```
Frontend: setInterval(5000) → google.script.run.fetchMessages({..., since})
  │
  ▼
authGuard_(params) → verify credentials
  │
  ├── FAIL → return error (trigger "Access Denied" handling)
  └── PASS
        ├── Open session sheet by FileID
        ├── Read all rows where Timestamp > since
        └── Return {success: true, messages: [...]}
```

### Security Model

```
┌─────────────────────────────────────────────────┐
│                  SECURITY LAYERS                 │
├─────────────────────────────────────────────────┤
│                                                  │
│  1. Project Gate                                 │
│     └── pid must exist + Status == "Active"      │
│                                                  │
│  2. Session Authentication (The Guard)           │
│     ├── Passcode: SHA-256 hashed, never stored   │
│     │   in plaintext                             │
│     └── Client_ID: UUID bound to localStorage    │
│         = device/browser binding                 │
│                                                  │
│  3. XSS Prevention (Defense in Depth)            │
│     ├── Server: sanitize_() before Sheet write   │
│     └── Client: textContent (not innerHTML)      │
│                                                  │
│  4. Race Condition Prevention                    │
│     └── LockService around session registration  │
│                                                  │
│  5. No Secrets in Frontend                       │
│     └── SheetIDs, FolderIDs, FileIDs stay        │
│         server-side only                         │
│                                                  │
└─────────────────────────────────────────────────┘
```

### Design Decisions

| Decision | Rationale |
|----------|-----------|
| `google.script.run` over `fetch`+`doPost` | HtmlService pages face CORS redirects through `googleusercontent.com`. `google.script.run` is the native, CORS-free channel. |
| SHA-256 (not bcrypt) | GAS has no bcrypt. `Utilities.computeDigest` SHA-256 is the best available. Passcodes are shared session secrets, not personal passwords. |
| Individual Spreadsheets per session | Better isolation than tabs in one workbook. Avoids GAS concurrency limits on a single Spreadsheet. Cleaner Drive organization. |
| CacheService for config lookups | Polling every 5s from N clients = many config reads. 5-min cache TTL keeps it fast without hitting Sheets API quotas. |
| Optimistic UI for sending | GAS round-trip is 1-3s. Showing the message immediately makes the chat feel responsive. |
| `textContent` (not `innerHTML`) | Built-in XSS safety. No need for a client-side escape function when setting text. Server-side `sanitize_()` is the second layer for data-at-rest safety. |
| LockService for registration | Two browsers submitting the same SID simultaneously could create duplicate sessions. Lock + re-check pattern prevents this. |

### File Map

```
AnonymousChatTool/
├── Code.gs          Backend: doGet, authenticate, sendMessage, fetchMessages + helpers
├── index.html       Frontend: auth screen, chat UI, polling, state management
├── README.md        Setup and usage instructions
└── DEVELOPMENT.md   This file — architecture, decisions, security model
```

### Testing Scenarios

| # | Scenario | Expected Result |
|---|----------|-----------------|
| 1 | New session: open URL, enter passcode | Registers SID, creates session sheet, enters chat |
| 2 | Returning user: refresh same browser | Auto-authenticates, loads message history |
| 3 | Wrong passcode on existing SID | "Invalid passcode" error |
| 4 | Same SID+passcode, different browser | "Access Denied: Session locked to another device." |
| 5 | Send message with `<script>` tag | Rendered as plain text, not executed |
| 6 | Project Status set to "Inactive" | All operations return "Project is inactive" |
| 7 | Two users (different SIDs) in same project | Each sees only their own session messages |
| 8 | Rapid concurrent registration (same SID) | LockService prevents duplicate rows |

### Future Considerations

- **Webhook/Push**: Replace polling with a push mechanism if GAS adds WebSocket support.
- **Message deletion**: Admin function to clear session sheets.
- **Export**: Bulk export all sessions in a project to CSV/JSON.
- **Rate limiting**: Add per-client rate limits if abuse is a concern.
