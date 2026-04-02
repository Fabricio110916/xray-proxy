import https from 'https';
import http from 'http';

const agent = new https.Agent({ rejectUnauthorized: false });

export default async function handler(req, res) {
  const target = `https://137.131.176.224:443${req.url}`;

  const options = {
    method: req.method,
    headers: {
      ...req.headers,
      host: '137.131.176.224',
    },
    agent,
  };

  const proxyReq = https.request(target, options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy error:', err);
    res.status(502).end('Bad Gateway');
  });

  req.pipe(proxyReq, { end: true });
}

export const config = {
  api: {
    bodyParser: false,    // necessário para streaming raw
    responseLimit: false, // sem limite de tamanho
  },
};
