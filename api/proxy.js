export const config = { runtime: 'edge' };

export default async function handler(req) {
  const url = new URL(req.url);
  url.hostname = 'my.koom.pp.ua'; // domínio no Cloudflare
  url.port = '443';
  url.protocol = 'https:';

  const response = await fetch(url.toString(), {
    method: req.method,
    headers: req.headers,
    body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
    duplex: 'half',
  });

  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
}
