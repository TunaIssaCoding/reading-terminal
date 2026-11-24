# Reading Terminal — implementation report

## Delivered

All application files are in `site/`, with no build step or runtime framework:

- `index.html`, `styles.css`: dark-default three-column workspace, light theme, collapsible 21% library, default 30%-of-viewport notes pane, pointer/keyboard resizing, mobile drawers, accessible labels/focus states, settings and shortcut dialogs. Closed mobile drawers and the covered reader are inert to keyboard focus.
- `js/reader.js`: measured source-line layout; interlinear notes beginning under the highlight's first letter; continued gap-by-gap wrapping, including beyond the passage and source end; locally expanding gaps; selection via `h`, floating Highlight and custom context menu; Copy/Search actions; Shift-right-click escape; click-to-edit, Esc, empty Backspace, delete control; quote/context/paragraph anchoring; native highlighted-passage dragging and a Send alternative.
- `js/library.js`: counted Unread/Read/Commented accordions, required status/summary-length ordering, star-before-title controls, starred/tag filters, title/tag/author/body search, metadata and status menus.
- `js/notes.js`: autosaved long notes, divider, live read-only reading-order margin notes, read-only bot summary and Connections; internal links open library articles. Drops anywhere in the notes pane append a block quote after one empty line.
- `js/store.js`: private GitHub Contents API access; configurable owner/repo/branch/token; device-local token storage; namespaced IndexedDB cache and durable queue; two-second debounce and lifecycle flushing; synchronous recovery journal; bounded SHA-conflict retries; per-highlight timestamp merging and deletion tombstones; preservation of both concurrent long-note versions; per-field state merging; protection against edits made during an in-flight PUT; authenticated asset blobs; backup export/import; explicit partial-backup warnings. PUT paths are restricted to app-owned `user/*` files.
- `js/markdown.js`: escaped basic markdown with safe URL handling and local article links. Private image paths do not first request files from the public site.
- `js/demo.js`: three substantial, explicitly fictional articles, sample notes and linked bot summaries. No token is required.
- `sw.js`: caches only public application code for offline startup; private API data remains outside Cache Storage.
- `DESIGN.md`: written before application code, then updated to reflect verified integration details.
- `README.md`: GitHub Pages/local hosting, private `reading-data` setup, restricted fine-grained token instructions, data schemas, interaction guide, sync/conflict behavior and backup/security notes.

## Verification actually run

### JavaScript syntax

Final `node --check` runs passed for all eight JavaScript files:

```text
sw.js
js/app.js
js/demo.js
js/library.js
js/markdown.js
js/notes.js
js/reader.js
js/store.js
```

Each final check ran from `site/` through:

```sh
flock /workspace/reviews/box-test.lock nice -n 19 ionice -c3 node --check <file>
```

### Actual headless Chromium application

Served the real files using `python3 -m http.server`, and launched headless Google Chrome under the requested `flock`/`nice`/`ionice` wrapper. Used browser keyboard/mouse events, DOM geometry checks and visual screenshots—not a DOM-only substitute.

Observed:

- Native mouse selection displayed the floating action; `h` immediately focused the interlinear editor.
- Typed a 1,326-character margin note. It occupied **12 line gaps**, its first fragment was **0 pixels** from the highlighted first letter horizontally, and geometry checks found **no intersection with source-line boxes**. This was checked again after the final reader changes.
- The highlight, complete margin text and long-note quote survived reload.
- Native dragging displayed the active drop target and appended the exact passage with `\n\n> ` separation. Drops onto both the editor and the pane header succeeded.
- Floating-button and right-click-menu highlighting both created focused editable notes. Click-to-edit updated the margin collection. Empty Backspace retained the highlight; the delete control removed both the highlight and its collected note. Shift-right-click was not intercepted.
- Star toggles did not open other articles. Starred-only and tag filtering worked. Searching a phrase present only in an unopened article body found that article.
- Exercised `/`, `j`, Enter, `r`, `s`, `n`, `?`, and Esc; typing in the search editor did not invoke reading shortcuts.
- Manual status override, read toggling, promotion to commented and automatic read marking near the body end worked.
- At a 1,440-pixel viewport, the default notes pane measured **432 pixels**. Keyboard resize changed it to 31%; highlights and notes remained anchored after reflow.
- Dark and light themes were visually inspected. Settings opened, the token input was masked, and the no-token connection test returned demo-mode guidance.
- At a 390-pixel viewport, both mobile drawers opened, the notes drawer settled at approximately **358.8 pixels**, and the document had no horizontal overflow. Closed drawers rejected focus; opening notes isolated the background; Esc restored the reader.
- With the HTTP origin server **stopped**, an uncached request failed, but reloading still displayed the app, **99 source lines**, and the saved margin note through the service-worker shell and IndexedDB. The server was restored afterward.
- A 501-item browser fixture rendered all rows in approximately **19 ms** in this run. Unread/Read timestamps and Commented bot-length precedence produced the expected first rows; body-only filtering selected the expected item. This is a single local measurement, not a network or cross-device benchmark.

Visual evidence retained outside the deployable site:

- `../out/desktop.png`
- `../out/mobile-notes.png`

### Real modules exercised with deterministic API/data fixtures

No real GitHub credentials were supplied or used. The actual store and UI ran against controlled browser-side GitHub responses.

Verified:

- Private-repository connection acceptance and public-repository refusal.
- A simulated **409** caused a SHA re-fetch/retry and retained both concurrent long-note versions.
- Text entered while a PUT was pending survived completion of that earlier PUT and reached the simulated remote.
- Highlight-id last-write-wins, later deletion tombstones, unchanged-side three-way merges, and repeated conflict merging without duplicate text.
- Independent remote star/local status changes merged.
- Failed offline writes remained queued; a new store instance recovered them; reconnect drained the queue even when an earlier failed cache read was still settling.
- The optional highlight start offset survived normalization. Resolved offsets preserved same-paragraph reading order after an edit.
- A repository-relative SVG asset fetched through the authenticated API became a decodable **16 × 12** blob image.
- Export included an uncached orphan note file and excluded the token. Import preserved local and imported long-note text. Offline export explicitly reported incomplete remote coverage.
- In a private-mode UI fixture, source and notes refreshed before a deliberately delayed bot-summary request. The final visible reader, textarea and summary all contained the newer remote values rather than stale cached values.
- Escaped raw HTML and rejected script URL schemes; recognized internal article links; avoided public-host requests for private asset paths.
- Source soft breaks, mixed inline code fonts and code hard breaks produced correct single-line source boxes. Quotes re-anchored after paragraph insertion. A long note used **28 additional end-of-source gaps**. Unmatched passages remained visible in warnings. Text before/after an inline image remained highlightable while the image was preserved.

## Failures found and corrected

- A failed background offline read could poison the first reconnect flush. Flush now waits for outstanding user-file reconciliation before taking its write snapshot.
- Normalization discarded stored highlight offsets. Offsets are preserved and resolved positions are supplied to the margin collection.
- Soft markdown newlines and inline code font changes produced incorrect source-line splitting. Whitespace normalization and line-height-based detection corrected both.
- Only the inner notes content accepted drops. The entire notes pane now accepts them.
- Image-containing paragraphs had unhighlightable adjacent text. The reader separates those text runs into source paragraphs without losing the image.
- Remote refresh events arriving while another article file was loading could be replaced by an older return value. Opening now keeps the newer reconciled values.
- Partial backups were insufficiently explicit in Settings. Their filename, JSON and user-visible result now identify incomplete remote coverage.

## Known limits and unverified environments

- **No live private GitHub round trip was performed.** Token permission enforcement, organization approval/SSO policies, actual GitHub rate limits and a real GitHub Pages deployment still require an authorized repository/device. The API behavior above was verified with deterministic fixtures, not represented as live-service evidence.
- Chromium desktop and mobile viewport behavior was exercised. **Native Safari, iOS/iPadOS selection, touch dragging and IME composition were not device-tested.** Touch/keyboard users have explicit Send-to-notes controls instead of depending on native HTML drag support.
- Interlinear notes are one stored string rendered through per-gap textareas. Native mouse text selection is local to a fragment; arrow navigation and typing/paste continue through the canonical note. This is not a single contiguous native multi-line selection surface.
- The markdown renderer intentionally implements basic markdown, not all CommonMark/GFM extensions. Raw HTML is escaped; tables and footnotes are not implemented or required by the supplied spec.
- Unopened private articles cannot be read offline until fetched. A complete backup requires successful remote enumeration; a partial cached backup remains explicitly available when offline.
- Browser/network emulation did not remain offline across reload in this harness. Offline startup was therefore proved by stopping the origin server, rather than claiming success from the unreliable emulation alone.

At v1 delivery, no permanent test harness or temporary fixture scripts were added to the deployable site. Browser tabs and verification services were stopped after checking the app. The disposable browser profile was removed; only the two screenshots remained as runtime artifacts.

## FIX1

Implemented all nine numbered fixes from `../review/REVIEW.md`. Changes are confined to `site/`; no real reading data, credentials, bot changes, deployments or pushes were involved.

### Fixes

1. **B1 — selected-text dragging:** reader event handlers normalize Text targets to their parent Element before calling `closest`. Highlighted text explicitly permits text selection, overriding Chromium's draggable-element selection default. The permanent regression covers native selection → native Text-node drag → quote appended to long notes, plus dispatched Text-node pointer/click/drag events.
2. **B2 — history:** user article opens push history; initial restoration replaces the entry. `popstate` and `hashchange` restore without pushing duplicate entries. Navigation smoke also exposed body-link markup being lost when splitting source lines; preserving inline ancestry keeps those links navigable.
3. **B3 — PDFs:** `pdf_path` names a file in the private repo, fetched through the Contents API and cached as an `application/pdf` blob. The header opens its object URL in a new tab. Absolute `pdf_url` remains supported and takes precedence. Missing PDFs show an unavailable label.
4. **B4 — images:** articles with no body image render `images[]` as a thumbnail strip under the summary. Private paths use authenticated blob loading. Body `assets/` paths resolve from the repo root, while relative paths such as `../assets/images/file.png` resolve from the article directory. No private asset is requested from the public site.
5. **B5 — open-only writes:** the first auto-open does not mutate state. Subsequent `last_opened_at` values stay in memory until included with a real status/star edit; opening and browsing alone never enqueue a write. Notes/state edits retain the existing two-second debounce and lifecycle flush.
6. **B6 — body search:** optional `search-index.json` supplies slug-to-text entries, fetched once per connection session and cached in IndexedDB. Missing, malformed and unavailable indexes degrade to cached entries or lazy body fetching; missing/non-string entries fall back per article. Full bodies remain separate from index excerpts, so an index cannot replace reader content.
7. **B7 — status reversal:** automatic Commented promotion stores `commented_from`; clearing all long/margin note text restores the previous unread/read status. Manual Commented remains intact, including when chosen during an automatic promotion. Provenance survives reload/backup and merges atomically with status.
8. **B8 — growing notes:** long notes grow/shrink on input, article load, quote append and width/font changes. The textarea has no inner scrollbar or resize handle; the notes pane scrolls.
9. **B9 — presentation:** generated titles are italic in both list and reader. Compact density defaults to a one-line title plus tags/byline, with a persisted Comfortable toggle. Added SVG favicon plus ICO fallback and updated the public shell cache. Demo auto-open remains idle rather than reporting a save.

`README.md` documents the PDF/image/search-index schemas and updated interactions; `DESIGN.md` records the changed contracts. `tests/smoke.py` contains only fictional fixtures and uses no real GitHub token.

### Verification actually run

- **Syntax:** `node --check <file>` passed for all seven `js/*.js` files and `sw.js`; the final reader change was checked again.
- **Full headless smoke:** `python3 tests/smoke.py http://127.0.0.1:8765` passed against the served site with Google Chrome and mocked GitHub Contents API responses:

  ```text
  PASS navigation_media_layout
  PASS search index: full
  PASS search index: absent
  PASS search index: malformed
  PASS search index: partial
  PASS indexed_search
  PASS debounce_status_and_growth
  Native selected-highlight drag targets: nodeType 3, trusted true
  PASS highlight_drag_and_persistence
  PASS keyboard_stars_and_read
  PASS mobile_and_demo
  PASS store_conflict_export_import
  PASS all fictional headless reading-terminal regressions
  ```

- The suite verified PDF new tabs and decoded image blobs, external `pdf_url`, no public private-asset requests, Back/Forward/internal links, zero initial/open-only PUTs, body-only search without article fan-out when indexed, fallback search, debounce timing, unread/read restoration versus manual Commented across reload, textarea growth/shrink, native and dispatched selected-text drops, live margins without source overlap, highlight deletion/empty-note retention, persistence, sorting/stars/keyboard/read threshold, mobile drawers, favicon responses, private-only writes, 409 retries, independent star merging, atomic status provenance, export/import and refusal of a public data repo. No uncaught page exceptions were observed in the successful run.
- **Visual/direct browser checks:** dark and light desktop surfaces and mobile notes were inspected. Desktop widths at 1440 × 900 were **302.39 / 705.61 / 432 px**; compact rows were **56.44 px**, with **10 fully visible rows** in the 24-item fixture. At 390 × 844, notes measured **358.80 px**, the covered reader was inert and document width stayed **390 px**. A 45-line editor grew to **1111 px** and shrank to **235 px** after native deletion. Floating-button and custom-context-menu highlights focused their editors and updated margin notes; no page errors.

The live-GitHub, Safari/iOS and touch/IME limits above still apply. Bot-side asset copying and optional index generation remain the data producer's responsibility; this pass changes only the app.

## UNLOCK

### Delivered

- Added `js/vault.js`: WebCrypto AES-256-GCM envelope encryption, authenticated vault/slot identities, one PBKDF2-SHA256 password slot (600,000 iterations minimum), HKDF-SHA256 PRF slots, strict format validation, immutable passkey/password changes, and uniform password failures.
- Added `js/passkey.js`: hostname-derived RP, resident/user-verified credentials, credential-specific PRF evaluation, optional second registration prompt, feature detection and explicit unsupported-PRF fallback. No third-party cryptography or CDN dependencies.
- Added `js/auth.js` and `js/vault-api.js`: themed mobile lock/setup screens, first-use and replacement consent, direct encrypted Contents API publication, Settings Security, current-password verification, passkey removal confirmation, and slot-by-id merging with one 409/422 retry. Concurrent password changes and different vault identities are not silently overwritten.
- Added `js/session.js`: remembered payload/DEK encrypted under a non-extractable AES-GCM CryptoKey structured-cloned into a separate IndexedDB database. Normal vault tokens never enter localStorage/sessionStorage. Remember-off is memory-only. A replacement identity invalidates a remembered session; older same-identity Pages publications do not roll back newer local commits.
- Added top-bar Lock and `ReadingStore.lock()`: bounded best-effort sync, request cancellation, token/reference erasure, blob revocation and current-library cache clearing, while preserving queued edits and recovery-journal data. Delayed operations cannot repopulate a locked library or restore a replaced vault session.
- Legacy manual-token settings remain under **Advanced: connect with a token** and work when no vault exists. Successful vault unlocking removes an old persisted manual token. Demo remains explicit and isolated; backup data never includes vault secrets.
- Added `blob:` to CSP connect-src, declared the existing ICO fallback, and bumped the service worker to `reading-terminal-shell-v3` with all new modules. Vault reads/navigations remain network-only and outside the shell cache.
- Updated `DESIGN.md` with the threat model and `README.md` with setup, device trust, recovery and revocation instructions. The public-vault/Git-history risk and plaintext queued-edit exception are explicit.

Changes are confined to `site/`. No real GitHub requests, real credentials, deployment, commit or push were performed. **No `site/vault.json` was created**; setup tests capture encrypted PUTs in memory. The two package metadata files enable Node ES modules and `node --test site/tests/`; they add no build step or dependencies.

### Verification actually run

- **Syntax:** `node --check` passed for all 13 `.js` files and `tests/vault.test.mjs`.
- **Crypto:** `node --test site/tests/` passed **18 tests** on Node **24.22.1**. Coverage includes password/PRF round trips, wrong passwords, payload/wrap tampering, vault/slot AAD and swapped wraps, low-iteration refusal, malformed envelopes/payloads, unchanged-DEK password rotation, passkey removal, second-prompt registration, unsupported PRF, concurrent slot deletion/addition, concurrent password changes and replacement-vault rejection.
- **Unlock browser scenarios:** all six passed in headless Chrome with mocked GitHub endpoints: encrypted setup PUT, wrong/right password, remembered and memory-only reloads, offline remembered boot/retry, cache clearing with queued-edit recovery, replacement consent/invalidation, current-password validation, 409 password-change merge, 422 passkey-removal retry, cancellation of an active search, and vault replacement during a deliberately delayed real KDF. No uncaught page exceptions or unexpected network requests were observed in that successful run.
- **Original combined regression run:** `python3 tests/smoke.py http://127.0.0.1:8765` reported all **13 top-level scenarios** passing in **60.09 seconds**, ending with `PASS all fictional headless reading-terminal regressions`. Existing navigation/PDF/image/layout, full/absent/malformed/partial search-index, debounce/status/notes growth, native Text-node drag/highlight persistence, keyboard/stars/read threshold, mobile/demo, and conflict/export/import checks remained passing alongside the six unlock scenarios. The CDP scenario accepted a `SecurityError` incorrectly mapped to the unsupported-PRF fallback; it did not exercise successful PRF unlock.
- **Storage inspection:** the remembered key was non-extractable and `exportKey('raw', key)` failed. IndexedDB record fields contained ciphertext and metadata, not plaintext token/payload/DEK fields. Normal Web Storage contained no fixture credentials.
- **Stalled-write scenario:** with a PUT deliberately held open, Lock completed in **1,504.6 ms**, cleared the store token, revoked its PDF blob URL, retained the queued note, and a newly unlocked store synced that exact note.
- **Real service worker:** a fresh Chromium context installed and activated `reading-terminal-shell-v3` with 17 public shell URLs and no vault/API entries. Offline shell reload worked; a vault fetch failed with a network error, and direct navigation to `/vault.json` failed with `ERR_INTERNET_DISCONNECTED` rather than receiving index.html. A scripted blob fetch succeeded under CSP.
- **Visual/direct UI:** inspected the actual 390 × 844 setup screen in light theme and lock screen in dark theme, with no horizontal overflow. Enter submitted a wrong password, displayed the exact specified failure and cleared the input. An empty-library setup retained `#setup`, and its Settings setup link successfully reopened setup and deleted the remembered record.
- **WebAuthn correction:** the earlier claim that Chrome's virtual authenticator lacked usable PRF was incorrect. The `127.0.0.1` RP id caused `SecurityError`, which the UI misclassified as unsupported PRF. Use `localhost` with `hasPrf: true`, `ctap2_1`, and `internal`; the smoke now requires passkey registration, an encrypted vault commit, Lock and successful passkey unlock instead of accepting the fallback. Physical Face ID/Touch ID remains unverified.

### Corrected during integration

- Lock canceling an active body-index search originally surfaced an uncaught rejection. Search continuations now respect the connection/search generation, and real failures in the current search still report normally.
- A background vault replacement originally returned early while password verification was busy. Replacement now forces Lock and invalidates the operation generation; late password/passkey results cannot commit or resurrect that session.
- Browser regressions wait for Lock completion before reload and for desktop panes to stop being inert after a mobile-to-desktop resize. This avoids mistaking an unfinished lock or an unaccepted synthetic fill for completed user input.

Live GitHub permissions/Pages publication, native Safari/iOS behavior, and physical passkey authenticators remain unverified. Non-extractable device keys are not protection against same-origin malicious code or a compromised browser profile. Revocation requires deleting the GitHub token and running setup again, not merely removing an old public vault slot.

## UNLOCK fix pass 1

- Setup retains the token on validation/network/GitHub errors and clears only the password fields; success clears all three. Change password already cleared all password fields on error and success, including mismatches; that behavior is unchanged and covered by smoke assertions.
- Loading `#demo` opens the same isolated demo as the Explore link before vault/session loading. Passkey `SecurityError` now reports “Passkeys are not available on this address.”; cancellation and unsupported-PRF messages are unchanged.
- The smoke defaults to `localhost` and uses Chrome's internal CTAP2.1 virtual authenticator with `hasPrf: true`. The prior address failure is no longer accepted as a PRF fallback success. README and DESIGN now explain the valid RP address and verification boundary.
- **Syntax:** `node --check` passed for all 13 `.js` files and `tests/vault.test.mjs`.
- **Node:** `node --test tests/` passed **19 tests**, including invalid-address versus cancellation/unsupported errors for both passkey registration and unlock.
- **Browser smoke:** `python3 tests/smoke.py http://localhost:8765` passed all **13 top-level scenarios** in **61.01 seconds**. This includes token retention after mismatched passwords, a network failure and a GitHub 403; password clearing; direct `#demo` loading; and actual virtual-authenticator **add passkey → encrypted vault commit → Lock → passkey unlock**. The run printed `PASS CDP virtual authenticator PRF add and unlock (not physical hardware)` and `PASS all fictional headless reading-terminal regressions`.
- **Direct visual checks:** inspected the loaded demo library and setup mismatch screen in Chrome; the token remained masked and both password fields were empty.

All edits remain inside `site/`. No `vault.json` was created; mocked GitHub vault writes remained in memory. No real credentials, commit or push were used. Live GitHub and physical authenticator limits remain unchanged.

## v2 phase 1

### Changed

- Top bar: Library stays left; private sync shows relative age, an exact local-time tooltip and a 15-second refresh. Lock and ⋯ are on the right. ⋯ contains View, Settings and Help; View owns density and theme. At 390 × 844, only Library, the title, Notes and ⋯ remain in the bar.
- Renamed the pane/help label to Notes. Added reusable dashed `.bot-content` styling to the intake summary and existing bot-pane text, never user notes/highlights. Intake is labelled “Summary · from intake”; supplied `summary_by` is shown without inventing a writer. Existing summary front matter can name `summary_by` / `connections_by`.
- Preserved `j`/`k`/Enter, `/`, `?`, and reader keys. Global shortcuts ignore inputs, textareas, editable contenteditable variants, textbox editors and blocked auth screens. Esc closes menus/overlays/drawers before closing the reader. The interlinear editor retains its local editing keys.
- Removed the custom context menu. Selection offers Highlight, Send to notes and Copy; selectionchange and visualViewport-aware positioning support touch selections and viewport changes. Native right-click is not prevented.
- One six-second toast system replaces transient notices. Highlight deletion and automatic read/commented transitions apply immediately and can be undone. Highlight Undo works after navigating away and after synchronization. Passkey removal hides the slot immediately but delays publication until its own Undo window expires; Lock cancels pending removals. Concurrent notices retain independent timers.
- Lock screen: Password, Unlock, available passkey option, Remember this device, Explore the demo and collapsed Other options. Setup never overwrites a vault. Separate `#replace` requires exact, untrimmed REPLACE before publication.
- Settings order: Security, Backup, Connection, then collapsed Advanced token connection. Direct `#demo` skips credentials/vault loading; demo article hashes retain the demo marker so reload stays local in `demo:v1`.
- Updated public shell cache version, README and DESIGN. Added the no-dialogs regression and extended the existing fictional browser harness. A small Node test entry point ensures `node --test tests/` runs both test files instead of only the old package entry.

Current unread/read/commented statuses, their existing automatic rules and persisted state/notes formats remain in place. No migrations, Arrivals, queue, shelves, Edition, Listen or end-of-article bot box were built. `vault.json` was not created or edited. No commit, push or deployment was performed.

### Verification actually run

All commands below ran from `site/`.

```sh
node --check sw.js && node --check js/app.js && node --check js/auth.js && node --check js/demo.js && node --check js/library.js && node --check js/markdown.js && node --check js/notes.js && node --check js/passkey.js && node --check js/reader.js && node --check js/session.js && node --check js/store.js && node --check js/vault-api.js && node --check js/vault.js && node --check tests/index.mjs && node --check tests/no-dialogs.test.mjs && node --check tests/vault.test.mjs && node --test tests/
```

Passed syntax checks for **13 application JS files and 3 test modules**. Node reported **20 tests, 20 passed, 0 failed, 0 skipped**, including the unchanged vault suite and the recursive native-dialog scan.

- Focused runs of the actual Playwright scenarios passed selection-toolbar Copy/Send/Highlight, deletion/Undo across navigation and reload, automatic status Undo, editor guards, relative sync timer, demo/mobile behavior, setup/unlock/remember/Lock, exact replacement gating, delayed passkey deletion/conflicts/cancellation, and CDP virtual-authenticator PRF add/unlock.
- Earlier full runs exposed a Text-node target exception in the new outside-click handler and a smoke click aimed behind the mobile menu. The handler now normalizes the target; the outside-click scenario uses an uncovered point. Re-selecting a successfully copied passage now starts cleanly. A direct browser reload exposed loss of demo routing; retaining the demo article marker fixes it.
- Direct Chrome visual inspection covered the dark desktop at 1440 × 900, light phone at 390 × 844, overflow/View controls, mobile Settings order and collapsed Advanced. Reloading a demo article retained `#demo&article=…` and opened fictional content.
- The added touch-emulation regression exposed an unnecessary first ResizeObserver reflow that cleared a new selection despite unchanged width. The reader now tracks its last measured layout width and skips that redundant reflow; selecting then tapping Highlight survives and persists the exact quote.

The local server used for the final suite was:

```sh
python3 -m http.server 8766 --bind 127.0.0.1
```

Final verification command:

```sh
node --check js/reader.js && node --test tests/ && python3 tests/smoke.py http://localhost:8766
```

**Passed**, combined wall time **137.18 seconds**. The final reader syntax check passed; Node again reported **20/20**; all **17 top-level browser scenarios** passed with system Chrome `/usr/bin/google-chrome`, fictional data and intercepted GitHub/vault endpoints:

```text
PASS navigation_media_layout
PASS indexed_search
PASS debounce_status_and_growth
PASS highlight_drag_and_persistence
PASS keyboard_stars_and_read
PASS phase_one_surface
PASS selection_toolbar_and_undo
PASS automatic_status_undo_and_typing
PASS relative_sync_timer
PASS mobile_and_demo
PASS store_conflict_export_import
PASS setup_unlock_remember_lock
PASS setup_replacement_and_invalidation
PASS security_password_remove_conflicts
PASS lock_during_search
PASS replacement_during_security_work
PASS CDP virtual authenticator PRF add and unlock (not physical hardware)
PASS cdp_passkey_unlock
PASS all fictional headless reading-terminal regressions
```

The suite additionally passed all four full/absent/malformed/partial search-index cases. No uncaught browser exceptions or unexpected network requests were reported. Coverage includes mouse and emulated-touch toolbar use, six-second deletion/Undo expiry and persistence, contenteditable/input/lock shortcut guards, reader Esc, mobile top bar, sync-age refresh without writes, replacement rejection for non-exact REPLACE, independent passkey Undo windows, conflict retries and cancellation on Lock. The original navigation/media, notes/drag/persistence, store merge/backup and vault scenarios remain passing. Verification services were stopped afterward.

Native iPhone/iPad Safari, physical Face ID/Touch ID and live GitHub/Pages publication were not available for verification. Chrome touch emulation and a virtual authenticator do not establish native Safari or physical-device support. No real credentials or private reading data were used in the tests.
