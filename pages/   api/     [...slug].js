import https from 'https';

const TARGET_HOST = '137.131.176.224';
const TARGET_BASE = `https://${TARGET_HOST}:443`;

const agent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
  scheduling: 'fifo',
});

const BLOCKED_REQ_HEADERS = new Set([
  'host', 'connection', 'keep-alive',
  'transfer-encoding', 'content-length',
  'x-forwarded-host', 'x-forwarded-proto',
  'x-vercel-id', 'x-vercel-cache',
  'cdn-loop', 'cf-connecting-ip',
]);

const BLOCKED_RES_HEADERS = new Set([
  'transfer-encoding', 'connection', 'keep-alive', 'content-length',
]);

function isLongStream(req, resHeaders) {
  if (req.method === 'POST') return false;
  if (req.method !== 'GET') return false;
  const ct = (resHeaders['content-type'] || '').toLowerCase();
  return ct.includes('octet-stream') || ct.includes('stream') || !resHeaders['content-length'];
}

export default async function handler(req, res) {
  // Reconstrói o path original removendo o prefixo /api
  const path = '/' + (req.query.slug || []).join('/');
  const qs = new URL(req.url, 'http://localhost').search;
  const target = `${TARGET_BASE}${path}${qs}`;

  const cleanHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!BLOCKED_REQ_HEADERS.has(k.toLowerCase())) {
      cleanHeaders[k] = v;
    }
  }

  const xfwd = req.headers['x-forwarded-for'] || '';
  const options = {
    method: req.method,
    headers: {
      ...cleanHeaders,
      host: TARGET_HOST,
      connection: 'keep-alive',
      ...(xfwd && { 'x-real-ip': xfwd, 'x-forwarded-for': xfwd }),
    },
    agent,
  };

  let settled = false;
  let heartbeatInterval = null;

  const cleanup = () => {
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  };

  const proxyReq = https.request(target, options, (proxyRes) => {
    if (settled) { proxyRes.resume(); return; }
    settled = true;

    const safeHeaders = {};
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (!BLOCKED_RES_HEADERS.has(k.toLowerCase())) safeHeaders[k] = v;
    }

    const streaming = isLongStream(req, proxyRes.headers);

    if (streaming) {
      safeHeaders['Transfer-Encoding'] = 'chunked';
      safeHeaders['Content-Type'] = safeHeaders['Content-Type'] || 'application/octet-stream';
      safeHeaders['X-Accel-Buffering'] = 'no';
      safeHeaders['Cache-Control'] = 'no-store, no-cache';

      res.writeHead(proxyRes.statusCode, safeHeaders);

      proxyRes.on('data', (chunk) => {
        const ok = res.write(chunk);
        if (!ok) { proxyRes.pause(); res.once('drain', () => proxyRes.resume()); }
      });

      proxyRes.on('end', () => { cleanup(); if (!res.writableEnded) res.end(); });

      heartbeatInterval = setInterval(() => {
        if (res.writableEnded) { cleanup(); return; }
        if (!res.writableNeedDrain) try { res.write(Buffer.alloc(0)); } catch { cleanup(); }
      }, 15000);

    } else {
      safeHeaders['X-Accel-Buffering'] = 'no';
      if (proxyRes.headers['content-length']) safeHeaders['Content-Length'] = proxyRes.headers['content-length'];
      res.writeHead(proxyRes.statusCode, safeHeaders);
      proxyRes.pipe(res, { end: true });
    }

    proxyRes.on('error', (err) => { console.error('proxyRes:', err.message); cleanup(); if (!res.writableEnded) res.end(); });
    res.on('close', () => { cleanup(); if (!proxyRes.destroyed) proxyRes.destroy(); });
  });

  proxyReq.setTimeout(280000, () => {
    if (!settled) { settled = true; cleanup(); proxyReq.destroy(new Error('timeout')); }
  });

  proxyReq.on('socket', (socket) => {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30000);
  });

  proxyReq.on('error', (err) => {
    cleanup();
    if (settled) return;
    settled = true;
    const status = err.message.includes('timeout') ? 504 : 502;
    const msg = err.message.includes('timeout') ? 'Gateway Timeout' : 'Bad Gateway';
    if (!res.headersSent) res.status(status).end(msg);
    else if (!res.writableEnded) res.end();
  });

  req.on('error', (err) => { cleanup(); if (!proxyReq.destroyed) proxyReq.destroy(); });
  req.on('close', () => { cleanup(); if (!settled && !proxyReq.destroyed) proxyReq.destroy(); });

  proxyReq.on('drain', () => req.resume());
  req.on('data', (chunk) => { if (!proxyReq.write(chunk)) req.pause(); });
  req.on('end', () => proxyReq.end());
}

export const config = {
  api: { bodyParser: false, responseLimit: false },
};
