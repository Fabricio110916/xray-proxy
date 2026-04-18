import https from 'https';

const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

export default function handler(req, res) {
  const target = `http://137.131.176.224${req.url}`;

  const skip = new Set(['host','connection','transfer-encoding','content-length',
    'x-forwarded-for','x-forwarded-host','x-forwarded-proto',
    'x-vercel-id','x-vercel-cache','cdn-loop']);

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!skip.has(k.toLowerCase())) headers[k] = v;
  }
  headers.host = '137.131.176.224';

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

export const config = { api: { bodyParser: false, responseLimit: false } };
