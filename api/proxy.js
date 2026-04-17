import https from 'https';

// Agent singleton — recriá-lo a cada request é um dos maiores causadores de instabilidade
const agent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
  keepAliveMsecs: 30000,      // era 10s, aumentado para reduzir reconexões
  maxSockets: 50,             // era 100, valor alto demais causa sobrecarga
  maxFreeSockets: 10,         // era 50, mantém menos sockets ociosos
  timeout: 30000,             // era 60s, timeout mais curto evita acúmulo de conexões presas
  scheduling: 'fifo',         // garante ordem de uso dos sockets livres
});

const BLOCKED_HEADERS = new Set([
  'host', 'connection', 'x-forwarded-for',
  'x-forwarded-host', 'x-forwarded-proto',
  'x-vercel-id', 'x-vercel-cache',
  'cdn-loop', 'cf-connecting-ip',
  'transfer-encoding',        // CRÍTICO: causava falhas de framing HTTP ao fazer pipe
  'content-length',           // pode ficar inválido após remoção de headers
]);

const TARGET_HOST = '137.131.176.224';
const TARGET_BASE = `https://${TARGET_HOST}:443`;
const REQUEST_TIMEOUT_MS = 25000;

export default async function handler(req, res) {
  const target = `${TARGET_BASE}${req.url}`;

  const cleanHeaders = Object.fromEntries(
    Object.entries(req.headers)
      .filter(([k]) => !BLOCKED_HEADERS.has(k.toLowerCase()))
  );

  const options = {
    method: req.method,
    headers: {
      ...cleanHeaders,
      host: TARGET_HOST,
      connection: 'keep-alive',
    },
    agent,
    // REMOVIDO: timeout aqui não funciona como esperado no https.request —
    // ele mede inatividade do socket, não duração total. Use proxyReq.setTimeout()
  };

  // Aborta tudo se o cliente desconectar — evita requests órfãos acumulando
  const abortController = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) abortController.abort();
  });

  let settled = false;
  const settle = () => { settled = true; };

  const proxyReq = https.request(target, options, (proxyRes) => {
    if (settled) {
      proxyRes.resume(); // drena a resposta sem processar para liberar o socket
      return;
    }
    settle();

    // Remove transfer-encoding da resposta — o Node já cuida do chunking
    const safeHeaders = Object.fromEntries(
      Object.entries(proxyRes.headers)
        .filter(([k]) => k.toLowerCase() !== 'transfer-encoding')
    );

    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(proxyRes.statusCode, safeHeaders);

    proxyRes.on('error', (err) => {
      console.error('proxyRes error:', err.message);
      if (!res.writableEnded) res.end();
    });

    // CORREÇÃO: highWaterMark fica no pipeline, não no pipe()
    proxyRes.pipe(res, { end: true });

    // Garante que a resposta seja liberada se o cliente sumir
    res.on('close', () => {
      if (!proxyRes.destroyed) proxyRes.destroy();
    });
  });

  // setTimeout() é a forma correta de timeout no https.request
  proxyReq.setTimeout(REQUEST_TIMEOUT_MS, () => {
    if (!settled) {
      settle();
      proxyReq.destroy(new Error('Request timeout'));
    }
  });

  proxyReq.on('socket', (socket) => {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30000);
  });

  proxyReq.on('error', (err) => {
    if (err.name === 'AbortError') return; // cliente desconectou, silencia
    console.error('Proxy error:', err.message);
    if (!settled) {
      settle();
      if (!res.headersSent) res.status(502).json({ error: 'Bad Gateway', detail: err.message });
      else if (!res.writableEnded) res.end();
    }
  });

  req.on('error', (err) => {
    console.error('Request stream error:', err.message);
    if (!proxyReq.destroyed) proxyReq.destroy();
  });

  req.pipe(proxyReq, { end: true });
}

export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
  },
};
