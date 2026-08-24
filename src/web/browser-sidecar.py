#!/usr/bin/env python3
"""
Symbiote — Browser Sidecar
Persistent Playwright browser managed via JSON-RPC over stdin/stdout.
Launched by the TypeScript browser engine, runs as a long-lived subprocess.
"""

import json
import sys
import os
import hashlib
import base64
from pathlib import Path
from typing import Optional

# Playwright imports
from playwright.sync_api import sync_playwright, Browser, BrowserContext, Page

CHROMIUM_PATH = '/usr/bin/chromium'
SYMBIOTE_DIR = Path.home() / '.symbiote'
PROFILES_DIR = SYMBIOTE_DIR / 'profiles'
SCREENSHOTS_DIR = SYMBIOTE_DIR / 'screenshots'
DOWNLOADS_DIR = SYMBIOTE_DIR / 'downloads'

for d in [PROFILES_DIR, SCREENSHOTS_DIR, DOWNLOADS_DIR]:
    d.mkdir(parents=True, exist_ok=True)


class EncryptionManager:
    def __init__(self, key: Optional[str] = None):
        try:
            from cryptography.fernet import Fernet
            if key:
                dk = hashlib.sha256(key.encode()).digest()
                self.fernet = Fernet(base64.urlsafe_b64encode(dk))
            else:
                key_path = SYMBIOTE_DIR / '.encryption-key'
                if key_path.exists():
                    self.fernet = Fernet(key_path.read_bytes())
                else:
                    k = Fernet.generate_key()
                    key_path.write_bytes(k)
                    key_path.chmod(0o600)
                    self.fernet = Fernet(k)
            self.available = True
        except ImportError:
            self.fernet = None
            self.available = False

    def encrypt(self, data: str) -> bytes:
        if self.fernet:
            return self.fernet.encrypt(data.encode())
        return data.encode()

    def decrypt(self, data: bytes) -> str:
        if self.fernet:
            return self.fernet.decrypt(data).decode()
        return data.decode()


class BrowserEngine:
    def __init__(self, encryption_key: Optional[str] = None):
        self.pw = sync_playwright().start()
        self.browser: Optional[Browser] = None
        self.contexts: dict[str, BrowserContext] = {}
        self.pages: dict[str, list[Page]] = {}
        self.active_profile: str = 'default'
        self.active_tab: dict[str, int] = {}
        self.crypto = EncryptionManager(encryption_key)

    def _ensure_browser(self):
        if not self.browser or not self.browser.is_connected():
            self.browser = self.pw.chromium.launch(
                headless=True,
                executable_path=CHROMIUM_PATH,
                args=['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
                      '--disable-extensions', '--disable-background-networking',
                      '--disable-sync', '--disable-translate', '--no-first-run']
            )

    def _get_context(self, profile: str) -> BrowserContext:
        if profile in self.contexts:
            return self.contexts[profile]
        self._ensure_browser()
        profile_dir = PROFILES_DIR / profile
        profile_dir.mkdir(parents=True, exist_ok=True)
        cookies_file = profile_dir / 'cookies.enc'
        storage_state = None
        if cookies_file.exists():
            try:
                encrypted = cookies_file.read_bytes()
                decrypted = self.crypto.decrypt(encrypted)
                tmp = profile_dir / '_state.json'
                tmp.write_text(decrypted)
                storage_state = str(tmp)
            except Exception:
                pass
        ctx_opts = {'viewport': {'width': 1280, 'height': 720},
                    'user_agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/144.0.0.0 Safari/537.36'}
        if storage_state:
            ctx_opts['storage_state'] = storage_state
        ctx = self.browser.new_context(**ctx_opts)
        self.contexts[profile] = ctx
        page = ctx.new_page()
        self.pages[profile] = [page]
        self.active_tab[profile] = 0
        tmp = profile_dir / '_state.json'
        if tmp.exists():
            tmp.unlink()
        return ctx

    def _active_page(self) -> Page:
        profile = self.active_profile
        self._get_context(profile)
        pages = self.pages.get(profile, [])
        idx = self.active_tab.get(profile, 0)
        if not pages:
            ctx = self.contexts[profile]
            pages = [ctx.new_page()]
            self.pages[profile] = pages
        if idx >= len(pages):
            idx = len(pages) - 1
            self.active_tab[profile] = idx
        return pages[idx]

    def _save_profile(self, profile: str):
        if profile not in self.contexts:
            return
        try:
            ctx = self.contexts[profile]
            state = ctx.storage_state()
            state_json = json.dumps(state)
            encrypted = self.crypto.encrypt(state_json)
            profile_dir = PROFILES_DIR / profile
            cookies_file = profile_dir / 'cookies.enc'
            cookies_file.write_bytes(encrypted)
            cookies_file.chmod(0o600)
        except Exception:
            pass

    def _extract_text(self, page: Page, selector: Optional[str] = None, max_tokens: int = 4000) -> str:
        try:
            if selector:
                el = page.query_selector(selector)
                if el:
                    text = el.inner_text()
                else:
                    return f"No element found for selector: {selector}"
            else:
                for s in ['main', 'article', '[role="main"]', '#content', '.content', 'body']:
                    el = page.query_selector(s)
                    if el:
                        text = el.inner_text()
                        break
                else:
                    text = page.inner_text('body')
            lines = [l.strip() for l in text.split('\n') if l.strip()]
            text = '\n'.join(lines)
            max_chars = max_tokens * 4
            if len(text) > max_chars:
                text = text[:max_chars] + '\n[... truncated]'
            return text
        except Exception as e:
            return f"Error extracting text: {e}"

    def _take_screenshot(self, page: Page, full: bool = False) -> str:
        name = hashlib.md5(f"{page.url}{os.getpid()}{id(page)}".encode()).hexdigest()[:12]
        path = SCREENSHOTS_DIR / f"{name}.jpg"
        try:
            page.screenshot(path=str(path), type='jpeg', quality=60 if not full else 90, full_page=full)
            return str(path)
        except Exception as e:
            return f"error:{e}"

    def _detect_password_fields(self, page: Page) -> list:
        try:
            fields = page.query_selector_all('input[type="password"]')
            return [{'visible': f.is_visible()} for f in fields]
        except Exception:
            return []

    def _dismiss_popups(self, page: Page):
        for sel in ['#onetrust-accept-btn-handler', '.cc-accept', '[data-testid="cookie-accept"]',
                     'button[aria-label*="Accept"]', 'button[aria-label*="accept"]',
                     '[id*="cookie"] button[id*="accept"]', '[class*="cookie"] button[class*="accept"]']:
            try:
                el = page.query_selector(sel)
                if el and el.is_visible():
                    el.click()
                    break
            except Exception:
                continue

    # ── RPC Handlers ──
    def handle_browse(self, p):
        page = self._active_page()
        try:
            page.goto(p['url'], timeout=p.get('timeout', 15000), wait_until='domcontentloaded')
            self._dismiss_popups(page)
            text = self._extract_text(page)
            ss = self._take_screenshot(page)
            pw = self._detect_password_fields(page)
            self._save_profile(self.active_profile)
            return {'success': True, 'url': page.url, 'title': page.title(), 'text': text, 'screenshot': ss, 'password_fields': pw}
        except Exception as e:
            return {'success': False, 'error': str(e), 'url': p['url']}

    def handle_click(self, p):
        page = self._active_page()
        try:
            if p.get('text'):
                page.get_by_text(p['text'], exact=p.get('exact', False)).first.click(timeout=p.get('timeout', 5000))
            elif p.get('selector'):
                page.click(p['selector'], timeout=p.get('timeout', 5000))
            else:
                return {'success': False, 'error': 'No selector or text'}
            page.wait_for_load_state('domcontentloaded', timeout=5000)
            self._save_profile(self.active_profile)
            return {'success': True, 'url': page.url, 'title': page.title(), 'text': self._extract_text(page), 'screenshot': self._take_screenshot(page)}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def handle_type(self, p):
        page = self._active_page()
        try:
            if p.get('clear', True):
                page.fill(p['selector'], p['text'], timeout=p.get('timeout', 5000))
            else:
                page.type(p['selector'], p['text'], timeout=p.get('timeout', 5000))
            if p.get('submit', False):
                page.press(p['selector'], 'Enter')
                page.wait_for_load_state('domcontentloaded', timeout=5000)
            return {'success': True, 'text': self._extract_text(page)}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def handle_screenshot(self, p):
        page = self._active_page()
        path = self._take_screenshot(page, full=p.get('full_page', False))
        if path.startswith('error:'):
            return {'success': False, 'error': path}
        return {'success': True, 'path': path, 'url': page.url, 'title': page.title()}

    def handle_extract(self, p):
        page = self._active_page()
        return {'success': True, 'text': self._extract_text(page, selector=p.get('selector'), max_tokens=p.get('max_tokens', 4000)), 'url': page.url}

    def handle_scroll(self, p):
        page = self._active_page()
        d = p.get('direction', 'down')
        amt = p.get('amount', 500)
        try:
            if d == 'down': page.evaluate(f'window.scrollBy(0,{amt})')
            elif d == 'up': page.evaluate(f'window.scrollBy(0,-{amt})')
            elif d == 'top': page.evaluate('window.scrollTo(0,0)')
            elif d == 'bottom': page.evaluate('window.scrollTo(0,document.body.scrollHeight)')
            elif d == 'element' and p.get('selector'): page.evaluate(f'document.querySelector("{p["selector"]}")?.scrollIntoView({{behavior:"smooth"}})')
            info = page.evaluate('({y:window.scrollY,height:document.body.scrollHeight,viewport:window.innerHeight})')
            return {'success': True, 'scroll': info, 'text': self._extract_text(page)}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def handle_wait(self, p):
        page = self._active_page()
        try:
            if p.get('selector'): page.wait_for_selector(p['selector'], timeout=p.get('timeout', 10000))
            elif p.get('navigation'): page.wait_for_load_state('domcontentloaded', timeout=p.get('timeout', 10000))
            else: page.wait_for_timeout(p.get('timeout', 2000))
            return {'success': True, 'url': page.url, 'title': page.title()}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def handle_session(self, p):
        self._save_profile(self.active_profile)
        self.active_profile = p['profile']
        self._get_context(p['profile'])
        return {'success': True, 'profile': p['profile']}

    def handle_tab_open(self, p):
        profile = self.active_profile
        ctx = self._get_context(profile)
        page = ctx.new_page()
        self.pages[profile].append(page)
        self.active_tab[profile] = len(self.pages[profile]) - 1
        if p.get('url'):
            try: page.goto(p['url'], timeout=15000, wait_until='domcontentloaded')
            except Exception as e: return {'success': False, 'error': str(e)}
        return {'success': True, 'tab_index': self.active_tab[profile], 'tab_count': len(self.pages[profile]), 'url': page.url, 'title': page.title()}

    def handle_tab_switch(self, p):
        profile = self.active_profile
        idx = p['index']
        pages = self.pages.get(profile, [])
        if 0 <= idx < len(pages):
            self.active_tab[profile] = idx
            return {'success': True, 'index': idx, 'url': pages[idx].url, 'title': pages[idx].title()}
        return {'success': False, 'error': f'Tab {idx} out of range'}

    def handle_tab_close(self, p):
        profile = self.active_profile
        pages = self.pages.get(profile, [])
        idx = self.active_tab.get(profile, 0)
        if len(pages) <= 1: return {'success': False, 'error': 'Cannot close last tab'}
        pages[idx].close()
        pages.pop(idx)
        if idx >= len(pages): idx = len(pages) - 1
        self.active_tab[profile] = idx
        return {'success': True, 'closed': idx, 'active': idx, 'tab_count': len(pages)}

    def handle_tabs(self, p):
        profile = self.active_profile
        pages = self.pages.get(profile, [])
        active = self.active_tab.get(profile, 0)
        tabs = []
        for i, pg in enumerate(pages):
            try: tabs.append({'index': i, 'url': pg.url, 'title': pg.title(), 'active': i == active})
            except: tabs.append({'index': i, 'url': '?', 'title': '?', 'active': i == active})
        return {'success': True, 'tabs': tabs}

    def handle_download(self, p):
        page = self._active_page()
        try:
            with page.expect_download(timeout=p.get('timeout', 30000)) as dl:
                if p.get('selector'): page.click(p['selector'])
            download = dl.value
            save_path = DOWNLOADS_DIR / p.get('filename', download.suggested_filename)
            download.save_as(str(save_path))
            return {'success': True, 'path': str(save_path)}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def handle_upload(self, p):
        page = self._active_page()
        try:
            page.set_input_files(p['selector'], p['file_path'], timeout=p.get('timeout', 5000))
            return {'success': True, 'file': p['file_path']}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def handle_close(self, p):
        for prof in list(self.contexts.keys()):
            self._save_profile(prof)
            try: self.contexts[prof].close()
            except: pass
        self.contexts.clear()
        self.pages.clear()
        if self.browser:
            try: self.browser.close()
            except: pass
            self.browser = None
        return {'success': True}

    HANDLERS = {
        'browse': 'handle_browse', 'click': 'handle_click', 'type': 'handle_type',
        'screenshot': 'handle_screenshot', 'extract': 'handle_extract', 'scroll': 'handle_scroll',
        'wait': 'handle_wait', 'session': 'handle_session', 'tab_open': 'handle_tab_open',
        'tab_switch': 'handle_tab_switch', 'tab_close': 'handle_tab_close', 'tabs': 'handle_tabs',
        'download': 'handle_download', 'upload': 'handle_upload', 'close': 'handle_close',
    }


def main():
    engine = BrowserEngine(os.environ.get('SYMBIOTE_ENCRYPTION_KEY'))
    for line in sys.stdin:
        line = line.strip()
        if not line: continue
        try:
            req = json.loads(line)
            handler_name = BrowserEngine.HANDLERS.get(req.get('method', ''))
            if handler_name:
                result = getattr(engine, handler_name)(req.get('params', {}))
            else:
                result = {'success': False, 'error': f'Unknown method: {req.get("method")}'}
            print(json.dumps({'id': req.get('id', 0), 'result': result}), flush=True)
        except Exception as e:
            print(json.dumps({'id': 0, 'result': {'success': False, 'error': str(e)}}), flush=True)

if __name__ == '__main__':
    main()
