/**
 * ============================================================
 * SELF-BACKUP — paste this into the Apps Script editor once.
 *
 * It saves a complete copy of this script project to your Google
 * Drive, timestamped, and keeps the last 20. Put it on a weekly
 * trigger and the backend backs itself up forever with no further
 * effort from you.
 *
 * Setup is in backend/README.md — about five minutes, once.
 * ============================================================
 */

/** Where the copies go. Created automatically the first time. */
var BACKUP_FOLDER = 'Salon Asteria — Script Backups';

/** How many copies to keep before the oldest is deleted. */
var KEEP = 20;

/**
 * Run this once by hand to authorise it, then let the trigger do it.
 */
function backupProjectToDrive() {
  var scriptId = ScriptApp.getScriptId();

  var res = UrlFetchApp.fetch(
    'https://script.googleapis.com/v1/projects/' + scriptId + '/content',
    {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    }
  );

  if (res.getResponseCode() !== 200) {
    throw new Error(
      'Backup failed (HTTP ' + res.getResponseCode() + ').\n\n' +
      'Most likely the Apps Script API is still off. Turn it on at\n' +
      'https://script.google.com/home/usersettings and run this again.\n\n' +
      res.getContentText()
    );
  }

  var body = res.getContentText();
  var folder = getBackupFolder_();
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HHmm');

  folder.createFile('asteria-script ' + stamp + '.json', body, MimeType.PLAIN_TEXT);
  prune_(folder);

  var fileCount = JSON.parse(body).files.length;
  Logger.log('Backed up ' + fileCount + ' file(s) to "' + BACKUP_FOLDER + '" at ' + stamp);
}

/**
 * Run this ONCE to schedule a weekly backup. Running it again is safe —
 * it clears any trigger it made before, so you cannot end up with two.
 */
function scheduleWeeklyBackup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'backupProjectToDrive') ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('backupProjectToDrive')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(4)
    .create();

  Logger.log('Weekly backup scheduled for Monday mornings.');
}

// ---------- helpers ----------

function getBackupFolder_() {
  var it = DriveApp.getFoldersByName(BACKUP_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(BACKUP_FOLDER);
}

function prune_(folder) {
  var files = [];
  var it = folder.getFiles();
  while (it.hasNext()) files.push(it.next());

  files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  files.slice(KEEP).forEach(function (f) { f.setTrashed(true); });
}
