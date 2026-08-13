/**
 * ============================================================
 * APPS SCRIPT SELF-BACKUP
 *
 * Lives in its own standalone project — it never touches the code
 * it is backing up. Add a project to TARGETS and it gets copied to
 * Drive on a weekly trigger, keeping the last 20 of each.
 *
 * Setup: backend/README.md, Option C.
 * ============================================================
 */

/** Every project to back up. Script ID: editor -> Project Settings -> Script ID. */
var TARGETS = [
  { name: 'Salon Asteria Inventory',  scriptId: 'PASTE_ASTERIA_SCRIPT_ID_HERE' },
  { name: 'Tonette Godard Assessment', scriptId: '1qMIihWGEDMgzc0fNe9mY4cwankuxVOW6AaV9Woh_X4ZAaXb26upBG3hx' },
  { name: 'Brett Ross Assessment',     scriptId: '15C-8BiwhZLPJ1RuZuzR9Dh5qYYMRpixOeDeWIZ5krm5cFpyReoSexDrN' }
];

var ROOT_FOLDER = 'Apps Script Backups';
var KEEP = 20;

/**
 * Run this by hand once to authorise. After that the trigger runs it.
 * One failing project does not stop the others.
 */
function backupAllProjects() {
  var root = folder_(DriveApp.getRootFolder(), ROOT_FOLDER);
  var ok = [], failed = [];

  TARGETS.forEach(function (t) {
    if (!t.scriptId || t.scriptId.indexOf('PASTE_') === 0) return;   // not filled in yet
    try {
      backupOne_(t, root);
      ok.push(t.name);
    } catch (err) {
      failed.push(t.name + ' — ' + err.message);
    }
  });

  Logger.log('Backed up: ' + (ok.join(', ') || 'nothing'));
  if (failed.length) Logger.log('FAILED: ' + failed.join(' | '));
  if (failed.length && !ok.length) throw new Error(failed.join(' | '));
}

function backupOne_(target, root) {
  var res = UrlFetchApp.fetch(
    'https://script.googleapis.com/v1/projects/' + target.scriptId + '/content',
    { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true }
  );

  var code = res.getResponseCode();
  if (code === 403) {
    throw new Error('403 — turn the Apps Script API on at script.google.com/home/usersettings');
  }
  if (code === 404) {
    throw new Error('404 — wrong Script ID, or this account cannot open that project');
  }
  if (code !== 200) {
    throw new Error('HTTP ' + code + ': ' + res.getContentText().slice(0, 200));
  }

  var body = res.getContentText();
  var dir = folder_(root, target.name);
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HHmm');

  // Skip if nothing has changed since the last copy — keeps the folder
  // meaningful instead of 20 identical files.
  var newest = newestFile_(dir);
  if (newest && newest.getBlob().getDataAsString() === body) {
    Logger.log(target.name + ': unchanged, skipped');
    return;
  }

  dir.createFile(stamp + '.json', body, MimeType.PLAIN_TEXT);
  prune_(dir);
}

/**
 * Run this once to schedule the weekly backup. Safe to run again —
 * it removes any trigger it created before.
 */
function scheduleWeeklyBackup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'backupAllProjects') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('backupAllProjects')
    .timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(4).create();
  Logger.log('Weekly backup scheduled — Mondays, around 4am.');
}

// ---------- helpers ----------

function folder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function listFiles_(dir) {
  var out = [], it = dir.getFiles();
  while (it.hasNext()) out.push(it.next());
  out.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  return out;
}

function newestFile_(dir) {
  var f = listFiles_(dir);
  return f.length ? f[0] : null;
}

function prune_(dir) {
  listFiles_(dir).slice(KEEP).forEach(function (f) { f.setTrashed(true); });
}
