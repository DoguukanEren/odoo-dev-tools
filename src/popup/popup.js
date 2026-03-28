document.addEventListener('DOMContentLoaded', () => {
  // i18n: data-i18n attribute olan tüm elementleri çevir
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const msg = chrome.i18n.getMessage(el.dataset.i18n);
    if (msg) el.textContent = msg;
  });

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    const tab = tabs[0];

    // ============ SAYFA BİLGİSİ ============
    chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_INFO' }, (response) => {
      const el = document.getElementById('page-info-content');
      if (chrome.runtime.lastError || !response) {
        el.innerHTML = '<span class="no-data">' + chrome.i18n.getMessage('noOdooPage') + '</span>';
        return;
      }

      const r = response;

      if (r.env) {
        const badge = document.getElementById('env-badge');
        badge.textContent = r.env.label + ' — ' + r.hostname;
        badge.style.background = r.env.color;
        badge.style.display = 'block';
      }

      let html = '<div class="page-info-grid">';
      if (r.model) html += '<div class="pi-item"><span class="pi-label">Model</span><span class="pi-value">' + r.model + '</span></div>';
      if (r.actionId) html += '<div class="pi-item"><span class="pi-label">Action</span><span class="pi-value">' + r.actionId + '</span></div>';
      if (r.menuId) html += '<div class="pi-item"><span class="pi-label">Menu</span><span class="pi-value">' + r.menuId + '</span></div>';
      if (r.viewType) html += '<div class="pi-item"><span class="pi-label">View</span><span class="pi-value">' + r.viewType + '</span></div>';
      if (r.recordId) html += '<div class="pi-item"><span class="pi-label">ID</span><span class="pi-value">' + r.recordId + '</span></div>';
      html += '</div>';
      el.innerHTML = html;

      if (r.model) {
        document.getElementById('export-model').value = r.model;
        document.getElementById('nav-model').value = r.model;
      }
    });

    // ============ DEBUG MODU ============
    document.getElementById('debug-on').addEventListener('click', () => {
      updateDebugMode(tab, '1');
    });

    document.getElementById('debug-assets').addEventListener('click', () => {
      updateDebugMode(tab, 'assets');
    });

    document.getElementById('debug-off').addEventListener('click', () => {
      updateDebugMode(tab, '');
    });

    function updateDebugMode(tab, debugValue) {
      // Odoo debug modu URL'de ?debug=1 veya ?debug=assets seklinde
      const url = new URL(tab.url);
      if (debugValue) {
        url.searchParams.set('debug', debugValue);
      } else {
        url.searchParams.delete('debug');
      }
      chrome.tabs.update(tab.id, { url: url.toString() });
      window.close();
    }

    // ============ HIZLI NAVIGASYON ============
    document.getElementById('nav-go').addEventListener('click', () => {
      const model = document.getElementById('nav-model').value.trim();
      const id = document.getElementById('nav-id').value.trim();
      if (!model) return;

      // Content script uzerinden navigate et (Odoo action sistemi ile)
      chrome.tabs.sendMessage(tab.id, {
        type: 'NAVIGATE_RECORD',
        model: model,
        id: id || ''
      });
      window.close();
    });

    document.getElementById('nav-id').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('nav-go').click();
    });
    document.getElementById('nav-model').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('nav-go').click();
    });

    // ============ FIELD EXPORT ============
    document.getElementById('export-csv').addEventListener('click', () => exportFields('csv', tab));
    document.getElementById('export-json').addEventListener('click', () => exportFields('json', tab));

    function exportFields(format, tab) {
      const model = document.getElementById('export-model').value.trim();
      if (!model) return;

      chrome.tabs.sendMessage(tab.id, { type: 'EXPORT_FIELDS', model }, (response) => {
        if (chrome.runtime.lastError || !response || !response.fields) {
          alert(chrome.i18n.getMessage('exportError'));
          return;
        }

        const fields = response.fields;
        let content, filename, mimeType;

        if (format === 'csv') {
          const headers = ['name', 'field_description', 'ttype', 'required', 'store', 'readonly', 'relation', 'compute', 'modules'];
          const rows = fields.map(f => headers.map(h => '"' + String(f[h] || '').replace(/"/g, '""') + '"').join(','));
          content = headers.join(',') + '\n' + rows.join('\n');
          filename = model.replace(/\./g, '_') + '_fields.csv';
          mimeType = 'text/csv';
        } else {
          content = JSON.stringify(fields, null, 2);
          filename = model.replace(/\./g, '_') + '_fields.json';
          mimeType = 'application/json';
        }

        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      });
    }

    // ============ TEKNIK KISAYOLLAR ============
    // Odoo'da teknik menuler action ID yerine dogrudan model hash ile acilir
    // Ama Odoo web client action olmadan hash'e model koyunca hata veriyor
    // Bu yuzden Settings > Technical altindaki menuler icin RPC ile action_id buluyoruz
    document.querySelectorAll('.shortcut-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const model = btn.dataset.model;
        // Content script uzerinden action bul ve navigate et
        chrome.tabs.sendMessage(tab.id, {
          type: 'OPEN_TECHNICAL_MODEL',
          model: model
        });
        window.close();
      });
    });
  });

  // ============ YARDIM TOGGLE ============
  document.getElementById('help-toggle').addEventListener('click', () => {
    const content = document.getElementById('help-content');
    const caret = document.querySelector('.caret');
    if (content.style.display === 'none') {
      content.style.display = 'block';
      caret.textContent = '▲';
    } else {
      content.style.display = 'none';
      caret.textContent = '▼';
    }
  });
});
