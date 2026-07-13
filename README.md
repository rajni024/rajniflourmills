# ਰਜਨੀ ਫਲੋਰ ਮਿਲ (Rajni Flour Mill) — Record Management App

A small web app (Punjabi UI) for a flour mill to log grinding jobs, mark goods as picked up, and manage/backup records. Built with plain HTML/JS and Tailwind CSS (via CDN), with some pages wired to Firebase Firestore/Auth.

## Files

| File | Purpose | Data source |
|---|---|---|
| `index.html` | Simple entry form to log a new grinding record (date/time, queue number, customer, village, material, weight). Links to `out.html` and `check.html`. | `localStorage` (`grindingRecords`) |
| `in.html` | Fuller entry form with search-by-queue-number-and-date, edit/update, and logout. | Firebase Firestore (`GrindingRecords` collection) + Firebase Auth |
| `out.html` | Lists pending records and lets you mark them "out" with an exit weight. | `localStorage` (`grindingRecords` for reading, `outRecords` for writing) |
| `check.html` | Read-only report table of all records. | `localStorage` (`grindingRecords`) |
| `delete.html` | Admin/data-management screen: view, delete (with automatic backup), restore, bulk-delete, and JSON export/import of records. | Firebase Firestore (`GrindingRecords` + `BackupRecords` collections) |

## Tech stack

- **Tailwind CSS** — loaded from `https://cdn.tailwindcss.com` (no build step)
- **Firebase v10.8.0** (modular SDK) — Firestore for data, Auth for logout — used in `in.html` and `delete.html`
- **Vanilla JS** — no framework, no bundler

## Setup

1. These are static files — no build step required. Open `index.html` or `in.html` in a browser, or serve the folder with any static file server:
   ```
   npx serve .
   ```
2. `in.html` and `delete.html` connect to a live Firebase project (config is embedded in the script). Make sure Firestore security rules are configured appropriately before deploying publicly (see **Notes** below).

## Typical flow

1. Staff logs a new grinding job (`in.html` or `index.html`).
2. When the customer picks up their goods, mark it "out" (`out.html`) with the exit weight.
3. View all records in a report (`check.html`).
4. Admins manage/delete/backup/restore records and export/import JSON (`delete.html`).

## Notes / things worth reviewing

- **Two different storage systems are in use.** `index.html`, `out.html`, and `check.html` read/write to the browser's `localStorage`, while `in.html` and `delete.html` read/write to Firebase Firestore. Because `localStorage` is per-browser/per-device, records entered on `in.html` (Firestore) won't show up in `check.html`'s report or `out.html`'s pending list (which read `localStorage`), and vice versa. If the intent is a single shared record system, these pages should be unified on one data source (Firestore is the better fit for multi-device/staff use).
- **Firebase config is exposed in client-side code.** This is normal for Firebase web apps (the API key isn't a secret), but access control must come from **Firestore Security Rules**, not from hiding the config. Worth double-checking the rules on the `milllmr` project restrict reads/writes appropriately (e.g., requiring authentication).
- **`delete.html` has no auth check** — anyone who can load the page can bulk-delete or restore records. Consider gating it behind the same Firebase Auth used in `in.html`.
- **IDs as document keys**: `in.html` builds Firestore doc IDs as `queueNumber + "_" + date`. If two customers reuse the same queue number on the same date, the second save will silently overwrite the first.
