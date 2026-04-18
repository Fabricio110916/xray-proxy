export const runtime = 'edge';

const TARGET = 'wss://my.koom.pp.ua';

const SKIP = new Set([
  'x-forwarded-host', 'x-forwarded-proto',
  'x-vercel-id', 'x-vercel-cache', 'cdn-loop',
  'content-length', 'transfer-encoding',
]);

export default async function handler(req) {
  const isWS = req.headers.get('upgrade')?.toLowerCase() === 'websocket';

  if (!isWS) {
    // HTTP normal
    const url = `https://my.koom.pp.ua${new URL(req.url).pathname}${new URL(req.url).search}`;
    const headers = new Headers();
    for (const [k, v] of req.headers.entries()) {
      if (!SKIP.has(k.toLowerCase())) headers.set(k, v);
    }
    headers.set('host', 'my.koom.pp.ua');

    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? null : req.body,
      duplex: 'half',
    }).catch(err => new Response(`Bad Gateway: ${err.message}`, { status: 502 }));

    const resHeaders = new Headers();
    for (const [k, v] of upstream.headers.entries()) {
      if (k !== 'transfer-encoding' && k !== 'content-length') resHeaders.set(k, v);
    }
    resHeaders.set('x-accel-buffering', 'no');
    resHeaders.set('cache-control', 'no-store');

    return new Response(upstream.body, {
      status: upstream.status,
      headers: resHeaders,
    });
  }

  // WebSocket — Edge runtime suporta nativamente
  const { 0: client, 1: server } = new WebSocketPair();

  server.accept();

  // Conecta ao upstream via WebSocket
  const wsUrl = `${TARGET}${new URL(req.url).pathname}${new URL(req.url).search}`;

  // Repassa headers relevantes pro handshake
  const wsHeaders = {};
  for (const [k, v] of req.headers.entries()) {
    if (!SKIP.has(k.toLowerCase()) && k !== 'upgrade' && k !== 'connection') {
      wsHeaders[k] = v;
    }
  }

  let upstream;
  try {
    upstream = new WebSocket(wsUrl, {
      headers: {
        ...wsHeaders,
        host: 'my.koom.pp.ua',
      },
    });
  } catch (err) {
    server.close(1011, 'Upstream connection failed');
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  // Cliente → Upstream
  server.addEventListener('message', (e) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(e.data);
    }
  });

  server.addEventListener('close', (e) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.close(e.code, e.reason);
    }
  });

  server.addEventListener('error', () => upstream.close());

  // Upstream → Cliente
  upstream.addEventListener('message', (e) => {
    if (server.readyState === WebSocket.OPEN) {
      server.send(e.data);
    }
  });

  upstream.addEventListener('close', (e) => {
    if (server.readyState === WebSocket.OPEN) {
      server.close(e.code, e.reason);
    }
  });

  upstream.addEventListener('error', () => server.close(1011, 'Upstream error'));

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}
