# Getting the Apps Script into this folder

The Apps Script that owns the data, the login and every write lives only in
Google's editor. It is bound to the *Salon Asteria Inventory DB* Sheet, which
means no outside tool can reach it — not Drive, not an API, not me. Google
only hands a bound script to a signed-in human in that browser tab.

So there are two ways to stop it being a single point of failure. Pick one.

| | Effort | What you get |
|---|---|---|
| **A. Self-backup** *(recommended)* | ~5 min once | Backs itself up to Drive weekly, forever, untouched by you |
| **B. Copy into git** | ~3 min once, then 2 min per edit | The code sits here in version control with the front end |

**Read this first, though:** you are less exposed than it sounds. Every time
you deploy, Apps Script saves an immutable snapshot of the whole project as a
numbered *version*, and you can roll back to any of them from
**Deploy → Manage deployments**. That is a real safety net you already have.
It only fails you if you edit and save without ever deploying, or if the
project itself is deleted. And because `README.md` documents the full API
contract and `dev/mockserver.js` implements it, the backend is rebuildable
from scratch even in the worst case.

That is the honest framing. It is worth doing, not worth panicking about.

---

# Option A — make it back itself up (recommended)

Paste one file in, click run twice, done. After that it copies the entire
script project into your Drive every Monday and keeps the last 20.

### A1. Turn on the Apps Script API

Go to <https://script.google.com/home/usersettings> and switch
**Google Apps Script API** to **On**. One toggle, one time, for your whole
account.

### A2. Add the backup file

1. Open the *Salon Asteria Inventory DB* Sheet → **Extensions → Apps Script**
2. In the **Files** list, click **+ → Script**
3. Name it `Backup`
4. Delete the stub `function myFunction() {}` it creates
5. Paste in the whole contents of `backend/Backup.gs` from this folder
6. **Ctrl + S**

### A3. Allow it to see the project

The script needs permission to read itself and write to Drive. Add these to
the manifest:

1. Click the **gear icon** (Project Settings) → tick **"Show 'appsscript.json'
   manifest file in editor"**
2. Click **`< >`** (Editor) → open **`appsscript.json`**
3. Add an `oauthScopes` block. If one already exists, merge these in rather
   than replacing it:

```json
{
  "timeZone": "America/Chicago",
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "oauthScopes": [
    "https://www.googleapis.com/auth/script.projects.readonly",
    "https://www.googleapis.com/auth/script.external_request",
    "https://www.googleapis.com/auth/script.scriptapp",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/spreadsheets"
  ]
}
```

> Keep whatever `timeZone`, `webapp` or other keys are already there. You are
> only adding `oauthScopes`.

4. **Ctrl + S**

### A4. Run it once

1. In the function dropdown at the top, choose **`backupProjectToDrive`**
2. Click **Run**
3. Google will ask for permission — **Review permissions → your account →
   Advanced → Go to (project name) → Allow**. This is Google warning you about
   your own script; it is expected.
4. When it finishes, check Drive for a folder called
   **Salon Asteria — Script Backups** with a `.json` file in it

If it errors, the message will tell you what to fix — almost always that
step A1 was missed.

### A5. Put it on a schedule

1. Choose **`scheduleWeeklyBackup`** from the dropdown
2. Click **Run**

That is it. Monday mornings from now on, permanently, with no involvement
from you.

### Restoring from a backup

The `.json` file holds every file in the project. Open it, find the `"source"`
value for the file you want, and paste it back into the editor. Ugly but
complete — nothing is lost.

---

# Option B — copy it into this folder

Do this as well if you want the backend sitting in version control next to the
front end, so both halves move together. Fifteen minutes, once, then two
minutes each time you edit the script.

---

## Step 1 — Open the script

**If the script is attached to the inventory Sheet** (most likely):

1. Open the Salon Asteria inventory Google Sheet
2. **Extensions → Apps Script**

**If that menu opens an empty project**, the script is standalone instead:

1. Go to <https://script.google.com/home>
2. Find the project in the list — likely called *Salon Asteria Inventory*,
   *Untitled project*, or similar
3. Click it

You will know you have the right one when you see functions named `doGet`,
`doPost`, `boot`, `setCount` or `finishCount`.

---

## Step 2 — Turn on the manifest file

The project's settings — timezone, runtime, who can call the web app — live in
a file that is hidden by default.

1. Click the **gear icon** (Project Settings) in the left sidebar
2. Tick **"Show 'appsscript.json' manifest file in editor"**
3. Click the **`< >`** (Editor) icon to go back

You should now see `appsscript.json` in the Files list.

---

## Step 3 — Copy every file

Look at the **Files** list in the left sidebar. There may be more than one —
copy all of them, not just `Code.gs`.

For each file:

1. Click the file name
2. Click anywhere in the code
3. **Ctrl + A** (select all), then **Ctrl + C** (copy)
4. Create a matching file in this folder and paste it in

The file must end up at, for example:

```
Salon Asteria\backend\Code.gs
Salon Asteria\backend\appsscript.json
```

> **If you use Notepad**, choose *Save as type: All Files* before saving, or
> Windows silently saves it as `Code.gs.txt`.

---

## Step 4 — Write down the deployment settings

These are not in any file. They only exist in the Apps Script interface, and
if the deployment is ever deleted, the app's `SCRIPT_URL` changes and the app
stops working with no obvious cause.

1. **Deploy → Manage deployments**
2. Create `backend/deployment.md` and record:

```
Deployment ID:   AKfycby... (the long string in the /macros/s/.../exec URL)
Web app URL:     https://script.google.com/macros/s/.../exec
Execute as:      Me (your@email) | User accessing the web app
Who has access:  Anyone | Anyone with Google account | Only myself
Version:         e.g. 12
Script ID:       Project Settings -> Script ID
```

The **Script ID** is the one you need if you ever set up `clasp` (below).

---

## Step 5 — Commit it

Open a terminal in the project folder and run:

```bash
git add backend/ && git commit -m "Add Apps Script source and deployment settings"
```

That is the moment the backend stops being a single point of failure.

---

## Every time you edit the script from now on

1. Make the change in the Apps Script editor and deploy it
2. Copy the changed file
3. Paste it over the copy in `backend/`
4. Commit:

```bash
git add backend/ && git commit -m "Backend: what you changed"
```

If you skip this, the copy here goes stale and becomes worse than useless —
it looks like a backup but restores the wrong thing.

---

## One security note before you commit

If the PIN is written directly in the code (something like
`var PIN = '1234'`), it is about to go into git history permanently.

That is **fine while this repo stays on your machine** — it has no remote, so
nothing leaves your computer. But do not add a public GitHub remote to it
without dealing with this first.

The cleaner fix, worth doing anyway:

1. In the Apps Script editor: **Project Settings → Script Properties → Add
   script property**
2. Property `PIN`, value `1234` (or whatever it is)
3. In the code, replace the hardcoded PIN with:

```js
function getStoredPin() {
  return PropertiesService.getScriptProperties().getProperty('PIN');
}
```

Now the secret lives in the project settings, not the source, and the source
is safe to share or push anywhere.

---

## Optional — automate it with clasp

`clasp` is Google's official command-line tool. It syncs the script both ways,
so you never copy and paste again. Worth it if you expect to touch the backend
regularly; skip it if this is a once-a-quarter job.

**One-time setup:**

1. Enable the API at <https://script.google.com/home/usersettings> — turn
   **Google Apps Script API** on
2. Then:

```bash
npm install -g @google/clasp
```

```bash
clasp login
```

3. From inside the `backend` folder, using the Script ID from Step 4:

```bash
clasp clone <SCRIPT_ID>
```

**From then on:**

```bash
clasp pull
```

pulls Google's version down to your folder, and

```bash
clasp push
```

sends your local version up.

Two things to expect: clasp saves `.gs` files locally as `.js` (it converts
them back on push, which is normal), and it creates a `.clasp.json` holding
the Script ID — that is safe to commit.

Pulling still does not deploy. After `clasp push`, you must still go to
**Deploy → Manage deployments → Edit → Deploy** for the change to reach the
live web app.
