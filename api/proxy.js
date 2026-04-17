import https from 'https';

const TARGET_HOST = '137.131.176.224';
const TARGET_BASE = `https://${TARGET_HOST}:443`;

const agent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 30000,
  scheduling: 'fifo',
});

const BLOCKED_REQ_HEADERS = new Set([
  'host', 'connection', 'keep-alive',
  'transfer-encoding', 'content-length',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  'x-vercel-id', 'x-vercel-cache',
  'cdn-loop', 'cf-connecting-ip',
]);

const BLOCKED_RES_HEADERS = new Set([
  'transfer-encoding', 'connection',
  'keep-alive', 'content-length',
]);

// Detecta se é streaming longo (download de pacotes IP)
// Autenticação é sempre POST — não deve ter heartbeat
function isLongStream(req, resHeaders) {
  if (req.method === 'POST') return false; // auth/upload nunca é stream longo
  if (req.method !== 'GET') return false;

  const ct = (resHeaders['content-type'] || '').toLowerCase();
  // stream longo tem content-type de bytes ou sem content-length definido
  return (
    ct.includes('octet-stream') ||
    ct.includes('stream') ||
    !resHeaders['content-length']
  );
}

export default async function handler(req, res) {
  const target = `${TARGET_BASE}${req.url}`;

  const cleanHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!BLOCKED_REQ_HEADERS.has(k.toLowerCase())) {
      cleanHeaders[k] = v;
    }
  }

  const options = {
    method: req.method,
    headers: {
      ...cleanHeaders,
      host: TARGET_HOST,
      connection: 'keep-alive',
    },
    agent,
  };

  let settled = false;
  let heartbeatInterval = null;

  const cleanup = () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  };

  const proxyReq = https.request(target, options, (proxyRes) => {
    if (settled) { proxyRes.resume(); return; }
    settled = true;

    const safeHeaders = {};
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (!BLOCKED_RES_HEADERS.has(k.toLowerCase())) {
        safeHeaders[k] = v;
      }
    }

    const streaming = isLongStream(req, proxyRes.headers);

    if (streaming) {
      // Só força chunked em streams longos
      safeHeaders['Transfer-Encoding'] = 'chunked';
      safeHeaders['Content-Type'] = safeHeaders['Content-Type'] || 'application/octet-stream';
    } else {
      // Resposta normal (auth, upload) — deixa o content-length original se existir
      if (proxyRes.headers['content-length']) {
        safeHeaders['Content-Length'] = proxyRes.headers['content-length'];
      }
    }

    safeHeaders['X-Accel-Buffering'] = 'no';
    safeHeaders['Cache-Control'] = 'no-store, no-cache';

    res.writeHead(proxyRes.statusCode, safeHeaders);

    if (streaming) {
      heartbeatInterval = setInterval(() => {
        if (!res.writableEnded) {
          try { res.write(''); } catch { cleanup(); }
        } else {
          cleanup();
        }
      }, 5000);

      proxyRes.on('data', (chunk) => {
        if (!res.writableEnded) {
          try { res.write(chunk); } catch (err) {
            console.error('stream write error:', err.message);
            cleanup();
            if (!proxyRes.destroyed) proxyRes.destroy();
          }
        }
      });

      proxyRes.on('end', () => {
        cleanup();
        if (!res.writableEnded) res.end();
      });

    } else {
      // Auth/upload: pipe simples, sem heartbeat, fecha corretamente
      proxyRes.pipe(res, { end: true });
    }

    proxyRes.on('error', (err) => {
      console.error('proxyRes error:', err.message);
      cleanup();
      if (!res.writableEnded) res.end();
    });

    res.on('close', () => {
      cleanup();
      if (!proxyRes.destroyed) proxyRes.destroy();
    });
  });

  proxyReq.setTimeout(20000, () => {
    if (!settled) {
      settled = true;
      cleanup();
      proxyReq.destroy(new Error('upstream timeout'));
    }
  });

  proxyReq.on('socket', (socket) => {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30000);
  });

  proxyReq.on('error', (err) => {
    console.error('proxyReq error:', err.code, err.message);
    cleanup();
    if (settled) return;
    settled = true;

    const status = err.message.includes('timeout') ? 504 : 502;
    const msg = err.message.includes('timeout') ? 'Gateway Timeout' : 'Bad Gateway';
    if (!res.headersSent) res.status(status).end(msg);
    else if (!res.writableEnded) res.end();
  });

  req.on('error', (err) => {
    console.error('client req error:', err.message);
    cleanup();
    if (!proxyReq.destroyed) proxyReq.destroy();
  });

  req.on('close', () => {
    cleanup();
    if (!settled && !proxyReq.destroyed) proxyReq.destroy();
  });

  req.pipe(proxyReq, { end: true });
}

export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
  },
};
