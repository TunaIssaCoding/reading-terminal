# Reading Terminal

A static, local-first reading workspace. No build step, framework, backend, analytics, or third-party scripts. Unlock your private library with a passkey, with your own password as backup. **Explore the demo** uses 44 fictional records whose edits stay on that device and never touch GitHub; demo links use `#demo&article=…` and the isolated `demo:v2` namespace, and demo startup removes legacy `demo:v1` records. Opening the app reopens the article you were last reading; an `#article=` link opens that article instead.

**26 Nov 2026:** Edition, Arrivals (triage), Up next and the library shelves were removed. The layout is the library (narrowest) beside the reader and notes, which share the remaining width equally.

## Publish the app

Publish the contents of `site/` to a public GitHub Pages repository (or any HTTPS static host). The app supports a Pages subdirectory: all code URLs are relative. The public repository contains app code, fictional fixtures and, after browser setup, an **encrypted** `vault.json`. Never add real articles, notes, backup exports, plaintext passwords or tokens. There is no pre-created vault in this source tree.

For local use, serve the directory rather than opening a `file://` URL:

```sh
cd site
python3 -m http.server 8000
```

Open `http://localhost:8000`. ES modules and service workers require HTTP(S). After the first successful load, the public app shell is available offline. Private content you have opened is cached in IndexedDB; unopened remote articles require a connection. Body search uses the optional `search-index.json` described below. Missing index entries fall back to progressively fetching and caching unopened articles (four concurrent requests).

## Create your private data repository

1. Create a **private** GitHub repository named **`reading-data`**. Initialize it with a commit and note the branch name (normally `main`). Owner, repository and branch are configurable.
2. Populate the private repo with the layout below. Start with `library.json` containing `[]` if your bot has not imported articles yet.
3. In GitHub, go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
4. Select the appropriate resource owner. Under repository access, choose **Only select repositories → reading-data and reading-terminal**. Grant **Repository permissions → Contents: Read and write**. Metadata read is automatically included. Choose an expiry appropriate to your usage; do not grant unrelated repositories.
5. Open the published site. With no vault, it displays setup. Enter the token, choose a password of at least 12 characters (**4–5 random words recommended**), and confirm it. Repository names/branches are configurable under **Repositories**. Choose **Create vault and unlock**. The private data repository is checked; the browser encrypts the token and commits only encrypted vault JSON to the site repository. The password is never transmitted; the token is sent only to GitHub in Authorization headers.
6. This device unlocks immediately; GitHub Pages may take a minute to publish the vault for other devices. Open **⋯ → Settings → Security → Add passkey on this device**. Face ID, Touch ID or the platform authenticator will prompt; some platforms need a second prompt to obtain the PRF unlock secret. If PRF is unsupported, use your password on that device—no unusable slot is saved.
7. On another device, unlock with an available passkey or your password, then optionally add that device's passkey in Settings. Passkeys are tied to the site's hostname; changing hosts requires registering new ones. Normal use never needs token pasting.

**Remember this device** is on by default. It encrypts the session and DEK under a non-extractable device CryptoKey stored in IndexedDB, allowing silent unlock on the next visit, even offline. Use it only on a trusted browser profile. Turn it off to re-prompt after reload; credentials are then kept in memory, never sessionStorage. Same-origin scripts can use a stored CryptoKey despite its non-extractable flag.

The top-bar **Lock** button gives pending sync up to 1.5 seconds, deletes the remembered session, clears the current library cache and screen, and revokes private asset URLs. **Unsynced edits survive** in the durable queue/recovery journal and sync after the next unlock. These pending edits and downloaded backups are not encrypted by the vault. Sync/export before clearing browser data or retiring a device.

Settings → **Security** lists/removes passkeys and changes the password after verifying the current one. Removing a passkey hides its row immediately and offers **Undo for 6 seconds**; publication starts only after that window. Undo or locking before expiry cancels removal. Changing the password keeps existing passkeys working. Passwords protect the public vault against offline guessing through PBKDF2 cost, not a server rate limit. Protect the device, browser profile, GitHub account and Pages origin; do not install untrusted scripts or paste credentials into chat/source files.

Forgotten password and no usable passkey? On the lock screen open **Other options → Replace vault**, or load **`./#replace`**. Supply the token and a new password, and type **REPLACE** exactly. This separate screen is the only replacement path; **Set up a vault** (`#setup`) never overwrites an existing vault. No old password is needed, but existing passkeys stop working against the replacement; remembered devices lock after observing its new identity. To revoke a leaked token, **delete/revoke it on GitHub and replace the vault with a new token**. Removing a passkey or changing the password does not revoke a token already obtained from an older vault, which may remain in Git history.

### Advanced manual connection

Existing manual tokens continue to work when `vault.json` is absent. **Settings → Advanced: connect with a token** retains connection testing and Save & connect. This legacy path stores the token in localStorage and needs access only to the private data repository. A successful vault unlock removes the old saved token. Exports never contain credentials. Use setup for the normal cross-device password/passkey flow.

## Private repository layout

```text
library.json
articles/<slug>.md
assets/pdf/<slug>.pdf
assets/images/<file>
search-index.json             # optional
user/state.json
user/queue.json
user/notes/<slug>.json
bot/summaries/<slug>.md
bot/editions/YYYY-MM-DD.json  # not shown by the app since 26 Nov 2026
bot/meta.json
```

`library.json` is an array of records:

```json
[
  {
    "id": "example-1",
    "slug": "example-essay",
    "title": "An example essay",
    "title_is_generated": false,
    "author": "Example Author",
    "handle": "@example",
    "url": "https://example.com/essay",
    "created_at": "2026-01-01T12:00:00Z",
    "added_at": "2026-01-02T12:00:00Z",
    "source_label": "Example journal",
    "lede": "The opening thought of this example essay.",
    "read_minutes": 4,
    "source_type": "essay",
    "words": 800,
    "tags": ["Design", "Attention"],
    "summary": "A short introduction. A second sentence describing the argument.",
    "pdf_url": null,
    "pdf_path": "assets/pdf/example-essay.pdf",
    "images": ["assets/images/example-diagram.png"]
  }
]
```

Ids must be stable; slugs must be safe single path components. The first tag is the knowledge domain. Article bodies are markdown. Generated titles (`title_is_generated: true`) are subtly italicised.

Optional metadata falls back as follows: `added_at` → `created_at`; `read_minutes` → `ceil(words / 230)`; `source_label` → `source_type`. Without `summary`, the reader shows only `lede` when supplied. It does not invent an intake summary.

**PDFs:** put the file in the private repository under `assets/pdf/` and set `pdf_path` to its repository-relative path, not a local filesystem path. The app fetches it through the authenticated Contents API, caches it as a PDF blob, and opens its object URL in a new tab. An absolute HTTP(S) `pdf_url` remains supported and takes precedence when both fields are supplied. No token is attached to external URLs.

**Images:** store private images under `assets/images/`. Bodies can use `![Description](assets/images/file.png)` (repository root) or `![Description](../assets/images/file.png)` (relative to `articles/<slug>.md`). Other relative body paths resolve from the article's directory; paths cannot escape the repository. If the body has no image, the app renders the item's `images[]` strings as a thumbnail strip below the summary. Private images are fetched through the Contents API and displayed as cached blob URLs, never requested from the public site. Absolute HTTP(S) images remain supported and contact their remote hosts without the token. Missing/offline assets show alternative text or an unavailable caption.

**Optional body search index:** the bot can write `search-index.json` as an object mapping article slug to plain body text, preferably lowercased:

```json
{ "example-essay": "the article's searchable plain text..." }
```

Full text gives complete body search; a truncated excerpt (for example, the first 2,000 characters) only searches that excerpt until the full body is opened or cached in the current session. The index is fetched once per connection session and cached in IndexedDB. Missing, malformed or unavailable indexes gracefully fall back to cached index entries or lazy body fetching; missing/non-string entries fall back per article. The app never writes the index.

`user/state.json` maps article **id** to `{progress, position, starred, triaged_at, progress_changed_at, last_opened_at, _timestamps}`. `progress` is `new`, `reading`, `finished`, or `let_go`; `position` is a 0–1 scroll fraction. `starred` is displayed as **★ Keeper** (“worth coming back to”), independently of progress. `_timestamps` preserves per-field conflict merging. Untriaged/unopened timestamps can be `null`. Has notes is never stored: it is derived from nonblank long notes or highlight note text in the notes file.

`user/queue.json` (the old Up next queue) is no longer edited by the interface. The store still reads and merges an existing file, so devices on an older version keep syncing; nothing new is added to it.

### One-time v2 migration

Before writing converted state, the app saves the original `state.json` text in its namespaced IndexedDB backup store. No download is required. **Settings → Backup → Export pre-v2 backup** exports that original state file. The backup survives Lock, is not encrypted by the vault, and is lost if browser storage is cleared. When migrating an old offline cache without original formatting, the backup serializes its pre-conversion content.

| Legacy state | Progress |
| --- | --- |
| Unread | New, untriaged |
| Read | Finished |
| Commented, `commented_from: "unread"` | Reading |
| Commented, `commented_from: "read"` or null/missing | Finished |

Migration removes `status`, its legacy timestamps, and `commented_from`; non-New entries receive `triaged_at`. Clean v2 state is not rewritten on later loads. SHA retries reapply conversion to fresh remote state and preserve concurrent user fields. The fictional demo follows the same migration in its own namespace.

`user/notes/<slug>.json` contains:

```json
{
  "long_notes": "",
  "highlights": [
    {
      "id": "stable-highlight-id",
      "quote": "exact source text",
      "prefix": "nearby text before",
      "suffix": "nearby text after",
      "para": 0,
      "note": "A thought between the lines.",
      "still_agree_at": "2026-11-24",
      "created_at": "2026-01-01T12:00:00Z",
      "updated_at": "2026-01-01T12:00:00Z"
    }
  ],
  "links": [{ "slug": "another-essay", "title": "Another essay" }],
  "hidden_links": [],
  "updated_at": "2026-01-01T12:00:00Z"
}
```

The app may add a highlight `start` offset, optional `still_agree_at` local calendar date, `long_notes_updated_at`, and `deleted_highlights` tombstones for robust anchoring and concurrent edits. **Still agree** sets that highlight's date without changing its quote or note; Undo restores the previous date or its absence. Preserve these extra fields when moving data. Never have the bot overwrite `user/*`.

The bot owns `library.json`, `articles/*`, `assets/*`, optional `search-index.json`, `bot/summaries/<slug>.md`, `bot/editions/<YYYY-MM-DD>.json`, and `bot/meta.json`. The reading store **only PUTs `user/state.json`, `user/queue.json`, and `user/notes/<slug>.json`**. Bot summaries are fetched lazily when an article opens; a missing summary is normal. Front matter can provide `summary_by`, `date` or `updated_at`, `notes_updated_at`, `connections_by`, and a `connections` YAML-like list of `{slug, title, why}`. The body can contain `## About your notes` and a `## Connections` markdown list. Article links can use `[Title](article:other-slug)`, `[Title](articles/other-slug.md)`, `[Title](#article=other-slug)`, or `[[other-slug|Title]]`.

Editions (`bot/editions/`) are no longer displayed or requested by the app. The store's parser remains for older cached data.

## Reading and writing

- **Library:** one list grouped by progress (New, Reading, Finished, Let go), each group newest first, with search and filters for progress, Keepers, notes, length and source. **Feeling lucky**, below the filters, opens a random article you haven't started (progress New), never the one already open; it is disabled when nothing is unread.
- **Images:** tap any article image (body or thumbnail strip) to open it full-screen at its original resolution, scaled to fit. With several images, ←/→ or the side arrows move between them; Esc, × or a tap anywhere else closes.
- **Library:** New / Reading / Finished / Let go groups, newest added first. Filters: Progress, ★ Keepers, ✎ With notes, ≤ 10 min, and Source (from `source_label`). **With notes · most recent** sorts globally by the notes file's `updated_at`, not summary length. Rows show one full domain chip, source label, minutes, a `✎ n` badge (annotated highlights + one for long notes), and a thin Reading progress bar. Click a domain to filter. **⋯ → View** contains Compact / Comfortable density and theme controls.
- **Navigation:** opening an article from the list, keyboard or internal link adds browser history. Back and Forward restore the article without adding another entry; initial restoration replaces the current entry.
- **Progress:** opening New sets Reading and saves `last_opened_at`; other progress is preserved on open. Reaching 90% marks Reading as Finished and shows **Marked finished · Undo** for six seconds. Undo returns to Reading and cannot immediately re-trigger until scrolling below 90%. `r` toggles Finished / Reading with Undo. **Let go** is in the reader's ⋯ menu with Undo. Notes never change progress. Keeper is independent. The reader header shows progress and percentage while Reading; ⋯ also holds Open PDF and Open source. With no article, article actions are hidden and `r`/`s` do nothing.
- **Interlinear notes:** select source text and press `h`, or use the floating **Highlight / Send to notes / Copy** toolbar. The browser's right-click menu is never replaced. Selection changes also position the toolbar above touch selections, clamped inside the visible viewport. The focused highlight editor starts below the selected first letter and continues through following line gaps. Extra rows expand spacing rather than obscure the source. Use arrows to move between note fragments; paste works across gaps. Click a highlight or its amber note to edit. Esc closes editing; Backspace on an empty note closes it but keeps the highlight. `×` deletes the highlight immediately, with **Undo for 6 seconds**, including after navigating to another article. Anchors use exact quote, surrounding context and paragraph hint; if the source changed beyond recognition, the preserved note appears in a warning below the article.
- **Long notes:** write markdown in the right pane, normally exactly 30% of the viewport. The editor grows and shrinks with its content; the pane, not the editor, scrolls. Drag its left edge or focus the separator and press arrow keys to resize. Drag highlighted text (including an existing text selection) onto the notes area to append a block quote after one empty line. The highlight's `↗` action and each margin entry's Send button provide keyboard/touch alternatives.
- **Your notes:** long markdown notes → reading-order highlights (click a quote to jump) → kept links. Kept links resolve current library titles and open on click/Enter; missing articles are labelled “not in your library.” **Remove** offers six-second Undo. No bot content appears in this pane. Article source lines use approximately 1.6 line height; only a note/editor opens extra space underneath its line. The intake summary remains labelled **Summary · from intake**.
- **End-of-article bot box:** dashed, attributed to `summary_by` and its date, or **Reading bot** when no author is supplied. “About your notes” uses the safe markdown renderer. Connections are headed “Suggested by” their `connections_by`, with titles resolved from the library. Unknown articles are marked “not in your library” and cannot be kept. **Keep link** saves `{slug, title}` in `links[]`, removes that slug from `hidden_links[]`, and displays **Kept ✓** plus **Unkeep**. **Hide** saves a slug in `hidden_links[]`; the small **Show hidden (n)** control reveals hidden suggestions without rewriting decisions. Keep, Unkeep and Hide offer six-second Undo; both arrays remain deduplicated. If notes are newer than `notes_updated_at`, the box says “Your notes changed since this was written.” The app never edits bot files.
- **Collections:** **Library**, **Papers** and **Books & textbooks** sit right of the wordmark. Each shows only its own items; search, filters, sources and Feeling lucky work inside the current one. A record's `collection` field (`library`, `papers`, `books`) decides, otherwise `source_type`: `paper` → Papers, `book` or `textbook` → Books & textbooks, anything else → Library. Clicking the current collection hides or shows the list. Opening an article switches to its collection. The last collection is remembered on each device.
- **Top bar:** the wordmark and collections sit left; successful private sync shows relative age and an exact local-time tooltip, refreshed every 15 seconds. Queued/error states remain explicit; demo saves are labelled local, not synced. Lock and **⋯ → View / Settings / Help** are on the right.
- **Mobile:** the top bar keeps the title, Library, Notes and ⋯, and the collections sit at the top of the library drawer; sync, the private/demo badge and Lock move into ⋯. Library and Notes open slide-over drawers. Tap outside or press Esc outside an editor to close.
- **Settings:** Security first, then Backup, then Connection. **Advanced: connect with a token** is last and collapsed whenever Settings opens. Feedback uses one toast system; overlapping Undo actions each retain their own six-second window.

### Keyboard

| Key | Action |
| --- | --- |
| `j` / `k` | Focus next / previous article in the library |
| `Enter` | Open focused item |
| `r` | Toggle Finished / Reading |
| `s` | Toggle current article's Keeper |
| `h` | Highlight source selection |
| `n` | Focus long notes |
| `/` | Focus search |
| `Esc` | Close overlays/menus/drawers, then the reader; the note editor has its own Esc |
| `?` | Keyboard help |

Reading shortcuts do not fire inside inputs, textareas, contenteditable editors, settings or the lock/setup/replacement screens. Dark mode is default; change it in **⋯ → View**. Menus close on Esc and outside click.

## Persistence, conflicts, and backups

Every edit is saved to the local cache and durable queue first. A commit follows 2 seconds after you stop typing, but at most once every 10 seconds, so a long writing session stays under 360 commits an hour (GitHub allows 500). Leaving the window or app, and reconnecting, sends everything at once. If GitHub asks the app to slow down, it shows how long, waits that long and then syncs; edits stay on the device meanwhile. The open article's notes are re-checked when you return to the app and every 30 seconds while it's open (skipped for 5 seconds after you type), so notes written on another device appear without reopening the article. Closing a browser can interrupt a network request; the durable queue resumes on the next load. Wait for the sync indicator before switching to another device if possible.

Article opens are state edits: they save `last_opened_at` and move New to Reading. Reading position is locally saved at most once per 750 ms while scrolling, with a trailing save and a flush on navigation/blur/hidden visibility; network writes use the existing debounce. The app restores saved Reading position on reopen.

Private caches are separated by owner/repository/branch. SHA conflicts trigger a fresh read and a bounded retry. Highlights merge by id and update timestamp; deletion tombstones prevent resurrection. State merges by field. Concurrent differing long-note edits preserve **both** versions with a visible conflict marker, newer first; resolve the marker by editing the long notes. Failed writes remain queued and are surfaced in the top bar, rather than being silently treated as synced. GitHub permissions, expired tokens and rate limits can prevent sync; fix settings or reconnect and retain a backup.

The store still merges an existing `user/queue.json` three-way (remote order, local additions appended, local removals applied against the saved base) so older devices keep syncing; the interface no longer edits it.


Settings → **Export backup** downloads all available user state, queue and notes, without your token or article bodies. Export online to retrieve uncached and orphaned remote notes. If remote enumeration or retrieval fails, the download is visibly named **PARTIAL**, the JSON includes `complete: false` and warnings, and Settings tells you to reconnect and export again. **Import backup** merges through the same save/sync pipeline; an existing remote queue is never replaced. **Export pre-v2 backup** separately exports the retained original state JSON, not a full user-data backup. Keep backups private and secure.

## Implementation and verification

`DESIGN.md` describes module contracts, the note layout and sync semantics. `REPORT.md` records the checks actually run and known limits. `js/*.js` and `sw.js` are plain JavaScript; no build is required. The markdown renderer escapes raw HTML and allows safe links rather than executing article HTML. HTTPS hosting is recommended and required for service workers except on localhost.

The permanent headless smoke harness uses only fictional data and a mocked GitHub Contents API. With Python Playwright and `/usr/bin/google-chrome` installed, serve `site/` and run from the project root:

```sh
node --test site/tests/
python3 site/tests/smoke.py http://localhost:8808
```

The URL argument is optional (`READING_BASE_URL`, otherwise `http://localhost:8808`). Use `localhost`, not `127.0.0.1`, so WebAuthn has a valid RP id. **Note (26 Nov 2026):** the harness still contains Edition, triage and Up next scenarios; remove them before running it. The remaining scenarios exercise connection decisions, the reader, store, setup/unlock/remember/Lock, security conflicts and a CDP virtual authenticator configured with `hasPrf: true`, `ctap2_1`, and `internal`. This does not verify physical authenticators. No real token or repository is used. Crypto unit tests use Node 20+ WebCrypto; package metadata only selects ES modules and the directory test entrypoint, not a build step.
