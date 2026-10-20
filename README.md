# Salon Asteria Inventory

A phone-first inventory app for Salon Asteria. You walk the salon zone by zone,
count what's on the shelf, log deliveries as they arrive, and the app works out
what actually got used.

Data lives in a Neon Postgres database behind one Vercel Function,
`api/index.js`, which serves `/api`. The front end is static files with no
build step. Until October 2026 the data lived in a Google Sheet behind an
Apps Script; `backend/Code.gs` is that script, kept as the reference the new
backend was tested against.

---

## Files

```
index.html, app.css, app.js   the app (markup, styles, all logic)
sw.js                         service worker: caches the shell, never /api
manifest.webmanifest, img/    installable-app metadata, logos, icons
api/index.js                  the backend: every action, on Neon
db/schema.sql                 the tables (one per old Sheet tab)
lib/                          the Sheet-to-table map, the export
scripts/                      import / verify / export / lock, local dev server
test/parity.mjs               new backend vs the Apps Script, side by side
test/cutover.mjs              export round trip and importer lock
backend/                      the old Apps Script and its notes
dev/mockserver.js             an in-memory mock backend
```

## Deploying

Vercel project `salon-asteria-inventory` (team I-MGMT) builds from GitHub
`Scochran101/salon-asteria-inventory`: a push to `main` goes live, any other
branch gets a private preview. `.vercelignore` keeps everything but the app
and `api/` off the public site.

Environment variables in Vercel:

- `DATABASE_URL` and friends: set by the Neon integration (database
  `salon-asteria-db`).
- `APP_PASSWORD`: the shared PIN. Set it in Vercel (Settings > Environment
  Variables), never in code. Changing it signs nobody out.

**After changing `app.css`, `app.js` or `index.html`, bump `CACHE` in
`sw.js`** (`asteria-shell-v4` to `v5`). Otherwise phones keep serving the
cached shell and will not see the update.

---

## The data

One table per old Sheet tab, with the same columns (snake_case in the
database; the API still answers with the Sheet's headers). See `db/schema.sql`.

**Products**

| Column | Notes |
|---|---|
| `ProductID` | unique, server-assigned |
| `Category` | free text. The app sorts the six known ones first and shows anything else after |
| `Brand`, `Line`, `SubType`, `Shade` | the display name is built from these |
| `Par` | reorder level. Below this, it lands on the Order list |
| `Price` | optional. Drives the refill estimate and cost of goods used |
| `Verify` | `Y` flags a row transcribed from handwritten notes |
| `Notes` | free text |
| `Active` | `Y` or blank. Blank archives it everywhere |

**Zones**: `ZoneID`, `Name`, `SortOrder`, `Active`
**ZoneCounts**: `ProductID`, `ZoneID`, `Qty`, `LastUpdated`
**Snapshots**: `SnapshotID`, `Date`, `Status` (`closed`), `Notes`
**SnapshotLines**: `SnapshotID`, `ProductID`, `ZoneID`, `Qty` (the counts each snapshot froze)
**Restocks**: `RestockID`, `Date`, `ProductID`, `Qty`, `Note`

Products, zones and restocks also keep the `clientId` the app sent, so a
retried write finds the row it already made.

Quantities are stored to the nearest half, so half a tube is `0.5` and displays
as `½`.

---

## API contract

`GET /api?action=…&token=…`

| Action | Returns |
|---|---|
| `ping` (no token) | `{ok, message, version}` |
| `login` (`&password=`) | `{success, token}`, `{success:false}`, or `{success:false, locked:true}` |
| `boot` | `{products, zones, counts, snapshots, restocks}` (the last 50 restocks) |
| `report` | `{ready, previous:{id,date}, current:{id,date}, rows:[…]}` or `{ready:false, message}` |
| `usageHistory` (`&periods=`, default 8) | `{ready, periods:[{from, to, rows:[{productId, usage, restocked, label}]}]}` |

`POST /api` with `{token, action, data}`

| Action | `data` | Returns |
|---|---|---|
| `login` (no token) | `password` | as the GET login. This is what the app uses, so the PIN stays out of URLs |
| `setCount` | `productId, zoneId, qty` | `{ok}` |
| `removeFromZone` | `productId, zoneId` | `{ok}` |
| `addProduct` | `clientId, category, brand, line, subType, shade, price, par, notes, zoneId, qty` | `{ok, productId}` |
| `updateProduct` | `productId` + any of `category, brand, line, subType, shade, par, notes, verify, active, price` | `{ok}` |
| `addZone` | `clientId, name` | `{ok, zoneId}` |
| `updateZone` | `zoneId` + any of `name, sortOrder, active` | `{ok}` |
| `restock` | `clientId, productId, qty, note` | `{ok, restockId}` |
| `deleteRestock` | `restockId` | `{ok}` |
| `finishCount` | `notes` | `{ok, snapshotId}` |

Any response may be `{error:"AUTH"}`, which signs the user out; a refused
write answers `{error:"<reason>"}`.

- **`clientId` makes a create safe to retry.** `addProduct`, `addZone` and
  `restock` return the row a `clientId` already made instead of a second one.
- **`price: null` clears a price.** Absent leaves it alone.
- **Login locks for 15 minutes after 10 wrong PINs in 15 minutes**, for
  everyone. Phones already signed in keep working.

---

## How saving works

Nothing is written straight to the network.

1. A change is applied to the screen immediately.
2. It is appended to a queue in `localStorage`, coalesced by target — tapping
   `+` eleven times sends one write, not eleven.
3. The queue flushes in order with exponential backoff, on reconnect, and when
   the app comes back to the foreground.
4. Nothing leaves the queue until the server confirms it.

The header chip reports the queue's real state — `Saving…`, `Saved`,
`N changes waiting`, or `Offline · N waiting` — and tapping it lists exactly
what is outstanding. Rows with unconfirmed writes carry an amber dot.

This means a full count can be done in a stockroom with no signal and syncs on
the way out. It also means **finishing a count is blocked while writes are
outstanding**, because a snapshot taken over unsynced numbers would be wrong.

A write that fails eight times is parked so it cannot block the rest of the
queue, and stays visible in the pending list.

---

## Behaviour worth knowing

**Back never leaves the app.** Every screen change and every sheet pushes a
history entry, so Android's back button and iOS edge-swipe close the sheet,
then leave the zone, then leave the tab.

**Undo appears where it is needed.** Jumping to an absolute quantity from the
quick pad, typing one in, or removing a product from a zone all offer Undo in
the toast for six seconds. Stepping by one does not — the other button already
undoes it.

**First run asks for one thing at a time.** Until there is a zone and a
product, the Count tab shows a two-step setup that ticks itself off rather than
an empty list.

**Marking something ordered clears itself.** Tap an item on the Order list and
it moves to "On the way". Logging a delivery for it in Restock removes the
flag — you never have to remember to un-mark it.

---

## Local development

Against the real database (copy `.env.local` from `vercel env pull`, put a
made-up `APP_PASSWORD` in `.env.test`):

```bash
node --env-file=.env.local --env-file=.env.test scripts/dev-server.mjs
```

Without a database, `node dev/mockserver.js` serves the app over an in-memory
mock (PIN `1234`; `/_control?fail=1` simulates an outage).

Tests (both reload the database from the export afterwards, and must never
run after the switch):

```bash
npm run test:parity -- "<Sheet export .xlsx>"
node --env-file=.env.local test/cutover.mjs "<Sheet export .xlsx>"
```

---

## Known limits

- **The "ordered" state on the Order list is per-device.** It lives in
  `localStorage`, so marking something ordered on the front-desk iPad will not
  show on a stylist's phone. Moving it to the database is a small backend change.
- **One shared PIN, so counts are not attributed to a person.**
- **Trend lines on the report appear from the third finished count.** Fewer
  periods are not a trend.
- **Archived products and hidden zones have no in-app way back.** Ask Steven;
  it is one database change.
