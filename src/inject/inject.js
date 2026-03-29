// MAIN world script - Odoo RPC cagrilarini yakalar (fetch + XMLHttpRequest)
(function () {

  function isRpcUrl(url) {
    return typeof url === 'string' && (
      url.includes('/web/dataset/call_kw') ||
      url.includes('/web/action') ||
      url.includes('/web/dataset/search_read') ||
      url.includes('/web/dataset/call') ||
      url.includes('/web/webclient')
    );
  }

  function postLog(data) {
    window.postMessage({ type: 'ODOO_RPC_LOG', ...data }, window.location.origin);
  }

  function parseResultCount(text) {
    try {
      const data = JSON.parse(text);
      if (!data.result) return 0;
      if (Array.isArray(data.result)) return data.result.length;
      if (data.result.records) return data.result.records.length;
      if (data.result.length) return data.result.length;
      return 1;
    } catch (e) { return 0; }
  }

  // ============ XMLHttpRequest Intercept (Odoo 16/17 bunu kullanir) ============
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._odooUrl = url;
    this._odooMethod = method;
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const url = this._odooUrl || '';
    const startTime = performance.now();
    let parsedBody = null;

    if (isRpcUrl(url) && body) {
      try { parsedBody = JSON.parse(body); } catch (e) {}
    }

    if (parsedBody) {
      this.addEventListener('load', function () {
        const duration = Math.round(performance.now() - startTime);
        const params = parsedBody.params || {};
        const resultCount = parseResultCount(this.responseText);

        postLog({
          model: params.model || params.kwargs?.model || '-',
          method: params.method || parsedBody.method || '-',
          args: params.args ? JSON.stringify(params.args).substring(0, 200) : '',
          duration: duration,
          resultCount: resultCount,
          timestamp: Date.now(),
          url: url,
          error: this.status >= 400
        });
      });

      this.addEventListener('error', function () {
        const duration = Math.round(performance.now() - startTime);
        postLog({
          model: '-', method: 'ERROR', args: 'Network error',
          duration: duration, resultCount: 0, timestamp: Date.now(),
          url: url, error: true
        });
      });
    }

    return origSend.apply(this, arguments);
  };

  // ============ Fetch Intercept (modern Odoo versiyonlari) ============
  const originalFetch = window.fetch;

  window.fetch = function (...args) {
    const url = (args[0] && args[0].url) ? args[0].url : (typeof args[0] === 'string' ? args[0] : '');
    const startTime = performance.now();

    if (!isRpcUrl(url)) {
      return originalFetch.apply(this, args);
    }

    return originalFetch.apply(this, args).then(response => {
      const duration = Math.round(performance.now() - startTime);

      try {
        const body = args[1] && args[1].body;
        if (body) {
          const data = JSON.parse(body);
          const params = data.params || {};

          const cloned = response.clone();
          cloned.text().then(text => {
            postLog({
              model: params.model || params.kwargs?.model || '-',
              method: params.method || data.method || '-',
              args: params.args ? JSON.stringify(params.args).substring(0, 200) : '',
              duration: duration,
              resultCount: parseResultCount(text),
              timestamp: Date.now(),
              url: url
            });
          }).catch(() => {});
        }
      } catch (e) {}

      return response;
    }).catch(err => {
      const duration = Math.round(performance.now() - startTime);
      postLog({
        model: '-', method: 'ERROR', args: err.message || '',
        duration: duration, resultCount: 0, timestamp: Date.now(),
        url: url, error: true
      });
      throw err;
    });
  };
})();
