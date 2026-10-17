// The Google Apps Script the owner pastes once at script.google.com (page:
// GET /reconciliation/revenue-intake). It runs in Google's cloud every hour — no office PC, no
// third-party mail service — finds the POS's nightly "פדיון" sheet in the owner's Gmail and posts
// it to POST /ingest/revenue-report. The app decides the store (from the subject) and the day
// (from the file stamp / send time); the script only carries the mail across.
//
// A thread is labelled when it is finished with: AP-imported (taken, or nothing to take) or
// AP-failed (the app refused it and already told the owner why). A network error, 5xx, 401 or 503
// leaves it unlabelled, so the next hour tries again; "newer_than:4d" bounds the retries.

/**
 * @param {{appUrl:string, secret:string, sender?:string, generatedAt?:string}} o
 * @returns {string} the script source, ready to paste
 */
export function buildRevenueIngestScript({ appUrl, secret, sender = 'avivpost@avivpos.co.il', generatedAt = '' }) {
  const js = (v) => JSON.stringify(String(v));
  return `// AP Control — קליטת דוח פדיון מהמייל${generatedAt ? ` (נוצר ${generatedAt})` : ''}
// 🔒 יש כאן סוד שמאפשר להכניס נתונים לאפליקציה — לא לשתף את הקוד הזה עם אף אחד.
// הפעלה: בחר למעלה את הפונקציה installTrigger ולחץ "הפעלה" (Run) פעם אחת, ואשר גישה לג׳ימייל.

var APP_URL = ${js(String(appUrl).replace(/\/$/, ''))};
var SECRET = ${js(secret)};
var SENDER = ${js(sender)};
var DONE = 'AP-imported';
var FAILED = 'AP-failed';

function label_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function pullRevenueReports() {
  var done = label_(DONE);
  var failed = label_(FAILED);
  var query = 'from:' + SENDER + ' (filename:xls OR filename:xlsx OR filename:csv) newer_than:4d -label:' + DONE + ' -label:' + FAILED;
  GmailApp.search(query, 0, 50).forEach(function (thread) {
    var retry = false;
    var refused = false;
    thread.getMessages().forEach(function (msg) {
      msg.getAttachments().forEach(function (att) {
        var name = att.getName();
        if (!/פדיון/.test(name) || !/\\.(xlsx?|csv)$/i.test(name)) return;
        var url = APP_URL + '/ingest/revenue-report'
          + '?subject=' + encodeURIComponent(msg.getSubject())
          + '&sent=' + encodeURIComponent(msg.getDate().toISOString())
          + '&file_name=' + encodeURIComponent(name);
        var res;
        try {
          res = UrlFetchApp.fetch(url, {
            method: 'post',
            headers: { 'x-ingest-secret': SECRET },
            payload: { file: att.copyBlob().setName(name) },
            muteHttpExceptions: true,
          });
        } catch (e) {
          retry = true;
          console.log('אין חיבור לאפליקציה: ' + e);
          return;
        }
        var code = res.getResponseCode();
        console.log(code + ' · ' + name + ' · ' + res.getContentText().slice(0, 300));
        if (code >= 500 || code === 401 || code === 503) retry = true;
        else if (code >= 300) refused = true;
      });
    });
    if (!retry) thread.addLabel(refused ? failed : done);
  });
}

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'pullRevenueReports') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('pullRevenueReports').timeBased().everyHours(1).create();
  pullRevenueReports();
}
`;
}
