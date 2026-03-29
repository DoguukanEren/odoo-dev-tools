(function () {
  function t(key) {
    try {
      if (!chrome.runtime || !chrome.runtime.id) return key;
      return chrome.i18n.getMessage(key) || key;
    } catch (e) { return key; }
  }

  function safeChromeStorage(fn) {
    try {
      if (!chrome.runtime || !chrome.runtime.id) return;
      fn();
    } catch (e) { /* extension context invalidated */ }
  }

  // Named constants — magic number'lar yerine
  const TOAST_VISIBLE_MS      = 1500;
  const TOAST_FADE_MS         = 300;
  const HASH_CHANGE_DELAY_MS  = 300;
  const SPA_NAVIGATE_DELAY_MS = 400;
  const HIDE_DELAY_MS         = 300;
  const MAX_RPC_LOGS          = 100;
  const RPC_SLOW_THRESHOLD_MS = 500;
  const DOMAIN_TUPLE_REGEX    = /\(\s*['"]([\w.]+)['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*(.+?)\s*\)/g;

  let currentTooltip = null;
  let previousTooltip = null;
  let hideTimer = null;
  let panel = null;
  let rpcLogs = [];

  // ============================================================
  // YARDIMCI FONKSIYONLAR
  // ============================================================
  function odooRpc(model, method, args, kwargs) {
    const payload = {
      jsonrpc: '2.0', method: 'call', id: Date.now(),
      params: { model, method, args, kwargs: kwargs || {} }
    };
    // Odoo 17+ path-based endpoint dene, sonra fallback
    const endpoint = window.location.origin + '/web/dataset/call_kw';
    return fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload)
    }).then(r => r.json()).then(d => {
      if (d.error) {
        console.warn('[OdooDevTools] RPC error:', model, method, d.error.data?.message || d.error.message);
        return [];
      }
      return d.result || [];
    });
  }

  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function getUrlParams() {
    const hash = window.location.hash || '';
    const path = window.location.pathname || '';
    const get = (key) => { const m = hash.match(new RegExp(key + '=(\\w+)')); return m ? m[1] : ''; };

    // Odoo 16- : hash-based routing (#model=product.template&...)
    const hashModel = get('model');
    if (hashModel) {
      return {
        model: hashModel,
        viewType: get('view_type') || 'form',
        actionId: get('action'),
        menuId: get('menu_id'),
        recordId: get('id'),
        cids: get('cids'),
        routingType: 'hash'
      };
    }

    // Odoo 17+ : path-based routing (/odoo/[app]/[resource]/[id])
    if (path.startsWith('/odoo')) {
      const segments = path.split('/').filter(Boolean);
      const lastSegment = segments[segments.length - 1];
      const recordId = /^\d+$/.test(lastSegment) ? lastSegment : '';
      const viewType = recordId ? 'form' : 'list';

      // OWL component state'inden model adini oku
      let model = '';
      try {
        const selectors = ['.o_form_view', '.o_list_view', '.o_kanban_view', '.o_view_controller'];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (!el) continue;
          // OWL fiber uzerinden dene
          const fiber = el.__owl__;
          if (fiber) {
            const comp = fiber.component;
            model = comp?.model?.root?.resModel || comp?.props?.resModel || '';
            if (model) break;
          }
          // data-model attribute'dan dene
          const dm = el.closest('[data-model]');
          if (dm) { model = dm.dataset.model; break; }
        }
      } catch (e) { /* OWL erisim hatasi */ }

      return { model, viewType, actionId: '', menuId: '', recordId, cids: '', routingType: 'path' };
    }

    return { model: '', viewType: 'form', actionId: '', menuId: '', recordId: '', cids: '', routingType: 'unknown' };
  }

  function isOdooPage() {
    if (window.location.pathname.startsWith('/odoo')) return true;
    const hash = window.location.hash || '';
    if (hash.includes('model=') || hash.includes('action=')) return true;
    if (document.querySelector('.o_web_client, .o_action_manager, .o_home_menu')) return true;
    return false;
  }

  function getEnvInfo() {
    const host = window.location.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1') return { label: 'LOCAL', color: '#607d8b' };
    if (host.includes('dev') || host.includes('test')) return { label: 'DEV', color: '#2196f3' };
    if (host.includes('staging') || host.includes('stage') || host.includes('demo') || host.includes('poc')) return { label: 'STAGING', color: '#ff9800' };
    return { label: 'PROD', color: '#f44336' };
  }

  function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
      showCopyToast(text.length > 40 ? text.substring(0, 40) + '...' : text);
    });
  }

  function showCopyToast(text) {
    let toast = document.getElementById('odoo-copy-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'odoo-copy-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = t('copied') + text;
    toast.style.display = 'block';
    toast.style.opacity = '1';
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => { toast.style.display = 'none'; }, TOAST_FADE_MS); }, TOAST_VISIBLE_MS);
  }

  // ============================================================
  // ALT BİLGİ BARI
  // ============================================================
  function createInfoBar() {
    if (document.getElementById('odoo-dev-infobar')) return;

    const params = getUrlParams();
    if (!params.model && !isOdooPage()) return; // Odoo sayfasi degilse gosterme

    const env = getEnvInfo();
    const bar = document.createElement('div');
    bar.id = 'odoo-dev-infobar';

    bar.innerHTML = `
      <span class="infobar-env" style="background:${env.color}">${env.label}</span>
      <span class="infobar-item" data-copy="${esc(params.model)}">📦 ${esc(params.model)}</span>
      ${params.actionId ? '<span class="infobar-item" data-copy="' + esc(params.actionId) + '">⚡ Action: ' + esc(params.actionId) + '</span>' : ''}
      ${params.menuId ? '<span class="infobar-item" data-copy="' + esc(params.menuId) + '">📋 Menu: ' + esc(params.menuId) + '</span>' : ''}
      <span class="infobar-item" data-copy="${esc(params.viewType)}">🖼 ${esc(params.viewType)}</span>
      ${params.recordId ? '<span class="infobar-item" data-copy="' + esc(params.recordId) + '">🔑 ID: ' + esc(params.recordId) + '</span>' : ''}
      <button id="infobar-toggle-panel" title="${t('togglePanel')}">🔧</button>
      <button id="infobar-close" title="✕">✕</button>
    `;

    document.body.appendChild(bar);

    // Tiklama ile kopyalama
    bar.querySelectorAll('.infobar-item').forEach(item => {
      item.addEventListener('click', () => copyToClipboard(item.dataset.copy));
      item.style.cursor = 'pointer';
    });

    bar.querySelector('#infobar-close').addEventListener('click', () => {
      bar.style.display = 'none';
    });

    bar.querySelector('#infobar-toggle-panel').addEventListener('click', () => {
      if (!panel) {
        createPanel();
        safeChromeStorage(() => chrome.storage.local.get(['panelPos'], (result) => {
          if (result.panelPos) {
            panel.style.top = result.panelPos.top;
            panel.style.left = result.panelPos.left;
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
          }
          panel.style.display = 'flex';
          safeChromeStorage(() => chrome.storage.local.set({ panelVisible: true }));
        }));
      } else {
        const visible = panel.style.display === 'none';
        panel.style.display = visible ? 'flex' : 'none';
        safeChromeStorage(() => chrome.storage.local.set({ panelVisible: visible }));
      }
    });
  }

  // Sayfa yuklendiginde info bar olustur
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createInfoBar);
  } else {
    createInfoBar();
  }
  // Hash degistiginde guncelle
  window.addEventListener('hashchange', () => {
    const old = document.getElementById('odoo-dev-infobar');
    if (old) old.remove();
    // Kucuk gecikme — Odoo hash'i gunceller sonra DOM stabilize olur
    setTimeout(createInfoBar, HASH_CHANGE_DELAY_MS);
  });

  // Odoo SPA navigasyonu icin pushState/replaceState de dinle
  function onSpaNavigate() {
    setTimeout(() => {
      const old = document.getElementById('odoo-dev-infobar');
      if (old) old.remove();
      createInfoBar();
    }, SPA_NAVIGATE_DELAY_MS);
  }

  const origPushState = history.pushState;
  history.pushState = function () {
    origPushState.apply(this, arguments);
    onSpaNavigate();
  };

  const origReplaceState = history.replaceState;
  history.replaceState = function () {
    origReplaceState.apply(this, arguments);
    onSpaNavigate();
  };

  // ============================================================
  // RPC IZLEYICI
  // ============================================================
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data && event.data.type === 'ODOO_RPC_LOG') {
      const log = event.data;
      rpcLogs.push(log);
      if (rpcLogs.length > MAX_RPC_LOGS) rpcLogs.shift();
      updateRpcTab();
    }
  });

  function updateRpcTab() {
    if (!panel) return;
    const el = panel.querySelector('#odoo-tooltip-rpc');
    if (!el) return;
    // Her zaman guncelle — tab aktif degilse bile veri biriksin
    renderRpcContent(el);
  }

  function renderRpcContent(el) {
    if (rpcLogs.length === 0) {
      el.innerHTML = '<div class="tab-empty">' + t('noRpcCalls') + '</div>';
      return;
    }

    const parts = [
      '<div class="rpc-header">',
      '<span class="rpc-count">' + rpcLogs.length + ' ' + t('rpcCalls') + '</span>',
      '<button id="rpc-clear-btn" class="rpc-clear">' + t('rpcClear') + '</button>',
      '</div>',
      '<div class="rpc-list">',
    ];

    [...rpcLogs].reverse().forEach((log) => {
      const time = new Date(log.timestamp).toLocaleTimeString('tr-TR');
      const cls = log.error ? 'rpc-item rpc-error' : (log.duration > RPC_SLOW_THRESHOLD_MS ? 'rpc-item rpc-slow' : 'rpc-item');
      parts.push('<div class="' + cls + '">');
      parts.push('<div class="rpc-row1">');
      parts.push('<span class="rpc-model">' + esc(log.model) + '</span>');
      parts.push('<span class="rpc-method">' + esc(log.method) + '</span>');
      parts.push('<span class="rpc-duration">' + log.duration + 'ms</span>');
      parts.push('</div>');
      parts.push('<div class="rpc-row2">');
      parts.push('<span class="rpc-time">' + time + '</span>');
      if (log.resultCount) parts.push('<span class="rpc-result">' + log.resultCount + ' ' + t('rpcRecords') + '</span>');
      parts.push('</div>');
      if (log.args) parts.push('<div class="rpc-args">' + esc(log.args) + '</div>');
      parts.push('</div>');
    });

    parts.push('</div>');
    el.innerHTML = parts.join('');

    // Temizle butonu
    const clearBtn = el.querySelector('#rpc-clear-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        rpcLogs = [];
        renderRpcContent(el);
      });
    }
  }

  // ============================================================
  // FLOATING PANEL
  // ============================================================
  function createPanel() {
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = 'odoo-tooltip-panel';
    panel.innerHTML = `
      <div id="odoo-tooltip-panel-header">
        <span>Odoo Dev Tools</span>
        <div style="display:flex;gap:6px;">
          <button id="odoo-tooltip-copy-btn" title="${t('copyPanel')}">📋</button>
          <button id="odoo-tooltip-close-btn" title="${t('closePanel')}">✕</button>
        </div>
      </div>
      <div id="odoo-tooltip-tabs">
        <button class="tab-btn active" data-tab="genel">${t('tabGeneral')}</button>
        <button class="tab-btn" data-tab="teknik">${t('tabTechnical')}</button>
        <button class="tab-btn" data-tab="viewlar">${t('tabView')}</button>
        <button class="tab-btn" data-tab="erisim">${t('tabAccess')}</button>
        <button class="tab-btn" data-tab="iliskiler">${t('tabRelations')}</button>
        <button class="tab-btn" data-tab="rpc">RPC</button>
      </div>
      <div id="odoo-tooltip-tab-content">
        <div class="tab-pane active" data-tab="genel">
          <pre id="odoo-tooltip-panel-content"></pre>
          <div id="odoo-tooltip-addon-info"></div>
          <div id="odoo-tooltip-copy-formats"></div>
        </div>
        <div class="tab-pane" data-tab="teknik">
          <div id="odoo-tooltip-teknik" class="tab-inner"><span class="tab-loading">${t('loading')}</span></div>
        </div>
        <div class="tab-pane" data-tab="viewlar">
          <div id="odoo-tooltip-viewlar" class="tab-inner"><span class="tab-loading">${t('loading')}</span></div>
        </div>
        <div class="tab-pane" data-tab="erisim">
          <div id="odoo-tooltip-erisim" class="tab-inner"><span class="tab-loading">${t('loading')}</span></div>
        </div>
        <div class="tab-pane" data-tab="iliskiler">
          <div id="odoo-tooltip-iliskiler" class="tab-inner"><span class="tab-loading">${t('loading')}</span></div>
        </div>
        <div class="tab-pane" data-tab="rpc">
          <div id="odoo-tooltip-rpc" class="tab-inner"><span class="tab-loading">RPC izleniyor...</span></div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);
    makeDraggable(panel, panel.querySelector('#odoo-tooltip-panel-header'));

    panel.querySelector('#odoo-tooltip-close-btn').addEventListener('click', () => {
      panel.style.display = 'none';
      safeChromeStorage(() => chrome.storage.local.set({ panelVisible: false }));
    });

    panel.querySelector('#odoo-tooltip-copy-btn').addEventListener('click', () => {
      const activePane = panel.querySelector('.tab-pane.active');
      if (activePane) copyToClipboard(activePane.textContent.trim());
    });

    panel.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        panel.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        panel.querySelector('.tab-pane[data-tab="' + btn.dataset.tab + '"]').classList.add('active');
        safeChromeStorage(() => chrome.storage.local.set({ activeTab: btn.dataset.tab }));
        // RPC tabina gecildiginde guncelle
        if (btn.dataset.tab === 'rpc') {
          renderRpcContent(panel.querySelector('#odoo-tooltip-rpc'));
        }
      });
    });

    return panel;
  }

  function makeDraggable(el, handle) {
    let offsetX = 0, offsetY = 0, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      offsetX = e.clientX - el.getBoundingClientRect().left;
      offsetY = e.clientY - el.getBoundingClientRect().top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      el.style.left = (e.clientX - offsetX) + 'px';
      el.style.top = (e.clientY - offsetY) + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => {
      if (dragging) {
        dragging = false;
        safeChromeStorage(() => chrome.storage.local.set({ panelPos: { top: el.style.top, left: el.style.left } }));
      }
    });
  }

  function setTabContent(tabName, html) {
    if (!panel) return;
    const el = panel.querySelector('#odoo-tooltip-' + tabName);
    if (el) el.innerHTML = html;
  }

  function showPanel(text) {
    const p = createPanel();
    p.querySelector('#odoo-tooltip-panel-content').textContent = text;
    p.querySelector('#odoo-tooltip-addon-info').innerHTML = '';
    p.querySelector('#odoo-tooltip-copy-formats').innerHTML = '';
    ['teknik', 'viewlar', 'erisim', 'iliskiler'].forEach(tab => {
      setTabContent(tab, '<span class="tab-loading">' + t('loading') + '</span>');
    });

    // Storage'dan pozisyon, tab ve görünürlük geri yükle
    safeChromeStorage(() => chrome.storage.local.get(['panelPos', 'activeTab'], (result) => {
      if (result.panelPos) {
        p.style.top = result.panelPos.top;
        p.style.left = result.panelPos.left;
        p.style.right = 'auto';
        p.style.bottom = 'auto';
      }

      const tab = result.activeTab || 'genel';
      p.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      p.querySelectorAll('.tab-pane').forEach(p2 => p2.classList.remove('active'));
      const activeBtn = p.querySelector('.tab-btn[data-tab="' + tab + '"]');
      const activePane = p.querySelector('.tab-pane[data-tab="' + tab + '"]');
      if (activeBtn) activeBtn.classList.add('active');
      if (activePane) activePane.classList.add('active');

      // Pozisyon restore edildikten sonra göster — flicker önleme
      p.style.display = 'flex';
      safeChromeStorage(() => chrome.storage.local.set({ panelVisible: true }));
    }));
  }

  // ============================================================
  // GENEL TAB — Addon + Kopyalama Formatlari
  // ============================================================
  function fetchGenelInfo(modelName, fieldName) {
    odooRpc('ir.model.fields', 'search_read', [
      [['model', '=', modelName], ['name', '=', fieldName]],
      ['id', 'modules', 'field_description', 'ttype', 'relation']
    ], { limit: 1 }).then(fields => {
      if (!fields || fields.length === 0) return;
      const f = fields[0];

      function renderAddonHtml(moduleStr) {
        let html = '<div class="addon-line"><span class="addon-label">📦 ' + t('addonLabel') + ':</span> <span class="addon-value">' + esc(moduleStr || t('unknown')) + '</span></div>';
        if (f.relation) {
          html += '<div class="addon-line"><span class="addon-label">🔗 ' + t('relationLabel') + ':</span> <span class="addon-value">' + esc(f.relation) + '</span></div>';
        }
        if (panel) panel.querySelector('#odoo-tooltip-addon-info').innerHTML = html;
      }

      if (f.modules) {
        // Admin kullanicilarda modules direkt gelir
        renderAddonHtml(f.modules);
      } else {
        // Non-admin fallback: ir.model.data'dan module adini al
        odooRpc('ir.model.data', 'search_read', [
          [['model', '=', 'ir.model.fields'], ['res_id', '=', f.id]],
          ['module']
        ], { limit: 10 }).then(dataRecs => {
          if (dataRecs && dataRecs.length > 0) {
            const mods = [...new Set(dataRecs.map(d => d.module))].join(', ');
            renderAddonHtml(mods);
          } else {
            renderAddonHtml('');
          }
        }).catch(() => renderAddonHtml(''));
      }
    }).catch(() => {
      if (panel) panel.querySelector('#odoo-tooltip-addon-info').innerHTML = '';
    });

    // Kopyalama formatlari
    const formats = panel.querySelector('#odoo-tooltip-copy-formats');
    if (formats) {
      formats.innerHTML = `
        <div class="copy-formats-title">${t('quickCopy')}</div>
        <div class="copy-formats-grid">
          <button class="copy-fmt-btn" data-text="${esc(modelName + '.' + fieldName)}" title="Python path">🐍 ${esc(modelName + '.' + fieldName)}</button>
          <button class="copy-fmt-btn" data-text="[('${esc(fieldName)}', '=', )]" title="Domain format">🔍 [('${esc(fieldName)}', '=', )]</button>
          <button class="copy-fmt-btn" data-text='&lt;field name="${esc(fieldName)}"/&gt;' title="XML field">📄 &lt;field name="${esc(fieldName)}"/&gt;</button>
          <button class="copy-fmt-btn" data-text="self.env['${esc(modelName)}'].${esc(fieldName)}" title="ORM erişim">⚙️ self.env['${esc(modelName)}'].${esc(fieldName)}</button>
        </div>
      `;
      formats.querySelectorAll('.copy-fmt-btn').forEach(btn => {
        btn.addEventListener('click', () => copyToClipboard(btn.dataset.text));
      });
    }
  }

  // ============================================================
  // TEKNIK TAB
  // ============================================================
  function fetchTeknikInfo(modelName, fieldName) {
    odooRpc('ir.model.fields', 'search_read', [
      [['model', '=', modelName], ['name', '=', fieldName]],
      [
        'name', 'field_description', 'ttype', 'relation', 'relation_field',
        'required', 'readonly', 'store', 'compute', 'depends', 'copied',
        'selection_ids', 'help', 'size', 'translate', 'index',
        'domain', 'groups', 'on_delete', 'related'
      ]
    ], { limit: 1 }).then(fields => {
      if (!fields || fields.length === 0) {
        setTabContent('teknik', '<div class="tab-empty">' + t('fieldNotFound') + '</div>');
        return;
      }
      const f = fields[0];
      const rows = [
        [t('fieldNameLabel'), f.name],
        [t('descriptionLabel'), f.field_description],
        [t('typeLabel'), f.ttype],
        ['Store', f.store ? '✅ ' + t('yes') : '❌ ' + t('no')],
        ['Required', f.required ? '✅ ' + t('yes') : '❌ ' + t('no')],
        ['Readonly', f.readonly ? '✅ ' + t('yes') : '❌ ' + t('no')],
        ['Index', f.index ? '✅ ' + t('yes') : '❌ ' + t('no')],
        ['Copied', f.copied ? '✅ ' + t('yes') : '❌ ' + t('no')],
        ['Translate', f.translate ? '✅ ' + t('yes') : '❌ ' + t('no')],
      ];
      if (f.compute && f.compute !== false && f.compute !== 'False') {
        rows.push(['Compute', typeof f.compute === 'string' ? f.compute : '✅ Evet (computed field)']);
      }
      if (f.related && f.related !== false) rows.push(['Related', f.related]);
      if (f.depends && f.depends !== false) rows.push(['Depends', f.depends]);
      if (f.relation) rows.push([t('relatedModelLabel'), f.relation]);
      if (f.relation_field) rows.push([t('relatedFieldLabel'), f.relation_field]);
      if (f.on_delete) rows.push(['On Delete', f.on_delete]);
      if (f.domain && f.domain !== '[]') rows.push(['Domain', f.domain]);
      if (f.help) rows.push([t('helpLabel'), f.help]);
      if (f.groups && f.groups.length > 0) rows.push([t('groupsLabel'), Array.isArray(f.groups) ? f.groups.join(', ') : f.groups]);

      const parts = ['<table class="info-table">'];
      rows.forEach(([label, value]) => {
        parts.push('<tr><td class="info-label">' + esc(label) + '</td><td class="info-value">' + esc(String(value || '-')) + '</td></tr>');
      });
      parts.push('</table>');
      setTabContent('teknik', parts.join(''));
    }).catch(() => setTabContent('teknik', '<div class="tab-empty">' + t('queryError') + '</div>'));
  }

  // ============================================================
  // VIEWLAR TAB + XML ONIZLEME
  // ============================================================
  function fetchViewInfo(modelName) {
    const viewType = getUrlParams().viewType;

    odooRpc('ir.ui.view', 'search_read', [
      [['model', '=', modelName], ['type', '=', viewType], ['inherit_id', '=', false]],
      ['name', 'xml_id', 'key', 'priority', 'arch_db']
    ], { limit: 5, order: 'priority' }).then(baseViews => {
      if (!baseViews || baseViews.length === 0) {
        setTabContent('viewlar', '<div class="tab-empty">' + t('viewNotFound') + '</div>');
        return;
      }

      const baseView = baseViews[0];

      odooRpc('ir.ui.view', 'search_read', [
        [['inherit_id', '=', baseView.id]],
        ['name', 'xml_id', 'key', 'priority']
      ], { order: 'priority' }).then(inheritedViews => {
        const parts = [];

        parts.push('<div class="view-section-title">🖼 ' + t('baseViewTitle') + ' (' + esc(viewType) + ')</div>');
        parts.push('<table class="info-table">');
        parts.push('<tr><td class="info-label">' + t('nameLabel') + '</td><td class="info-value">' + esc(baseView.name || '-') + '</td></tr>');
        parts.push('<tr><td class="info-label">ID</td><td class="info-value">' + baseView.id + '</td></tr>');
        parts.push('<tr><td class="info-label">XML ID</td><td class="info-value">' + esc(baseView.xml_id || '-') + '</td></tr>');
        parts.push('<tr><td class="info-label">' + t('priorityLabel') + '</td><td class="info-value">' + (baseView.priority || '-') + '</td></tr>');
        parts.push('</table>');
        parts.push('<button class="xml-preview-btn" id="xml-preview-toggle">' + t('xmlPreview') + '</button>');
        parts.push('<pre class="xml-preview-content" id="xml-preview-content" style="display:none;">' + esc(baseView.arch_db || t('xmlNotFound')) + '</pre>');

        if (baseViews.length > 1) {
          parts.push('<div class="view-section-title" style="margin-top:12px;">📋 ' + t('otherBaseViews') + '</div>');
          parts.push('<table class="info-table">');
          for (let i = 1; i < baseViews.length; i++) {
            const v = baseViews[i];
            parts.push('<tr><td class="info-label">' + esc(v.xml_id || 'ID:' + v.id) + '</td><td class="info-value">' + esc(v.name || '-') + '</td></tr>');
          }
          parts.push('</table>');
        }

        if (inheritedViews && inheritedViews.length > 0) {
          parts.push('<div class="view-section-title" style="margin-top:12px;">🔀 ' + t('inheritedViews') + ' (' + inheritedViews.length + ')</div>');
          parts.push('<div class="inherited-list">');
          inheritedViews.forEach(v => {
            const addon = (v.xml_id || '').split('.')[0] || '?';
            parts.push('<div class="inherited-item">');
            parts.push('<span class="inherited-addon">' + esc(addon) + '</span>');
            parts.push('<span class="inherited-name">' + esc(v.xml_id || v.name || 'ID:' + v.id) + '</span>');
            parts.push('</div>');
          });
          parts.push('</div>');
        } else {
          parts.push('<div class="tab-note" style="margin-top:12px;">' + t('noInheritedViews') + '</div>');
        }

        setTabContent('viewlar', parts.join(''));

        // XML toggle event
        setTimeout(() => {
          const toggleBtn = panel.querySelector('#xml-preview-toggle');
          const content = panel.querySelector('#xml-preview-content');
          if (toggleBtn && content) {
            toggleBtn.addEventListener('click', () => {
              content.style.display = content.style.display === 'none' ? 'block' : 'none';
              toggleBtn.textContent = content.style.display === 'none' ? t('xmlPreview') : t('xmlHide');
            });
          }
        }, 100);
      });
    }).catch(() => setTabContent('viewlar', '<div class="tab-empty">' + t('queryError') + '</div>'));
  }

  // ============================================================
  // ERISIM TAB + DOMAIN YORUMLAYICI
  // ============================================================
  function explainDomain(domainStr) {
    if (!domainStr || domainStr === '[]' || domainStr === 'None') return t('domainNoRestriction');
    const opMap = { '=': 'eşit', '!=': 'eşit değil', '>': 'büyük', '<': 'küçük', '>=': 'büyük/eşit', '<=': 'küçük/eşit', 'in': 'içinde', 'not in': 'içinde değil', 'like': 'benzer', 'ilike': 'benzer (harf duyarsız)', 'child_of': 'alt elemanı', 'parent_of': 'üst elemanı' };
    const valueMap = { 'user.id': 'giriş yapan kullanıcı ID\'si', 'user.partner_id.id': 'kullanıcının partneri', 'user.company_id.id': 'kullanıcının şirketi', 'user.company_ids.ids': 'kullanıcının erişebildiği şirketler', 'True': 'Doğru', 'False': 'Yanlış', 'true': 'Doğru', 'false': 'Yanlış' };
    const fieldMap = { 'company_id': 'Şirket', 'company_ids': 'Şirketler', 'user_id': 'Kullanıcı', 'partner_id': 'Partner', 'create_uid': 'Oluşturan', 'active': 'Aktiflik', 'state': 'Durum', 'type': 'Tür', 'parent_id': 'Üst kayıt', 'team_id': 'Ekip', 'department_id': 'Departman', 'employee_id': 'Çalışan', 'manager_id': 'Yönetici', 'warehouse_id': 'Depo', 'journal_id': 'Yevmiye', 'account_id': 'Hesap', 'currency_id': 'Para birimi', 'country_id': 'Ülke' };

    try {
      let cleaned = domainStr.trim().replace(/%(s|d)/g, '...');
      DOMAIN_TUPLE_REGEX.lastIndex = 0;
      let parts = [], match;
      while ((match = DOMAIN_TUPLE_REGEX.exec(cleaned)) !== null) {
        const field = match[1], op = match[2];
        let val = match[3].trim().replace(/^['"]|['"]$/g, '');
        const fl = fieldMap[field] || field.replace(/_/g, ' ');
        const ol = opMap[op] || op;
        val = valueMap[val] || val;
        parts.push('"' + fl + '" ' + ol + ' ' + val);
      }
      if (parts.length === 0) return t('domainCannotParse');
      const hasOr = cleaned.includes("'|'") || cleaned.includes('"|"');
      return t('domainShowOnly') + ' ' + parts.join(hasOr ? t('domainOr') : t('domainAnd')) + ' ' + t('domainAreShown');
    } catch (e) { return t('domainCannotParse'); }
  }

  function fetchErisimInfo(modelName) {
    const accessP = odooRpc('ir.model.access', 'search_read', [
      [['model_id.model', '=', modelName]],
      ['name', 'group_id', 'perm_read', 'perm_write', 'perm_create', 'perm_unlink']
    ], {});
    const ruleP = odooRpc('ir.rule', 'search_read', [
      [['model_id.model', '=', modelName]],
      ['name', 'groups', 'domain_force', 'perm_read', 'perm_write', 'perm_create', 'perm_unlink']
    ], {});

    Promise.all([accessP, ruleP]).then(([accesses, rules]) => {
      const parts = [];

      parts.push('<div class="view-section-title">' + t('accessRights') + '</div>');
      if (accesses && accesses.length > 0) {
        parts.push('<table class="info-table access-table">');
        parts.push('<tr><th>Grup</th><th>R</th><th>W</th><th>C</th><th>D</th></tr>');
        accesses.forEach(a => {
          const group = a.group_id ? a.group_id[1] : t('everyone');
          parts.push('<tr>');
          parts.push('<td class="info-label" title="' + esc(a.name) + '">' + esc(group) + '</td>');
          parts.push('<td class="perm-cell">' + (a.perm_read ? '✅' : '❌') + '</td>');
          parts.push('<td class="perm-cell">' + (a.perm_write ? '✅' : '❌') + '</td>');
          parts.push('<td class="perm-cell">' + (a.perm_create ? '✅' : '❌') + '</td>');
          parts.push('<td class="perm-cell">' + (a.perm_unlink ? '✅' : '❌') + '</td>');
          parts.push('</tr>');
        });
        parts.push('</table>');
      } else {
        parts.push('<div class="tab-note">' + t('noAccessFound') + '</div>');
      }

      parts.push('<div class="view-section-title" style="margin-top:12px;">' + t('recordRulesTitle') + '</div>');
      if (rules && rules.length > 0) {
        parts.push('<div class="rules-list">');
        rules.forEach(r => {
          parts.push('<div class="rule-item">');
          parts.push('<div class="rule-name">' + esc(r.name || '-') + '</div>');
          if (r.domain_force) {
            parts.push('<div class="rule-domain">' + esc(r.domain_force) + '</div>');
            parts.push('<div class="rule-explain">💬 ' + esc(explainDomain(r.domain_force)) + '</div>');
          }
          const perms = [];
          if (r.perm_read) perms.push('R');
          if (r.perm_write) perms.push('W');
          if (r.perm_create) perms.push('C');
          if (r.perm_unlink) perms.push('D');
          parts.push('<div class="rule-perms">' + perms.join(' · ') + '</div>');
          parts.push('</div>');
        });
        parts.push('</div>');
      } else {
        parts.push('<div class="tab-note">' + t('noRulesFound') + '</div>');
      }
      setTabContent('erisim', parts.join(''));
    }).catch(() => setTabContent('erisim', '<div class="tab-empty">' + t('queryError') + '</div>'));
  }

  // ============================================================
  // ILISKILER TAB — Model Iliski Haritasi
  // ============================================================
  function fetchIliskilerInfo(modelName) {
    odooRpc('ir.model.fields', 'search_read', [
      [['model', '=', modelName], ['ttype', 'in', ['many2one', 'one2many', 'many2many']]],
      ['name', 'field_description', 'ttype', 'relation', 'relation_field']
    ], { order: 'ttype, name' }).then(fields => {
      if (!fields || fields.length === 0) {
        setTabContent('iliskiler', '<div class="tab-empty">' + t('noRelations') + '</div>');
        return;
      }

      const grouped = { many2one: [], one2many: [], many2many: [] };
      fields.forEach(f => {
        if (grouped[f.ttype]) grouped[f.ttype].push(f);
      });

      const parts = ['<div class="relation-model-name">' + esc(modelName) + '</div>'];

      const sections = [
        { key: 'many2one', icon: '➡️', title: 'Many2one', desc: t('m2oDesc') },
        { key: 'one2many', icon: '⬅️', title: 'One2many', desc: t('o2mDesc') },
        { key: 'many2many', icon: '↔️', title: 'Many2many', desc: t('m2mDesc') },
      ];

      sections.forEach(s => {
        const items = grouped[s.key];
        if (items.length === 0) return;
        parts.push('<div class="view-section-title" style="margin-top:10px;">' + s.icon + ' ' + s.title + ' <span class="rel-desc">(' + s.desc + ')</span></div>');
        parts.push('<div class="relation-list">');
        items.forEach(f => {
          parts.push('<div class="relation-item">');
          parts.push('<div class="relation-field">' + esc(f.name) + '</div>');
          parts.push('<div class="relation-target">' + esc(f.relation || '-') + '</div>');
          parts.push('<div class="relation-label">' + esc(f.field_description || '') + '</div>');
          parts.push('</div>');
        });
        parts.push('</div>');
      });

      setTabContent('iliskiler', parts.join(''));
    }).catch(() => setTabContent('iliskiler', '<div class="tab-empty">' + t('queryError') + '</div>'));
  }

  // ============================================================
  // TOOLTIP PARSE & OBSERVER
  // ============================================================
  function parseTooltipFields(tooltip) {
    let modelName = null, fieldName = null;
    tooltip.querySelectorAll('.o-tooltip--technical li').forEach(li => {
      const titleEl = li.querySelector('.o-tooltip--technical--title');
      if (!titleEl) return;
      const title = titleEl.textContent.trim().toLowerCase();
      const value = li.textContent.replace(titleEl.textContent, '').trim();
      if (title.includes('field') || title.includes('alan')) fieldName = value;
      if (title.includes('model')) modelName = value;
    });
    return { modelName, fieldName };
  }

  function extractTooltipText(tooltip) {
    let lines = [];
    const help = tooltip.querySelector('.o-tooltip--help');
    if (help && help.textContent.trim()) {
      lines.push('Aciklama: ' + help.textContent.trim());
      lines.push('');
    }
    tooltip.querySelectorAll('.o-tooltip--technical li').forEach(li => {
      const titleEl = li.querySelector('.o-tooltip--technical--title');
      const title = titleEl ? titleEl.textContent.trim() : '';
      const value = li.textContent.replace(title, '').trim();
      lines.push('  ' + title + ' ' + value);
    });
    return lines.join('\n');
  }

  // Odoo 16: .o-tooltip / Odoo 17+: aynı class ancak parent farklı olabilir
  const TOOLTIP_SELECTOR = '.o-tooltip';

  const observer = new MutationObserver(() => {
    const tooltip = document.querySelector(TOOLTIP_SELECTOR);
    if (tooltip && tooltip !== currentTooltip) {
      currentTooltip = tooltip;
      const tooltipText = extractTooltipText(tooltip);
      showPanel(tooltipText);

      const { modelName, fieldName } = parseTooltipFields(tooltip);
      if (modelName && fieldName) {
        fetchGenelInfo(modelName, fieldName);
        fetchTeknikInfo(modelName, fieldName);
        fetchViewInfo(modelName);
        fetchErisimInfo(modelName);
        fetchIliskilerInfo(modelName);
      }

      if (previousTooltip && previousTooltip !== tooltip) {
        previousTooltip.removeEventListener('mouseenter', onTooltipEnter);
        previousTooltip.removeEventListener('mouseleave', onTooltipLeave);
      }
      tooltip.addEventListener('mouseenter', onTooltipEnter);
      tooltip.addEventListener('mouseleave', onTooltipLeave);
      previousTooltip = tooltip;
    }
  });

  function onTooltipEnter() { clearTimeout(hideTimer); }
  function onTooltipLeave() {
    hideTimer = setTimeout(() => { if (currentTooltip) currentTooltip.style.display = 'none'; }, HIDE_DELAY_MS);
  }

  observer.observe(document.body, { childList: true, subtree: true });

  function getTooltipIcon(target) {
    try {
      if (!target || target.nodeType !== 1) return null;
      // Odoo 16-17: data-tooltip-template attribute
      return target.closest('[data-tooltip-template="web.FieldTooltip"]')
        // Odoo 17+ alternatif: data-tooltip ile field bilgisi
        || target.closest('[data-tooltip][data-field]')
        || target.closest('.o_field_widget .o_optional_columns_dropdown_toggle');
    } catch (e) { return null; }
  }

  document.addEventListener('mouseover', (e) => {
    const icon = getTooltipIcon(e.target);
    if (icon) { clearTimeout(hideTimer); if (currentTooltip) currentTooltip.style.display = ''; }
  }, true);

  document.addEventListener('mouseout', (e) => {
    const icon = getTooltipIcon(e.target);
    if (icon) { hideTimer = setTimeout(() => { if (currentTooltip) currentTooltip.style.display = 'none'; }, HIDE_DELAY_MS); }
  }, true);

  // ============================================================
  // POPUP MESAJ DINLEYICI
  // ============================================================
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'GET_PAGE_INFO') {
      const params = getUrlParams();
      const env = getEnvInfo();
      sendResponse({ ...params, env, hostname: window.location.hostname, href: window.location.href });
      return;
    }

    if (msg.type === 'EXPORT_FIELDS') {
      odooRpc('ir.model.fields', 'search_read', [
        [['model', '=', msg.model]],
        ['name', 'field_description', 'ttype', 'required', 'store', 'readonly', 'relation', 'compute', 'modules']
      ], { order: 'name' }).then(fields => {
        sendResponse({ fields });
      });
      return true; // async
    }

    if (msg.type === 'NAVIGATE_RECORD') {
      // Odoo action sistemi uzerinden navigate et
      navigateToRecord(msg.model, msg.id);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'OPEN_TECHNICAL_MODEL') {
      // Teknik model icin action bul ve ac
      openTechnicalModel(msg.model);
      sendResponse({ ok: true });
      return;
    }
  });

  // Odoo'nun kendi action servisini kullanarak navigate et
  function navigateToRecord(model, id) {
    // Once modelin default action'ini bul
    odooRpc('ir.actions.act_window', 'search_read', [
      [['res_model', '=', model], ['view_mode', 'like', 'form']],
      ['id']
    ], { limit: 1 }).then(actions => {
      if (actions && actions.length > 0) {
        const actionId = actions[0].id;
        const base = window.location.origin + '/web#';
        if (id) {
          window.location.href = base + 'action=' + encodeURIComponent(actionId) + '&model=' + encodeURIComponent(model) + '&view_type=form&id=' + encodeURIComponent(id);
        } else {
          window.location.href = base + 'action=' + encodeURIComponent(actionId) + '&model=' + encodeURIComponent(model) + '&view_type=list';
        }
      } else {
        // Action bulunamazsa dogrudan dene
        const base = window.location.origin + '/web#';
        if (id) {
          window.location.href = base + 'model=' + encodeURIComponent(model) + '&view_type=form&id=' + encodeURIComponent(id);
        } else {
          window.location.href = base + 'model=' + encodeURIComponent(model) + '&view_type=list';
        }
      }
    });
  }

  function openTechnicalModel(model) {
    // Teknik model icin action bul
    odooRpc('ir.actions.act_window', 'search_read', [
      [['res_model', '=', model]],
      ['id', 'name']
    ], { limit: 1, order: 'id' }).then(actions => {
      if (actions && actions.length > 0) {
        window.location.href = window.location.origin + '/web#action=' + encodeURIComponent(actions[0].id) + '&model=' + encodeURIComponent(model) + '&view_type=list';
      } else {
        // Action yoksa Settings > Technical > model ile dene
        window.location.href = window.location.origin + '/odoo/settings?searchText=' + encodeURIComponent(model);
      }
    });
  }
})();
