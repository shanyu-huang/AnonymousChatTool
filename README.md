# Secure Multi-Project Anonymous Chat Tool

A lightweight anonymous chat system built on Google Apps Script + Google Sheets. Designed for qualitative research — researchers create projects, participants join via URL. Sessions are device-bound for security.

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  Browser     │────▶│  Google Apps      │────▶│  Google Sheets      │
│  (index.html)│◀────│  Script (Code.gs) │◀────│  (Data Storage)     │
└─────────────┘     └──────────────────┘     └─────────────────────┘
   google.script.run        │
                            ▼
                    ┌──────────────────┐
                    │  Google Drive     │
                    │  (Session Files)  │
                    └──────────────────┘
```

## Setup

### 1. Create the Global Config Sheet

1. Create a new Google Sheet.
2. Name the first sheet tab "Config".
3. Add headers in Row 1: `pid | MasterSheetID | FolderID | Status | Name`
4. Copy the **Spreadsheet ID** from the URL (the long string between `/d/` and `/edit`).

### 2. Deploy the Apps Script

1. Go to [script.google.com](https://script.google.com) → New Project.
2. Replace `Code.gs` contents with the provided `Code.gs`.
3. Create a new HTML file named `index` → paste the provided `index.html`.
4. Create a new HTML file named `admin` → paste the provided `admin.html`.
5. Set the Script Properties (**File → Project settings → Script properties**):
   - `GLOBAL_CONFIG_SHEET_ID` → your Global Config Sheet ID
   - `ADMIN_KEY` → a strong secret password for the Consultant Dashboard
6. **Deploy → New deployment**:
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
7. Copy the deployment URL.

### 3. Share Permissions

The deployer's Google account needs:
- **Edit access** to the Global Config Sheet.
- Projects created via the dashboard automatically grant access (they are created under the deployer's account).

### 4. Create Projects (via Dashboard — recommended)

Open `{deployment_url}?mode=admin` in your browser, sign in with your `ADMIN_KEY`, and use the **New Project** button. The dashboard automatically creates the Master Sheet and Drive folder — no manual steps needed.

**Manual alternative** (if needed): Create a Master Sheet with headers `SID | Passcode | Client_ID | FileID | LastUpdate`, create a Drive folder, and add a row to the Global Config Sheet:

| pid | MasterSheetID | FolderID | Status | Name |
|-----|---------------|----------|--------|------|
| my-project | (Master Sheet ID) | (Folder ID) | Active | My Research Project |

## Usage

### URL Format

```
https://script.google.com/macros/s/{DEPLOYMENT_ID}/exec?pid=PROJECT_ID&sid=SESSION_ID
```

- `pid` — Project ID (must match a row in Global Config).
- `sid` — Session ID (any unique string per conversation).

### Participant Flow

1. Open the URL → enter a passcode and select role.
2. Chat interface appears. Messages poll every 5 seconds.
3. The session is bound to this browser/device. Clearing localStorage or switching devices will lock you out.

### Consultant Dashboard

Open `{deployment_url}?mode=admin` and sign in with your `ADMIN_KEY`.

| Feature | How |
|---------|-----|
| Create a project | Click **+ New Project**, fill in Project ID and optional display name |
| View sessions | Click **View →** on a project row |
| Generate participant link | Click **+ Generate Link** inside a project, copy the URL |

### Researcher Workflow

1. Open the dashboard → create a project → click **+ Generate Link** for each participant.
2. Share the generated URL via email/messaging.
3. All chat data is stored in Google Sheets within the project's Drive folder.

## Testing

1. **Normal window**: Open `?pid=test&sid=001`, enter passcode "abc123", select "consultant".
2. **Same window refresh**: Should auto-reconnect without re-entering passcode.
3. **Incognito window**: Open the same URL, enter the same passcode "abc123" → should see **"Access Denied: Session locked to another device."** (different `client_id`).
4. **XSS test**: Send `<script>alert(1)</script>` as a message → should render as plain text.

## Deactivating a Project

Set the `Status` column to `Inactive` in the Global Config Sheet. All access is immediately blocked (within the 5-minute cache TTL).

## Limitations

- **GAS execution time**: Max 6 minutes per call (not an issue for chat operations).
- **GAS quotas**: Consumer accounts have daily limits on Sheets read/write. For heavy usage, consider a Workspace account.
- **Polling latency**: Messages appear within 5 seconds (not real-time).
- **No push notifications**: Participants must keep the tab open.
