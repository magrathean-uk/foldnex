# Foldnex - AI One-Click Tab Grouper for Chrome

**Foldnex** is a high-performance Chrome extension (Manifest V3) that organizes open browser tabs into clean, colored tab groups with a single click.

Instead of naive domain-matching (e.g. putting all `youtube.com` tabs into "Video"), Foldnex uses AI to analyze the actual URLs and page titles in context to identify what you are working on right now (e.g., *"Trip Planning"*, *"Q3 Budget"*, *"PR Code Review"*).

---

## Key Features

1. **One-Click & Keyboard Hotkey Action**:
   - Click the toolbar icon or press **`Alt + G`** (or **`⌘ + Shift + G`** on Mac) to organize your tab strip instantly.
   - Badge progress feedback: `...` (analyzing) → `✓` (completed).
   - Press **`Alt + U`** (or **`⌘ + Shift + U`**) to ungroup tabs.
2. **Local Machine Learning & Memory Cache (0ms Fast Path)**:
   - Learns and synthesizes URL patterns (`domain/path/*`) from AI groupings.
   - Tabs matching memorized patterns with high confidence are classified locally in **0ms** with zero API requests.
   - Learns from manual user corrections (e.g., when you rename a group or move a tab).
3. **Multi-Provider AI Architecture**:
   - **✨ Chrome Built-in Gemini Nano**: 100% on-device, private, free, and runs offline via Chrome's Prompt API (`window.ai`).
   - **⚡ Google Gemini 2.0 Flash**: Blazing fast (~300ms) with structured JSON generation and generous free tier.
   - **🤖 OpenAI & OAuth**: Supports `gpt-4o-mini`, OAuth Bearer tokens, or any OpenAI-compatible base URL (Groq, OpenRouter, Ollama).
4. **Token & Privacy Sanitization**:
   - Strips tracking parameters (`utm_*`, `fbclid`, session tokens) and hash fragments before AI analysis.
   - Cleans redundant website suffixes from titles to reduce token count and prevent prompt injection.
5. **Offline Smart Mode & Automatic Enterprise Fallback (Zero AI)**:
   - If your organization's IT policy or corporate proxy blocks Gemini Nano or external AI APIs, Foldnex automatically falls back to its built-in Offline Smart Clusterer (combining structural URL subpath hierarchy and TF-IDF title keyword co-occurrence).
   - 100% on-device, 0ms latency, zero network requests, fully air-gapped and corporate DLP compliant.

---

## Quick Start (Install Unpacked)

1. Open Chrome and navigate to: `chrome://extensions`
2. Enable **Developer mode** using the toggle in the top-right corner.
3. Click **Load unpacked** and select this directory:
   ```
   /Users/bolyki/dev/source/foldnex
   ```
4. Click the puzzle icon in Chrome's toolbar and **pin Foldnex**.

---

## Enabling Chrome's Built-in Gemini Nano (Free & On-Device)

To use the on-device Gemini Nano model (no API keys required):

1. Ensure you are using **Chrome 128+** or **Chrome Canary**.
2. Open `chrome://flags/#optimization-guide-on-device-model` and set it to:
   - **Enabled BypassPerfRequirement**
3. Open `chrome://flags/#prompt-api-for-gemini-nano` and set it to:
   - **Enabled**
4. Relaunch Chrome.
5. Open `chrome://components` and find **Optimization Guide On Device Model**. Click **Check for update** to complete the model download.
6. Open Foldnex options to verify the status indicator shows **Ready**!

---

## Configuration & Rules Management

- **Popup Menu**: Click the extension icon to view tab counts, switch AI providers, or toggle "Direct 1-Click Toolbar Mode".
- **Options Dashboard**: Right-click the icon and choose **Options** (or click the gear icon in the popup) to:
  - Configure your Google Gemini or OpenAI API keys.
  - View and manage your learned URL pattern cache.
  - Add custom regex/wildcard rules (e.g. `jira.mycompany.com/*` → "Jira Tickets").
  - Export and import rules in JSON format.
