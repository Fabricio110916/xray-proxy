export const config = {
  runtime: 'nodejs', // mais estável pra túnel
};

export default async function handler(req, res) {
  try {
    const TARGET_HOST = 'my.koom.pp.ua';
    const TARGET_URL = `https://${TARGET_HOST}`;

    const url = new URL(req.url, `http://${req.headers.host}`);

    const targetPath = url.pathname.replace('/api/proxy', '') + url.search;
    const targetUrl = TARGET_URL + targetPath;

    const headers = { ...req.headers };

    headers['host'] = TARGET_HOST;
    headers['x-forwarded-host'] = TARGET_HOST;

    delete headers['x-vercel-id'];
    delete headers['x-vercel-deployment-url'];
    delete headers['x-vercel-forwarded-for'];

    const fetchOptions = {
      method: req.method,
      headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? req : undefined,
      redirect: 'manual',
    };

    const response = await fetch(targetUrl, fetchOptions);

    res.status(response.status);

    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== 'content-encoding') {
        res.setHeader(key, value);
      }
    });

    response.body.pipe(res);

  } catch (error) {
    res.status(502).json({
      error: 'Proxy error',
      message: error.message,
    });
  }
}
