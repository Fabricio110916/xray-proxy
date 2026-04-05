import https from 'https';

const agent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,          // reutiliza conexões TCP = mais velocidade
  keepAliveMsecs: 10000,
  maxSockets: 100,          // mais conexões paralelas
  maxFreeSockets: 50,
});

export default async function handler(req, res) {
  const target = `https://137.131.176.224:443${req.url}`;

  const options = {
    method: req.method,
    headers: {
      host: '137.131.176.224',
      'content-type': req.headers['content-type'] || 'application/octet-stream',
      'transfer-encoding': req.headers['transfer-encoding'] || '',
    },
    agent,
  };

  const proxyReq = https.request(target, options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
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
