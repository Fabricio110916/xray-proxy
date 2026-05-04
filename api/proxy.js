export const config = {
  runtime: 'nodejs',
};

export default async function handler(req, res) {
  try {
    const TARGET = 'https://my.koom.pp.ua';

    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname.replace(/^\/api\/proxy/, '') + url.search;
    const targetUrl = TARGET + path;

    // 🔥 Headers camuflados estilo Injector
    const headers = {
      ...req.headers,
      host: 'my.koom.pp.ua',
      origin: 'https://www.google.com',
      referer: 'https://www.google.com/',
      'user-agent':
        req.headers['user-agent'] ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'x-forwarded-host': 'my.koom.pp.ua',
      'x-real-ip': req.socket?.remoteAddress || '1.1.1.1',
    };

    // limpa lixo da Vercel
    delete headers['x-vercel-id'];
    delete headers['x-vercel-forwarded-for'];

    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body:
        req.method !== 'GET' && req.method !== 'HEAD' ? req : undefined,
      redirect: 'manual',
    });

    res.status(response.status);

    response.headers.forEach((v, k) => {
      if (!['content-encoding', 'transfer-encoding'].includes(k.toLowerCase())) {
        res.setHeader(k, v);
      }
    });

    response.body.pipe(res);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
