# Kanban Project Management Board (Google Apps Script)

An enterprise-grade, multi-user **Jira-lite Kanban Board** built entirely on **Google Apps Script**, backed by **Google Sheets**, with a modern UI using Tailwind CSS, SortableJS, SweetAlert2, and Chart.js.

---

## Features

| Feature | Description |
|---|---|
| 🔒 **Role-Based Access Control** | Employee / Lead / Main Lead with server-side enforcement |
| 🗂️ **Kanban Board** | 3-column drag-and-drop board (To-Do → In-Progress → Done) |
| ✅ **Done Visual Cues** | Strikethrough + opacity on completed cards |
| 💾 **Real-time Persistence** | Status changes are saved to Google Sheets instantly |
| ✨ **AI Task Breakdown** | Gemini API splits tasks into sub-tasks with smart deadlines |
| ⏰ **EOD Reminders** | Automated Google Chat webhook notifications at 4:30 PM daily |
| 📊 **Weekly Reports** | Chart.js pie chart + one-click PDF export |
| 🔍 **Lead/Main Lead Filters** | Filter by assignee or team |

---

## Technology Stack

- **Backend:** Google Apps Script (Code.gs)
- **Database:** Google Sheets (Users / Tasks / Teams)
- **Frontend:** HTML + Tailwind CSS + Vanilla JS
- **Libraries:** SortableJS · SweetAlert2 · Chart.js
- **Integrations:** Gemini API (AI) · Google Chat Webhooks

---

## Setup Instructions

### Step 1 — Create the Google Spreadsheet

1. Go to [sheets.google.com](https://sheets.google.com) and create a new spreadsheet.
2. Create **three sheets** (tabs) with the exact names and headers below.

**Sheet: `Users`**

| A: Email | B: Role | C: Team_ID |
|---|---|---|
| alice@company.com | Main Lead | 1 |
| bob@company.com | Lead | 1 |
| carol@company.com | Employee | 1 |

> Role values must be exactly: `Main Lead`, `Lead`, or `Employee`

**Sheet: `Tasks`**

| A: Task_ID | B: Title | C: Description | D: Assignee_Email | E: Status | F: Created_Date | G: Due_Date | H: Parent_Task_ID |
|---|---|---|---|---|---|---|---|

> Status values must be exactly: `To-Do`, `In-Progress`, or `Done`

**Sheet: `Teams`**

| A: Team_ID | B: Lead_Email | C: Project_Name |
|---|---|---|
| 1 | bob@company.com | Alpha Project |

---

### Step 2 — Set Up the Apps Script Project

1. Open your Google Spreadsheet.
2. Click **Extensions → Apps Script**.
3. Delete the default `Code.gs` content.
4. Copy the content of each file from this repository into matching files in the Apps Script editor:

| File | Purpose |
|---|---|
| `Code.gs` | Backend logic |
| `Index.html` | HTML shell |
| `JavaScript.html` | Frontend JS |
| `Stylesheet.html` | Custom CSS |

5. In **`Code.gs`**, update the three configuration constants at the top of the file:

```js
const SPREADSHEET_ID   = 'YOUR_SPREADSHEET_ID_HERE';    // From the Sheets URL
const CHAT_WEBHOOK_URL = 'YOUR_GOOGLE_CHAT_WEBHOOK_URL_HERE';
const GEMINI_API_KEY   = 'YOUR_GEMINI_API_KEY_HERE';
```

6. Click **Project Settings** (gear icon) → check **"Show `appsscript.json` manifest"**.
7. Replace the content of `appsscript.json` with the file from this repository.

---

### Step 3 — Get API Keys & Webhook

**Spreadsheet ID**
- Found in the URL: `https://docs.google.com/spreadsheets/d/**SPREADSHEET_ID**/edit`

**Gemini API Key**
1. Visit [Google AI Studio](https://aistudio.google.com/)
2. Click **Get API key → Create API key**
3. Copy the key into `GEMINI_API_KEY`

**Google Chat Webhook**
1. Open your Google Chat space
2. Click the space name → **Manage webhooks**
3. Click **Add webhook**, name it (e.g., "Kanban Reminders"), copy the URL
4. Paste it into `CHAT_WEBHOOK_URL`

---

### Step 4 — Deploy as a Web App

1. In Apps Script, click **Deploy → New deployment**
2. Click the gear icon next to "Select type" → choose **Web app**
3. Set:
   - **Execute as:** `User accessing the web app`
   - **Who has access:** `Anyone` (or `Anyone within your organisation`)
4. Click **Deploy** and copy the Web App URL
5. Share the URL with your team

---

### Step 5 — Enable EOD Reminders (Optional)

Run the `setupTrigger()` function once from the Apps Script editor:

1. Select `setupTrigger` from the function dropdown
2. Click **Run**
3. Authorise the required permissions

This creates a daily trigger that runs `sendEODReminders()` at 4:30 PM to notify assignees of stale in-progress tasks via Google Chat.

---

## Role Permissions Summary

| Action | Employee | Lead | Main Lead |
|---|:---:|:---:|:---:|
| View own tasks | ✅ | — | — |
| View team tasks | — | ✅ | — |
| View all tasks | — | — | ✅ |
| Create tasks | ✅ | ✅ | ✅ |
| Reassign tasks | ❌ | ✅ | ✅ |
| Delete tasks | ❌ | ✅ | ✅ |
| Filter by team | ❌ | ✅ | ✅ |
| Global dashboard | ❌ | ❌ | ✅ |

---

## File Structure

```
├── Code.gs           # Backend: CRUD, RBAC, AI, Chat, Reports
├── Index.html        # UI shell: Tailwind, Kanban columns, modals
├── JavaScript.html   # Frontend: SortableJS, google.script.run, Chart.js
├── Stylesheet.html   # Custom CSS: Done states, animations, drag styles
├── appsscript.json   # GAS manifest with OAuth scopes
└── README.md         # This file
```

---

## Architecture

```
Browser (HTML/CSS/JS)
     │
     │  google.script.run (async RPC)
     ▼
Google Apps Script (Code.gs)
     │
     ├── Google Sheets (Users / Tasks / Teams)
     ├── Gemini API (UrlFetchApp → AI sub-tasks)
     └── Google Chat Webhook (UrlFetchApp → EOD alerts)
```

---

## Security Notes

- All RBAC checks are performed **server-side** in `Code.gs` using `Session.getActiveUser().getEmail()`.
- The frontend never trusts user-supplied role claims — the backend always re-validates.
- API keys and webhook URLs are stored as script-level constants (not in the sheet) to avoid exposure.
- For production use, consider storing secrets in [Script Properties](https://developers.google.com/apps-script/guides/properties) instead of hardcoded constants.
