#!/usr/bin/env python3
"""Headless behavioral regressions; all GitHub data below is fictional.

Serve site/, then run: python3 site/tests/smoke.py [http://localhost:8765]
READING_BASE_URL supplies the URL when the positional argument is omitted.
Requires Python Playwright and /usr/bin/google-chrome; no browser install needed.
No real repository, credentials, downloads, screenshots, or result files are used.
"""

import argparse
import base64
from contextlib import contextmanager
import hashlib
import json
import os
import re
import time
from urllib.parse import unquote, urlparse

from playwright.sync_api import expect, sync_playwright


TOKEN = "fictional-smoke-token-not-a-credential"
SETTINGS = {"owner": "fictional-reader", "repo": "fictional-library", "branch": "main", "token": TOKEN}
API_ROOT = "/repos/fictional-reader/fictional-library"
NOTES = ".long-notes-editor"
STAMP = "2026-01-01T00:00:00.000Z"
PASSWORD = "Fictional orchard comet river 73!"
NEW_PASSWORD = "Fictional lantern meadow orbit 94!"
SITE_ROOT = "/repos/fictional-reader/fictional-site/contents/vault.json"
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")


def pdf_bytes():
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
               b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>",
               b"<< /Length 0 >>\nstream\n\nendstream"]
    result = b"%PDF-1.4\n"
    offsets = [0]
    for number, body in enumerate(objects, 1):
        offsets.append(len(result))
        result += str(number).encode() + b" 0 obj\n" + body + b"\nendobj\n"
    xref = len(result)
    result += b"xref\n0 5\n0000000000 65535 f \n"
    result += b"".join(f"{offset:010} 00000 n \n".encode() for offset in offsets[1:])
    return result + f"trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()


def wait_until(page, condition, message, timeout=12000):
    deadline = time.monotonic() + timeout / 1000
    while time.monotonic() < deadline:
        if condition():
            return
        page.wait_for_timeout(50)
    raise AssertionError(message)


class Repository:
    def __init__(self, index="full", private=True):
        self.private = private
        self.requests = []
        self.public_vault_requests = []
        self.puts = []
        self.violations = []
        self.conflicts = {}
        self.items = []
        self.files = {}
        self.vault = None
        self.vault_puts = []
        self.vault_conflict = None
        self.vault_conflict_status = 409
        self.public_vault_error = False
        self.fail_writes = False
        body_index = {}
        for number in range(1, 25):
            slug = f"essay-{number:02}"
            status = "unread" if number <= 16 else "read" if number <= 21 else "commented"
            item = {"id": slug, "slug": slug, "title": f"Fictional field notebook {number:02}",
                    "author": "Ada Fiction", "tags": ["fiction.example", "fieldwork", "quiet"],
                    "created_at": f"2026-01-{25-number:02}T12:00:00Z",
                    "status_changed_at": f"2026-01-{25-number:02}T12:00:00Z", "status": status,
                    "words": 1800, "summary": "An invented observation, used only for regression checks.",
                    "url": "https://fiction.example/source", "title_is_generated": number == 1}
            paragraph = ("The fictional astronomer carried a notebook across the quiet orchard. "
                         "Every imagined observation deserves a careful sentence and a patient reader. "
                         "These invented details describe no real person or private reading material. ")
            body = "\n\n".join(f"{paragraph} Observation {n}." for n in range(24))
            if number == 1:
                item.update(pdf_path="assets/pdf/essay-01.pdf", images=["assets/images/fallback.png"])
            if number == 2:
                item.update(pdf_url="https://fiction.example/external.pdf", images=["assets/images/fallback.png"])
                body = "![An invented pixel](assets/images/inline.png)\n\n![Relative invented pixel](../assets/images/relative.png)\n\n" + body
            if number == 3:
                body = "[Return to the first notebook](article:essay-01)\n\n" + body
            if number == 14:
                body += "\n\nThe unique body-only search word is zephyrquartz."
            self.items.append(item)
            self.set(f"articles/{slug}.md", body)
            body_index[slug] = body.lower()
            self.set(f"bot/summaries/{slug}.md", "## Observations\nA fictional bot summary.\n\n## Connections\n"
                     "- [Another notebook](article:essay-03)")
        self.set("library.json", self.items)
        self.set("user/state.json", {})
        self.set("bot/meta.json", {"notes_summary_len": {"essay-22": 50, "essay-23": 900, "essay-24": 300}})
        self.files["assets/pdf/essay-01.pdf"] = pdf_bytes()
        self.files["assets/images/fallback.png"] = PNG
        self.files["assets/images/inline.png"] = PNG
        self.files["assets/images/relative.png"] = PNG
        if index == "full":
            self.set("search-index.json", body_index)
        elif index == "partial":
            del body_index["essay-14"]
            body_index["essay-15"] = {"invalid": "not text"}
            self.set("search-index.json", body_index)
        elif index == "malformed":
            self.set("search-index.json", "{ definitely not JSON")
        elif index != "absent":
            raise ValueError(index)

    def set(self, path, value):
        self.files[path] = (value if isinstance(value, str) else json.dumps(value)).encode()

    def document(self, path):
        return json.loads(self.files[path])

    def article_gets(self):
        return [path for method, path, _ in self.requests if method == "GET" and path.startswith("articles/")]

    def route(self, route, request):
        url = urlparse(request.url)
        if request.headers.get("authorization") != f"Bearer {TOKEN}":
            self.violations.append("GitHub request missing fictional authorization")
            return route.fulfill(status=401, json={"message": "Unauthorized fictional request"})
        if url.path == "/repos/fictional-reader/fictional-site":
            return route.fulfill(json={"private": False, "permissions": {"push": True}})
        if url.path == SITE_ROOT:
            return self.route_vault(route, request)
        if url.path == API_ROOT:
            self.requests.append((request.method, "repository", time.monotonic()))
            return route.fulfill(json={"private": self.private, "permissions": {"push": True}})
        prefix = API_ROOT + "/contents/"
        if not url.path.startswith(prefix):
            self.violations.append("Unexpected GitHub endpoint: " + url.path)
            return route.fulfill(status=404, json={"message": "No fictional endpoint"})
        path = unquote(url.path[len(prefix):])
        self.requests.append((request.method, path, time.monotonic()))
        if request.method == "PUT":
            if self.fail_writes:
                return route.fulfill(status=503, json={"message": "Fictional offline write"})
            if not self.private or not re.fullmatch(r"user/(state\.json|notes/[^/]+\.json)", path):
                self.violations.append("Unsafe PUT: " + path)
                return route.fulfill(status=403, json={"message": "Unsafe write"})
            data = request.post_data_json
            self.puts.append((path, time.monotonic(), data))
            if path in self.conflicts:
                self.set(path, self.conflicts.pop(path))
                return route.fulfill(status=409, json={"message": "Fictional concurrent edit"})
            current = self.files.get(path)
            sha = hashlib.sha1(current).hexdigest() if current is not None else None
            if data.get("sha") != sha:
                return route.fulfill(status=409, json={"message": "SHA mismatch"})
            self.files[path] = base64.b64decode(data["content"])
            return route.fulfill(json={"content": {"path": path, "sha": hashlib.sha1(self.files[path]).hexdigest()}})
        if path == "user/notes":
            return route.fulfill(json=[{"type": "file", "name": p.rsplit("/", 1)[1], "path": p}
                                       for p in self.files if p.startswith("user/notes/")])
        if path not in self.files:
            return route.fulfill(status=404, json={"message": "Not Found"})
        content = self.files[path]
        if "raw" in request.headers.get("accept", ""):
            mime = "application/pdf" if path.endswith(".pdf") else "image/png" if path.endswith(".png") else "text/plain"
            return route.fulfill(body=content, content_type=mime)
        return route.fulfill(json={"type": "file", "encoding": "base64", "path": path,
                                   "content": base64.b64encode(content).decode(), "sha": hashlib.sha1(content).hexdigest()})

    def route_vault(self, route, request):
        content = json.dumps(self.vault).encode() if self.vault is not None else None
        sha = hashlib.sha1(content).hexdigest() if content is not None else None
        if request.method == "GET":
            if content is None:
                return route.fulfill(status=404, json={"message": "Not Found"})
            return route.fulfill(json={"type": "file", "encoding": "base64", "path": "vault.json",
                                       "sha": sha, "content": base64.b64encode(content).decode()})
        if request.method != "PUT":
            self.violations.append("Unexpected vault method: " + request.method)
            return route.fulfill(status=405, json={"message": "Method not allowed"})
        data = request.post_data_json
        self.vault_puts.append(data)
        if self.vault_conflict is not None:
            self.vault = self.vault_conflict
            self.vault_conflict = None
            return route.fulfill(status=self.vault_conflict_status, json={"message": "Fictional concurrent vault edit"})
        if data.get("sha") != sha:
            return route.fulfill(status=409, json={"message": "SHA mismatch"})
        decoded = base64.b64decode(data["content"]).decode()
        assert data["message"] == "Update reading vault"
        assert data.get("branch", "main") == "main"
        assert TOKEN not in decoded and PASSWORD not in decoded and NEW_PASSWORD not in decoded
        self.vault = json.loads(decoded)
        assert self.vault["format"] == "reading-terminal-vault"
        assert "token" not in self.vault and "dek" not in self.vault
        return route.fulfill(json={"content": {"path": "vault.json",
                                               "sha": hashlib.sha1(json.dumps(self.vault).encode()).hexdigest()}})


@contextmanager
def session(browser, base, repo=None, mobile=False, store_only=False, demo=False, vault=False, clock=False):
    repo = repo or Repository()
    context = browser.new_context(viewport={"width": 390 if mobile else 1440, "height": 844 if mobile else 900},
                                  service_workers="block", reduced_motion="reduce", has_touch=mobile)
    errors, unexpected = [], []
    origin = urlparse(base)

    def network(route, request):
        url = urlparse(request.url)
        if url.hostname == "api.github.com":
            return repo.route(route, request)
        if url.hostname == "fiction.example" and url.path == "/external.pdf":
            return route.fulfill(content_type="text/html", body="<title>Fictional external PDF destination</title>")
        if (url.scheme, url.netloc) == (origin.scheme, origin.netloc):
            if url.path.endswith("/vault.json"):
                repo.public_vault_requests.append(request.url)
                if repo.public_vault_error:
                    return route.abort("internetdisconnected")
                if repo.vault is None:
                    return route.fulfill(status=404, json={"message": "No fictional vault"})
                return route.fulfill(json=repo.vault, headers={"Cache-Control": "no-store"})
            if url.path.endswith("/__smoke_store__.html"):
                return route.fulfill(content_type="text/html", body="<!doctype html><title>Isolated store smoke</title>")
            if "/assets/" in url.path:
                unexpected.append("Private asset fetched from public site: " + url.path)
                return route.fulfill(status=404, body="Private fixture must use authenticated Contents API")
            return route.continue_()
        unexpected.append(request.url)
        return route.abort()

    context.route("**/*", network)
    if not demo and not vault:
        context.add_init_script(
            "if (location.origin === " + json.dumps(f"{origin.scheme}://{origin.netloc}") + ") "
            "localStorage.setItem('reading-terminal.settings', " + json.dumps(json.dumps(SETTINGS)) + ")")
    context.on("page", lambda page: page.on("pageerror", lambda error: errors.append(str(error))))
    page = context.new_page()
    if clock:
        page.clock.install()
    page.route("https://api.github.com/**", repo.route)
    page.set_default_timeout(12000)
    page.goto(base + ("/__smoke_store__.html" if store_only else "/#demo" if demo else
                      "/#article=essay-01" if not vault else "/"))
    if not store_only and not vault:
        page.wait_for_selector(".source-line")
        expect(page.locator(NOTES)).to_be_enabled()
        page.evaluate("document.fonts.ready")
    try:
        yield page, repo, errors
        assert not errors, "Uncaught browser exceptions: " + repr(errors)
        assert not repo.violations, repo.violations
        assert not unexpected, "Unexpected/public network fetches: " + repr(unexpected)
    finally:
        context.close()


def opened(page, slug):
    expect(page.locator(".library-item.is-active")).to_have_attribute("data-library-id", slug)
    expect(page.locator(NOTES)).to_have_attribute("aria-label", f"Long notes for Fictional field notebook {int(slug[-2:]):02}")
    page.wait_for_selector(".source-line")
    assert page.url.endswith("#article=" + slug), page.url


def open_item(page, slug):
    page.locator(f'[data-library-id="{slug}"] .library-title').click()
    opened(page, slug)


def status(page, slug, value):
    expect(page.locator(f'.library-group[data-status="{value}"] [data-library-id="{slug}"]')).to_have_count(1)


def set_status(page, slug, value):
    row = page.locator(f'[data-library-id="{slug}"]')
    row.locator(".item-status-toggle").click()
    row.locator(f'button[data-action="status"][data-status="{value}"]').click()
    status(page, slug, value)


def menu_action(page, selector, view=False):
    page.locator("#more-toggle").click()
    expect(page.locator("#more-menu")).to_be_visible()
    if view:
        page.locator("#view-toggle").click()
        expect(page.locator("#view-menu")).to_be_visible()
    page.locator(selector).click()
    if page.locator("#more-menu").is_visible():
        page.keyboard.press("Escape")
    if page.locator("#more-menu").is_visible():
        page.keyboard.press("Escape")


def lock_library(page):
    if page.locator("#lock-button").is_visible():
        page.locator("#lock-button").click()
    else:
        menu_action(page, "#lock-button")
    expect(page.locator("#lock-screen")).to_be_visible()


def synced(page):
    expect(page.locator("#sync-status")).to_have_text(re.compile(r"^Synced\b", re.I), timeout=15000)
    expect(page.locator("#sync-status")).to_have_attribute("title", re.compile(r".+"))


def navigation_media_layout(browser, base):
    with session(browser, base) as (page, repo, _):
        opened(page, "essay-01")
        page.wait_for_timeout(2500)  # A negative assertion must exceed the 2s sync debounce.
        assert repo.puts == [], "Initial open must not create a repository commit"
        expect(page.locator("#article-header h1")).to_have_css("font-style", "italic")
        expect(page.locator('[data-library-id="essay-01"] .library-title')).to_have_css("font-style", "italic")
        for group, expected in [("unread", [f"essay-{n:02}" for n in range(1, 17)]),
                                ("read", [f"essay-{n:02}" for n in range(17, 22)]),
                                ("commented", ["essay-23", "essay-24", "essay-22"])]:
            actual = page.locator(f'.library-group[data-status="{group}"] .library-item').evaluate_all("rows => rows.map(r => r.dataset.libraryId)")
            assert actual == expected, (group, actual)
        metrics = page.locator("#library").evaluate("""root => {
            const box = root.getBoundingClientRect();
            const rows = [...root.querySelectorAll('.library-item')];
            return {height: rows[0].getBoundingClientRect().height,
              visible: rows.filter(r => {const b=r.getBoundingClientRect();return b.top>=box.top && b.bottom<=box.bottom}).length};
        }""")
        assert 9 <= metrics["visible"] <= 13, metrics
        menu_action(page, "#library-density", view=True)
        comfortable = page.locator(".library-item").first.bounding_box()["height"]
        assert comfortable > metrics["height"] + 10, (metrics, comfortable)
        page.reload()
        opened(page, "essay-01")
        assert page.locator(".library-item").first.bounding_box()["height"] > metrics["height"] + 10
        menu_action(page, "#library-density", view=True)
        icons = page.locator('link[rel~="icon"]')
        assert icons.count(), "Missing favicon link"
        icon_url = icons.first.evaluate("el => el.href")
        assert page.evaluate("async url => (await fetch(url)).ok", icon_url), icon_url
        # Chromium handles favicon.ico specially under request interception.
        # The linked SVG is fetched in-page above; check the legacy endpoint directly.
        assert page.context.request.get(base + "/favicon.ico").ok, "/favicon.ico returns an error"
        image = page.locator(".article-images img")
        expect(image).to_have_count(1)
        expect(image).to_have_attribute("src", re.compile(r"^blob:"))
        image.evaluate("img => img.decode()")
        assert image.evaluate("img => img.naturalWidth") == 1
        pdf = page.locator("#article-header").get_by_role("link", name=re.compile("PDF"))
        expect(pdf).to_have_attribute("href", re.compile(r"^blob:"))
        with page.context.expect_page() as pending:
            pdf.click()
        popup = pending.value
        popup.wait_for_url(re.compile(r"^blob:"))
        popup.close()
        assert any(method == "GET" and path == "assets/pdf/essay-01.pdf" for method, path, _ in repo.requests)
        initial_history = page.evaluate("history.length")
        open_item(page, "essay-02")
        assert page.evaluate("history.length") == initial_history + 1
        inline = page.locator("#article-body img")
        expect(inline).to_have_count(2)
        for image in inline.all():
            expect(image).to_have_attribute("src", re.compile(r"^blob:"))
            image.evaluate("img => img.decode()")
        expect(page.locator(".article-images img")).to_have_count(0)
        with page.context.expect_page() as pending:
            page.locator("#article-header").get_by_role("link", name=re.compile("PDF")).click()
        external = pending.value
        external.wait_for_url("https://fiction.example/external.pdf")
        external.close()
        page.locator('.connections-section a[data-article="essay-03"]').click()
        opened(page, "essay-03")
        page.go_back()
        opened(page, "essay-02")
        page.go_back()
        opened(page, "essay-01")
        page.go_forward()
        opened(page, "essay-02")
        open_item(page, "essay-03")
        page.locator('#article-body a[data-article="essay-01"]').click()
        opened(page, "essay-01")
        page.go_back()
        opened(page, "essay-03")
        page.wait_for_timeout(2500)
        assert repo.puts == [], "Open/history/density/media operations must not sync user state"


def indexed_search(browser, base):
    for mode in ("full", "absent", "malformed", "partial"):
        with session(browser, base, Repository(index=mode)) as (page, repo, _):
            before = len(repo.article_gets())
            page.locator("#search").fill("zephyrquartz")
            expect(page.locator(".library-title")).to_have_text(["Fictional field notebook 14"], timeout=20000)
            expect(page.locator("#search-status")).to_have_text("", timeout=20000)
            # Include the search debounce even when an indexed match renders immediately.
            page.wait_for_timeout(450)
            fetched = repo.article_gets()[before:]
            if mode == "full":
                assert fetched == [], (mode, fetched)
            elif mode == "partial":
                assert set(fetched) == {"articles/essay-14.md", "articles/essay-15.md"}, fetched
            else:
                assert "articles/essay-14.md" in fetched, (mode, fetched)
            assert repo.puts == [], "Searching must not write user data"
        print("PASS search index:", mode)


def debounce_status_and_growth(browser, base):
    with session(browser, base) as (page, repo, _):
        page.locator(NOTES).fill("First fictional thought")
        status(page, "essay-01", "commented")
        page.wait_for_timeout(650)
        assert not repo.puts, "Notes synced before debounce"
        page.locator(NOTES).fill("Second fictional thought")
        last_input = time.monotonic()
        page.wait_for_timeout(650)
        assert not repo.puts, "Debounce did not restart after another edit"
        synced(page)
        assert min(at for _, at, _ in repo.puts) - last_input >= 1.65, repo.puts
        assert repo.document("user/notes/essay-01.json")["long_notes"] == "Second fictional thought"
        expect(page.locator("#reader-star")).to_have_attribute("aria-pressed", "false")
        count = len(repo.puts)
        page.locator("#reader-star").click()
        page.wait_for_timeout(650)
        assert len(repo.puts) == count, "Star synced before debounce"
        synced(page)
        assert repo.document("user/state.json")["essay-01"]["starred"] is True
        page.reload()
        opened(page, "essay-01")
        expect(page.locator(NOTES)).to_have_value("Second fictional thought")
        status(page, "essay-01", "commented")
        page.locator(NOTES).fill("")
        status(page, "essay-01", "unread")
        synced(page)
        open_item(page, "essay-17")
        page.locator(NOTES).fill("An annotation on an already read article")
        status(page, "essay-17", "commented")
        synced(page)
        page.reload()
        opened(page, "essay-17")
        page.locator(NOTES).fill("  \n ")
        status(page, "essay-17", "read")
        # An explicit Commented choice must sever an earlier automatic promotion.
        open_item(page, "essay-04")
        page.locator(NOTES).fill("Temporary thought")
        status(page, "essay-04", "commented")
        set_status(page, "essay-04", "commented")
        synced(page)
        page.reload()
        opened(page, "essay-04")
        page.locator(NOTES).fill("")
        status(page, "essay-04", "commented")
        open_item(page, "essay-22")
        page.locator(NOTES).fill("Temporary thought on a manually commented fixture")
        page.locator(NOTES).fill("")
        status(page, "essay-22", "commented")
        small = page.locator(NOTES).bounding_box()["height"]
        page.locator(NOTES).fill("\n".join(f"Fictional note line {n}: an observation." for n in range(70)))
        page.wait_for_function("() => document.querySelector('.long-notes-editor').getBoundingClientRect().height > 1200")
        tall = page.locator(NOTES).bounding_box()["height"]
        assert tall > small * 2
        expect(page.locator(NOTES)).to_have_css("resize", "none")
        expect(page.locator(NOTES)).to_have_css("overflow-y", "hidden")
        assert page.locator(NOTES).evaluate("el => el.scrollHeight <= el.clientHeight + 2")
        assert page.locator("#notes-pane").evaluate("el => el.scrollHeight > el.clientHeight")
        page.locator(NOTES).fill("Short again")
        page.wait_for_function("() => document.querySelector('.long-notes-editor').getBoundingClientRect().height < " + str(tall / 2))
        synced(page)


def select_passage(page, paragraph=0):
    line = page.locator(".source-paragraph").nth(paragraph).locator(".line-text").first
    line.scroll_into_view_if_needed()
    box = line.bounding_box()
    page.mouse.move(box["x"] + 2, box["y"] + box["height"] / 2)
    page.mouse.down()
    page.mouse.move(box["x"] + min(300, box["width"] - 4), box["y"] + box["height"] / 2, steps=12)
    page.mouse.up()
    page.wait_for_function("() => getSelection().toString().trim().length > 10")
    expect(page.locator("#selection-actions")).to_be_visible()
    return page.evaluate("getSelection().toString().trim()")


def make_highlight(page, paragraph=0, note="A fictional margin thought"):
    select_passage(page, paragraph)
    page.keyboard.press("h")
    page.wait_for_function("() => document.activeElement.matches('.interlinear-editor')")
    page.keyboard.insert_text(note)
    expect(page.locator(".margin-note-text").filter(has_text=note)).to_have_count(1)
    page.keyboard.press("Escape")
    return page.locator("mark[data-highlight]").first.get_attribute("data-highlight")


def highlight_drag_and_persistence(browser, base):
    with session(browser, base) as (page, repo, errors):
        open_item(page, "essay-05")
        highlight_id = make_highlight(page)
        status(page, "essay-05", "commented")
        quote = page.locator(".margin-note-quote").first.inner_text()
        page.locator(NOTES).fill("A pre-existing fictional note")
        synced(page)
        page.locator("#reader-pane").focus()
        mark = page.locator(f'mark[data-highlight="{highlight_id}"]').first
        mark.scroll_into_view_if_needed()
        # Record the real event target, not the draggable ancestor or currentTarget.
        page.evaluate("""() => {
          window.smokeDrags = [];
          document.addEventListener('dragstart', event => window.smokeDrags.push({
            nodeType: event.target.nodeType, trusted: event.isTrusted,
            text: event.target.textContent, types: [...event.dataTransfer.types]
          }), true);
        }""")
        box = mark.bounding_box()
        x, y = box["x"] + min(22, box["width"] / 2), box["y"] + box["height"] / 2
        page.mouse.dblclick(x, y)
        page.wait_for_function("() => getSelection().toString().trim().length > 0")
        assert page.evaluate("getSelection().anchorNode.parentElement.closest('mark[data-highlight]') !== null")
        page.keyboard.press("Escape")
        drop = page.locator(NOTES).bounding_box()
        page.mouse.move(x, y)
        page.mouse.down()
        page.wait_for_timeout(180)  # Allow Chromium's selected-text drag gesture to start.
        page.mouse.move(x + 35, y + 3, steps=8)
        page.mouse.move(drop["x"] + 50, drop["y"] + 45, steps=18)
        page.mouse.move(drop["x"] + 55, drop["y"] + 48, steps=3)
        page.mouse.up()
        expected = "A pre-existing fictional note\n\n> " + quote
        expect(page.locator(NOTES)).to_have_value(expected)
        native = page.evaluate("smokeDrags.filter(event => event.trusted)")
        assert native, "Dragging the text selection emitted no native dragstart"
        assert not errors, errors
        print("Native selected-highlight drag targets:", json.dumps(native))
        # Chromium versions differ between an Element and Text native target. Always
        # exercise the exact Text-node regression as well, using one real DataTransfer.
        dispatched = page.evaluate("""() => {
          const mark = document.querySelector('mark[data-highlight]');
          const node = document.createTreeWalker(mark, NodeFilter.SHOW_TEXT).nextNode();
          const dataTransfer = new DataTransfer();
          node.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true}));
          node.dispatchEvent(new MouseEvent('click', {bubbles:true}));
          node.dispatchEvent(new DragEvent('dragstart', {bubbles:true, cancelable:true, dataTransfer}));
          const payload = dataTransfer.getData('application/x-reading-highlight');
          const target = document.querySelector('#notes-pane');
          for (const type of ['dragenter','dragover','drop'])
            target.dispatchEvent(new DragEvent(type, {bubbles:true, cancelable:true, dataTransfer}));
          node.dispatchEvent(new DragEvent('dragend', {bubbles:true, dataTransfer}));
          return {nodeType: node.nodeType, payload, events: window.smokeDrags};
        }""")
        assert dispatched["nodeType"] == 3
        assert any(event["nodeType"] == 3 and not event["trusted"] for event in dispatched["events"])
        assert json.loads(dispatched["payload"])["quote"] == quote
        expect(page.locator(NOTES)).to_have_value(expected + "\n\n> " + quote)
        assert not errors, errors
        # Editing a margin stays live, and it never collides with the source lines.
        page.evaluate("getSelection().removeAllRanges()")
        mark.click()
        page.wait_for_function("() => document.activeElement.matches('.interlinear-editor')")
        page.keyboard.press("End")
        page.keyboard.insert_text(" More fictional detail. " * 14)
        expect(page.locator(".margin-note-text")).to_contain_text("More fictional detail")
        collisions = page.evaluate("""() => {
          const lines = [...document.querySelectorAll('.line-text')].map(el => el.getBoundingClientRect());
          return [...document.querySelectorAll('.interlinear-editor')].some(el => {
            const a=el.getBoundingClientRect(); return lines.some(b => a.left<b.right && a.right>b.left && a.top<b.bottom-1 && a.bottom>b.top+1);
          });
        }""")
        assert not collisions, "Interlinear notes overlap source text"
        page.keyboard.press("Escape")
        synced(page)
        saved = repo.document("user/notes/essay-05.json")
        assert saved["long_notes"] == expected + "\n\n> " + quote
        page.reload()
        opened(page, "essay-05")
        expect(page.locator(NOTES)).to_have_value(saved["long_notes"])
        expect(page.locator(".margin-note-text")).to_contain_text("More fictional detail")
        assert page.locator(f'mark[data-highlight="{highlight_id}"]').count() >= 1
        # All note types participate in automatic Commented; an empty highlight alone does not.
        page.locator(NOTES).fill("")
        status(page, "essay-05", "commented")
        page.locator(f'mark[data-highlight="{highlight_id}"]').first.click()
        page.locator('button[data-note-action="delete"]').first.click()
        status(page, "essay-05", "unread")
        expect(page.locator("mark[data-highlight]")).to_have_count(0)
        make_highlight(page, note="x")
        page.locator("mark[data-highlight]").first.click()
        page.keyboard.press("Control+A")
        page.keyboard.press("Backspace")
        page.keyboard.press("Backspace")
        status(page, "essay-05", "unread")
        assert page.locator("mark[data-highlight]").count() >= 1, "Empty note removed the highlight"
        synced(page)


def keyboard_stars_and_read(browser, base):
    with session(browser, base) as (page, repo, _):
        active = page.url
        page.locator('[data-library-id="essay-02"] .library-star').click()
        assert page.url == active, "Starring a sidebar item opened it"
        expect(page.locator('[data-library-id="essay-02"] .library-star')).to_have_attribute("aria-pressed", "true")
        page.locator("#star-filter").click()
        expect(page.locator(".library-title")).to_have_text(["Fictional field notebook 02"])
        page.locator("#star-filter").click()
        open_item(page, "essay-01")  # Reset list focus after the one-item starred filter.
        page.locator("#reader-pane").focus()
        page.keyboard.press("j")
        expect(page.locator(".library-item.is-focused")).to_have_attribute("data-library-id", "essay-02")
        page.keyboard.press("Enter")
        opened(page, "essay-02")
        page.keyboard.press("k")
        page.keyboard.press("Enter")
        opened(page, "essay-01")
        page.locator("#reader-pane").focus()
        page.keyboard.press("s")
        expect(page.locator("#reader-star")).to_have_attribute("aria-pressed", "true")
        page.keyboard.press("r")
        status(page, "essay-01", "read")
        page.keyboard.press("r")
        status(page, "essay-01", "unread")
        page.keyboard.press("n")
        expect(page.locator(NOTES)).to_be_focused()
        page.locator("#reader-pane").focus()
        page.keyboard.press("/")
        expect(page.locator("#search")).to_be_focused()
        page.keyboard.insert_text("rjk")
        expect(page.locator("#search")).to_have_value("rjk")
        assert page.url.endswith("#article=essay-01")
        page.locator("#search").fill("")
        status(page, "essay-01", "unread")
        page.locator("#reader-pane").focus()
        page.keyboard.press("?")
        expect(page.locator("#help-dialog")).to_be_visible()
        page.keyboard.press("Escape")
        expect(page.locator("#help-dialog")).not_to_be_visible()
        for progress, expected_status in [(0.85, "unread"), (0.92, "read")]:
            page.evaluate("""fraction => {
              const pane=document.querySelector('#reader-pane'), body=document.querySelector('#article-body');
              const start=body.getBoundingClientRect().top-pane.getBoundingClientRect().top+pane.scrollTop;
              pane.scrollTop=start+body.offsetHeight*fraction-pane.clientHeight;
              pane.dispatchEvent(new Event('scroll'));
            }""", progress)
            expect(page.locator("#reading-progress")).to_have_text(f"{round(progress*100)}%")
            status(page, "essay-01", expected_status)
        synced(page)
        assert all(path.startswith("user/") for path, _, _ in repo.puts)
        page.locator("#reader-pane").focus()
        page.keyboard.press("Escape")
        expect(page.locator(".source-line")).to_have_count(0)
        expect(page.locator(NOTES)).to_be_disabled()
        page.keyboard.press("Enter")
        opened(page, "essay-01")


def mobile_and_demo(browser, base):
    with session(browser, base, mobile=True) as (page, _, _):
        page.locator("#notes-toggle").click()
        expect(page.locator("#notes-toggle")).to_have_attribute("aria-expanded", "true")
        bounds = page.locator("#notes-pane").bounding_box()
        assert 0 <= bounds["x"] and bounds["x"] + bounds["width"] <= 391, bounds
        page.locator(NOTES).fill("\n".join(f"Mobile fictional observation {i}" for i in range(50)))
        assert page.locator(NOTES).evaluate("el => el.scrollHeight <= el.clientHeight + 2")
        assert page.locator("#notes-pane").evaluate("el => el.scrollHeight > el.clientHeight")
        page.locator("#notes-pane").evaluate("el => el.scrollTop = el.scrollHeight")
        assert page.locator("#notes-pane").evaluate("el => el.scrollTop > 0")
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Mobile horizontal overflow"
        page.locator("#notes-pane").evaluate("el => el.scrollTop = 0")
        page.locator("#notes-close").click()
        expect(page.locator("#notes-toggle")).to_have_attribute("aria-expanded", "false")
        page.locator("#library-toggle").click()
        expect(page.locator("#library-toggle")).to_have_attribute("aria-expanded", "true")
        page.locator("#drawer-backdrop").click(position={"x": 380, "y": 400})
        expect(page.locator("#library-toggle")).to_have_attribute("aria-expanded", "false")
    with session(browser, base, demo=True) as (page, repo, _):
        expect(page.locator(".library-item")).to_have_count(3)
        page.wait_for_timeout(2500)
        assert "Saving" not in page.locator("#sync-status").inner_text()
        assert not repo.requests, "Demo mode contacted GitHub"
        assert not repo.public_vault_requests, "Direct demo fetched vault.json"
        assert TOKEN not in page.evaluate("JSON.stringify({...localStorage})")
        page.goto(base + "/#demo")
        page.reload()
        expect(page.locator(".library-item")).to_have_count(3)
        expect(page.locator("#setup-screen")).not_to_be_visible()
        expect(page.locator("#lock-screen")).not_to_be_visible()
        expect(page.locator("#lock-button")).not_to_be_visible()
        expect(page.locator(NOTES)).to_be_enabled()
        assert not repo.requests, "Direct demo link contacted GitHub"
        assert not repo.public_vault_requests, "Reloading demo fetched vault.json"
    with session(browser, base, vault=True) as (page, repo, _):
        expect(page.locator("#setup-screen")).to_be_visible()
        page.locator("#setup-screen [data-demo]").click()
        expect(page.locator(".library-item")).to_have_count(3)
        expect(page.locator(NOTES)).to_be_enabled()
        assert not repo.requests, "Setup demo link contacted GitHub"


def phase_one_surface(browser, base):
    for mobile in (False, True):
        repo = Repository()
        repo.items[1]["summary_by"] = "Fictional intake agent"
        repo.set("library.json", repo.items)
        with session(browser, base, repo, mobile=mobile) as (page, repo, _):
            for selector in ("#settings-open", "#help-open", "#view-toggle", "#theme-toggle", "#library-density"):
                expect(page.locator(selector)).not_to_be_visible()
            if mobile:
                controls = page.locator(".topbar button:visible").evaluate_all("els => els.map(el => el.id).sort()")
                assert controls == sorted(["library-toggle", "notes-toggle", "more-toggle"]), controls
                expect(page.locator(".wordmark")).to_be_visible()
                assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            page.locator("#more-toggle").click()
            for selector in ("#view-toggle", "#settings-open", "#help-open"):
                expect(page.locator(selector)).to_be_visible()
            page.locator("#view-toggle").click()
            expect(page.locator("#theme-toggle")).to_be_visible()
            expect(page.locator("#library-density")).to_be_visible()
            page.keyboard.press("Escape")
            expect(page.locator("#view-menu")).not_to_be_visible()
            if page.locator("#more-menu").is_visible():
                page.keyboard.press("Escape")
            expect(page.locator("#more-menu")).not_to_be_visible()
            initial_theme = page.locator("html").get_attribute("data-theme")
            menu_action(page, "#theme-toggle", view=True)
            assert page.locator("html").get_attribute("data-theme") != initial_theme
            page.reload()
            opened(page, "essay-01")
            assert page.locator("html").get_attribute("data-theme") != initial_theme
            page.locator("#more-toggle").click()
            page.locator("#article-header h1").click(position={"x": 5, "y": 5})
            expect(page.locator("#more-menu")).not_to_be_visible()
            menu_action(page, "#help-open")
            expect(page.locator("#help-dialog")).to_be_visible()
            page.keyboard.press("Escape")
            expect(page.locator("#help-dialog")).not_to_be_visible()
            menu_action(page, "#settings-open")
            expect(page.locator("#settings-dialog")).to_be_visible()
            sections = page.locator("#settings-dialog > section, #settings-dialog > details").evaluate_all(
                "els => els.map(el => el.id)")
            assert sections == ["security-section", "backup-section", "connection-section", "advanced-connection"], sections
            assert not page.locator("#advanced-connection").evaluate("el => el.open")
            expect(page.locator("#export-data")).to_be_visible()
            expect(page.locator("#security-unavailable")).to_be_visible()
            page.keyboard.press("Escape")
            expect(page.locator("#settings-dialog")).not_to_be_visible()
            expect(page.locator(".article-summary .bot-label")).to_contain_text("from intake")
            expect(page.locator(".article-summary .bot-label")).not_to_contain_text("Fictional intake agent")
            if mobile:
                page.locator("#library-toggle").click()
            open_item(page, "essay-02")
            expect(page.locator(".article-summary .bot-label")).to_contain_text("Fictional intake agent")
            if mobile:
                page.locator("#notes-toggle").click()
            expect(page.locator(".notes-topline")).to_contain_text("Notes")
            assert not re.search(r"the other page", page.locator("body").text_content(), re.I)
            assert not re.search(r"the other page", page.locator(NOTES).get_attribute("aria-label"), re.I)


def selection_toolbar_and_undo(browser, base):
    with session(browser, base) as (page, repo, _):
        page.context.grant_permissions(["clipboard-read", "clipboard-write"])
        open_item(page, "essay-05")
        quote = select_passage(page)
        for selector in ("#highlight-selection", "#send-selection", "#copy-selection"):
            expect(page.locator(selector)).to_be_visible()
        page.evaluate("""() => {
          window.contextPrevented = null;
          document.addEventListener('contextmenu', event => {
            queueMicrotask(() => { window.contextPrevented = event.defaultPrevented; });
          }, {once:true});
        }""")
        page.locator(".line-text").first.click(button="right")
        page.wait_for_function("() => window.contextPrevented !== null")
        assert page.evaluate("window.contextPrevented") is False, "Reader suppressed the native context menu"
        quote = select_passage(page)
        page.locator("#copy-selection").click()
        assert page.evaluate("navigator.clipboard.readText()") == quote
        expect(page.locator(NOTES)).to_have_value("")
        quote = select_passage(page)
        page.locator("#send-selection").click()
        expect(page.locator(NOTES)).to_have_value("> " + quote)
        quote = select_passage(page, 1)
        page.locator("#highlight-selection").click()
        expect(page.locator(".interlinear-editor")).to_be_focused()
        page.keyboard.insert_text("A toolbar-created fictional margin")
        page.keyboard.press("Escape")
        highlight_id = page.locator("mark[data-highlight]").first.get_attribute("data-highlight")
        synced(page)
        # Let promotion notices expire so each Undo below addresses only deletion.
        page.wait_for_timeout(6100)
        page.locator("mark[data-highlight]").first.click()
        page.locator('button[data-note-action="delete"]').first.click()
        expect(page.locator("mark[data-highlight]")).to_have_count(0)
        open_item(page, "essay-06")
        page.wait_for_timeout(4400)
        undo = page.locator("#toast .toast-message").filter(
            has=page.get_by_role("button", name="Undo", exact=True))
        expect(undo).to_have_count(1)
        undo.get_by_role("button", name="Undo", exact=True).click()
        open_item(page, "essay-05")
        expect(page.locator(f'mark[data-highlight="{highlight_id}"]').first).to_be_visible()
        expect(page.locator(".margin-note-text")).to_contain_text("A toolbar-created fictional margin")
        synced(page)
        page.reload()
        opened(page, "essay-05")
        assert any(h["id"] == highlight_id and not h.get("deleted")
                   for h in repo.document("user/notes/essay-05.json")["highlights"])
        page.locator("mark[data-highlight]").first.click()
        page.locator('button[data-note-action="delete"]').first.click()
        page.wait_for_timeout(6200)
        expect(page.locator("#toast .toast-message button")).to_have_count(0)
        synced(page)
        page.reload()
        opened(page, "essay-05")
        expect(page.locator("mark[data-highlight]")).to_have_count(0)
        assert highlight_id in repo.document("user/notes/essay-05.json")["deleted_highlights"]
    with session(browser, base, mobile=True) as (page, repo, _):
        source = page.locator(".source-run").first
        source.scroll_into_view_if_needed()
        quote = source.evaluate("""el => {
          document.activeElement.blur();
          const range=document.createRange(); range.selectNodeContents(el);
          const selection=getSelection(); selection.removeAllRanges(); selection.addRange(range);
          return selection.toString();
        }""")
        toolbar = page.locator("#selection-actions")
        expect(toolbar).to_be_visible()
        bounds = toolbar.bounding_box()
        assert 0 <= bounds["x"] and bounds["x"] + bounds["width"] <= 390, bounds
        assert 0 <= bounds["y"] and bounds["y"] + bounds["height"] <= 844, bounds
        assert bounds["y"] + bounds["height"] <= source.bounding_box()["y"] + 1, bounds
        page.locator("#highlight-selection").tap()
        expect(page.locator(".interlinear-editor")).to_be_focused()
        synced(page)
        assert repo.document("user/notes/essay-01.json")["highlights"][0]["quote"] == quote


def automatic_status_undo_and_typing(browser, base):
    with session(browser, base) as (page, repo, _):
        for slug, previous in (("essay-01", "unread"), ("essay-17", "read")):
            open_item(page, slug)
            page.locator(NOTES).fill("Keep this fictional thought after status Undo.")
            status(page, slug, "commented")
            page.locator("#toast .toast-message").get_by_role("button", name="Undo", exact=True).last.click()
            status(page, slug, previous)
            expect(page.locator(NOTES)).to_have_value("Keep this fictional thought after status Undo.")
            synced(page)
            status(page, slug, previous)
            assert repo.document(f"user/notes/{slug}.json")["long_notes"] == "Keep this fictional thought after status Undo."
        open_item(page, "essay-02")
        for editor in (page.locator(NOTES),):
            editor.fill("")
            editor.press_sequentially("rjkns/?")
            editor.press("Enter")
            editor.press("Escape")
            expect(editor).to_be_focused()
            expect(editor).to_have_value("rjkns/?\n")
            expect(page.locator("#help-dialog")).not_to_be_visible()
            opened(page, "essay-02")
            expect(page.locator("#reader-star")).to_have_attribute("aria-pressed", "false")
        make_highlight(page, note="Editable shortcut guard ")
        page.locator("mark[data-highlight]").first.click()
        editor = page.locator(".interlinear-editor")
        editor.press("End")
        editor.press_sequentially("rjkns/?")
        expect(editor).to_have_value(re.compile(r"rjkns/\?"))
        expect(page.locator("#help-dialog")).not_to_be_visible()
        opened(page, "essay-02")
        expect(page.locator("#reader-star")).to_have_attribute("aria-pressed", "false")
        editor.press("Escape")
        for editable in ("", "true", "plaintext-only"):
            page.evaluate("""value => {
              const editor=document.createElement('div'); editor.id='smoke-editor';
              editor.setAttribute('contenteditable',value);
              document.querySelector('#article-header').append(editor); editor.focus();
            }""", editable)
            page.keyboard.type("rjkns/?")
            page.keyboard.press("Enter")
            page.keyboard.press("Escape")
            expect(page.locator("#smoke-editor")).to_be_focused()
            expect(page.locator("#help-dialog")).not_to_be_visible()
            expect(page.locator("#reader-star")).to_have_attribute("aria-pressed", "false")
            opened(page, "essay-02")
            page.locator("#smoke-editor").evaluate("el => el.remove()")
        # A fresh article demonstrates the automatic read threshold and its Undo.
        open_item(page, "essay-03")
        page.evaluate("""() => {
          const pane=document.querySelector('#reader-pane'), body=document.querySelector('#article-body');
          const start=body.getBoundingClientRect().top-pane.getBoundingClientRect().top+pane.scrollTop;
          pane.scrollTop=start+body.offsetHeight*.94-pane.clientHeight;
          pane.dispatchEvent(new Event('scroll'));
        }""")
        status(page, "essay-03", "read")
        page.locator("#toast .toast-message").get_by_role("button", name="Undo", exact=True).last.click()
        status(page, "essay-03", "unread")
        page.locator("#reader-pane").dispatch_event("scroll")
        status(page, "essay-03", "unread")
        synced(page)
        assert repo.document("user/state.json")["essay-03"]["status"] == "unread"


def relative_sync_timer(browser, base):
    with session(browser, base, clock=True) as (page, repo, _):
        page.locator(NOTES).fill("Fictional sync timestamp observation.")
        synced(page)
        sync = page.locator("#sync-status")
        initial, absolute = sync.inner_text(), sync.get_attribute("title")
        assert page.evaluate("value => Number.isFinite(Date.parse(value))", absolute), absolute
        writes = len(repo.puts)
        page.clock.run_for(65000)
        expect(sync).not_to_have_text(initial)
        expect(sync).to_have_text(re.compile(r"^Synced\b", re.I))
        expect(sync).to_have_attribute("title", absolute)
        assert len(repo.puts) == writes, "Relative-time refresh wrote repository data"


def store_conflict_export_import(browser, base):
    repo = Repository()
    repo.set("user/notes/essay-06.json", {"long_notes": "Shared fictional baseline", "highlights": [],
                                         "updated_at": STAMP, "long_notes_updated_at": STAMP})
    with session(browser, base, repo, store_only=True) as (page, repo, _):
        page.evaluate("""async settings => {
          const {ReadingStore}=await import('./js/store.js');
          window.smokeStore=new ReadingStore(settings);
          await smokeStore.init();
          await smokeStore.getNotes('essay-06');
          await smokeStore.saveNotes('essay-06', {long_notes:'Local fictional edit', highlights:[]});
        }""", SETTINGS)
        repo.conflicts["user/notes/essay-06.json"] = {"long_notes": "Concurrent fictional edit", "highlights": [],
                                                      "updated_at": "2026-02-01T00:00:00.000Z",
                                                      "long_notes_updated_at": "2026-02-01T00:00:00.000Z"}
        result = page.evaluate("async () => await smokeStore.flush()")
        assert result["pending"] == 0, result
        remote = repo.document("user/notes/essay-06.json")["long_notes"]
        assert "Local fictional edit" in remote and "Concurrent fictional edit" in remote and "<<<<<<<" in remote, remote
        assert sum(path == "user/notes/essay-06.json" for path, _, _ in repo.puts) == 2
        # A concurrent manual Commented status must not inherit the losing automatic
        # status's provenance; an unrelated local star must survive the same retry.
        page.evaluate("""async () => {
          await smokeStore.saveState({'essay-06': {
            status:'commented', commented_from:'read', starred:true,
            status_changed_at:new Date().toISOString()
          }});
        }""")
        future = "2099-01-01T00:00:00.000Z"
        repo.conflicts["user/state.json"] = {"essay-06": {
            "status": "commented", "commented_from": None, "starred": False,
            "status_changed_at": future, "_timestamps": {
                "status": future, "status_changed_at": future, "starred": STAMP}}}
        assert page.evaluate("async () => (await smokeStore.flush()).pending") == 0
        merged = repo.document("user/state.json")["essay-06"]
        assert merged["status"] == "commented" and merged.get("commented_from") is None, merged
        assert merged["starred"] is True, merged
        assert sum(path == "user/state.json" for path, _, _ in repo.puts) == 2
        backup = page.evaluate("async () => await smokeStore.exportData()")
        assert backup["format"] == "reading-terminal-user-data" and backup["complete"] is True
        assert backup["notes"]["essay-06"]["long_notes"] == remote
        assert TOKEN not in json.dumps(backup) and "token" not in backup["source"]
        page.evaluate("smokeStore.dispose()")
    # Import into an empty browser and repository, not back into the source cache.
    with session(browser, base, Repository(), store_only=True) as (page, repo, _):
        restored = page.evaluate("""async ({settings, backup}) => {
          const {ReadingStore}=await import('./js/store.js');
          const store=new ReadingStore(settings); await store.init();
          await store.importData(backup); const flush=await store.flush();
          const notes=await store.getNotes('essay-06'); store.dispose();
          return {flush, notes};
        }""", {"settings": SETTINGS, "backup": backup})
        assert restored["flush"]["pending"] == 0
        assert restored["notes"]["long_notes"] == remote
        assert repo.document("user/notes/essay-06.json")["long_notes"] == remote
    with session(browser, base, Repository(private=False), store_only=True) as (page, repo, _):
        denied = page.evaluate("""async settings => {
          const {ReadingStore}=await import('./js/store.js'); const store=new ReadingStore(settings);
          let error=''; try { await store.testConnection(); } catch (e) { error=e.message; }
          await store.saveNotes('essay-01', {long_notes:'Never publish this fictional note', highlights:[]});
          const flush=await store.flush(); store.dispose(); return {error, flush};
        }""", SETTINGS)
        assert "private" in denied["error"].lower(), denied
        assert denied["flush"]["pending"] > 0 and repo.puts == [], denied


def fill_setup(page, password=PASSWORD):
    page.locator("#setup-token").fill(TOKEN)
    page.locator("#setup-password").fill(password)
    page.locator("#setup-confirm").fill(password)
    details = page.locator("#setup-form details")
    if not details.evaluate("el => el.open"):
        details.locator("summary").click()
    for field, value in {"owner": "fictional-reader", "repo": "fictional-library", "branch": "main",
                         "site-repo": "fictional-site", "site-branch": "main"}.items():
        page.locator("#setup-" + field).fill(value)


def vault_library(page):
    expect(page.locator("#lock-screen")).not_to_be_visible()
    expect(page.locator("#setup-screen")).not_to_be_visible()
    expect(page.locator("#lock-button")).to_have_count(1)
    expect(page.locator("#lock-button")).to_be_enabled()
    expect(page.locator('[data-library-id="essay-01"]')).to_have_count(1)
    expect(page.locator(NOTES)).to_be_enabled()
    page.wait_for_selector(".source-line")


def unlock_password(page, password=PASSWORD, remember=True):
    expect(page.locator("#lock-screen")).to_be_visible()
    page.locator("#unlock-remember").set_checked(remember)
    expect(page.locator("#unlock-submit")).to_be_enabled()
    page.locator("#unlock-password").fill(password)
    page.locator("#unlock-password").press("Enter")
    vault_library(page)
    expect(page.locator("#unlock-password")).to_have_value("")


def no_browser_secrets(page):
    storage = page.evaluate("JSON.stringify({local:{...localStorage},session:{...sessionStorage}})")
    for secret in (TOKEN, PASSWORD, NEW_PASSWORD):
        assert secret not in storage, "Vault secret persisted in Web Storage"


def auth_mobile_layout(page, screen, fields):
    expect(page.locator(screen)).to_be_visible()
    assert page.viewport_size["width"] == 390
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Auth screen horizontal overflow"
    for selector in fields:
        control = page.locator(selector)
        control.scroll_into_view_if_needed()
        bounds = control.bounding_box()
        assert bounds and 0 <= bounds["x"] and bounds["x"] + bounds["width"] <= 391, (selector, bounds)
        assert bounds["height"] >= 24, (selector, bounds)


def setup_unlock_remember_lock(browser, base):
    with session(browser, base, vault=True, mobile=True) as (page, repo, _):
        expect(page.locator("#setup-screen")).to_be_visible()
        expect(page.locator("#setup-token")).to_have_attribute("type", "password")
        expect(page.locator("#setup-remember")).to_be_checked()
        auth_mobile_layout(page, "#setup-screen", ["#setup-token", "#setup-password", "#setup-confirm", "#setup-submit"])
        fill_setup(page)
        page.locator("#setup-password").fill("")
        page.locator("#setup-password").press_sequentially("rjkns/?")
        expect(page.locator("#help-dialog")).not_to_be_visible()
        expect(page.locator("#setup-screen")).to_be_visible()
        page.locator("#setup-password").fill(PASSWORD)
        page.locator("#setup-confirm").fill(NEW_PASSWORD)
        page.locator("#setup-submit").click()
        expect(page.locator("#setup-submit")).to_be_enabled()
        expect(page.locator("#setup-token")).to_have_value(TOKEN)
        for selector in ("#setup-password", "#setup-confirm"):
            expect(page.locator(selector)).to_have_value("")
        assert not repo.vault_puts, "Mismatched passwords published a vault"
        setup_endpoint = "https://api.github.com" + SITE_ROOT + "*"
        for fail in (lambda route: route.abort("internetdisconnected"),
                     lambda route: route.fulfill(status=403, json={"message": "Fictional permission denied"})):
            page.route(setup_endpoint, fail)
            page.locator("#setup-password").fill(PASSWORD)
            page.locator("#setup-confirm").fill(PASSWORD)
            page.locator("#setup-submit").click()
            expect(page.locator("#setup-submit")).to_be_enabled()
            expect(page.locator("#setup-token")).to_have_value(TOKEN)
            for selector in ("#setup-password", "#setup-confirm"):
                expect(page.locator(selector)).to_have_value("")
            assert repo.vault is None and not repo.vault_puts, "Failed setup published a vault"
            page.unroute(setup_endpoint, fail)
        page.locator("#setup-password").fill(PASSWORD)
        page.locator("#setup-confirm").fill(PASSWORD)
        page.locator("#setup-submit").click()
        vault_library(page)
        assert len(repo.vault_puts) == 1
        assert len(repo.vault["slots"]) == 1 and repo.vault["slots"][0]["type"] == "password"
        assert repo.vault["slots"][0]["iterations"] >= 600000
        for selector in ("#setup-token", "#setup-password", "#setup-confirm"):
            expect(page.locator(selector)).to_have_value("")
        no_browser_secrets(page)
        remembered = page.evaluate("""async () => {
          const db=await new Promise(resolve=>{const r=indexedDB.open('reading-terminal-session');r.onsuccess=()=>resolve(r.result)});
          const record=await new Promise(resolve=>{const r=db.transaction('remembered').objectStore('remembered').get('device');r.onsuccess=()=>resolve(r.result)});
          db.close();
          let rejectsExport=false;try{await crypto.subtle.exportKey('raw',record.key)}catch{rejectsExport=true}
          return {extractable:record.key.extractable,rejectsExport,fields:Object.keys(record),encrypted:record.ciphertext instanceof ArrayBuffer};
        }""")
        assert remembered["extractable"] is False and remembered["rejectsExport"] and remembered["encrypted"]
        assert not {"token", "payload", "dek", "vault"}.intersection(remembered["fields"])
        page.reload()
        vault_library(page)
        no_browser_secrets(page)
        lock_library(page)
        expect(page.locator("#lock-screen")).to_be_visible()
        auth_mobile_layout(page, "#lock-screen", ["#unlock-password", "#unlock-submit"])
        expect(page.locator("#unlock-passkey")).not_to_be_visible()
        expect(page.locator("#unlock-password")).to_have_attribute("autocomplete", "current-password")
        expect(page.locator("#unlock-error")).to_have_attribute("role", "alert")
        page.locator("#unlock-password").press_sequentially("rjkns/?")
        expect(page.locator("#unlock-password")).to_have_value("rjkns/?")
        expect(page.locator("#help-dialog")).not_to_be_visible()
        expect(page.locator("#more-menu")).not_to_be_visible()
        expect(page.locator("#lock-screen")).to_be_visible()
        page.locator("#unlock-submit").focus()
        for key in ("r", "j", "k", "n", "s", "/", "?", "Escape"):
            page.keyboard.press(key)
        expect(page.locator("#unlock-submit")).to_be_focused()
        expect(page.locator("#help-dialog")).not_to_be_visible()
        expect(page.locator("#article-body")).to_be_empty()
        expect(page.locator("#lock-screen")).to_be_visible()
        page.locator("#unlock-password").fill("")
        page.reload()
        expect(page.locator("#lock-screen")).to_be_visible()
        page.locator("#unlock-password").fill("Wrong fictional password 123!")
        page.locator("#unlock-submit").click()
        expect(page.locator("#unlock-error")).not_to_be_empty()
        expect(page.locator("#unlock-password")).to_have_value("")
        expect(page.locator("#lock-screen")).to_be_visible()
        unlock_password(page, remember=False)
        no_browser_secrets(page)
        page.reload()
        expect(page.locator("#lock-screen")).to_be_visible()
        unlock_password(page)
        repo.fail_writes = True
        page.set_viewport_size({"width": 1440, "height": 900})
        page.wait_for_function("() => !document.querySelector('#notes-pane').inert")
        page.locator(NOTES).fill("Fictional edit queued before Lock while GitHub is unavailable.")
        expect(page.locator(NOTES)).to_have_value("Fictional edit queued before Lock while GitHub is unavailable.")
        lock_library(page)
        expect(page.locator("#lock-screen")).to_be_visible()
        locked_cache = page.evaluate("""async () => {
          const db=await new Promise(resolve=>{const r=indexedDB.open('reading-terminal-cache');r.onsuccess=()=>resolve(r.result)});
          const read=name=>new Promise(resolve=>{const r=db.transaction(name).objectStore(name).getAll();r.onsuccess=()=>resolve(r.result)});
          const cache=await read('cache'),queue=await read('queue');db.close();
          return {cache:cache.map(r=>r.path),queue:queue.map(r=>r.path),reader:document.querySelector('#article-body').textContent};
        }""")
        assert locked_cache["cache"] == [] and locked_cache["reader"] == ""
        assert "user/notes/essay-01.json" in locked_cache["queue"], locked_cache
        no_browser_secrets(page)
        page.reload()
        expect(page.locator("#lock-screen")).to_be_visible()
        repo.fail_writes = False
        unlock_password(page)
        expect(page.locator(NOTES)).to_have_value("Fictional edit queued before Lock while GitHub is unavailable.")
        synced(page)
        assert repo.document("user/notes/essay-01.json")["long_notes"] == (
            "Fictional edit queued before Lock while GitHub is unavailable.")
        repo.public_vault_error = True
        page.reload()
        vault_library(page)
        lock_library(page)
        expect(page.locator("#lock-screen")).to_be_visible()
        page.reload()
        expect(page.locator("#lock-screen")).to_be_visible()
        expect(page.locator("#unlock-error")).not_to_be_empty()
        expect(page.locator("#unlock-retry")).to_be_visible()
        repo.public_vault_error = False
        page.locator("#unlock-retry").click()
        unlock_password(page)


def seed_vault(page, repo, passkeys=False):
    result = page.evaluate("""async ({payload,password,passkeys}) => {
      const crypto = await import('./js/vault.js');
      const made = await crypto.createVault(payload,password);
      let vault=made.vault;
      if(passkeys) vault=await crypto.addPasskeySlot(vault,made.dek,{
        credentialId:crypto.toBase64Url(new Uint8Array(32).fill(11)),
        prfSalt:new Uint8Array(32).fill(12), prfOutput:new Uint8Array(32).fill(13),
        label:'Synthetic crypto fixture, not a hardware passkey'});
      return vault;
    }""", {"payload": {**SETTINGS, "site_repo": "fictional-site", "site_branch": "main"},
           "password": PASSWORD, "passkeys": passkeys})
    repo.vault = result
    return result


def setup_replacement_and_invalidation(browser, base):
    with session(browser, base, vault=True, store_only=True) as (page, repo, _):
        original = seed_vault(page, repo)
        page.goto(base + "/")
        unlock_password(page)
        replacement = seed_vault(page, repo)
        assert replacement["vault_id"] != original["vault_id"]
        page.reload()
        wait_until(page, lambda: page.evaluate("""async () => {
          const {loadRemembered}=await import('./js/session.js'); return await loadRemembered() === null;
        }"""), "Replacing the vault identity did not delete the remembered device record")
        expect(page.locator("#lock-screen")).to_be_visible()
        options = page.locator("#lock-other-options")
        assert not options.evaluate("el => el.open")
        expect(options.locator('a[href="#replace"]')).not_to_be_visible()
        options.locator("summary").click()
        expect(options.locator('a[href="#setup"]')).to_be_visible()
        options.locator('a[href="#setup"]').click()
        expect(page.locator("#setup-screen")).to_be_visible()
        expect(page.locator("#replace-screen")).not_to_be_visible()
        expect(page.locator("#setup-form")).not_to_be_visible()
        expect(page.locator('#setup-existing a[href="#replace"]')).to_be_visible()
        assert not repo.vault_puts, "Setup overwrote an existing vault"
        page.goto(base + "/#replace")
        expect(page.locator("#replace-screen")).to_be_visible()
        expect(page.locator("#setup-screen")).not_to_be_visible()
        expect(page.locator("#replace-confirm")).to_have_value("")
        for invalid in ("", "replace", "REPLACE ", " REPLACE"):
            fill_setup(page, NEW_PASSWORD)
            page.locator("#replace-confirm").fill(invalid)
            page.locator("#setup-form").evaluate("form => form.requestSubmit()")
            expect(page.locator("#replace-screen")).to_be_visible()
            assert not repo.vault_puts, "Replacement accepted a non-exact confirmation"
            assert repo.vault["vault_id"] == replacement["vault_id"]
        fill_setup(page, NEW_PASSWORD)
        page.locator("#replace-confirm").fill("REPLACE")
        page.locator("#setup-submit").click()
        vault_library(page)
        assert len(repo.vault_puts) == 1 and repo.vault_puts[0].get("sha")
        assert repo.vault["vault_id"] != replacement["vault_id"]
        lock_library(page)
        unlock_password(page, NEW_PASSWORD)


def security_password_remove_conflicts(browser, base):
    with session(browser, base, vault=True, store_only=True) as (page, repo, _):
        initial = seed_vault(page, repo, passkeys=True)
        original_slot = next(slot for slot in initial["slots"] if slot["type"] == "passkey")
        page.goto(base + "/")
        unlock_password(page)
        menu_action(page, "#settings-open")
        expect(page.locator("#security-section")).to_be_visible()
        page.locator("#security-section summary").filter(has_text="Change password").click()

        def change(current):
            page.locator("#current-password").fill(current)
            page.locator("#new-password").fill(NEW_PASSWORD)
            page.locator("#confirm-password").fill(NEW_PASSWORD)
            page.locator("#change-password-submit").click()

        change("Wrong fictional password")
        expect(page.locator("#change-password-submit")).to_be_enabled()
        assert not repo.vault_puts
        for selector in ("#current-password", "#new-password", "#confirm-password"):
            expect(page.locator(selector)).to_have_value("")
        page.locator("#current-password").fill(PASSWORD)
        page.locator("#new-password").fill(NEW_PASSWORD)
        page.locator("#confirm-password").fill(PASSWORD)
        page.locator("#change-password-submit").click()
        expect(page.locator("#change-password-submit")).to_be_enabled()
        for selector in ("#current-password", "#new-password", "#confirm-password"):
            expect(page.locator(selector)).to_have_value("")
        assert not repo.vault_puts, "Mismatched passwords changed the vault"
        # This is a crypto fixture, not a fabricated WebAuthn success.
        concurrent = page.evaluate("""async ({vault,password}) => {
          const c=await import('./js/vault.js'); const {dek}=await c.unlockWithPassword(vault,password);
          return c.addPasskeySlot(vault,dek,{credentialId:c.toBase64Url(new Uint8Array(32).fill(21)),
            prfSalt:new Uint8Array(32).fill(22),prfOutput:new Uint8Array(32).fill(23),
            label:'Concurrent synthetic slot'});
        }""", {"vault": initial, "password": PASSWORD})
        repo.vault_conflict = concurrent
        change(PASSWORD)
        wait_until(page, lambda: len(repo.vault_puts) == 2 and repo.vault != concurrent,
                   "Password change did not retry the 409 conflict")
        expect(page.locator("#change-password-submit")).to_be_enabled()
        for selector in ("#current-password", "#new-password", "#confirm-password"):
            expect(page.locator(selector)).to_have_value("")
        assert {s["id"] for s in repo.vault["slots"] if s["type"] == "passkey"} == {
            s["id"] for s in concurrent["slots"] if s["type"] == "passkey"}
        assert repo.vault["payload"] == initial["payload"], "Changing password re-encrypted the payload"
        crypto_check = page.evaluate("""async ({vault,oldPassword,newPassword,slotId}) => {
          const c=await import('./js/vault.js'); let oldRejected=false;
          try {await c.unlockWithPassword(vault,oldPassword)} catch {oldRejected=true}
          const fresh=await c.unlockWithPassword(vault,newPassword);
          const prf=await c.unlockWithPrf(vault,slotId,new Uint8Array(32).fill(13));
          return {oldRejected, token:fresh.payload.token, passkeyToken:prf.payload.token};
        }""", {"vault": repo.vault, "oldPassword": PASSWORD, "newPassword": NEW_PASSWORD,
               "slotId": original_slot["id"]})
        assert crypto_check == {"oldRejected": True, "token": TOKEN, "passkeyToken": TOKEN}
        remove = page.locator(f'#passkey-list button[data-slot-id="{original_slot["id"]}"]')
        remove.click()
        expect(remove).to_have_count(0)
        page.wait_for_timeout(5000)
        assert len(repo.vault_puts) == 2, "Removal published before its six-second Undo window"
        page.locator("#toast .toast-message").get_by_role("button", name="Undo", exact=True).click()
        expect(remove).to_be_visible()
        page.wait_for_timeout(1200)
        assert len(repo.vault_puts) == 2, "Undone removal committed a vault"
        repo.vault_conflict_status = 422
        repo.vault_conflict = json.loads(json.dumps(repo.vault))
        repo.vault_conflict["updated_at"] = "2099-01-01T00:00:00.000Z"
        other_slot = next(s for s in repo.vault["slots"] if s["type"] == "passkey" and s["id"] != original_slot["id"])
        remove.click()
        expect(remove).to_have_count(0)
        page.wait_for_timeout(3500)
        other_remove = page.locator(f'#passkey-list button[data-slot-id="{other_slot["id"]}"]')
        other_remove.click()
        assert len(repo.vault_puts) == 2, "First removal published before six seconds"
        wait_until(page, lambda: len(repo.vault_puts) == 4, "Expired removal did not retry its conflict")
        # The second notice must retain its own full window when the first expires.
        page.locator("#toast .toast-message").get_by_role("button", name="Undo", exact=True).click()
        expect(other_remove).to_be_visible()
        page.wait_for_timeout(3500)
        assert len(repo.vault_puts) == 4, "Removal did not retry exactly once, or Undo committed"
        remaining = [s for s in repo.vault["slots"] if s["type"] == "passkey"]
        assert len(remaining) == 1 and remaining[0]["id"] != original_slot["id"]
        assert sum(s["type"] == "password" for s in repo.vault["slots"]) == 1
        page.locator('#settings-dialog [data-close]').click()
        no_browser_secrets(page)
        page.reload()
        vault_library(page)
        menu_action(page, "#settings-open")
        expect(page.locator("#passkey-list button[data-slot-id]")).to_have_count(1)
        expect(page.locator("#passkey-list")).to_contain_text(remaining[0]["label"])
        pending_remove = page.locator("#passkey-list button[data-slot-id]")
        pending_remove.click()
        expect(pending_remove).to_have_count(0)
        page.locator('#settings-dialog [data-close]').click()
        lock_library(page)
        unlock_password(page, NEW_PASSWORD)
        page.wait_for_timeout(6200)
        assert len(repo.vault_puts) == 4, "A removal from the locked session committed later"
        menu_action(page, "#settings-open")
        expect(page.locator("#passkey-list button[data-slot-id]")).to_have_count(1)
        page.locator('#settings-dialog [data-close]').click()


def lock_during_search(browser, base):
    with session(browser, base, vault=True, store_only=True) as (page, repo, _):
        seed_vault(page, repo)
        page.goto(base + "/")
        unlock_password(page)
        pending = []
        page.route("**/contents/search-index.json*", lambda route: pending.append(route))
        page.locator("#search").fill("orchard")
        wait_until(page, lambda: bool(pending), "Search did not start before Lock")
        lock_library(page)
        expect(page.locator("#lock-screen")).to_be_visible()
        for route in pending:
            route.abort()
        page.unroute("**/contents/search-index.json*")
        unlock_password(page)


def replacement_during_security_work(browser, base):
    with session(browser, base, vault=True, store_only=True) as (page, repo, _):
        seed_vault(page, repo)
        page.goto(base + "/")
        unlock_password(page)
        replacement = seed_vault(page, repo)
        pending = []
        page.route("**/vault.json*", lambda route: pending.append(route))
        page.reload()
        vault_library(page)
        wait_until(page, lambda: bool(pending), "Background vault check did not start")
        # Delay the real KDF, rather than substituting a fake password result.
        page.evaluate("""() => {
          const derive=crypto.subtle.deriveKey.bind(crypto.subtle);
          window.restoreKdf=()=>{crypto.subtle.deriveKey=derive};
          crypto.subtle.deriveKey=async(...args)=>{
            await new Promise(resolve=>window.releaseKdf=resolve);
            return derive(...args);
          };
        }""")
        menu_action(page, "#settings-open")
        page.locator("#security-section summary").click()
        page.locator("#current-password").fill(PASSWORD)
        page.locator("#new-password").fill(NEW_PASSWORD)
        page.locator("#confirm-password").fill(NEW_PASSWORD)
        page.locator("#change-password-submit").click()
        page.wait_for_function("() => typeof window.releaseKdf === 'function'")
        pending.pop().fulfill(json=replacement)
        expect(page.locator("#lock-screen")).to_be_visible()
        expect(page.locator("#settings-dialog")).not_to_be_visible()
        assert page.evaluate("async () => (await (await import('./js/session.js')).loadRemembered()) === null")
        page.evaluate("window.restoreKdf(); window.releaseKdf()")
        page.unroute("**/vault.json*")
        unlock_password(page)
        assert repo.vault["vault_id"] == replacement["vault_id"] and not repo.vault_puts


def cdp_passkey_unlock(browser, base):
    with session(browser, base, vault=True, store_only=True) as (page, repo, _):
        seed_vault(page, repo)
        page.goto(base + "/")
        unlock_password(page)
        cdp = page.context.new_cdp_session(page)
        authenticator = None
        try:
            cdp.send("WebAuthn.enable")
            authenticator = cdp.send("WebAuthn.addVirtualAuthenticator", {"options": {
                "protocol": "ctap2", "ctap2Version": "ctap2_1", "transport": "internal",
                "hasResidentKey": True, "hasUserVerification": True, "isUserVerified": True,
                "hasPrf": True, "automaticPresenceSimulation": True}})["authenticatorId"]
            menu_action(page, "#settings-open")
            page.locator("#passkey-label").fill("Fictional CDP authenticator")
            page.locator("#add-passkey").click()
            wait_until(page, lambda: len(repo.vault_puts) == 1, "Passkey registration did not publish", timeout=30000)
            assert len(repo.vault_puts) == 1, "Passkey registration did not commit the vault"
            assert sum(slot["type"] == "passkey" for slot in repo.vault["slots"]) == 1
            expect(page.locator("#passkey-list")).to_contain_text("Fictional CDP authenticator")
            page.locator('#settings-dialog [data-close]').click()
            lock_library(page)
            expect(page.locator("#unlock-passkey")).to_be_visible()
            page.locator("#unlock-passkey").click()
            vault_library(page)
            no_browser_secrets(page)
            print("PASS CDP virtual authenticator PRF add and unlock (not physical hardware)", flush=True)
        finally:
            if authenticator:
                cdp.send("WebAuthn.removeVirtualAuthenticator", {"authenticatorId": authenticator})
            cdp.detach()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base_url", nargs="?", default=os.environ.get("READING_BASE_URL", "http://localhost:8765"))
    args = parser.parse_args()
    base = args.base_url.rstrip("/")
    expect.set_options(timeout=12000)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True, args=["--no-sandbox"])
        try:
            for scenario in (navigation_media_layout, indexed_search, debounce_status_and_growth,
                             highlight_drag_and_persistence, keyboard_stars_and_read, phase_one_surface,
                             selection_toolbar_and_undo, automatic_status_undo_and_typing, relative_sync_timer,
                             mobile_and_demo, store_conflict_export_import, setup_unlock_remember_lock,
                             setup_replacement_and_invalidation, security_password_remove_conflicts,
                             lock_during_search, replacement_during_security_work, cdp_passkey_unlock):
                scenario(browser, base)
                print("PASS", scenario.__name__, flush=True)
        finally:
            browser.close()
    print("PASS all fictional headless reading-terminal regressions")


if __name__ == "__main__":
    main()
