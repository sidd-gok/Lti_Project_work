/**
 * =============================================================================
 * JIRA-LITE KANBAN BOARD - Google Apps Script Backend (Code.gs)
 * =============================================================================
 *
 * SETUP INSTRUCTIONS:
 * -------------------
 * 1. Open Google Sheets and create a new spreadsheet.
 * 2. Create the following sheets (tabs) with exact column headers:
 *
 *    Sheet: "Users"
 *      A1: Email  |  B1: Role  |  C1: Team_ID
 *      Role values: "Main Lead", "Lead", "Trainee"
 *
 *    Sheet: "Tasks"
 *      A1: Task_ID  |  B1: Title  |  C1: Description  |  D1: Assignee_Email
 *      E1: Status   |  F1: Created_Date  |  G1: Due_Date  |  H1: Parent_Task_ID
 *      Status values: "To-Do", "In-Progress", "Done"
 *
 *    Sheet: "Teams"
 *      A1: Team_ID  |  B1: Lead_Email  |  C1: Project_Name
 *
 * 3. In Apps Script Editor (Extensions > Apps Script):
 *    - Paste this code into Code.gs
 *    - Set the SPREADSHEET_ID constant below to your Spreadsheet's ID
 *    - Set CHAT_WEBHOOK_URL to your Google Chat space webhook URL
 *    - Set GEMINI_API_KEY to your Gemini API key (from Google AI Studio)
 *
 * 4. Deploy as Web App:
 *    Deploy > New deployment > Web app
 *    Execute as: User accessing the web app
 *    Who has access: Anyone in your organization (or Anyone)
 *
 * 5. To enable EOD reminders, run setupTrigger() once from the Apps Script editor.
 * =============================================================================
 */

// ─── CONFIGURATION ────────────────────────────────────────────────────────────

/** Replace with your Google Spreadsheet ID (from the URL) */
const SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID_HERE';

/**
 * Google Chat Webhook URL for EOD reminders.
 * Get it from: Google Chat Space > Manage Webhooks > Add Webhook
 */
const CHAT_WEBHOOK_URL = 'YOUR_GOOGLE_CHAT_WEBHOOK_URL_HERE';

/**
 * Gemini API key from Google AI Studio (https://aistudio.google.com/)
 */
const GEMINI_API_KEY = 'YOUR_GEMINI_API_KEY_HERE';

/** Gemini model endpoint */
const GEMINI_API_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' +
  GEMINI_API_KEY;

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────

/**
 * Serves the web application HTML page.
 * @returns {HtmlOutput} The rendered HTML page.
 */
function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Kanban Project Board')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Helper: include a sub-file (HTML/CSS/JS partials) into the Index template.
 * Usage in HTML: <?!= include('Stylesheet') ?>
 * @param {string} filename - Name of the .html file to include (without extension).
 * @returns {string} Raw HTML/CSS/JS content.
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ─── SPREADSHEET HELPERS ──────────────────────────────────────────────────────

/**
 * Returns the active spreadsheet.
 * @returns {GoogleAppsScript.Spreadsheet.Spreadsheet}
 */
function getSpreadsheet() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

/**
 * Returns a named sheet.
 * @param {string} name - Sheet tab name.
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getSheet(name) {
  return getSpreadsheet().getSheetByName(name);
}

/**
 * Converts a sheet's data (excluding header row) to an array of plain objects.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @returns {Object[]}
 */
function sheetToObjects(sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  return data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

/**
 * Generates a unique Task ID using timestamp + random suffix.
 * @returns {string}
 */
function generateTaskId() {
  return 'TASK-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
}

// ─── AUTHENTICATION & RBAC ────────────────────────────────────────────────────

/**
 * Returns the currently authenticated user's email.
 * @returns {string}
 */
function getCurrentUserEmail() {
  return Session.getActiveUser().getEmail();
}

/**
 * Looks up the current user's role and team from the Users sheet.
 * @returns {{ email: string, role: string, teamId: string } | null}
 */
function getCurrentUserInfo() {
  const email = getCurrentUserEmail();
  const users = sheetToObjects(getSheet('Users'));
  const user = users.find(u => u['Email'] === email);
  if (!user) return null;
  return {
    email: email,
    role: user['Role'],
    teamId: String(user['Team_ID'])
  };
}

/**
 * Exposed to the frontend: returns current user's info for UI personalization.
 * @returns {{ email: string, role: string, teamId: string } | null}
 */
function getUserInfo() {
  return getCurrentUserInfo();
}

// ─── TASK CRUD ────────────────────────────────────────────────────────────────

/**
 * Fetches tasks according to the current user's role:
 *   - Trainee   → only their own assigned tasks
 *   - Lead      → all tasks from every project/team where they are the Lead
 *   - Main Lead → all tasks in the system
 *
 * @returns {Object[]} Array of task objects.
 */
function getTasks() {
  const userInfo = getCurrentUserInfo();
  if (!userInfo) return [];

  const tasks = sheetToObjects(getSheet('Tasks'));

  if (userInfo.role === 'Main Lead') {
    return tasks;
  }

  if (userInfo.role === 'Lead') {
    // Find every project/team where this user is assigned as Lead
    const users = sheetToObjects(getSheet('Users'));
    const teams = sheetToObjects(getSheet('Teams'));
    const ledTeamIds = teams
      .filter(t => t['Lead_Email'] === userInfo.email)
      .map(t => String(t['Team_ID']));
    const teamEmails = users
      .filter(u => ledTeamIds.includes(String(u['Team_ID'])))
      .map(u => u['Email']);
    return tasks.filter(t => teamEmails.includes(t['Assignee_Email']));
  }

  // Trainee: only own tasks
  return tasks.filter(t => t['Assignee_Email'] === userInfo.email);
}

/**
 * Creates a new task and appends it to the Tasks sheet.
 * @param {Object} taskData - { title, description, assigneeEmail, dueDate, parentTaskId }
 * @returns {{ success: boolean, taskId: string }}
 */
function createTask(taskData) {
  const userInfo = getCurrentUserInfo();
  if (!userInfo) return { success: false, error: 'Not authenticated' };

  // Trainees can only create tasks for themselves
  const assignee = (userInfo.role === 'Trainee')
    ? userInfo.email
    : (taskData.assigneeEmail || userInfo.email);

  const taskId = generateTaskId();
  const now = new Date();

  getSheet('Tasks').appendRow([
    taskId,
    taskData.title || 'Untitled Task',
    taskData.description || '',
    assignee,
    'To-Do',
    now,
    taskData.dueDate ? new Date(taskData.dueDate) : '',
    taskData.parentTaskId || ''
  ]);

  return { success: true, taskId: taskId };
}

/**
 * Updates a task's status (drag-and-drop persistence).
 * Trainees can only update their own tasks; Leads can update team tasks.
 * @param {string} taskId
 * @param {string} newStatus - 'To-Do' | 'In-Progress' | 'Done'
 * @returns {{ success: boolean }}
 */
function updateTaskStatus(taskId, newStatus) {
  const validStatuses = ['To-Do', 'In-Progress', 'Done'];
  if (!validStatuses.includes(newStatus)) {
    return { success: false, error: 'Invalid status' };
  }

  const userInfo = getCurrentUserInfo();
  if (!userInfo) return { success: false, error: 'Not authenticated' };

  const sheet = getSheet('Tasks');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const taskIdCol = headers.indexOf('Task_ID');
  const statusCol = headers.indexOf('Status');
  const assigneeCol = headers.indexOf('Assignee_Email');

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][taskIdCol]) === String(taskId)) {
      // RBAC check
      if (userInfo.role === 'Trainee' && data[i][assigneeCol] !== userInfo.email) {
        return { success: false, error: 'Permission denied' };
      }
      sheet.getRange(i + 1, statusCol + 1).setValue(newStatus);
      return { success: true };
    }
  }
  return { success: false, error: 'Task not found' };
}

/**
 * Updates full task details (title, description, assignee, dueDate).
 * Leads and Main Lead can reassign tasks.
 * @param {Object} taskData - { taskId, title, description, assigneeEmail, dueDate }
 * @returns {{ success: boolean }}
 */
function updateTask(taskData) {
  const userInfo = getCurrentUserInfo();
  if (!userInfo) return { success: false, error: 'Not authenticated' };

  const sheet = getSheet('Tasks');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const taskIdCol  = headers.indexOf('Task_ID');
  const titleCol   = headers.indexOf('Title');
  const descCol    = headers.indexOf('Description');
  const assignCol  = headers.indexOf('Assignee_Email');
  const dueDateCol = headers.indexOf('Due_Date');

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][taskIdCol]) === String(taskData.taskId)) {
      // RBAC: Trainees can only edit tasks assigned to them
      if (userInfo.role === 'Trainee' && data[i][assignCol] !== userInfo.email) {
        return { success: false, error: 'Permission denied' };
      }

      // Trainees cannot reassign tasks
      const newAssignee = (userInfo.role === 'Trainee')
        ? data[i][assignCol]
        : (taskData.assigneeEmail || data[i][assignCol]);

      if (taskData.title)       sheet.getRange(i + 1, titleCol + 1).setValue(taskData.title);
      if (taskData.description !== undefined)
                                sheet.getRange(i + 1, descCol + 1).setValue(taskData.description);
      sheet.getRange(i + 1, assignCol + 1).setValue(newAssignee);
      if (taskData.dueDate)     sheet.getRange(i + 1, dueDateCol + 1).setValue(new Date(taskData.dueDate));

      return { success: true };
    }
  }
  return { success: false, error: 'Task not found' };
}

/**
 * Deletes a task row. Only Main Lead or Lead (for their team) can delete.
 * @param {string} taskId
 * @returns {{ success: boolean }}
 */
function deleteTask(taskId) {
  const userInfo = getCurrentUserInfo();
  if (!userInfo) return { success: false, error: 'Not authenticated' };
  if (userInfo.role === 'Trainee') return { success: false, error: 'Permission denied' };

  const sheet = getSheet('Tasks');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const taskIdCol  = headers.indexOf('Task_ID');
  const assigneeCol = headers.indexOf('Assignee_Email');

  // Pre-build the set of visible member emails for Lead scope check
  let visibleEmails = null;
  if (userInfo.role === 'Lead') {
    const users = sheetToObjects(getSheet('Users'));
    const teams = sheetToObjects(getSheet('Teams'));
    const ledTeamIds = new Set(
      teams.filter(t => t['Lead_Email'] === userInfo.email).map(t => String(t['Team_ID']))
    );
    visibleEmails = new Set(
      users.filter(u => ledTeamIds.has(String(u['Team_ID']))).map(u => u['Email'])
    );
  }

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][taskIdCol]) === String(taskId)) {
      // Leads may only delete tasks assigned to members of their project(s)
      if (visibleEmails && !visibleEmails.has(data[i][assigneeCol])) {
        return { success: false, error: 'Permission denied' };
      }
      sheet.deleteRow(i + 1);
      return { success: true };
    }
  }
  return { success: false, error: 'Task not found' };
}

// ─── TEAM & USER HELPERS ──────────────────────────────────────────────────────

/**
 * Returns the list of team members (email + role) visible to the current user.
 * Main Lead sees all users; Lead sees all their project members; Trainee sees only themselves.
 * @returns {Object[]}
 */
function getTeamMembers() {
  const userInfo = getCurrentUserInfo();
  if (!userInfo) return [];

  const users = sheetToObjects(getSheet('Users'));

  if (userInfo.role === 'Main Lead') return users;

  if (userInfo.role === 'Lead') {
    // Return members from every project/team where this user is the Lead
    const teams = sheetToObjects(getSheet('Teams'));
    const ledTeamIds = teams
      .filter(t => t['Lead_Email'] === userInfo.email)
      .map(t => String(t['Team_ID']));
    return users.filter(u => ledTeamIds.includes(String(u['Team_ID'])));
  }

  return users.filter(u => u['Email'] === userInfo.email);
}

/**
 * Returns all teams (for Main Lead dropdowns).
 * @returns {Object[]}
 */
function getTeams() {
  const userInfo = getCurrentUserInfo();
  if (!userInfo || userInfo.role !== 'Main Lead') return [];
  return sheetToObjects(getSheet('Teams'));
}

// ─── REPORTING ────────────────────────────────────────────────────────────────

/**
 * Generates a weekly report for the current user's visible scope.
 * Returns task counts (completed vs pending) broken down by assignee.
 * @returns {{ summary: Object[], chartData: Object, weekRange: string }}
 */
function getWeeklyReport() {
  const tasks = getTasks();
  const now = new Date();

  // Week range: Monday to Sunday of the current week
  const day = now.getDay();
  const diffToMonday = (day === 0) ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  const weekTasks = tasks.filter(t => {
    const created = new Date(t['Created_Date']);
    return created >= monday && created <= sunday;
  });

  // Aggregate by status
  const done      = weekTasks.filter(t => t['Status'] === 'Done').length;
  const inProgress = weekTasks.filter(t => t['Status'] === 'In-Progress').length;
  const todo      = weekTasks.filter(t => t['Status'] === 'To-Do').length;

  // Per-assignee breakdown
  const byAssignee = {};
  weekTasks.forEach(t => {
    const key = t['Assignee_Email'] || 'Unassigned';
    if (!byAssignee[key]) byAssignee[key] = { done: 0, inProgress: 0, todo: 0 };
    if (t['Status'] === 'Done')        byAssignee[key].done++;
    else if (t['Status'] === 'In-Progress') byAssignee[key].inProgress++;
    else                               byAssignee[key].todo++;
  });

  const summary = Object.entries(byAssignee).map(([email, counts]) => ({
    email, ...counts, total: counts.done + counts.inProgress + counts.todo
  }));

  const weekRange =
    monday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ' – ' +
    sunday.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return {
    summary,
    chartData: { done, inProgress, todo, total: weekTasks.length },
    weekRange
  };
}

/**
 * Generates an HTML report and converts it to a PDF blob for download.
 * Returns the PDF as a base64-encoded string.
 * @returns {{ success: boolean, base64: string, filename: string }}
 */
function generateReportPDF() {
  const report = getWeeklyReport();
  const userInfo = getCurrentUserInfo();

  // Build minimal HTML for the PDF
  const rows = report.summary.map(s =>
    `<tr>
       <td>${s.email}</td>
       <td>${s.done}</td>
       <td>${s.inProgress}</td>
       <td>${s.todo}</td>
       <td>${s.total}</td>
     </tr>`
  ).join('');

  const html = `
    <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; padding: 24px; color: #1a1a2e; }
          h1   { color: #4F46E5; }
          table { border-collapse: collapse; width: 100%; margin-top: 16px; }
          th, td { border: 1px solid #e2e8f0; padding: 8px 12px; text-align: left; }
          th    { background: #4F46E5; color: white; }
          tr:nth-child(even) { background: #f8fafc; }
          .meta { color: #64748b; font-size: 13px; margin-top: 4px; }
        </style>
      </head>
      <body>
        <h1>Weekly Task Report</h1>
        <p class="meta">Period: ${report.weekRange}</p>
        <p class="meta">Generated by: ${userInfo ? userInfo.email : 'System'}</p>
        <table>
          <thead>
            <tr>
              <th>Assignee</th>
              <th>Done</th>
              <th>In-Progress</th>
              <th>To-Do</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="margin-top:24px;">
          <strong>Summary:</strong>
          Done: ${report.chartData.done} |
          In-Progress: ${report.chartData.inProgress} |
          To-Do: ${report.chartData.todo} |
          Total: ${report.chartData.total}
        </p>
      </body>
    </html>`;

  const blob = HtmlService.createHtmlOutput(html)
    .getBlob()
    .setName('weekly_report.html');

  // Convert to PDF via Drive
  const file = DriveApp.createFile(blob);
  const pdfBlob = file.getAs('application/pdf');
  const base64  = Utilities.base64Encode(pdfBlob.getBytes());
  file.setTrashed(true); // clean up temp file

  return {
    success: true,
    base64: base64,
    filename: 'Weekly_Report_' + new Date().toISOString().split('T')[0] + '.pdf'
  };
}

// ─── GEMINI AI TASK CHUNKING ──────────────────────────────────────────────────

/**
 * Calls the Gemini API to suggest sub-task breakdown for a task description.
 * @param {string} title       - Task title.
 * @param {string} description - Task description.
 * @param {string} dueDate     - Due date string (YYYY-MM-DD).
 * @returns {{ success: boolean, subtasks: Array<{ title: string, deadline: string, description: string }> }}
 */
function getAITaskSuggestions(title, description, dueDate) {
  if (!GEMINI_API_KEY || GEMINI_API_KEY === 'YOUR_GEMINI_API_KEY_HERE') {
    return { success: false, error: 'Gemini API key not configured.' };
  }

  const today = new Date().toISOString().split('T')[0];
  const prompt = `You are a project management assistant.
Break the following task into 3-5 actionable sub-tasks with intermediate deadlines.

Task Title: ${title}
Description: ${description}
Start Date: ${today}
Due Date: ${dueDate}

Respond ONLY with a valid JSON array. Each element must have these fields:
- "title": short sub-task name
- "description": brief description of the sub-task
- "deadline": ISO date string (YYYY-MM-DD) between today and the due date

Example format:
[
  { "title": "...", "description": "...", "deadline": "YYYY-MM-DD" },
  ...
]`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 800 }
  };

  try {
    const response = UrlFetchApp.fetch(GEMINI_API_URL, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const json = JSON.parse(response.getContentText());

    if (json.error) {
      return { success: false, error: json.error.message };
    }

    // Extract the text and parse the embedded JSON
    const text = json.candidates[0].content.parts[0].text;
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return { success: false, error: 'Could not parse AI response.' };

    const subtasks = JSON.parse(jsonMatch[0]);
    return { success: true, subtasks: subtasks };

  } catch (e) {
    return { success: false, error: 'AI request failed: ' + e.message };
  }
}

/**
 * Creates sub-tasks from accepted AI suggestions.
 * @param {string} parentTaskId  - The parent task's ID.
 * @param {string} assigneeEmail - The assignee email.
 * @param {Array}  subtasks      - Array of { title, description, deadline }.
 * @returns {{ success: boolean, created: number }}
 */
function createSubtasksFromAI(parentTaskId, assigneeEmail, subtasks) {
  const userInfo = getCurrentUserInfo();
  if (!userInfo) return { success: false, error: 'Not authenticated' };

  let created = 0;
  subtasks.forEach(sub => {
    const result = createTask({
      title: sub.title,
      description: sub.description,
      assigneeEmail: assigneeEmail,
      dueDate: sub.deadline,
      parentTaskId: parentTaskId
    });
    if (result.success) created++;
  });

  return { success: true, created: created };
}

// ─── EOD GOOGLE CHAT REMINDERS ────────────────────────────────────────────────

/**
 * Time-driven trigger: sends EOD reminders via Google Chat webhook for any
 * "In-Progress" tasks whose assignees haven't updated them today.
 *
 * To activate: run setupTrigger() once from the Apps Script editor.
 * Schedule: runs daily at 4:30 PM (see setupTrigger).
 */
function sendEODReminders() {
  if (!CHAT_WEBHOOK_URL || CHAT_WEBHOOK_URL === 'YOUR_GOOGLE_CHAT_WEBHOOK_URL_HERE') {
    Logger.log('Chat webhook URL not configured. Skipping EOD reminders.');
    return;
  }

  const tasks = sheetToObjects(getSheet('Tasks'));
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const staleInProgress = tasks.filter(t => {
    if (t['Status'] !== 'In-Progress') return false;
    // Check if the task was last modified today (use Created_Date as proxy if no modified column)
    const created = new Date(t['Created_Date']);
    created.setHours(0, 0, 0, 0);
    // Flag as stale if NOT created/modified today
    return created.getTime() !== today.getTime();
  });

  if (staleInProgress.length === 0) {
    Logger.log('No stale in-progress tasks found for EOD reminder.');
    return;
  }

  // Group by assignee
  const byAssignee = {};
  staleInProgress.forEach(t => {
    const email = t['Assignee_Email'];
    if (!byAssignee[email]) byAssignee[email] = [];
    byAssignee[email].push(t);
  });

  // Send one aggregated message per assignee
  Object.entries(byAssignee).forEach(([email, assigneeTasks]) => {
    const taskList = assigneeTasks.map(t =>
      `• *${t['Title']}* (Due: ${t['Due_Date'] ? new Date(t['Due_Date']).toLocaleDateString() : 'N/A'})`
    ).join('\n');

    const message = {
      cards: [{
        header: {
          title: '⏰ EOD Kanban Reminder',
          subtitle: `Hi ${email} — Please update your board before logging off!`,
          imageUrl: 'https://www.gstatic.com/images/branding/product/1x/tasks_48dp.png'
        },
        sections: [{
          widgets: [{
            textParagraph: {
              text: `You have <b>${assigneeTasks.length}</b> task(s) still marked as <b>In-Progress</b> that haven't been updated today:\n\n${taskList}`
            }
          }, {
            textParagraph: {
              text: 'Please move completed tasks to <b>Done</b> or add a comment with your progress. 🙏'
            }
          }]
        }]
      }]
    };

    try {
      UrlFetchApp.fetch(CHAT_WEBHOOK_URL, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(message),
        muteHttpExceptions: true
      });
      Logger.log('EOD reminder sent to: ' + email);
    } catch (e) {
      Logger.log('Failed to send reminder to ' + email + ': ' + e.message);
    }
  });
}

// ─── TRIGGER SETUP ───────────────────────────────────────────────────────────

/**
 * Run this function ONCE from the Apps Script editor to create the daily
 * 4:30 PM time-driven trigger for EOD reminders.
 * (Triggers > Add Trigger, OR run this function manually.)
 */
function setupTrigger() {
  // Remove existing triggers for sendEODReminders to avoid duplicates
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === 'sendEODReminders') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('sendEODReminders')
    .timeBased()
    .everyDays(1)
    .atHour(16)        // 4 PM; GAS rounds to the nearest half-hour
    .nearMinute(30)
    .create();

  Logger.log('EOD reminder trigger created successfully.');
}
