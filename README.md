# Salon Asteria Inventory

A phone-first inventory app for Salon Asteria. You walk the salon zone by zone,
count what's on the shelf, log deliveries as they arrive, and the app works out
what actually got used.

Data lives in a Google Sheet. The front end is static files — no build step, no
dependencies, no toolchain to rot.

---

## Files

```
salon-asteria-inventory/
  index.html            markup + the SVG icon sprite
  app.css               all styles (replaces the old Tailwind CDN)
  app.js                all logic
  sw.js                 service worker — caches the shell, never the data
  manifest.webmanifest  installable-app metadata
  img/                  logos and home-screen icons
backend/
  HANDOFF.md            Apps Script changes still outstanding
```

## Deploying

Upload the contents of `salon-asteria-inventory/` to any static host, keeping
the folder structure. Three rules:

1. **Serve over HTTPS.** The service worker will not register otherwise
   (`localhost` is exempt for testing).
2. **Keep `sw.js` at the site root of the app**, alongside `index.html`. Its
   scope is the folder it sits in.
3. **After changing `app.css`, `app.js` or `index.html`, bump `CACHE` in
   `sw.js`** (`asteria-shell-v2` → `v3`). Otherwise phones keep serving the
   cached shell and will not see the update.

The backend URL is `SCRIPT_URL` at the top of `app.js`.

---

## The sheet

The Apps Script web app reads and writes these tabs.

**Products**

| Column | Notes |
|---|---|
| `ProductID` | unique, server-assigned |
| `Category` | free text. The app sorts the six known ones first and shows anything else after — it no longer hides unknown categories |
| `Brand`, `Line`, `SubType`, `Shade` | the display name is built from these |
| `Par` | reorder level. Below this, it lands on the Order list |
| `Price` | optional. Drives the refill estimate and cost of goods used |
| `Verify` | `Y` flags a row transcribed from handwritten notes |
| `Notes` | free text |
| `Active` | `Y` or blank. Blank archives it everywhere |

**Zones** — `ZoneID`, `Name`, `SortOrder`, `Active`
**Counts** — `ProductID`, `ZoneID`, `Qty`, `LastUpdated`
**Snapshots** — `SnapshotID`, `Date`, `Status` (`closed`), `Notes`
**Restocks** — `RestockID`, `Date`, `ProductID`, `Qty`, `Note`

Quantities are stored to the nearest half, so half a tube is `0.5` and displays
as `½`.

---

## API contract

`GET ?action=…&token=…`

| Action | Returns |
|---|---|
| `login` (`&password=`) | `{success, token}` or `{success:false}` |
| `boot` | `{products, zones, counts, snapshots, restocks}` |
| `report` | `{ready, previous:{date}, current:{date}, rows:[…]}` or `{ready:false, message}` |

`POST {token, action, data}`

| Action | `data` | Returns |
|---|---|---|
| `setCount` | `productId, zoneId, qty` | `{ok}` |
| `removeFromZone` | `productId, zoneId` | `{ok}` |
| `addProduct` | `clientId, category, brand, line, subType, shade, price, par, notes, zoneId, qty` | `{productId}` |
| `updateProduct` | `productId` + any of `category, brand, line, subType, shade, par, notes, verify, active, price` | `{ok}` |
| `addZone` | `clientId, name, sortOrder` | `{zoneId}` |
| `updateZone` | `zoneId` + any of `name, sortOrder, active` | `{ok}` |
| `restock` | `clientId, productId, qty, date` | `{restockId}` |
| `deleteRestock` | `restockId` | `{ok}` |
| `finishCount` | `notes` | `{snapshotId}` |

Any response may be `{error:"AUTH"}`, which signs the user out.

### Two contract notes the backend must honour

- **`clientId` is an idempotency key.** Writes are retried after a failure, and
  a 500 does not tell the client whether the write landed. `addProduct`,
  `addZone` and `restock` must return the existing record if they see a
  `clientId` they have already stored, rather than creating a second one. See
  `backend/HANDOFF.md`.
- **`price: null` means clear it.** Absent means leave it alone. The old
  behaviour — omitting the key when the field was blank — made it impossible to
  remove a wrong price.

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

There is a mock backend for testing without touching the real sheet:

```bash
node dev/mockserver.js
```

It serves the real files with `SCRIPT_URL` rewritten to itself, implements the
contract above in memory, and exposes `/_control?fail=1` to simulate an outage
so the queue can be exercised. The PIN is `1234`.

---

## Known limits

- **The "ordered" state on the Order list is per-device.** It lives in
  `localStorage`, so marking something ordered on the front-desk iPad will not
  show on a stylist's phone. Moving it to the sheet is a small backend change.
- **One shared PIN, so counts are not attributed to a person.**
- **The usage report compares the last two snapshots only.** Trends across more
  periods need the snapshot line data, which the backend does not currently
  expose — see `backend/HANDOFF.md`.
