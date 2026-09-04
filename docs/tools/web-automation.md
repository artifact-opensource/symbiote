# Web Automation

Symbiote includes a full web browsing suite powered by a Python Playwright sidecar. Agents can browse the web, fill forms, click elements, take screenshots, manage tabs, and maintain persistent login sessions.

## Architecture

```
Agent calls web_browse(url)
    |
    TypeScript tool sends JSON-RPC to Python sidecar
    |
    Sidecar: Playwright navigates -> extracts text -> screenshots
    |
    Returns: { title, url, text, screenshot_path }
    |
    Agent reasons about content, calls next tool
    |
    Sidecar closes after 5min idle (zero cost when not browsing)
```

The sidecar is a Python process (`browser-sidecar.py`) that communicates via JSON-RPC over stdin/stdout. It launches lazily on the first `web_browse` call and auto-closes after 5 minutes of inactivity.

## Prerequisites

- Python 3.10+
- Playwright + Chromium:

```bash
pip3 install playwright
python3 -m playwright install chromium
```

## Tools (14)

### Navigation
| Tool | Parameters | Description |
|------|-----------|-------------|
| `web_browse` | `url` | Navigate to URL. Returns page title, URL, extracted text (4000 token cap), and screenshot path. |
| `web_scroll` | `direction`, `amount?` | Scroll the viewport. Direction: "up", "down", "top", "bottom", or CSS selector to scroll to. |
| `web_wait` | `condition` | Wait for an element (CSS selector), navigation, or timeout (ms). |

### Interaction
| Tool | Parameters | Description |
|------|-----------|-------------|
| `web_click` | `selector` | Click an element. Accepts CSS selector or text content match (e.g. "Click me"). |
| `web_type` | `selector`, `text`, `clear?` | Type into an input field. Optional `clear` to empty field first. |
| `web_upload` | `selector`, `file_path` | Upload a file to a file input element. |

### Content
| Tool | Parameters | Description |
|------|-----------|-------------|
| `web_screenshot` | `full_page?` | Capture current page. Returns base64 image or file path. |
| `web_extract` | `selector?` | Extract text content. Optional CSS selector for focused extraction. |
| `web_download` | — | Save the most recent downloaded file to `~/.symbiote/downloads/`. |

### Tabs
| Tool | Parameters | Description |
|------|-----------|-------------|
| `web_tab_open` | `url?` | Open a new tab, optionally navigating to a URL. |
| `web_tab_switch` | `index` | Switch to a tab by index (0-based). |
| `web_tab_close` | — | Close the current tab. |
| `web_tabs` | — | List all open tabs with their titles and URLs. |

### Profiles
| Tool | Parameters | Description |
|------|-----------|-------------|
| `web_session` | `profile` | Switch browser profile. Loads encrypted cookies for persistent sessions. |

## Browser Profiles

Each profile maintains its own encrypted cookie store:

```
~/.symbiote/profiles/
  default/
    cookies.enc        -- AES-256 encrypted
    config.json        -- profile preferences
  ali/
    cookies.enc
    config.json
  ava/
    cookies.enc
    config.json
```

### Creating a Profile

Profiles are created automatically on first use:

```
Agent: web_session("ali")       -> creates ~/.symbiote/profiles/ali/
Agent: web_browse("github.com") -> user logs in manually
                                -> cookies saved to ali/cookies.enc
```

Next time `web_session("ali")` is called, the saved cookies load automatically. The agent is logged into GitHub without re-authenticating.

### Encryption

Cookies are encrypted with AES-256 using the `SYMBIOTE_ENCRYPTION_KEY` environment variable. If not set, a key is auto-generated and saved to `~/.symbiote/.key`.

## Security Model

1. **Credentials never enter LLM context.** The agent receives extracted text from pages, never raw form values.
2. **Password fields are detected but not read.** When a page has `type="password"` inputs, the agent flags them for human intervention.
3. **Profile isolation.** Each profile uses a separate Playwright browser context. No cookies or localStorage leak between profiles.
4. **Downloads are sandboxed.** All downloads go to `~/.symbiote/downloads/` — no path traversal.
5. **Cookie banner dismissal.** Common cookie consent patterns are auto-dismissed to reduce noise.

## Context Management

Web pages can be very large. Symbiote manages context carefully:

- Raw HTML is processed through a readability pipeline (strips nav, ads, scripts)
- Extracted text is capped at 4000 tokens
- `web_extract` with a CSS selector returns only the matching content
- Previous page contents are evicted from agent context after navigation
- Screenshots are stored to disk, not passed as base64 in context

## Example Usage

```
User: "Check our GitHub repos and tell me which has the most recent commit"

Agent: web_browse("https://github.com/Artifact-Virtual")
       -> Gets list of repositories with last update times
       
Agent: "Found 4 repos. mach6 was updated 2 hours ago, 
        singularity 4 hours ago, cthulu 1 hour ago. 
        Cthulu has the most recent commit."

User: "Open cthulu and show me the latest release"

Agent: web_click("cthulu")
       -> Navigates to cthulu repo page
       
Agent: web_click("Releases")
       -> Opens releases page
       
Agent: "Latest release is v6.0.0 - K9: The Cognition Kube, 
        published today. 42 files changed, 9933 insertions."
```
