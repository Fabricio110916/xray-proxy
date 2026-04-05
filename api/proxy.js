// api/proxy.js — versão Edge otimizada
export const config = { runtime: 'edge' };

export default async function handler(req) {
  const target = new URL(req.url);
  target.hostname = '137.131.176.224';
  target.port = '443';
  target.protocol = 'https:';

  const response = await fetch(target.toString(), {
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
