#!/usr/bin/env python3
"""Headless behavioral regressions; all GitHub data below is fictional.

Serve site/, then run: python3 site/tests/smoke.py [http://127.0.0.1:8765]
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
        self.puts = []
        self.violations = []
        self.conflicts = {}
        self.items = []
        self.files = {}
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


@contextmanager
def session(browser, base, repo=None, mobile=False, store_only=False, demo=False):
    repo = repo or Repository()
    context = browser.new_context(viewport={"width": 390 if mobile else 1440, "height": 844 if mobile else 900},
                                  service_workers="block", reduced_motion="reduce")
    errors, unexpected = [], []
    origin = urlparse(base)

    def network(route, request):
        url = urlparse(request.url)
        if url.hostname == "api.github.com":
            return repo.route(route, request)
        if url.hostname == "fiction.example" and url.path == "/external.pdf":
            return route.fulfill(content_type="text/html", body="<title>Fictional external PDF destination</title>")
        if (url.scheme, url.netloc) == (origin.scheme, origin.netloc):
            if url.path.endswith("/__smoke_store__.html"):
                return route.fulfill(content_type="text/html", body="<!doctype html><title>Isolated store smoke</title>")
            if "/assets/" in url.path:
                unexpected.append("Private asset fetched from public site: " + url.path)
                return route.fulfill(status=404, body="Private fixture must use authenticated Contents API")
            return route.continue_()
        unexpected.append(request.url)
        return route.abort()

    context.route("**/*", network)
    if not demo:
        context.add_init_script(
            "if (location.origin === " + json.dumps(f"{origin.scheme}://{origin.netloc}") + ") "
            "localStorage.setItem('reading-terminal.settings', " + json.dumps(json.dumps(SETTINGS)) + ")")
    context.on("page", lambda page: page.on("pageerror", lambda error: errors.append(str(error))))
    page = context.new_page()
    page.set_default_timeout(12000)
    page.goto(base + ("/__smoke_store__.html" if store_only else "/#article=essay-01" if not demo else "/"))
    if not store_only:
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


def synced(page):
    expect(page.locator("#sync-status")).to_have_text("All changes synced to your private repository.", timeout=15000)


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
        page.locator("#library-density").click()
        comfortable = page.locator(".library-item").first.bounding_box()["height"]
        assert comfortable > metrics["height"] + 10, (metrics, comfortable)
        page.reload()
        opened(page, "essay-01")
        assert page.locator(".library-item").first.bounding_box()["height"] > metrics["height"] + 10
        page.locator("#library-density").click()
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


def make_highlight(page, paragraph=0, note="A fictional margin thought"):
    line = page.locator(".source-paragraph").nth(paragraph).locator(".line-text").first
    line.scroll_into_view_if_needed()
    box = line.bounding_box()
    page.mouse.move(box["x"] + 2, box["y"] + box["height"] / 2)
    page.mouse.down()
    page.mouse.move(box["x"] + min(300, box["width"] - 4), box["y"] + box["height"] / 2, steps=12)
    page.mouse.up()
    page.wait_for_function("() => getSelection().toString().trim().length > 10")
    expect(page.locator("#selection-actions")).to_be_visible()
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base_url", nargs="?", default=os.environ.get("READING_BASE_URL", "http://127.0.0.1:8765"))
    args = parser.parse_args()
    base = args.base_url.rstrip("/")
    expect.set_options(timeout=12000)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True, args=["--no-sandbox"])
        try:
            for scenario in (navigation_media_layout, indexed_search, debounce_status_and_growth,
                             highlight_drag_and_persistence, keyboard_stars_and_read,
                             mobile_and_demo, store_conflict_export_import):
                scenario(browser, base)
                print("PASS", scenario.__name__, flush=True)
        finally:
            browser.close()
    print("PASS all fictional headless reading-terminal regressions")


if __name__ == "__main__":
    main()
