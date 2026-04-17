export const runtime = 'edge';

const TARGET_HOST = '137.131.176.224';
const TARGET_BASE = `https://${TARGET_HOST}:443`;

const BLOCKED_REQ_HEADERS = new Set([
  'host', 'connection', 'keep-alive',
  'transfer-encoding', 'content-length',
  'x-forwarded-host', 'x-forwarded-proto',
  'x-vercel-id', 'x-vercel-cache',
  'cdn-loop', 'cf-connecting-ip',
]);

const BLOCKED_RES_HEADERS = new Set([
  'transfer-encoding', 'connection', 'keep-alive', 'content-length',
]);

export default async function handler(req) {
  const url = `${TARGET_BASE}${new URL(req.url).pathname}${new URL(req.url).search}`;

  // Limpa headers
  const cleanHeaders = new Headers();
  for (const [k, v] of req.headers.entries()) {
    if (!BLOCKED_REQ_HEADERS.has(k.toLowerCase())) {
      cleanHeaders.set(k, v);
    }
  }
  cleanHeaders.set('host', TARGET_HOST);
  cleanHeaders.set('connection', 'keep-alive');
  cleanHeaders.set('x-real-ip', req.headers.get('x-forwarded-for') || '');
  cleanHeaders.set('x-forwarded-for', req.headers.get('x-forwarded-for') || '');

  const isStreaming = req.method === 'GET';

  let upstreamRes;
  try {
    upstreamRes = await fetch(url, {
      method: req.method,
      headers: cleanHeaders,
      body: ['GET', 'HEAD'].includes(req.method) ? null : req.body,
      // Crítico: não bufferiza — mantém o stream aberto
      duplex: 'half',
    });
  } catch (err) {
    return new Response(`Bad Gateway: ${err.message}`, { status: 502 });
  }

  // Limpa headers da resposta
  const resHeaders = new Headers();
  for (const [k, v] of upstreamRes.headers.entries()) {
    if (!BLOCKED_RES_HEADERS.has(k.toLowerCase())) {
      resHeaders.set(k, v);
    }
  }

  resHeaders.set('X-Accel-Buffering', 'no');
  resHeaders.set('Cache-Control', 'no-store, no-cache');

  if (isStreaming) {
    resHeaders.set('Content-Type', resHeaders.get('Content-Type') || 'application/octet-stream');

    // TransformStream com heartbeat — mantém vivo sem interferir nos dados
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    const pump = async () => {
      const reader = upstreamRes.body.getReader();
      
      // Heartbeat a cada 15s
      const heartbeat = setInterval(async () => {
        try {
          await writer.write(new Uint8Array(0));
        } catch {
          clearInterval(heartbeat);
        }
      }, 15000);

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
      } catch (err) {
        console.error('stream pump error:', err.message);
      } finally {
        clearInterval(heartbeat);
        try { await writer.close(); } catch {}
      }
    };

    // Roda em background sem bloquear o retorno da Response
    pump();

    return new Response(readable, {
      status: upstreamRes.status,
      headers: resHeaders,
    });

  } else {
    // POST (auth/upload): resposta simples, sem stream
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: resHeaders,
    });
  }
}
