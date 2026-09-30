#!/usr/bin/env python3
"""
Symbiote Browser Engine — Playwright-based web automation sidecar.

Runs as a subprocess, accepts JSON commands on stdin, returns JSON on stdout.
Manages persistent browser contexts, encrypted cookie storage, multi-tab browsing.

Protocol:
  Request:  {"action": "browse", "params": {"url": "https://..."}} \n
  Response: {"ok": true, "data": {...}} \n
"""

import sys
import os
import json
import base64
import hashlib
import logging
import time
import re
from pathlib import Path
from typing import Optional

logging.basicConfig(level=logging.INFO, format="[symbiote-browser] %(message)s", stream=sys.stderr)
logger = logging.getLogger("symbiote-browser")

try:
    from cryptography.fernet import Fernet
    HAS_CRYPTO = True
except ImportError:
    HAS_CRYPTO = False
    logger.warning("cryptography not installed — cookies stored in plaintext")

from playwright.sync_api import sync_playwright, Browser, BrowserContext, Page, Playwright


def derive_key(secret: str) -> bytes:
    digest = hashlib.sha256(secret.encode()).digest()
    return base64.urlsafe_b64encode(digest)

def encrypt_data(data: str, key: bytes) -> str:
    if not HAS_CRYPTO:
        return data
    return Fernet(key).encrypt(data.encode()).decode()

def decrypt_data(data: str, key: bytes) -> str:
    if not HAS_CRYPTO:
        return data
    return Fernet(key).decrypt(data.encode()).decode()


NOISE_SELECTORS = [
    'nav', 'footer', 'header nav', '.cookie-banner', '.cookie-consent',
    '#cookie-banner', '[class*="cookie"]', '[id*="cookie"]',
    '[class*="gdpr"]', '[id*="gdpr"]', '.advertisement', '.ad-container',
]

TOKEN_CAP = 4000

def extract_text(page: Page, selector: Optional[str] = None) -> str:
    try:
        if selector:
            el = page.query_selector(selector)
            if el:
                text = el.inner_text()
            else:
                text = f"Selector '{selector}' not found on page."
        else:
            for sel in NOISE_SELECTORS:
                try:
                    page.evaluate(f"document.querySelectorAll('{sel}').forEach(el => el.remove());")
                except Exception:
                    pass
            text = page.inner_text('body')
    except Exception as e:
        text = f"Text extraction failed: {e}"

    text = re.sub(r'\n{3,}', '\n\n', text)
    text = re.sub(r' {2,}', ' ', text)
    words = text.split()
    if len(words) > TOKEN_CAP:
        text = ' '.join(words[:TOKEN_CAP]) + '\n\n[... truncated to 4000 tokens]'
    else:
        text = ' '.join(words)
    return text.strip()


COOKIE_DISMISS_SELECTORS = [
    'button[id*="accept"]', 'button[class*="accept"]',
    'button[id*="agree"]', 'button[class*="agree"]',
    'button[id*="consent"]', 'button[class*="consent"]',
]

def dismiss_cookie_banners(page: Page):
    for sel in COOKIE_DISMISS_SELECTORS:
        try:
            btn = page.query_selector(sel)
            if btn and btn.is_visible():
                btn.click()
                logger.info(f"Dismissed cookie banner via: {sel}")
                return True
        except Exception:
            continue
    for text in ['Accept', 'Accept All', 'I Agree', 'Got it', 'OK']:
        try:
            btn = page.get_by_text(text, exact=True)
            if btn.count() > 0 and btn.first.is_visible():
                btn.first.click()
                logger.info(f"Dismissed cookie banner via text: {text}")
                return True
        except Exception:
            continue
    return False


class BrowserEngine:
    def __init__(self, encryption_key: str, profile_dir: str):
        self.encryption_key = derive_key(encryption_key)
        self.profile_dir = Path(profile_dir)
        self.profile_dir.mkdir(parents=True, exist_ok=True)

        self._pw: Optional[Playwright] = None
        self._browser: Optional[Browser] = None
        self._contexts: dict[str, BrowserContext] = {}
        self._pages: dict[str, list[Page]] = {}
        self._active_tab: dict[str, int] = {}
        self._current_profile: str = "default"
        self._screenshots_dir = Path(profile_dir).parent / "screenshots"
        self._screenshots_dir.mkdir(parents=True, exist_ok=True)
        self._downloads_dir = Path(profile_dir).parent / "downloads"
        self._downloads_dir.mkdir(parents=True, exist_ok=True)

    def _ensure_browser(self):
        if self._browser is None or not self._browser.is_connected():
            self._pw = sync_playwright().start()
            self._browser = self._pw.chromium.launch(
                headless=True,
                args=['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
            )
            logger.info("Browser launched (Chromium headless)")

    def _get_profile_path(self, profile: str) -> Path:
        p = self.profile_dir / profile
        p.mkdir(parents=True, exist_ok=True)
        return p

    def _save_cookies(self, profile: str):
        ctx = self._contexts.get(profile)
        if not ctx:
            return
        try:
            cookies = ctx.cookies()
            data = json.dumps(cookies)
            encrypted = encrypt_data(data, self.encryption_key)
            (self._get_profile_path(profile) / "cookies.enc").write_text(encrypted)
        except Exception as e:
            logger.error(f"Failed to save cookies for {profile}: {e}")

    def _load_cookies(self, profile: str) -> list:
        cookie_file = self._get_profile_path(profile) / "cookies.enc"
        if not cookie_file.exists():
            return []
        try:
            encrypted = cookie_file.read_text()
            data = decrypt_data(encrypted, self.encryption_key)
            return json.loads(data)
        except Exception as e:
            logger.error(f"Failed to load cookies for {profile}: {e}")
            return []

    def _ensure_context(self, profile: str) -> BrowserContext:
        self._ensure_browser()
        if profile not in self._contexts:
            ctx = self._browser.new_context(
                viewport={'width': 1280, 'height': 720},
                user_agent='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
                accept_downloads=True,
            )
            cookies = self._load_cookies(profile)
            if cookies:
                ctx.add_cookies(cookies)
                logger.info(f"Loaded {len(cookies)} cookies for profile '{profile}'")
            self._contexts[profile] = ctx
            self._pages[profile] = []
            self._active_tab[profile] = -1
        return self._contexts[profile]

    def _get_active_page(self) -> Optional[Page]:
        pages = self._pages.get(self._current_profile, [])
        idx = self._active_tab.get(self._current_profile, -1)
        if 0 <= idx < len(pages):
            return pages[idx]
        return None

    def _new_tab(self, url: Optional[str] = None) -> Page:
        ctx = self._ensure_context(self._current_profile)
        page = ctx.new_page()
        self._pages[self._current_profile].append(page)
        self._active_tab[self._current_profile] = len(self._pages[self._current_profile]) - 1
        if url:
            try:
                page.goto(url, wait_until='domcontentloaded', timeout=15000)
                dismiss_cookie_banners(page)
            except Exception as e:
                logger.warning(f"Navigation to {url} issue: {e}")
        return page

    def _take_screenshot(self, full: bool = False) -> Optional[str]:
        page = self._get_active_page()
        if not page:
            return None
        try:
            ts = int(time.time() * 1000)
            if full:
                path = self._screenshots_dir / f"full_{ts}.png"
                page.screenshot(path=str(path), full_page=False)
            else:
                path = self._screenshots_dir / f"thumb_{ts}.jpg"
                page.screenshot(path=str(path), full_page=False, type='jpeg', quality=60)
            return str(path)
        except Exception as e:
            logger.error(f"Screenshot failed: {e}")
            return None

    def _detect_password_fields(self, page: Page) -> list:
        try:
            fields = page.query_selector_all('input[type="password"]')
            return [{"index": i, "visible": f.is_visible()} for i, f in enumerate(fields)]
        except Exception:
            return []

    def browse(self, url: str) -> dict:
        page = self._get_active_page()
        if not page:
            page = self._new_tab()
        try:
            resp = page.goto(url, wait_until='domcontentloaded', timeout=15000)
            status = resp.status if resp else 0
        except Exception:
            try:
                time.sleep(2)
                resp = page.goto(url, wait_until='domcontentloaded', timeout=15000)
                status = resp.status if resp else 0
            except Exception as e2:
                return {"ok": False, "error": f"Navigation failed: {e2}"}
        dismiss_cookie_banners(page)
        text = extract_text(page)
        screenshot = self._take_screenshot()
        pw_fields = self._detect_password_fields(page)
        self._save_cookies(self._current_profile)
        return {
            "ok": True, "url": page.url, "title": page.title(),
            "status": status, "text": text, "screenshot": screenshot,
            "password_fields": pw_fields, "has_login": len(pw_fields) > 0,
        }

    def click(self, selector: str = '', text_match: str = None) -> dict:
        page = self._get_active_page()
        if not page:
            return {"ok": False, "error": "No active page. Use web_browse first."}
        try:
            if text_match:
                page.get_by_text(text_match, exact=False).first.click(timeout=5000)
            else:
                page.click(selector, timeout=5000)
            page.wait_for_load_state('domcontentloaded', timeout=5000)
        except Exception as e:
            return {"ok": False, "error": f"Click failed: {e}", "screenshot": self._take_screenshot()}
        dismiss_cookie_banners(page)
        text = extract_text(page)
        screenshot = self._take_screenshot()
        self._save_cookies(self._current_profile)
        return {"ok": True, "url": page.url, "title": page.title(), "text": text, "screenshot": screenshot}

    def type_text(self, selector: str, text: str, clear_first: bool = True) -> dict:
        page = self._get_active_page()
        if not page:
            return {"ok": False, "error": "No active page."}
        try:
            if clear_first:
                page.fill(selector, text, timeout=5000)
            else:
                page.type(selector, text, timeout=5000)
        except Exception as e:
            return {"ok": False, "error": f"Type failed: {e}", "screenshot": self._take_screenshot()}
        return {"ok": True, "selector": selector, "typed": len(text)}

    def screenshot(self, full: bool = True) -> dict:
        page = self._get_active_page()
        if not page:
            return {"ok": False, "error": "No active page."}
        path = self._take_screenshot(full=full)
        if path:
            return {"ok": True, "path": path}
        return {"ok": False, "error": "Screenshot failed."}

    def extract(self, selector: str = None) -> dict:
        page = self._get_active_page()
        if not page:
            return {"ok": False, "error": "No active page."}
        text = extract_text(page, selector)
        return {"ok": True, "text": text, "url": page.url, "title": page.title()}

    def scroll(self, direction: str = "down", amount: int = 500) -> dict:
        page = self._get_active_page()
        if not page:
            return {"ok": False, "error": "No active page."}
        try:
            if direction == "down":
                page.evaluate(f"window.scrollBy(0, {amount})")
            elif direction == "up":
                page.evaluate(f"window.scrollBy(0, -{amount})")
            elif direction == "top":
                page.evaluate("window.scrollTo(0, 0)")
            elif direction == "bottom":
                page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            time.sleep(0.3)
        except Exception as e:
            return {"ok": False, "error": f"Scroll failed: {e}"}
        scroll_info = page.evaluate("""() => ({
            scrollY: window.scrollY, scrollHeight: document.body.scrollHeight,
            viewportHeight: window.innerHeight,
            atTop: window.scrollY === 0,
            atBottom: window.scrollY + window.innerHeight >= document.body.scrollHeight - 10
        })""")
        text = extract_text(page)
        screenshot = self._take_screenshot()
        return {"ok": True, "scroll": scroll_info, "text": text, "screenshot": screenshot}

    def wait_for(self, selector: str = None, timeout: int = 10000) -> dict:
        page = self._get_active_page()
        if not page:
            return {"ok": False, "error": "No active page."}
        try:
            if selector:
                page.wait_for_selector(selector, timeout=timeout)
            else:
                page.wait_for_load_state('networkidle', timeout=timeout)
        except Exception as e:
            return {"ok": False, "error": f"Wait timed out: {e}", "screenshot": self._take_screenshot()}
        return {"ok": True, "url": page.url, "title": page.title()}

    def switch_profile(self, profile: str) -> dict:
        self._save_cookies(self._current_profile)
        self._current_profile = profile
        self._ensure_context(profile)
        pages = self._pages.get(profile, [])
        return {"ok": True, "profile": profile, "tabs": len(pages)}

    def tab_open(self, url: str = None) -> dict:
        page = self._new_tab(url)
        idx = self._active_tab[self._current_profile]
        result = {"ok": True, "tab_index": idx, "total_tabs": len(self._pages[self._current_profile])}
        if url:
            result.update({"url": page.url, "title": page.title(), "text": extract_text(page), "screenshot": self._take_screenshot()})
        return result

    def tab_switch(self, index: int) -> dict:
        pages = self._pages.get(self._current_profile, [])
        if 0 <= index < len(pages):
            self._active_tab[self._current_profile] = index
            page = pages[index]
            return {"ok": True, "tab_index": index, "url": page.url, "title": page.title(), "text": extract_text(page), "screenshot": self._take_screenshot()}
        return {"ok": False, "error": f"Tab index {index} out of range (0-{len(pages)-1})."}

    def tab_close(self) -> dict:
        pages = self._pages.get(self._current_profile, [])
        idx = self._active_tab.get(self._current_profile, -1)
        if 0 <= idx < len(pages):
            pages[idx].close()
            pages.pop(idx)
            self._active_tab[self._current_profile] = min(idx, len(pages) - 1) if pages else -1
            return {"ok": True, "remaining_tabs": len(pages)}
        return {"ok": False, "error": "No tab to close."}

    def tabs_list(self) -> dict:
        pages = self._pages.get(self._current_profile, [])
        active = self._active_tab.get(self._current_profile, -1)
        tabs = []
        for i, p in enumerate(pages):
            try:
                tabs.append({"index": i, "url": p.url, "title": p.title(), "active": i == active})
            except Exception:
                tabs.append({"index": i, "url": "?", "title": "?", "active": i == active})
        return {"ok": True, "tabs": tabs, "profile": self._current_profile}

    def download(self, save_as: str = None) -> dict:
        page = self._get_active_page()
        if not page:
            return {"ok": False, "error": "No active page."}
        try:
            with page.expect_download(timeout=10000) as dl_info:
                pass
            dl = dl_info.value
            filename = save_as or dl.suggested_filename
            dest = self._downloads_dir / filename
            dl.save_as(str(dest))
            return {"ok": True, "path": str(dest), "filename": filename}
        except Exception as e:
            return {"ok": False, "error": f"No download available: {e}"}

    def upload(self, selector: str, file_path: str) -> dict:
        page = self._get_active_page()
        if not page:
            return {"ok": False, "error": "No active page."}
        if not os.path.isfile(file_path):
            return {"ok": False, "error": f"File not found: {file_path}"}
        try:
            page.set_input_files(selector, file_path, timeout=5000)
            return {"ok": True, "file": file_path, "selector": selector}
        except Exception as e:
            return {"ok": False, "error": f"Upload failed: {e}"}

    def close_all(self):
        """Clean up all browser resources."""
        for profile in list(self._contexts.keys()):
            self._save_cookies(profile)
        for ctx in self._contexts.values():
            try:
                ctx.close()
            except Exception:
                pass
        if self._browser:
            try:
                self._browser.close()
            except Exception:
                pass
        if self._pw:
            try:
                self._pw.stop()
            except Exception:
                pass
        logger.info("Browser engine closed.")


ACTION_MAP = {
    'browse': lambda eng, p: eng.browse(p['url']),
    'click': lambda eng, p: eng.click(p.get('selector', ''), p.get('text_match')),
    'type': lambda eng, p: eng.type_text(p['selector'], p['text'], p.get('clear_first', True)),
    'screenshot': lambda eng, p: eng.screenshot(p.get('full', True)),
    'extract': lambda eng, p: eng.extract(p.get('selector')),
    'scroll': lambda eng, p: eng.scroll(p.get('direction', 'down'), p.get('amount', 500)),
    'wait': lambda eng, p: eng.wait_for(p.get('selector'), p.get('timeout', 10000)),
    'session': lambda eng, p: eng.switch_profile(p['profile']),
    'tab_open': lambda eng, p: eng.tab_open(p.get('url')),
    'tab_switch': lambda eng, p: eng.tab_switch(p['index']),
    'tab_close': lambda eng, p: eng.tab_close(),
    'tabs': lambda eng, p: eng.tabs_list(),
    'download': lambda eng, p: eng.download(p.get('save_as')),
    'upload': lambda eng, p: eng.upload(p['selector'], p['file_path']),
    'close': lambda eng, p: eng.close_all() or {"ok": True, "message": "Closed."},
}

def main():
    encryption_key = os.environ.get('SYMBIOTE_ENCRYPTION_KEY', 'symbiote-default-key-change-me')
    profile_dir = os.environ.get('SYMBIOTE_PROFILE_DIR', os.path.expanduser('~/.symbiote/profiles'))
    engine = BrowserEngine(encryption_key, profile_dir)
    logger.info(f"Browser engine ready. Profiles: {profile_dir}")
    sys.stdout.write(json.dumps({"ready": True}) + '\n')
    sys.stdout.flush()

    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except json.JSONDecodeError as e:
                sys.stdout.write(json.dumps({"ok": False, "error": f"Invalid JSON: {e}"}) + '\n')
                sys.stdout.flush()
                continue

            action = request.get('action', '')
            params = request.get('params', {})
            handler = ACTION_MAP.get(action)
            if not handler:
                result = {"ok": False, "error": f"Unknown action: {action}"}
            else:
                try:
                    result = handler(engine, params)
                    if result is None:
                        result = {"ok": True}
                except Exception as e:
                    logger.error(f"Action '{action}' failed: {e}")
                    result = {"ok": False, "error": str(e)}
            sys.stdout.write(json.dumps(result, default=str) + '\n')
            sys.stdout.flush()
    except KeyboardInterrupt:
        pass
    finally:
        engine.close_all()

if __name__ == '__main__':
    main()
