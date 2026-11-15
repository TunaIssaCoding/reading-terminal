# Reading Terminal

A static, local-first reading workspace. No build step, framework, backend, analytics, or third-party scripts. Unlock your private library with a passkey, with your own password as backup. The lock/setup screens also offer **Explore the demo library**: three fictional articles whose edits stay on that device and never touch GitHub.

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
6. This device unlocks immediately; GitHub Pages may take a minute to publish the vault for other devices. Open **Settings → Security → Add passkey on this device**. Face ID, Touch ID or the platform authenticator will prompt; some platforms need a second prompt to obtain the PRF unlock secret. If PRF is unsupported, use your password on that device—no unusable slot is saved.
7. On another device, unlock with an available passkey or your password, then optionally add that device's passkey in Settings. Passkeys are tied to the site's hostname; changing hosts requires registering new ones. Normal use never needs token pasting.

**Remember this device** is on by default. It encrypts the session and DEK under a non-extractable device CryptoKey stored in IndexedDB, allowing silent unlock on the next visit, even offline. Use it only on a trusted browser profile. Turn it off to re-prompt after reload; credentials are then kept in memory, never sessionStorage. Same-origin scripts can use a stored CryptoKey despite its non-extractable flag.

The top-bar **Lock** button gives pending sync up to 1.5 seconds, deletes the remembered session, clears the current library cache and screen, and revokes private asset URLs. **Unsynced edits survive** in the durable queue/recovery journal and sync after the next unlock. These pending edits and downloaded backups are not encrypted by the vault. Sync/export before clearing browser data or retiring a device.

Settings → **Security** lists/removes passkeys and changes the password after verifying the current one. Changing the password keeps existing passkeys working. Passwords protect the public vault against offline guessing through PBKDF2 cost, not a server rate limit. Protect the device, browser profile, GitHub account and Pages origin; do not install untrusted scripts or paste credentials into chat/source files.

Forgotten password and no usable passkey? Open **`./#setup`**, tick **Replace the existing vault**, and supply the token and a new password. No old password is needed, but existing passkeys stop working against the replacement; remembered devices lock after observing its new identity. To revoke a leaked token, **delete/revoke it on GitHub and re-run setup with a new token**. Removing a passkey or changing the password does not revoke a token already obtained from an older vault, which may remain in Git history.

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
user/notes/<slug>.json
bot/summaries/<slug>.md
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
    "source_type": "essay",
    "words": 800,
    "tags": ["Design", "Attention"],
    "summary": "A short introduction. A second sentence describing the argument.",
    "pdf_url": null,
    "pdf_path": "assets/pdf/example-essay.pdf",
    "images": ["assets/images/example-diagram.png"],
    "status": "unread",
    "starred": false,
    "status_changed_at": "2026-01-01T12:00:00Z"
  }
]
```

Ids must be stable; slugs must be safe single path components. The first tag is the knowledge domain. Article bodies are markdown. Generated titles (`title_is_generated: true`) are subtly italicised.

**PDFs:** put the file in the private repository under `assets/pdf/` and set `pdf_path` to its repository-relative path, not a local filesystem path. The app fetches it through the authenticated Contents API, caches it as a PDF blob, and opens its object URL in a new tab. An absolute HTTP(S) `pdf_url` remains supported and takes precedence when both fields are supplied. No token is attached to external URLs.

**Images:** store private images under `assets/images/`. Bodies can use `![Description](assets/images/file.png)` (repository root) or `![Description](../assets/images/file.png)` (relative to `articles/<slug>.md`). Other relative body paths resolve from the article's directory; paths cannot escape the repository. If the body has no image, the app renders the item's `images[]` strings as a thumbnail strip below the summary. Private images are fetched through the Contents API and displayed as cached blob URLs, never requested from the public site. Absolute HTTP(S) images remain supported and contact their remote hosts without the token. Missing/offline assets show alternative text or an unavailable caption.

**Optional body search index:** the bot can write `search-index.json` as an object mapping article slug to plain body text, preferably lowercased:

```json
{ "example-essay": "the article's searchable plain text..." }
```

Full text gives complete body search; a truncated excerpt (for example, the first 2,000 characters) only searches that excerpt until the full body is opened or cached in the current session. The index is fetched once per connection session and cached in IndexedDB. Missing, malformed or unavailable indexes gracefully fall back to cached index entries or lazy body fetching; missing/non-string entries fall back per article. The app never writes the index.

`user/state.json` maps article **id** to `{status, starred, status_changed_at, last_opened_at}`. These fields override library metadata. The app also records field timestamps and `commented_from` (`"unread"`, `"read"`, or `null`) to distinguish automatic promotion from a manual status choice. Status and its promotion provenance merge together. Preserve these fields in backups. `user/notes/<slug>.json` contains:

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
      "created_at": "2026-01-01T12:00:00Z",
      "updated_at": "2026-01-01T12:00:00Z"
    }
  ],
  "updated_at": "2026-01-01T12:00:00Z"
}
```

The app may add a highlight `start` offset, `long_notes_updated_at`, and `deleted_highlights` tombstones for robust anchoring and concurrent edits. Preserve these extra fields when moving data. Never have the bot overwrite `user/*`.

The bot owns `library.json`, `articles/*`, `assets/*`, optional `search-index.json`, `bot/summaries/<slug>.md`, and `bot/meta.json`. The app **only PUTs `user/state.json` and `user/notes/<slug>.json`**. Optional bot metadata is `{ "updated_at": "…", "notes_summary_len": { "example-essay": 123 } }`. Bot summary markdown can contain a `## Connections` section. Link to another article with `[Title](article:other-slug)`, `[Title](articles/other-slug.md)`, `[Title](#article=other-slug)`, or `[[other-slug|Title]]`.

## Reading and writing

- **Library:** collapsible Unread / Read / Commented groups. Unread and Read sort by most recent status change; Commented sorts by bot summary length, falling back to note length. Stars are independent of status. Click a tag to filter; click it again or the filter chip to clear. Compact density is the default; the Compact / Comfortable toggle saves a device-local preference.
- **Navigation:** opening an article from the list, keyboard or internal link adds browser history. Back and Forward restore the article without adding another entry; initial restoration replaces the current entry.
- **Status:** scrolling through about 90% of the article marks it read. Typing any margin or long note marks it commented. Removing all note text restores the previous unread/read status only when Commented was automatic; highlights without note text do not count. Manual Commented remains Commented. Reading alone never downgrades Commented. The row's `⋯` menu can explicitly choose any status; the next substantive note edit promotes it again.
- **Interlinear notes:** select source text and press `h`, click the floating Highlight action, or right-click → Highlight. The focused editor starts below the selected first letter and continues through following line gaps. Extra rows expand spacing rather than obscure the source. Use arrows to move between note fragments; paste works across gaps. Click a highlight or its amber note to edit. Esc closes editing; Backspace on an empty note closes it but keeps the highlight. `×` deletes the highlight. Anchors use exact quote, surrounding context and paragraph hint; if the source changed beyond recognition, the preserved note appears in a warning below the article.
- **Long notes:** write markdown in the right pane, normally exactly 30% of the viewport. The editor grows and shrinks with its content; the pane, not the editor, scrolls. Drag its left edge or focus the separator and press arrow keys to resize. Drag highlighted text (including an existing text selection) onto the notes area to append a block quote after one empty line. The highlight's `↗` action and each margin entry's Send button provide keyboard/touch alternatives.
- **Notes order:** long notes → divider → live margin notes → read-only bot summary → connections. Bot material is displayed, not generated or edited by this app.
- **Mobile:** Library and Notes buttons open slide-over drawers. Tap outside or press Esc to close. Use the Send action to move a highlight to notes on touch devices.

### Keyboard

| Key | Action |
| --- | --- |
| `j` / `k` | Focus next / previous item in expanded groups |
| `Enter` | Open focused item |
| `r` | Toggle read (commented remains commented; item menu can override) |
| `s` | Toggle current article's star |
| `h` | Highlight source selection |
| `n` | Focus long notes |
| `/` | Focus search |
| `Esc` | Close popovers/drawers or the interlinear editor |
| `?` | Keyboard help |

Reading shortcuts do not fire inside inputs, editors, settings or the lock/setup screens. Shift + right-click retains the browser's native context menu. Dark mode is default; the top-bar theme button switches to light mode.

## Persistence, conflicts, and backups

Every edit is saved to the local cache and durable queue before a roughly two-second network debounce. Blur, hidden visibility and reconnect also request a flush. Closing a browser can interrupt a network request; the durable queue resumes on the next load. Wait for the sync indicator before switching to another device if possible.

Opening an article does not enqueue a write or make a GitHub commit. The initial auto-open does not change state. Later open timestamps remain in memory until bundled with another real state edit (status/star); leaving before such an edit can discard those timestamps, never notes.

Private caches are separated by owner/repository/branch. SHA conflicts trigger a fresh read and a bounded retry. Highlights merge by id and update timestamp; deletion tombstones prevent resurrection. State merges by field. Concurrent differing long-note edits preserve **both** versions with a visible conflict marker, newer first; resolve the marker by editing the long notes. Failed writes remain queued and are surfaced in the top bar, rather than being silently treated as synced. GitHub permissions, expired tokens and rate limits can prevent sync; fix settings or reconnect and retain a backup.

Settings → **Export backup** downloads all available user state/notes, without your token or article bodies. Export online to retrieve uncached and orphaned remote notes. If remote enumeration or retrieval fails, the download is visibly named **PARTIAL**, the JSON includes `complete: false` and warnings, and Settings tells you to reconnect and export again. This preserves an emergency copy of cached work without claiming a complete remote backup. **Import backup** merges through the same save/sync pipeline. Keep backups private and secure.

## Implementation and verification

`DESIGN.md` describes module contracts, source-line layout and sync semantics. `REPORT.md` records the checks actually run and known limits. `js/*.js` and `sw.js` are plain JavaScript; no build is required. The markdown renderer escapes raw HTML and allows safe links rather than executing article HTML. HTTPS hosting is recommended and required for service workers except on localhost.

The permanent headless smoke harness uses only fictional data and a mocked GitHub Contents API. With Python Playwright and `/usr/bin/google-chrome` installed, serve `site/` and run from the project root:

```sh
node --test site/tests/
python3 site/tests/smoke.py http://localhost:8000
```

The URL argument is optional (`READING_BASE_URL`, otherwise `http://localhost:8765`). Use `localhost`, not `127.0.0.1`, so WebAuthn has a valid RP id. The harness exercises the real browser UI and store, including setup/unlock/remember/Lock, security conflicts and a CDP virtual authenticator configured with `hasPrf: true`, `ctap2_1`, and `internal`. Passkey registration, encrypted vault commit, Lock and PRF unlock must succeed; an unsupported fallback fails the scenario. This does not verify physical authenticators. The harness captures uncaught exceptions and rejects unexpected network requests; no real token or repository is used and no result files are generated. Crypto unit tests use Node 20+ WebCrypto; package metadata only selects ES modules and the directory test entrypoint, not a build step.
