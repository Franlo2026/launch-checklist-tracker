# Deploying the Bootlegger Launch Checklist Tracker

Same GitHub → Railway workflow you already use for the Ops Task Tracker.

## What's new in this update
- **Café × Task Status matrix in Insights (multi-step launches)**: for any launch built from
  sections (Training Proof, B.Better, Collateral, GAAP POS, etc.), Insights now shows a grid with
  every assigned café down the side and every task across the top — a coloured dot per cell
  (complete / in progress / not started / exempt) shows exactly what each café still owes, instead
  of only the aggregate "X café(s) started" count per section. A café that never touched the form
  still gets a full row so it's never invisible. Search-by-café and a "show outstanding only"
  toggle (on by default) keep it usable at 70+ cafés; rows are sorted with the most outstanding
  items first so the cafés needing the most follow-up are always at the top. The PDF export gets
  the same data condensed into an "Outstanding by Café" list — only cafés with something still
  owed, each with the specific task(s) still missing — so the printed report is directly
  actionable rather than just aggregate stats.
- **Photo capture now offers both camera and library**: removed a restriction that forced
  mobile browsers into camera-only mode for every photo field — tapping "Take Photo or Choose
  from Library" now brings up the normal device picker with both options, on every submission
  page.
- **Fixed: Insights and the PDF no longer show irrelevant questions/sections.** Found and fixed
  the root cause — every new tracker's editor started pre-loaded with 4 default checklist
  questions and a 2-item conditional section (leftover from before sections existed), and if an
  admin built a Pre-Launch/Post-Launch/mixed template without ever touching that hidden flat
  block, its default content was still being saved alongside the real sections. Insights and the
  PDF would then show a "Checklist Question Breakdown" and "Conditional Section Breakdown" full
  of questions that were never actually part of that launch's submission form. Fixed at the
  source (a sectioned tracker's checklist/conditional now save empty) and defensively in
  Insights/PDF (they skip those blocks entirely for any sectioned tracker) — the defensive half
  means this is retroactively fixed for every tracker already created, no data cleanup needed.
- **+ / − toggle on the "Add Sections" palette**: each preset button now reflects whether it's
  already in the template — "+ Add X" when it isn't, "− Remove X" (highlighted) once it is —
  so adding or removing a section no longer requires scrolling down to the section list.

## Previously shipped
- **Copy Template**: a "Duplicate" button on the Tracker Detail page opens the editor pre-filled
  from an existing launch, as a brand new tracker with fresh section/item ids.
- **A "Test" café for dry runs**, always available regardless of a launch's café scoping, excluded
  from every reporting number but still visible in the raw submissions list, and exempt from the
  one-submission-per-café lock.
- **Partial section submissions**: resubmitting a section with some questions still blank merges
  into the most recent incomplete entry instead of rejecting or duplicating it — a café can leave
  questions unanswered and finish them on a later visit.
- **Redesigned submission page for sectioned launches**: everything on one page, a dropdown per
  section instead of a submit button, one declaration + one submit at the bottom.
- **Mix-and-match sections**, **Archived tab**, and the **Bootlegger-wordmark-only branding** with
  the updated declaration text.

This is a **database-safe update** — every change here is either purely client-side (photo
picker, +/− toggle), a display-layer fix (Insights/PDF gating), or a new *computed* field added to
the existing Insights API response (the café × task matrix — derived from data already stored,
nothing new to migrate). Nothing touches the database schema or existing data. Just push the code.

### Building a template with mixed sections
In **+ New Launch Tracker**, under "Add Sections" you'll see three groups — Standard, Pre-Launch,
and Post-Launch — each listing its available sections as individual buttons. Click any that apply
(you're not limited to one category) to add an editable copy to the template; rename, add/remove
items, or mark a section **Repeatable** with a Min/Max submission count (e.g. Training Proof: min
3, max 4) as needed before saving.

### What a café sees on a sectioned link
After picking their café, everything is on one page: each section shows a dropdown to either skip
it for now or fill it in (a count of entries for repeatable sections). Sections already fully
submitted show a "✓ Complete" badge instead of a dropdown. At the bottom there's one declaration
and one Submit button — clicking it saves whatever sections/entries were filled in, even if others
were left for a later visit.

## 1. Push to GitHub
1. Create a new **private** repo, e.g. `Franlo2026/launch-checklist-tracker`
2. In this folder:
   ```bash
   git init
   git add .
   git commit -m "Initial launch checklist tracker"
   git branch -M main
   git remote add origin https://github.com/Franlo2026/launch-checklist-tracker.git
   git push -u origin main
   ```

## 2. Deploy on Railway
1. railway.app → **New Project** → **Deploy from GitHub repo** → select the repo
2. **+ Add Service** → **Database** → **PostgreSQL** (auto-wires `DATABASE_URL`)
3. Variables tab on the web service → add:
   - `NODE_ENV=production`
   - `JWT_SECRET=<a long random string>` — this signs admin login sessions.
     Generate one with: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
     **Keep this secret** — anyone with it could forge an admin session.
4. Settings → Networking → **Generate Domain** — this is your dashboard URL
   (e.g. `https://launch-checklist-tracker-production.up.railway.app`)

The app creates its own database tables on first boot.

## 3. First-time setup (do this once, right after deploying)
1. Open the Railway domain in a browser.
2. Since no admin account exists yet, you'll land on **"Create Admin Account"**.
   Set your own username + password here — this becomes the first admin.
3. Once logged in, go to **Manage Admins** (top nav) and add accounts for
   Charlene, Brent, Liam, or anyone else who needs dashboard access.
   Each person gets their own username/password.
4. Log out and confirm login works before handing accounts out.

## 4. Using it day-to-day
- **Dashboard** (the domain root) — bookmark this. Requires login.
- **+ New Launch Tracker** opens the full template editor:
  - Launch Name (internal) and Submission Form Title (what branches see) are separate fields
  - Add/remove/reword checklist items, toggle "Add Picture" per item
  - Optionally enable a conditional section (e.g. store-type specific checks)
    with its own trigger question and items
- Open a tracker → copy the **Submission Link** (`.../launch/<id>`) and send
  it to branches (WhatsApp, email, etc.) — **no login required on their end**,
  by design, since this is the one thing branch staff need one-tap access to.
- **Edit Template** lets you adjust an existing launch's checklist at any
  time — note this doesn't retroactively change submissions already made;
  those keep whatever questions were live when they were submitted.
- **Archive** a tracker once a launch is done to close the submission link.

## Access model (confirmed)
- `/` and `/tracker/<id>` (the dashboard and its detail views) — **admin login required**.
- `/launch/<id>` (the branch submission form) — **public, no login**, by design.
- Only an admin can create/edit trackers, view submissions, or manage other admins.

## Ongoing updates
Same as the Ops Tracker:
```bash
git add .
git commit -m "Describe the change"
git push
```
Railway redeploys automatically in ~60–90 seconds. The database (and admin
accounts) are untouched by code deploys.

## Notes
- Passwords are hashed with bcrypt before storage — never stored in plain text.
- Admin sessions are httpOnly signed cookies (30-day expiry); logging out clears them.
- Photos are compressed client-side (resized + JPEG ~65% quality) before
  upload, then stored directly in Postgres as base64 — no separate file
  storage/S3 setup needed.
- The café dropdown uses your current 128-store masterfile, grouped by region.
- If you ever need to add a new admin without anyone being logged in (e.g.
  first admin forgot their password), the simplest fix is to delete their row
  directly from the `admins` table in Railway's Postgres data tab, which will
  make the bootstrap screen reappear if it's the last admin — or just add a
  new admin manually via a one-off SQL insert and reset their password later.
