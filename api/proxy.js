import http2 from 'http2';

// Sessão HTTP/2 persistente — reconecta automaticamente se cair
let h2Session = null;
let sessionPromise = null;

const TARGET_HOST = '137.131.176.224';
const TARGET_URL = `https://${TARGET_HOST}`;
const REQUEST_TIMEOUT_MS = 25000;

function getSession() {
  if (h2Session && !h2Session.destroyed && !h2Session.closed) {
    return Promise.resolve(h2Session);
  }

  if (sessionPromise) return sessionPromise;

  sessionPromise = new Promise((resolve, reject) => {
    const session = http2.connect(TARGET_URL, {
      rejectUnauthorized: false,
      settings: {
        initialWindowSize: 1024 * 1024,  // 1MB flow control window
        maxConcurrentStreams: 100,
      },
    });

    session.on('connect', () => {
      console.log('HTTP/2 session established');
      h2Session = session;
      sessionPromise = null;
      resolve(session);
    });

    session.on('error', (err) => {
      console.error('H2 session error:', err.message);
      h2Session = null;
      sessionPromise = null;
      reject(err);
    });

    session.on('close', () => {
      console.warn('H2 session closed');
      h2Session = null;
      sessionPromise = null;
    });

    // GOAWAY = servidor pediu para parar de usar esta sessão
    session.on('goaway', (errorCode) => {
      console.warn('H2 GOAWAY received, code:', errorCode);
      h2Session = null;
      sessionPromise = null;
      session.destroy();
    });

    // Ping periódico para manter a sessão viva
    setInterval(() => {
      if (h2Session && !h2Session.destroyed) {
        h2Session.ping((err) => {
          if (err) {
            console.warn('H2 ping failed:', err.message);
            h2Session?.destroy();
          }
        });
      }
    }, 20000);
  });

  return sessionPromise;
}

const BLOCKED_REQ_HEADERS = new Set([
  'host', 'connection', 'keep-alive',
  'transfer-encoding', 'upgrade',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  'x-vercel-id', 'x-vercel-cache',
  'cdn-loop', 'cf-connecting-ip',
  'http2-settings',  // não pode ser encaminhado em HTTP/2
]);

const BLOCKED_RES_HEADERS = new Set([
  'connection', 'keep-alive', 'transfer-encoding',
  'upgrade', 'proxy-connection',
]);

export default async function handler(req, res) {
  let session;
  try {
    session = await getSession();
  } catch (err) {
    console.error('Failed to get H2 session:', err.message);
    return res.status(502).json({ error: 'Bad Gateway', detail: 'H2 session failed' });
  }

  // Monta headers HTTP/2 (pseudo-headers obrigatórios)
  const reqHeaders = {
    ':method': req.method,
    ':path': req.url,
    ':scheme': 'https',
    ':authority': TARGET_HOST,
  };

  // Copia headers do cliente, removendo os bloqueados
  for (const [k, v] of Object.entries(req.headers)) {
    if (!BLOCKED_REQ_HEADERS.has(k.toLowerCase())) {
      reqHeaders[k] = v;
    }
  }

  const h2Req = session.request(reqHeaders);

  // Timeout de request
  const timer = setTimeout(() => {
    if (!h2Req.destroyed) {
      h2Req.destroy(new Error('Request timeout'));
    }
  }, REQUEST_TIMEOUT_MS);

  // Se cliente desconectar, cancela o stream H2
  req.on('close', () => {
    clearTimeout(timer);
    if (!h2Req.destroyed) h2Req.destroy();
  });

  h2Req.on('response', (headers) => {
    clearTimeout(timer);

    const status = headers[':status'] ?? 502;

    // Filtra headers de resposta, remove pseudo-headers e bloqueados
    const safeHeaders = {};
    for (const [k, v] of Object.entries(headers)) {
      if (!k.startsWith(':') && !BLOCKED_RES_HEADERS.has(k.toLowerCase())) {
        safeHeaders[k] = v;
      }
    }

    safeHeaders['X-Accel-Buffering'] = 'no';
    safeHeaders['Cache-Control'] = 'no-store';

    res.writeHead(status, safeHeaders);

    h2Req.pipe(res, { end: true });

    res.on('close', () => {
      if (!h2Req.destroyed) h2Req.destroy();
    });
  });

  h2Req.on('error', (err) => {
    clearTimeout(timer);
    if (err.name === 'AbortError' || err.code === 'ERR_HTTP2_STREAM_CANCEL') return;
    console.error('H2 stream error:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Bad Gateway', detail: err.message });
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  req.on('error', (err) => {
    console.error('Client req error:', err.message);
    if (!h2Req.destroyed) h2Req.destroy();
  });

  // Pipe do body (POST/PUT etc.), mas não trava em GET/HEAD
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    req.pipe(h2Req, { end: true });
  } else {
    h2Req.end();
  }
}

export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
  },
};
