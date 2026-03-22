/**
 * HTTPS Proxy for Chariow → WhatsApp Webhook
 * 
 * Deploy this on Render.com (free HTTPS).
 * It receives webhooks from Make.com and forwards them to your bot-hosting.net server.
 * 
 * Flow: Make.com (HTTPS) → This Proxy (Render.com HTTPS) → bot-hosting.net (HTTP)
 */

const http = require('http');

// === CONFIGURATION ===
// Your bot-hosting.net server address (HTTP)
const TARGET_HOST = 'fi6.bot-hosting.net';
const TARGET_PORT = 22232;
const PROXY_PORT = process.env.PORT || 10000; // Render.com assigns PORT automatically

// === PROXY SERVER ===
const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      service: 'chariow-webhook-proxy',
      target: `http://${TARGET_HOST}:${TARGET_PORT}`,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // Forward ALL other requests to bot-hosting.net
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    const targetPath = req.url; // Forward the same path (e.g., /webhook/chariow)

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
  console.log('║     🔀 CHARIOW WEBHOOK PROXY (HTTPS → HTTP)            ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  🌐 Listening on port: ${PROXY_PORT}`);
  console.log(`║  🎯 Forwarding to: http://${TARGET_HOST}:${TARGET_PORT}`);
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
});
