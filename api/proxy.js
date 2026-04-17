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

export default async function handler(req, res) {
  const target = `${TARGET_BASE}${req.url}`;

  const cleanHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!BLOCKED_REQ_HEADERS.has(k.toLowerCase())) {
      cleanHeaders[k] = v;
    }
  }

  // Detecta se é uma requisição de streaming longa (XHTTP tunnel)
  const isStreaming =
    req.method === 'GET' ||
    (req.headers['x-stream-mode'] === 'xhttp') ||
    req.url?.includes('/xhttp') ||
    req.url?.includes('/download');

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

    // CRÍTICO: força chunked encoding — mantém a conexão aberta no Vercel
    safeHeaders['Transfer-Encoding'] = 'chunked';
    safeHeaders['X-Accel-Buffering'] = 'no';
    safeHeaders['Cache-Control'] = 'no-store, no-cache';
    safeHeaders['Connection'] = 'keep-alive';

    // Para streaming, força content-type que o Vercel não tenta bufferizar
    if (isStreaming) {
      safeHeaders['Content-Type'] = safeHeaders['Content-Type'] || 'application/octet-stream';
    }

    res.writeHead(proxyRes.statusCode, safeHeaders);

    if (isStreaming) {
      // Heartbeat: envia chunk vazio a cada 5s para evitar timeout do Vercel
      // O XHTTP ignora bytes nulos entre pacotes IP
      heartbeatInterval = setInterval(() => {
        if (!res.writableEnded) {
          try {
            res.write(''); // chunk vazio mantém a conexão viva
          } catch {
            cleanup();
          }
        } else {
          cleanup();
        }
      }, 5000);
    }

    proxyRes.on('data', (chunk) => {
      if (!res.writableEnded) {
        try {
          res.write(chunk);
        } catch (err) {
          console.error('write error:', err.message);
          cleanup();
          if (!proxyRes.destroyed) proxyRes.destroy();
        }
      }
    });

    proxyRes.on('end', () => {
      cleanup();
      if (!res.writableEnded) res.end();
    });

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
