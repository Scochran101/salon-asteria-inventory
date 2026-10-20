# Backend handoff — Apps Script changes still outstanding

> **Status, October 2026:** the backend moved to Neon (`api/index.js`), and
> items 1 to 4 below are built there and tested: retry-safe creates with
> `clientId`, clearing a price, login as a POST with a lock after 10 wrong
> PINs, and `usageHistory`. Item 5 (batched counts) and the two ideas at the
> end are not built. This file is kept as the record of what was asked for.

Everything in the review that could be fixed in the client is done. Four things
need the Apps Script, because they depend on data or behaviour the browser
cannot reach. They are listed in the order I'd do them.

The Apps Script source is not in this repo. **Put it here** (`backend/Code.gs`)
when you next open the editor — half the system is currently unversioned, and a
bad edit there has no undo.

The snippets below are written against the contract in `README.md`. Adapt the
sheet-access helpers to whatever the existing script already uses.

---

## 1. Idempotent writes — do this first

**Why it matters now.** The client retries failed writes. A 500 or a dropped
connection does not tell it whether the write landed. `setCount` is safe to
retry because it sets an absolute quantity, but `restock`, `addProduct` and
`addZone` all *create* rows — retrying them creates duplicates.

Today, a delivery logged while the signal is flaky can be recorded twice, which
silently corrupts the usage report.

The client already sends a `clientId` on all three. The backend needs to store
it and treat it as an idempotency key.

Add a `ClientID` column to **Products**, **Zones** and **Restocks**, then:

```js
function findByClientId(sheetName, clientId) {
  if (!clientId) return null;
  var sh = SpreadsheetApp.getActive().getSheetByName(sheetName);
  var data = sh.getDataRange().getValues();
  var head = data[0];
  var idCol = head.indexOf('ClientID');
  var keyCol = 0;                       // ProductID / ZoneID / RestockID
  if (idCol === -1) return null;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(clientId)) return data[i][keyCol];
  }
  return null;
}

function addRestock(d) {
  var existing = findByClientId('Restocks', d.clientId);
  if (existing) return { restockId: existing };   // already recorded — say so
  // ...existing insert, writing d.clientId into the ClientID column...
  return { restockId: newId };
}
```

Same shape for `addProduct` and `addZone`.

---

## 2. Let a price be cleared

**One line.** The client now sends `price: null` to mean "remove this", and
omits the key entirely to mean "leave it alone". Blanking the field used to be
silently ignored, so a wrong price could never be removed.

In `updateProduct`:

```js
// Was:  if (d.price !== undefined && d.price !== '') set('Price', d.price);
// Use — null clears the cell, undefined leaves it untouched:
if ('price' in d) set('Price', d.price === null ? '' : Number(d.price));
```

---

## 3. Move the PIN out of the URL, and rate-limit it

**Why.** The PIN currently travels as a query parameter
(`?action=login&password=1234`), which writes it into the Apps Script execution
log and any proxy in between. And a four-digit PIN on a public endpoint with no
lockout is 10,000 guesses.

**Do the backend side first — the client change alone breaks login.** The
client code is ready and commented at `submitPin()` in `app.js`.

Accept the PIN in the POST body, keep the GET path working until the new client
is deployed, and add a lockout:

```js
function doPost(e) {
  var p = JSON.parse(e.postData.contents);
  if (p.action === 'login') return jsonOut(login(p.data && p.data.password));
  // ...existing routing...
}

function login(password) {
  var cache = CacheService.getScriptCache();
  var key = 'pinfail';
  var fails = Number(cache.get(key) || 0);
  if (fails >= 10) return { success: false, locked: true };

  if (String(password) !== String(getStoredPin())) {
    cache.put(key, String(fails + 1), 900);   // 15-minute window
    return { success: false };
  }
  cache.remove(key);
  return { success: true, token: issueToken() };
}
```

Then in `app.js`, replace the `fetch` inside `submitPin()` with:

```js
const res = await fetch(SCRIPT_URL, {
  method: 'POST',
  body: JSON.stringify({ action: 'login', data: { password: pin } })
});
```

and handle `out.locked` by showing "Too many tries — wait 15 minutes."

> The lockout above is global, not per-device, because Apps Script has no
> reliable client identifier. That is the right trade for a salon: it stops
> brute force, and the one staff member who fat-fingers it four times is
> unaffected.

---

## 4. Expose snapshot history so the report can show trends

**What the client already does without you.** The usage report now shows units
used, units per week, cost of goods used, and biggest movers — all computed in
the browser from the existing `report` payload, with prices joined by name.

**What it cannot do.** Anything across more than the last two counts, because
`report` only ever returns one period, and `snapshots` carries no line data.

Add an action returning per-product usage for the last N periods:

```js
function getUsageHistory(periods) {
  periods = periods || 8;
  var snaps = getClosedSnapshots().slice(-(periods + 1));
  var out = [];
  for (var i = 1; i < snaps.length; i++) {
    out.push({
      from: snaps[i - 1].Date,
      to: snaps[i].Date,
      rows: computeUsageBetween(snaps[i - 1].SnapshotID, snaps[i].SnapshotID)
        .map(function (r) {
          return { productId: r.productId, usage: r.usage, restocked: r.restocked };
        })
    });
  }
  return { ready: out.length > 0, periods: out };
}
```

Two things to include that the current `report` omits:

- **`productId` on every row.** The client currently joins rows to products by
  reconstructing the display name, which works but breaks the moment a product
  is renamed. An ID makes cost of goods used exact.
- **The `label` unit** (tubes / bottles / litres) as it is today.

Once `?action=usageHistory` exists, the report can draw a sparkline per product
and answer "are we getting through more 7N than we used to?" — the question the
owner is actually asking. The client hooks are in `viewReport()` in `app.js`;
`.spark` styles are already in `app.css`.

---

## 5. Optional — batched counts

Not required, but it cuts round trips a lot during a full walk. The client
queue already coalesces per product+zone; it would flush far fewer requests if
it could send many at once.

```js
function setCounts(rows) {          // rows: [{productId, zoneId, qty}, ...]
  rows.forEach(function (r) { writeCount(r.productId, r.zoneId, r.qty); });
  return { ok: true, written: rows.length };
}
```

If you add it, tell me and I'll switch the queue's flush to use it — it's a
small change in `Q.flush()`.

---

## Also worth moving to the sheet

- **The "ordered" flag on the Order list.** It is currently per-device
  `localStorage`, so marking something ordered on the front desk does not show
  on a stylist's phone. An `Ordered` date column on Products, set by a small
  `markOrdered` action, fixes it.
- **The error log.** The client keeps the last 40 errors on the phone and the
  salon can copy them from More → Report a problem. Appending them to a
  `Log` tab would mean you see problems without having to ask.
