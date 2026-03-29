# Privacy Policy — Odoo Dev Tools

**Last updated: March 2026**

---

## Overview

Odoo Dev Tools is a browser extension built for Odoo developers and consultants. We are committed to your privacy: this extension collects **no personal data**, sends **nothing to external servers**, and operates entirely within your browser.

---

## What We Access

| What | Why | Where it stays |
|------|-----|----------------|
| Active tab URL | To detect if you're on an Odoo page | Your browser only |
| Odoo field & model data | Fetched via your Odoo instance's own JSON-RPC API | Your browser only |
| RPC call logs | Monitored in-memory for the RPC tab | Cleared on page reload |
| Panel position & preferences | Saved so your layout persists across pages | `chrome.storage.local` on your device |

---

## What We Do NOT Do

- We do **not** collect, store, or transmit personal data
- We do **not** use analytics or tracking tools
- We do **not** send any data to third-party servers
- We do **not** access pages unrelated to Odoo

---

## Permissions Explained

- **`activeTab`** — Read the current tab's URL to detect Odoo pages
- **`storage`** — Save your panel position and preferences locally on your device
- **`clipboardWrite`** — Copy field info to clipboard when you click a copy button

---

## Data Storage

All preferences are stored locally using `chrome.storage.local`. This data never leaves your device and is not synced to any server.

---

## Changes to This Policy

If this policy changes, the updated version will be published at this URL with a new date.

---

## Contact

Questions or concerns? Open an issue at [github.com/DoguukanEren/odoo-dev-tools/issues](https://github.com/DoguukanEren/odoo-dev-tools/issues)
