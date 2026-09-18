// ===========================================================================
// PORTAL.GS — DECRYPT 2.0 PARTICIPANT PORTAL
// Add this file to your existing Apps Script project.
// Then add the two new routes to your doGet in Code.gs (shown at the bottom).
// Nothing in Code.gs, Admin.gs, or any existing function changes.
// ===========================================================================

// ---------------------------------------------------------------------------
// PORTAL AUTH
// Matches email + access code against Sheet1.
// Returns the participant's full record if both match the same row.
// Deliberately returns a generic error message on mismatch — never reveals
// whether the email exists or just the code was wrong.
// ---------------------------------------------------------------------------

function handlePortalAuth(e) {
  var email = (e.parameter.email || '').trim().toLowerCase();
  var code  = (e.parameter.code  || '').trim().toUpperCase();

  if (!email || !code) {
    return jsonResponse({ ok: false, error: 'Please enter both your email and access code.' });
  }

  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Sheet1');
    var data  = sheet.getDataRange().getValues();
    var certMap = getCertificateStatusMap(); // from Admin.gs

    for (var i = 1; i < data.length; i++) {
      var row       = data[i];
      var rowEmail  = String(row[COL.EMAIL] || '').trim().toLowerCase();
      var rowCode   = String(row[COL.CODE]  || '').trim().toUpperCase();

      if (rowEmail === email && rowCode === code) {
        var certCode   = rowCode;
        var certStatus = certMap[certCode] || 'Pending';
        var certUrl    = getCertificateUrl(certCode);

        var participant = {
          name:         row[COL.NAME]         || '',
          email:        row[COL.EMAIL]        || '',
          phone:        row[COL.PHONE]        || '',
          location:     row[COL.LOCATION]     || '',
          identity:     row[COL.IDENTITY]     || '',
          source:       row[COL.SOURCE]       || '',
          track:        row[COL.TRACK]        || 'General',
          volunteer:    row[COL.VOLUNTEER]    || '',
          notes:        row[COL.NOTES]        || '',
          code:         rowCode,
          status:       row[COL.STATUS] === 'CHECKED_IN' ? 'CHECKED_IN' : 'REGISTERED',
          registeredAt: row[0]             ? new Date(row[0]).toISOString()             : null,
          checkinTime:  row[COL.CHECKIN_TIME] ? new Date(row[COL.CHECKIN_TIME]).toISOString() : null,
          certStatus:   certStatus,
          certUrl:      certUrl
        };

        return jsonResponse({ ok: true, participant: participant });
      }
    }

    // No match — generic message so we don't leak which field was wrong
    return jsonResponse({ ok: false, error: 'Email and access code do not match. Please check and try again.' });

  } catch (err) {
    return jsonResponse({ ok: false, error: 'Something went wrong. Please try again.' });
  }
}

// Helper: get certificate URL if status is Sent
function getCertificateUrl(code) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Certificates');
  if (!sheet) return '';
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toUpperCase() === code) {
      return data[i][6] || ''; // Column G: Certificate URL
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// EVENT INFO — read and write
// Stored in a single-row sheet called "EventInfo".
// The admin Command Center writes to it; the portal reads from it.
// ---------------------------------------------------------------------------

function getOrCreateEventInfoSheet() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('EventInfo');
  if (!sheet) {
    sheet = ss.insertSheet('EventInfo');
    sheet.appendRow(['Joining Link', 'Schedule', 'Announcement', 'Doors Open', 'Last Updated']);
    sheet.appendRow(['', '', '', '', '']); // empty data row ready to fill
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function handleGetEventInfo() {
  try {
    var sheet = getOrCreateEventInfoSheet();
    var data  = sheet.getDataRange().getValues();
    if (data.length < 2) return jsonResponse({ ok: true, joiningLink:'', schedule:'', announcement:'', doorsOpen:'', lastUpdated:'' });

    var row = data[1]; // single data row
    return jsonResponse({
      ok:           true,
      joiningLink:  row[0] || '',
      schedule:     row[1] || '',
      announcement: row[2] || '',
      doorsOpen:    row[3] || '',
      lastUpdated:  row[4] ? new Date(row[4]).toISOString() : ''
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.toString() });
  }
}

function handleSaveEventInfo(e) {
  // Called by the admin Command Center (token-protected via ADMIN_ACTIONS router)
  try {
    var sheet = getOrCreateEventInfoSheet();
    var row = [
      e.parameter.joiningLink  || '',
      e.parameter.schedule     || '',
      e.parameter.announcement || '',
      e.parameter.doorsOpen    || '',
      new Date()
    ];
    // Overwrite the single data row
    sheet.getRange(2, 1, 1, 5).setValues([row]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.toString() };
  }
}

// ---------------------------------------------------------------------------
// ADD THESE TWO BLOCKS TO YOUR doGet IN Code.gs
//
// Inside the public routes section (before the ADMIN_ACTIONS check):
//
//   if (action === 'portal_auth')  return handlePortalAuth(e);
//   if (action === 'get_event_info') return handleGetEventInfo();
//
// Inside ADMIN_ACTIONS object in Admin.gs, add one new entry:
//
//   'saveEventInfo': function(e) { return handleSaveEventInfo(e); },
//
// ---------------------------------------------------------------------------

// ===========================================================================
// ADMIN COMMAND CENTER ADDITIONS
// Add the Event Info editor to the Command Center so you can push content
// to participants without touching code.
// The JS and HTML additions below belong in AdminScript.html and
// AdminIndex.html respectively — clearly marked.
// ===========================================================================

/*
===========================================================================
ADMININDEX.HTML — add this section inside <main class="content">
===========================================================================

<section class="view" id="view-eventinfo">
  <div class="section-head">
    <div><h2>Event info</h2><p class="section-sub">What participants see in their portal.</p></div>
    <button class="btn btn-solid" id="eventinfo-save-btn">Save &amp; publish</button>
  </div>
  <div class="chamber">
    <div class="chamber-body pad" id="eventinfo-form">
      <div style="display:flex;flex-direction:column;gap:18px;">
        <div class="field">
          <label class="label" style="display:block;margin-bottom:6px;">Joining link</label>
          <input type="url" id="ei-link" placeholder="https://..." style="width:100%;background:var(--surface-2);border:1px solid var(--border);color:var(--text);padding:11px 14px;border-radius:8px;font-size:0.9rem;">
        </div>
        <div class="field">
          <label class="label" style="display:block;margin-bottom:6px;">Doors open</label>
          <input type="text" id="ei-doors" placeholder="e.g. Saturday 4 October, 9:00 AM WAT" style="width:100%;background:var(--surface-2);border:1px solid var(--border);color:var(--text);padding:11px 14px;border-radius:8px;font-size:0.9rem;">
        </div>
        <div class="field">
          <label class="label" style="display:block;margin-bottom:6px;">Schedule (one session per line)</label>
          <textarea id="ei-schedule" rows="6" placeholder="9:00 AM — Opening&#10;9:30 AM — Cybersecurity session&#10;..." style="width:100%;background:var(--surface-2);border:1px solid var(--border);color:var(--text);padding:11px 14px;border-radius:8px;font-size:0.9rem;resize:vertical;font-family:var(--font-body);"></textarea>
        </div>
        <div class="field">
          <label class="label" style="display:block;margin-bottom:6px;">Announcement <span style="color:var(--text-muted);font-size:0.62rem;">(optional — shows highlighted in the portal)</span></label>
          <input type="text" id="ei-announcement" placeholder="e.g. Joining links will be shared 30 minutes before start" style="width:100%;background:var(--surface-2);border:1px solid var(--border);color:var(--text);padding:11px 14px;border-radius:8px;font-size:0.9rem;">
        </div>
        <p class="label" id="ei-last-updated" style="margin-top:4px;"></p>
      </div>
    </div>
  </div>
</section>

Also add to the rail nav in AdminIndex.html:
<button class="rail-item" data-view="eventinfo">
  <svg><use href="#i-registration"/></svg>
  <span class="rail-item-label">Event info</span>
</button>

===========================================================================
ADMINSCRIPT.HTML — add these functions
===========================================================================

Add 'eventinfo' to VIEW_TITLES:
  eventinfo: 'Event info'

Add 'eventinfo' to VIEW_RENDERERS:
  eventinfo: renderEventInfo

Add 'eventinfo' to VIEW_CONTAINERS:
  eventinfo: []

Then add these two functions:

function renderEventInfo() {
  apiFetch({ action: 'get_event_info' })
    .then(function (d) {
      if (!d || !d.ok) return;
      document.getElementById('ei-link').value         = d.joiningLink  || '';
      document.getElementById('ei-schedule').value     = d.schedule     || '';
      document.getElementById('ei-announcement').value = d.announcement || '';
      document.getElementById('ei-doors').value        = d.doorsOpen    || '';
      if (d.lastUpdated) {
        document.getElementById('ei-last-updated').textContent =
          'Last published ' + new Date(d.lastUpdated).toLocaleString();
      }
    })
    .catch(function () {});
}

document.getElementById('eventinfo-save-btn').addEventListener('click', function () {
  var btn = this;
  btn.disabled = true;
  btn.textContent = 'Publishing…';
  apiFetch({
    action:       'saveEventInfo',
    joiningLink:  document.getElementById('ei-link').value.trim(),
    schedule:     document.getElementById('ei-schedule').value.trim(),
    announcement: document.getElementById('ei-announcement').value.trim(),
    doorsOpen:    document.getElementById('ei-doors').value.trim()
  })
  .then(function (d) {
    btn.disabled = false;
    btn.textContent = 'Save & publish';
    if (d && d.ok) {
      toast('Event info published to participant portal.');
      document.getElementById('ei-last-updated').textContent = 'Last published ' + new Date().toLocaleString();
    } else {
      toast('Could not save — try again.');
    }
  })
  .catch(function () {
    btn.disabled = false;
    btn.textContent = 'Save & publish';
    toast('Could not save — try again.');
  });
});

Note: apiFetch in AdminScript.html already includes the auth token, so
saveEventInfo goes through the ADMIN_ACTIONS router and is automatically
protected. No extra auth code needed here.
*/
