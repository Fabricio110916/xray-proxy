import https from 'https';

const TARGET_HOST = '137.131.176.224';
const TARGET_BASE = `https://${TARGET_HOST}:443`;
const REQUEST_TIMEOUT_MS = 25000;

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
  'transfer-encoding', 'content-length',  // recalculado automaticamente
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  'x-vercel-id', 'x-vercel-cache',
  'cdn-loop', 'cf-connecting-ip',
]);

const BLOCKED_RES_HEADERS = new Set([
  'transfer-encoding', 'connection', 'keep-alive',
]);

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

  const proxyReq = https.request(target, options, (proxyRes) => {
    if (settled) {
      proxyRes.resume();
      return;
    }
    settled = true;

    // Filtra headers problemáticos da resposta
    const safeHeaders = {};
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (!BLOCKED_RES_HEADERS.has(k.toLowerCase())) {
        safeHeaders[k] = v;
      }
    }
    safeHeaders['X-Accel-Buffering'] = 'no';
    safeHeaders['Cache-Control'] = 'no-store';

    res.writeHead(proxyRes.statusCode, safeHeaders);

    proxyRes.on('error', (err) => {
      console.error('proxyRes stream error:', err.message);
      if (!res.writableEnded) res.end();
    });

    proxyRes.pipe(res, { end: true });

    res.on('close', () => {
      if (!proxyRes.destroyed) proxyRes.destroy();
    });
  });

  // Timeout correto para https.request
  proxyReq.setTimeout(REQUEST_TIMEOUT_MS, () => {
    if (!settled) {
      settled = true;
      proxyReq.destroy(new Error('upstream timeout'));
    }
  });

  proxyReq.on('socket', (socket) => {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30000);
  });

  proxyReq.on('error', (err) => {
    console.error('proxyReq error:', err.code, err.message);
    if (settled) return;
    settled = true;

    const status = err.message.includes('timeout') ? 504 : 502;
    const msg = err.message.includes('timeout') ? 'Gateway Timeout' : 'Bad Gateway';

    if (!res.headersSent) res.status(status).end(msg);
    else if (!res.writableEnded) res.end();
  });

  req.on('error', (err) => {
    console.error('client req error:', err.message);
    if (!proxyReq.destroyed) proxyReq.destroy();
  });

  req.on('close', () => {
    // Cliente desconectou — libera o socket upstream
    if (!settled && !proxyReq.destroyed) {
      proxyReq.destroy();
    }
  });

  req.pipe(proxyReq, { end: true });
}

export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
  },
};
