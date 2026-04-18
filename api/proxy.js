export const config = {
  runtime: 'edge', 
};

const BLOCKED_HEADERS = new Set([
  'host', 'connection', 'x-forwarded-for',
  'x-forwarded-host', 'x-forwarded-proto',
  'x-vercel-id', 'x-vercel-cache',
  'cdn-loop', 'cf-connecting-ip',
]);

export default async function handler(req) {
  const url = new URL(req.url);
  // O alvo agora utiliza o domínio my.koom.pp.ua em vez do IP direto
  const target = https://`my.koom.pp.ua${url.pathname}${url.search}`;

  const newHeaders = new Headers();
  for (const [key, value] of req.headers.entries()) {
    if (!BLOCKED_HEADERS.has(key.toLowerCase())) {
      newHeaders.set(key, value);
    }
  }
  
  // Atualização do cabeçalho Host para coincidir com o novo domínio
  newHeaders.set('host', 'my.koom.pp.ua');
  newHeaders.set('connection', 'keep-alive');

  const init = {
    method: req.method,
    headers: newHeaders,
    redirect: 'manual',
  };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = req.body;
    init.duplex = 'half'; 
  }

  try {
    const response = await fetch(target, init);

    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('X-Accel-Buffering', 'no');
    responseHeaders.set('Cache-Control', 'no-store');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });

  } catch (error) {
    console.error('Proxy error:', error.message);
    return new Response('Bad Gateway', { status: 502 });
  }
}
