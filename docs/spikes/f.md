# Spike F — File System Access

## Question

Can Chrome's File System Access API support the workspace-storage path for a 200-file folder: recursive TypeScript discovery, full reads, conflict-safe writes, handle restoration from IndexedDB, and the persistent-permission flow after reload or browser restart?

## Method

Open `/spikes/f/` in Chrome and use a folder containing the Reference Dataset (or an equivalent 200-file folder). The page provides native-user-gesture buttons for:

- picking a folder, recursively scanning `.ts`/`.tsx` files, and reporting file count, total bytes, and elapsed time;
- reading every discovered file and reporting elapsed time;
- recording a SHA-256 baseline, allowing an external edit, then re-reading and hashing immediately before an attempted append/write;
- storing the folder handle in IndexedDB;
- restoring the handle, querying permission, requesting permission from the button click when the result is `prompt`, and reading again;
- re-picking a folder and comparing it with the stored handle using `isSameEntry`;
- copying the complete on-page log as JSON.

The page renders status and log content with `textContent`/DOM text nodes. It does not use `innerHTML` or `outerHTML`. No `measure.ts` is included because Playwright cannot select the native folder picker or reproduce the permission prompt without a real user gesture.

## Environment

| Item | Value |
|---|---|
| Browser | not measured — needs the human reference-MacBook run in Chrome |
| macOS / display / refresh rate | not measured — needs the human reference-MacBook run |
| Dataset | not measured — needs the human to run against `fixtures/reference-dataset` |
| Low Power Mode / power state | not measured — needs the human reference-MacBook run |
| Run date | not measured — needs the human reference-MacBook run |

## Gate output

`pnpm validate` exited 0. It passed typecheck, lint, max-lines, format check, knip, and the existing unit suite: 3 test files and 20 tests passed. No browser harness report was produced; the native picker and permission flow require the manual reference-MacBook run.

## Numbers

The page records integer millisecond timings from `performance.now()` in its copied JSON. The values below are intentionally not estimated.

| Metric | Result | How to obtain it |
|---|---|---|
| Scan file count | not measured — needs human Chrome run | Click Pick folder, then Scan folder |
| Scan total bytes | not measured — needs human Chrome run | Read the scan summary in the log |
| Scan time | not measured — needs human Chrome run | Read the `scan folder` duration |
| Read-all time | not measured — needs human Chrome run | Click Read all and read its duration |
| Edit + save time | not measured — needs human Chrome run | Prepare a baseline, then click Edit + Save one file |
| External-change hash detection | not measured — needs human external edit between the two buttons | A `SaveConflict detected` log means the write was skipped |
| IndexedDB handle store time | not measured — needs human Chrome run | Click Store handle |
| Restore handle time | not measured — needs human reload/browser-restart run | Reload, then click Restore handle and read again |
| `queryPermission` result and time | not measured — needs human Chrome run | Read `queryPermission after restore` |
| `requestPermission` result and time | not measured — needs permission prompt | Revoke permission or use a fresh profile, then click Restore |
| Read-after-restore time | not measured — needs human Chrome run | Read the scan and read-all entries after restore |
| `isSameEntry` result and time | not measured — needs human Chrome run | Store a handle, then re-pick the same and a different folder |
| “Allow on every visit” behavior | not measured — needs Chrome 122+ human run | Follow the persistent-permission checklist below |

## Manual steps

1. Start the dev server and open `/spikes/f/` in Chrome on the reference MacBook.
2. Click **Pick folder** and choose the generated `fixtures/reference-dataset` folder (or a real folder with 200 `.ts`/`.tsx` files). Record the scan count, bytes, and time after **Scan folder**.
3. Click **Read all** and record its duration. Confirm excluded directories and hidden directories are not included when using a real project folder.
4. Select one file and click **Prepare conflict check**. Change that same file in an external editor before clicking **Edit + Save one file**. Confirm the log reports `SaveConflict detected` and that the page did not write its draft.
5. Repeat the baseline and **Edit + Save one file** without an external change. Confirm one comment line is appended and the log reports a matching SHA-256 before the write.
6. Click **Store handle**, reload the page, and click **Restore handle and read again**. Record `queryPermission`, any `requestPermission`, and read timings.
7. Close and restart Chrome, reopen the page, and repeat restore. Record whether the IndexedDB handle remains and which permission state is returned.
8. In Chrome 122 or newer, when Chrome offers **Allow on every visit**, accept it and repeat reload and browser restart. Record whether the permission remains `granted` without another prompt.
9. Revoke the site/folder permission in Chrome settings or the site information panel. Click Restore again and record whether `queryPermission` returns `prompt`/`denied`, whether the click-triggered request is shown, and whether reading is blocked until access is restored.
10. Click **Re-pick and compare identity** for the same folder and for a different folder. Record the two `isSameEntry` results.
11. Click **Copy results as JSON** and attach the copied JSON to the spike result.

## Verdict

**Pending human reference-MacBook run.** The implementation exercises the required browser APIs and records all task-line metrics, but no native picker, permission prompt, persistent-permission, or external-editor result was measured in this sandbox. The verdict should be updated after the manual checklist and copied JSON are available.

## Proposed design impact

No design decision is changed by this spike yet. If the manual run confirms the flow, it supports D12's IndexedDB handle store, user-gesture permission request, `isSameEntry` folder identity check, and re-read/SHA-256 conflict guard. If persistent permission or handle restoration differs across reload and browser restart, record the observed Chrome behavior in D12 during task 2.8.

## Open questions

- Does Chrome on the reference MacBook retain the stored directory handle across a full browser restart, and under which permission choice?
- Does **Allow on every visit** avoid a prompt after both reload and browser restart on the target Chrome version?
- After permission revocation, does the target Chrome version return `prompt` or `denied` from `queryPermission`, and can the click-triggered `requestPermission` restore access?
- What scan/read timings and byte counts are obtained for the exact Reference Dataset on the reference machine?
