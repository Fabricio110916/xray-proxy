import https from 'https';

const agent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,        // reutiliza conexões TCP
  keepAliveMsecs: 10000,
  maxSockets: 100,        // conexões paralelas
  maxFreeSockets: 50,
  timeout: 60000,         // 60s timeout
});

export default async function handler(req, res) {
  const target = `https://137.131.176.224:443${req.url}`;

  const options = {
    method: req.method,
    headers: {
      ...req.headers,
      host: '137.131.176.224',
      connection: 'keep-alive', // força reuso de conexão
    },
    agent,
    timeout: 60000,
  };

  const proxyReq = https.request(target, options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) res.status(504).end('Gateway Timeout');
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy error:', err.message);
    if (!res.headersSent) res.status(502).end('Bad Gateway');
  });

  req.pipe(proxyReq, { end: true });
}

export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
  },
};
