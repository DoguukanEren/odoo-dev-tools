# Odoo Dev Tools

Chrome extension for Odoo developers and consultants — inspect fields, monitor RPC calls, analyze views and access rights directly in the browser.

## Features

### Floating Info Panel (6 tabs)
- **Genel** — Field tooltip, addon/module info, quick copy formats (Python path, domain, XML, ORM)
- **Teknik** — Field properties: store, compute, required, readonly, index, depends, related
- **View** — Base view + inherited views with XML preview
- **Erişim** — Access rights table + record rules with Turkish explanations
- **İlişki** — Many2one / One2many / Many2many relationship map
- **RPC** — Live RPC call monitor with slow/error highlighting

### Info Bar
Fixed bottom bar showing current model, action ID, menu ID, view type and record ID. Click any item to copy.

### Popup Tools
- **Debug mode** — Toggle `?debug=1` or `?debug=assets` with one click
- **Quick navigation** — Jump to any model or specific record by ID
- **Field export** — Export all fields of a model as CSV or JSON
- **Technical shortcuts** — One-click access to Models, Fields, Views, Actions, Menus, Access Rights, Rules, Modules

## Installation

### From Chrome Web Store
Search for **Odoo Dev Tools** or install directly from the store.

### Manual (Developer Mode)
1. Download or clone this repo
2. Go to `chrome://extensions/`
3. Enable **Developer mode**
4. Click **Load unpacked** → select the project folder

## Usage

1. Open any Odoo page in debug mode
2. Hover over a field's `?` icon — the info panel appears
3. Use the bottom info bar for page-level info
4. Click the extension icon in the toolbar for popup tools

## Privacy

This extension does not collect or transmit any data. See [Privacy Policy](https://doguukaneren.github.io/odoo-dev-tools/privacy-policy).

## License

MIT — made with ❤ by [Quanimo](https://quanimo.com)
