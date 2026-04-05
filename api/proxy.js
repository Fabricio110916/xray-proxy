import https from 'https';

const agent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 100,
  maxFreeSockets: 50,
});

export default async function handler(req, res) {
  const target = `https://137.131.176.224:443${req.url}`;

  // Remove headers problemáticos
  const { 
    'transfer-encoding': _te,
    'content-length': _cl,
    host: _host,
    ...safeHeaders 
  } = req.headers;

  const options = {
    method: req.method,
    headers: {
      ...safeHeaders,
      host: '137.131.176.224',
    },
    agent,
  };

  const proxyReq = https.request(target, options, (proxyRes) => {
    // Remove também da resposta
    const { 'transfer-encoding': _te2, ...safeResHeaders } = proxyRes.headers;
    res.writeHead(proxyRes.statusCode, safeResHeaders);
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
};export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
  },
};
