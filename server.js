/**
 * HTTPS Proxy for Chariow → WhatsApp Webhook + Analytics API
 * 
 * Deploy this on Render.com (free HTTPS).
 * It receives webhooks from Make.com and forwards them to your bot-hosting.net server.
 * ALSO handles Analytics (Chariow + Facebook) directly, to avoid Bot-Hosting upload issues.
 * 
 * Flow: Make.com (HTTPS) → This Proxy (Render.com HTTPS) → bot-hosting.net (HTTP)
 */

const http = require('http');
const https = require('https');

// === CONFIGURATION ===
const TARGET_HOST = 'fi6.bot-hosting.net';
const TARGET_PORT = 22232;
const PROXY_PORT = process.env.PORT || 10000;

// API Keys (from environment variables on Render.com)
const CHARIOW_API_KEY = process.env.CHARIOW_API_KEY || '';
const FB_ACCESS_TOKEN = process.env.FB_ACCESS_TOKEN || '';
const FB_AD_ACCOUNT_ID = process.env.FB_AD_ACCOUNT_ID || '4132886230361786';

// Helper: GET JSON from HTTPS
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// === PROXY SERVER ===
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const urlObj = new URL(req.url, `http://localhost`);
  const path = urlObj.pathname;

  // Health check
  if (req.method === 'GET' && (path === '/' || path === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      service: 'chariow-webhook-proxy',
      target: `http://${TARGET_HOST}:${TARGET_PORT}`,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // === ANALYTICS ROUTE — Handled directly on Render (no Bot-Hosting dependency) ===
  if (req.method === 'GET' && path === '/api/analytics') {
    try {
      const startDate = urlObj.searchParams.get('start') || null;
      const endDate   = urlObj.searchParams.get('end') || null;

      let totalSales = 0, totalRevenue = 0, currency = 'XOF';
      let adSpend = 0, impressions = 0, clicks = 0;

      // 1. Chariow sales (cursor-based pagination + native date filter)
      if (CHARIOW_API_KEY) {
        let cursor = null;
        let allSales = [];
        let baseUrl = 'https://api.chariow.com/v1/sales?status=completed';
        if (startDate && endDate) baseUrl += `&start_date=${startDate}&end_date=${endDate}`;

        do {
          const fetchUrl = cursor ? `${baseUrl}&cursor=${cursor}` : baseUrl;
          const chariowRes = await httpsGet(
            fetchUrl.replace('https://', '') // strip, we'll rebuild below
          ).catch(() => null);

          // Re-do with proper fetch since httpsGet is simplified
          const raw = await new Promise((resolve) => {
            https.get(fetchUrl, { headers: { 'Authorization': `Bearer ${CHARIOW_API_KEY}`, 'Accept': 'application/json' } }, (r) => {
              let d = '';
              r.on('data', c => d += c);
              r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
            }).on('error', () => resolve(null));
          });

          if (raw && raw.data && Array.isArray(raw.data)) {
            allSales = allSales.concat(raw.data);
            cursor = raw.pagination?.next_cursor || null;
          } else {
            cursor = null;
          }
        } while (cursor);

        totalSales = allSales.length;
        totalRevenue = allSales.reduce((acc, sale) => acc + (sale.payment?.amount?.value || 0), 0);
        if (allSales[0]) currency = allSales[0].payment?.amount?.currency || 'XOF';
      }

      // 2. Facebook Ads spend
      if (FB_ACCESS_TOKEN && FB_AD_ACCOUNT_ID) {
        // Get FB account currency
        const fbCurrencyRes = await new Promise((resolve) => {
          const fbUrl = `https://graph.facebook.com/v19.0/act_${FB_AD_ACCOUNT_ID}?fields=currency&access_token=${FB_ACCESS_TOKEN}`;
          https.get(fbUrl, (r) => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
          }).on('error', () => resolve({}));
        });

        let fbTimeParam = 'date_preset=maximum';
        if (startDate && endDate) {
          fbTimeParam = 'time_range=' + encodeURIComponent(JSON.stringify({ since: startDate, until: endDate }));
        }

        const fbRes = await new Promise((resolve) => {
          const fbUrl = `https://graph.facebook.com/v19.0/act_${FB_AD_ACCOUNT_ID}/insights?access_token=${FB_ACCESS_TOKEN}&${fbTimeParam}&fields=spend,impressions,clicks`;
          https.get(fbUrl, (r) => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
          }).on('error', () => resolve({}));
        });

        if (fbRes?.data && fbRes.data.length > 0) {
          const rawSpend = parseFloat(fbRes.data[0].spend || 0);
          let exchangeRate = 1;
          const fbCur = fbCurrencyRes?.currency || 'USD';
          if (fbCur === 'USD' && currency === 'XOF') exchangeRate = 605;
          if (fbCur === 'EUR' && currency === 'XOF') exchangeRate = 655.957;
          adSpend = Math.round(rawSpend * exchangeRate);
          impressions = parseInt(fbRes.data[0].impressions || 0);
          clicks = parseInt(fbRes.data[0].clicks || 0);
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        analytics: {
          chariow: { sales: totalSales, revenue: totalRevenue, currency },
          facebook: { spend: adSpend, impressions, clicks },
          roas: adSpend > 0 ? (totalRevenue / adSpend).toFixed(2) : 0,
          roi_net: totalRevenue - adSpend
        }
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // Forward ALL other requests to bot-hosting.net
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    const targetPath = req.url;

    const options = {
      hostname: TARGET_HOST,
      port: TARGET_PORT,
      path: targetPath,
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Forwarded-For': req.headers['x-forwarded-for'] || req.socket.remoteAddress,
        'X-Proxy': 'chariow-webhook-proxy'
      },
      timeout: 30000
    };

    console.log(`[Proxy] ${req.method} ${targetPath} → http://${TARGET_HOST}:${TARGET_PORT}${targetPath}`);

    const proxyReq = http.request(options, (proxyRes) => {
      let responseBody = '';
      proxyRes.on('data', chunk => responseBody += chunk);
      proxyRes.on('end', () => {
        console.log(`[Proxy] ✅ Response: ${proxyRes.statusCode} - ${responseBody.substring(0, 200)}`);
        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(responseBody);
      });
    });

    proxyReq.on('error', (err) => {
      console.error(`[Proxy] ❌ Error forwarding to target: ${err.message}`);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: false, 
        error: `Proxy error: ${err.message}`,
        target: `http://${TARGET_HOST}:${TARGET_PORT}${targetPath}`
      }));
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      console.error(`[Proxy] ❌ Timeout forwarding to target`);
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Proxy timeout' }));
    });

    proxyReq.write(body);
    proxyReq.end();
  });
});

server.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║     🔀 CHARIOW WEBHOOK PROXY + ANALYTICS               ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  🌐 Listening on port: ${PROXY_PORT}`);
  console.log(`║  🎯 Forwarding to: http://${TARGET_HOST}:${TARGET_PORT}`);
  console.log(`║  📊 Analytics: GET /api/analytics`);
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
});
