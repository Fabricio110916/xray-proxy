import https from 'https';
import http from 'http';

const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

const SKIP = new Set([
  'x-forwarded-host', 'x-forwarded-proto',
  'x-vercel-id', 'x-vercel-cache', 'cdn-loop',
  'content-length', 'transfer-encoding',
]);

export default function handler(req, res) {
  const target = `https://137.131.176.224${req.url}`;

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!SKIP.has(k.toLowerCase())) headers[k] = v;
  }
  headers['host'] = '137.131.176.224';

  // Detecta WebSocket
  const isWS = (req.headers['upgrade'] || '').toLowerCase() === 'websocket';

  if (isWS) {
    // Força headers de upgrade
    headers['upgrade'] = 'websocket';
    headers['connection'] = 'Upgrade';

    const options = {
      hostname: '137.131.176.224',
      port: 443,
      path: req.url,
      method: 'GET',
      headers,
      agent,
    };

    // Para WebSocket precisa pegar o socket raw
    const proxyReq = https.request(options);

    proxyReq.on('upgrade', (proxyRes, proxySocket, head) => {
      // Monta resposta 101 para o cliente
      let reply = 'HTTP/1.1 101 Switching Protocols\r\n';
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        reply += `${k}: ${v}\r\n`;
      }
      reply += '\r\n';

      const clientSocket = res.socket;
      clientSocket.write(reply);

      if (head && head.length) proxySocket.unshift(head);

      // Tunel bidirecional raw
      proxySocket.pipe(clientSocket);
      clientSocket.pipe(proxySocket);

      proxySocket.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => proxySocket.destroy());
      proxySocket.on('close', () => clientSocket.destroy());
      clientSocket.on('close', () => proxySocket.destroy());
    });

    proxyReq.on('error', (err) => {
      console.error('WS proxy error:', err.message);
      res.socket?.destroy();
    });

    proxyReq.end();

  } else {
    // HTTP normal com suporte a streaming
    const proxy = https.request(target, { method: req.method, headers, agent }, (upstream) => {
      const resHeaders = {};
      for (const [k, v] of Object.entries(upstream.headers)) {
        if (k !== 'transfer-encoding' && k !== 'content-length') resHeaders[k] = v;
      }
      resHeaders['transfer-encoding'] = 'chunked';
      resHeaders['x-accel-buffering'] = 'no';

      res.writeHead(upstream.statusCode, resHeaders);

      upstream.on('data', (chunk) => { if (!res.write(chunk)) upstream.pause(); });
      upstream.on('end', () => res.end());
      res.on('drain', () => upstream.resume());
      res.on('close', () => upstream.destroy());
    });

    proxy.setTimeout(280000, () => proxy.destroy());
    proxy.on('error', () => { if (!res.headersSent) res.status(502).end('Bad Gateway'); });

    req.pipe(proxy);
  }
}

export const config = { api: { bodyParser: false, responseLimit: false } };
