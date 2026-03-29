(function () {
  const t = (key) => chrome.i18n.getMessage(key) || key;

  let currentTooltip = null;
  let hideTimer = null;
  let panel = null;
  let rpcLogs = [];
  let lastModel = null;
  let lastField = null;

  // ============================================================
  // YARDIMCI FONKSIYONLAR
  // ============================================================
  function odooRpc(model, method, args, kwargs) {
    const payload = {
      jsonrpc: '2.0', method: 'call', id: Date.now(),
      params: { model, method, args, kwargs: kwargs || {} }
    };
    return fetch(window.location.origin + '/web/dataset/call_kw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(r => r.json()).then(d => d.result || []);
  }

  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function getUrlParams() {
    // v15/v16: /web#model=res.partner&view_type=list&action=123&id=42
    const hash = window.location.hash || '';
    if (hash.includes('model=')) {
      const get = (key) => { const m = hash.match(new RegExp('[#&]' + key + '=([\\w.]+)')); return m ? m[1] : ''; };
      return {
        model: get('model'),
        viewType: get('view_type') || 'form',
        actionId: get('action'),
        menuId: get('menu_id'),
        recordId: get('id'),
        cids: get('cids')
      };
    }

    // v17+: /odoo/{slug} or /odoo/{slug}/{id} — model not in URL, read from OWL state
    const searchParams = new URLSearchParams(window.location.search);
    let model = '', viewType = '', recordId = '', actionId = '', menuId = '';

    try {
      const apps = window.__owl__?.apps;
      if (apps) {
        for (const app of Object.values(apps)) {
          const env = app.env;
          if (!env || !env.services) continue;
          const actionService = env.services.action;
          if (!actionService) continue;
          const controller = actionService.currentController;
          if (controller) {
            const action = controller.action || {};
            if (action.res_model) {
              model = action.res_model;
              viewType = controller.view?.type || action.view_mode?.split(',')[0] || 'form';
              if (controller.record?.resId) recordId = String(controller.record.resId);
              if (action.id) actionId = String(action.id);
              break;
            }
          }
        }
      }
    } catch (e) {}

    // Fallback: extract numeric record ID from URL path (/odoo/contacts/42)
    if (!recordId) {
      const lastPart = window.location.pathname.split('/').filter(Boolean).pop();
      if (lastPart && /^\d+$/.test(lastPart)) {
        recordId = lastPart;
        viewType = viewType || 'form';
      }
    }

    return {
      model,
      viewType: viewType || 'list',
      actionId: actionId || searchParams.get('action') || '',
      menuId: menuId || searchParams.get('menu_id') || '',
      recordId,
      cids: searchParams.get('cids') || ''
    };
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
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => { toast.style.display = 'none'; }, 300); }, 1500);
  }

  // ============================================================
  // ALT BİLGİ BARI
  // ============================================================
  function createInfoBar() {
    if (document.getElementById('odoo-dev-infobar')) return;

    const params = getUrlParams();
    if (!params.model) return; // Odoo sayfasi degilse gosterme

    const env = getEnvInfo();
    const bar = document.createElement('div');
    bar.id = 'odoo-dev-infobar';

    bar.innerHTML = `
      <span class="infobar-env" style="background:${env.color}">${env.label}</span>
      <span class="infobar-item" data-copy="${esc(params.model)}">📦 ${esc(params.model)}</span>
      ${params.actionId ? '<span class="infobar-item" data-copy="' + params.actionId + '">⚡ Action: ' + params.actionId + '</span>' : ''}
      ${params.menuId ? '<span class="infobar-item" data-copy="' + params.menuId + '">📋 Menu: ' + params.menuId + '</span>' : ''}
      <span class="infobar-item" data-copy="${params.viewType}">🖼 ${params.viewType}</span>
      ${params.recordId ? '<span class="infobar-item" data-copy="' + params.recordId + '">🔑 ID: ' + params.recordId + '</span>' : ''}
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
        chrome.storage.local.get(['panelPos'], (result) => {
          if (result.panelPos) {
            panel.style.top = result.panelPos.top;
            panel.style.left = result.panelPos.left;
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
          }
          panel.style.display = 'flex';
          chrome.storage.local.set({ panelVisible: true });
        });
      } else {
        const visible = panel.style.display === 'none';
        panel.style.display = visible ? 'flex' : 'none';
        chrome.storage.local.set({ panelVisible: visible });
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
    setTimeout(createInfoBar, 300);
  });

  // Odoo SPA navigasyonu icin pushState/replaceState de dinle (v17+ path-based routing)
  function refreshInfoBar() {
    setTimeout(() => {
      const old = document.getElementById('odoo-dev-infobar');
      if (old) old.remove();
      createInfoBar();
    }, 500);
  }

  const origPushState = history.pushState;
  history.pushState = function () {
    origPushState.apply(this, arguments);
    refreshInfoBar();
  };

  const origReplaceState = history.replaceState;
  history.replaceState = function () {
    origReplaceState.apply(this, arguments);
    refreshInfoBar();
  };

  // ============================================================
  // RPC IZLEYICI
  // ============================================================
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'ODOO_RPC_LOG') {
      const log = event.data;
      rpcLogs.unshift(log);
      if (rpcLogs.length > 100) rpcLogs.pop();
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

    let html = '<div class="rpc-header">';
    html += '<span class="rpc-count">' + rpcLogs.length + ' ' + t('rpcCalls') + '</span>';
    html += '<button id="rpc-clear-btn" class="rpc-clear">' + t('rpcClear') + '</button>';
    html += '</div>';
    html += '<div class="rpc-list">';

    rpcLogs.forEach((log, i) => {
      const time = new Date(log.timestamp).toLocaleTimeString('tr-TR');
      const cls = log.error ? 'rpc-item rpc-error' : (log.duration > 500 ? 'rpc-item rpc-slow' : 'rpc-item');
      html += '<div class="' + cls + '">';
      html += '<div class="rpc-row1">';
      html += '<span class="rpc-model">' + esc(log.model) + '</span>';
      html += '<span class="rpc-method">' + esc(log.method) + '</span>';
      html += '<span class="rpc-duration">' + log.duration + 'ms</span>';
      html += '</div>';
      html += '<div class="rpc-row2">';
      html += '<span class="rpc-time">' + time + '</span>';
      if (log.resultCount) html += '<span class="rpc-result">' + log.resultCount + ' ' + t('rpcRecords') + '</span>';
      html += '</div>';
      if (log.args) {
        html += '<div class="rpc-args">' + esc(log.args) + '</div>';
      }
      html += '</div>';
    });

    html += '</div>';
    el.innerHTML = html;

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
      chrome.storage.local.set({ panelVisible: false });
    });

    panel.querySelector('#odoo-tooltip-copy-btn').addEventListener('click', () => {
      const activePane = panel.querySelector('.tab-pane.active');
      copyToClipboard(activePane.textContent.trim());
    });

    panel.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        panel.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        panel.querySelector('.tab-pane[data-tab="' + btn.dataset.tab + '"]').classList.add('active');
        chrome.storage.local.set({ activeTab: btn.dataset.tab });
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
        chrome.storage.local.set({ panelPos: { top: el.style.top, left: el.style.left } });
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
    chrome.storage.local.get(['panelPos', 'activeTab'], (result) => {
      if (result.panelPos) {
        p.style.top = result.panelPos.top;
        p.style.left = result.panelPos.left;
        p.style.right = 'auto';
        p.style.bottom = 'auto';
      }

      const tab = result.activeTab || 'genel';
      p.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      p.querySelectorAll('.tab-pane').forEach(p2 => p2.classList.remove('active'));
      p.querySelector('.tab-btn[data-tab="' + tab + '"]').classList.add('active');
      p.querySelector('.tab-pane[data-tab="' + tab + '"]').classList.add('active');
    });

    p.style.display = 'flex';
    chrome.storage.local.set({ panelVisible: true });
  }

  // ============================================================
  // GENEL TAB — Addon + Kopyalama Formatlari
  // ============================================================
  function fetchGenelInfo(modelName, fieldName) {
    odooRpc('ir.model.fields', 'search_read', [
      [['model', '=', modelName], ['name', '=', fieldName]],
      ['modules', 'field_description', 'ttype', 'relation']
    ], { limit: 1 }).then(fields => {
      let html = '';
      if (fields && fields.length > 0) {
        const f = fields[0];
        html += '<div class="addon-line"><span class="addon-label">📦 ' + t('addonLabel') + ':</span> <span class="addon-value">' + esc(f.modules || t('unknown')) + '</span></div>';
        if (f.relation) {
          html += '<div class="addon-line"><span class="addon-label">🔗 ' + t('relationLabel') + ':</span> <span class="addon-value">' + esc(f.relation) + '</span></div>';
        }
      }
      if (panel) panel.querySelector('#odoo-tooltip-addon-info').innerHTML = html;
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
      let html = '<table class="info-table">';
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
      // Compute: boolean veya string olabilir
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

      rows.forEach(([label, value]) => {
        html += '<tr><td class="info-label">' + esc(label) + '</td><td class="info-value">' + esc(String(value || '-')) + '</td></tr>';
      });
      html += '</table>';
      setTabContent('teknik', html);
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
        let html = '';

        // Base view
        html += '<div class="view-section-title">🖼 ' + t('baseViewTitle') + ' (' + esc(viewType) + ')</div>';
        html += '<table class="info-table">';
        html += '<tr><td class="info-label">' + t('nameLabel') + '</td><td class="info-value">' + esc(baseView.name || '-') + '</td></tr>';
        html += '<tr><td class="info-label">ID</td><td class="info-value">' + baseView.id + '</td></tr>';
        html += '<tr><td class="info-label">XML ID</td><td class="info-value">' + esc(baseView.xml_id || '-') + '</td></tr>';
        html += '<tr><td class="info-label">' + t('priorityLabel') + '</td><td class="info-value">' + (baseView.priority || '-') + '</td></tr>';
        html += '</table>';

        // XML Onizleme butonu
        html += '<button class="xml-preview-btn" id="xml-preview-toggle">' + t('xmlPreview') + '</button>';
        html += '<pre class="xml-preview-content" id="xml-preview-content" style="display:none;">' + esc(baseView.arch_db || t('xmlNotFound')) + '</pre>';

        // Diger base viewlar
        if (baseViews.length > 1) {
          html += '<div class="view-section-title" style="margin-top:12px;">📋 ' + t('otherBaseViews') + '</div>';
          html += '<table class="info-table">';
          for (let i = 1; i < baseViews.length; i++) {
            const v = baseViews[i];
            html += '<tr><td class="info-label">' + esc(v.xml_id || 'ID:' + v.id) + '</td><td class="info-value">' + esc(v.name || '-') + '</td></tr>';
          }
          html += '</table>';
        }

        // Inherited views
        if (inheritedViews && inheritedViews.length > 0) {
          html += '<div class="view-section-title" style="margin-top:12px;">🔀 ' + t('inheritedViews') + ' (' + inheritedViews.length + ')</div>';
          html += '<div class="inherited-list">';
          inheritedViews.forEach(v => {
            const addon = (v.xml_id || '').split('.')[0] || '?';
            html += '<div class="inherited-item">';
            html += '<span class="inherited-addon">' + esc(addon) + '</span>';
            html += '<span class="inherited-name">' + esc(v.xml_id || v.name || 'ID:' + v.id) + '</span>';
            html += '</div>';
          });
          html += '</div>';
        } else {
          html += '<div class="tab-note" style="margin-top:12px;">' + t('noInheritedViews') + '</div>';
        }

        setTabContent('viewlar', html);

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
      const tupleRegex = /\(\s*['"]([\w.]+)['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*(.+?)\s*\)/g;
      let parts = [], match;
      while ((match = tupleRegex.exec(cleaned)) !== null) {
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
      let html = '';

      html += '<div class="view-section-title">' + t('accessRights') + '</div>';
      if (accesses && accesses.length > 0) {
        html += '<table class="info-table access-table">';
        html += '<tr><th>Grup</th><th>R</th><th>W</th><th>C</th><th>D</th></tr>';
        accesses.forEach(a => {
          const group = a.group_id ? a.group_id[1] : t('everyone');
          html += '<tr>';
          html += '<td class="info-label" title="' + esc(a.name) + '">' + esc(group) + '</td>';
          html += '<td class="perm-cell">' + (a.perm_read ? '✅' : '❌') + '</td>';
          html += '<td class="perm-cell">' + (a.perm_write ? '✅' : '❌') + '</td>';
          html += '<td class="perm-cell">' + (a.perm_create ? '✅' : '❌') + '</td>';
          html += '<td class="perm-cell">' + (a.perm_unlink ? '✅' : '❌') + '</td>';
          html += '</tr>';
        });
        html += '</table>';
      } else {
        html += '<div class="tab-note">' + t('noAccessFound') + '</div>';
      }

      html += '<div class="view-section-title" style="margin-top:12px;">' + t('recordRulesTitle') + '</div>';
      if (rules && rules.length > 0) {
        html += '<div class="rules-list">';
        rules.forEach(r => {
          html += '<div class="rule-item">';
          html += '<div class="rule-name">' + esc(r.name || '-') + '</div>';
          if (r.domain_force) {
            html += '<div class="rule-domain">' + esc(r.domain_force) + '</div>';
            html += '<div class="rule-explain">💬 ' + esc(explainDomain(r.domain_force)) + '</div>';
          }
          const perms = [];
          if (r.perm_read) perms.push('R');
          if (r.perm_write) perms.push('W');
          if (r.perm_create) perms.push('C');
          if (r.perm_unlink) perms.push('D');
          html += '<div class="rule-perms">' + perms.join(' · ') + '</div>';
          html += '</div>';
        });
        html += '</div>';
      } else {
        html += '<div class="tab-note">' + t('noRulesFound') + '</div>';
      }
      setTabContent('erisim', html);
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

      let html = '<div class="relation-model-name">' + esc(modelName) + '</div>';

      const sections = [
        { key: 'many2one', icon: '➡️', title: 'Many2one', desc: t('m2oDesc') },
        { key: 'one2many', icon: '⬅️', title: 'One2many', desc: t('o2mDesc') },
        { key: 'many2many', icon: '↔️', title: 'Many2many', desc: t('m2mDesc') },
      ];

      sections.forEach(s => {
        const items = grouped[s.key];
        if (items.length === 0) return;
        html += '<div class="view-section-title" style="margin-top:10px;">' + s.icon + ' ' + s.title + ' <span class="rel-desc">(' + s.desc + ')</span></div>';
        html += '<div class="relation-list">';
        items.forEach(f => {
          html += '<div class="relation-item">';
          html += '<div class="relation-field">' + esc(f.name) + '</div>';
          html += '<div class="relation-target">' + esc(f.relation || '-') + '</div>';
          html += '<div class="relation-label">' + esc(f.field_description || '') + '</div>';
          html += '</div>';
        });
        html += '</div>';
      });

      setTabContent('iliskiler', html);
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

  const observer = new MutationObserver(() => {
    const tooltip = document.querySelector('.o-tooltip');
    if (tooltip && tooltip !== currentTooltip) {
      currentTooltip = tooltip;
      const tooltipText = extractTooltipText(tooltip);
      showPanel(tooltipText);

      const { modelName, fieldName } = parseTooltipFields(tooltip);
      lastModel = modelName;
      lastField = fieldName;
      if (modelName && fieldName) {
        fetchGenelInfo(modelName, fieldName);
        fetchTeknikInfo(modelName, fieldName);
        fetchViewInfo(modelName);
        fetchErisimInfo(modelName);
        fetchIliskilerInfo(modelName);
      }

      tooltip.addEventListener('mouseenter', () => clearTimeout(hideTimer));
      tooltip.addEventListener('mouseleave', () => {
        hideTimer = setTimeout(() => { tooltip.style.display = 'none'; }, 300);
      });
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  function getTooltipIcon(target) {
    try {
      if (!target || target.nodeType !== 1) return null;
      return target.closest('[data-tooltip-template="web.FieldTooltip"]');
    } catch (e) { return null; }
  }

  document.addEventListener('mouseover', (e) => {
    const icon = getTooltipIcon(e.target);
    if (icon) { clearTimeout(hideTimer); if (currentTooltip) currentTooltip.style.display = ''; }
  }, true);

  document.addEventListener('mouseout', (e) => {
    const icon = getTooltipIcon(e.target);
    if (icon) { hideTimer = setTimeout(() => { if (currentTooltip) currentTooltip.style.display = 'none'; }, 300); }
  }, true);

  // ============================================================
  // POPUP MESAJ DINLEYICI
  // ============================================================
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
        if (id) {
          window.location.href = window.location.origin + '/web#action=' + actionId + '&model=' + model + '&view_type=form&id=' + id;
        } else {
          window.location.href = window.location.origin + '/web#action=' + actionId + '&model=' + model + '&view_type=list';
        }
      } else {
        // Action bulunamazsa dogrudan dene
        if (id) {
          window.location.href = window.location.origin + '/web#model=' + model + '&view_type=form&id=' + id;
        } else {
          window.location.href = window.location.origin + '/web#model=' + model + '&view_type=list';
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
        window.location.href = window.location.origin + '/web#action=' + actions[0].id + '&model=' + model + '&view_type=list';
      } else {
        // Action yoksa Settings > Technical > model ile dene
        window.location.href = window.location.origin + '/odoo/settings?searchText=' + encodeURIComponent(model);
      }
    });
  }
})();
