/**
 * Cloudflare Worker: DEMAS / CNES Transparent CORS Proxy
 * 
 * Provides CORS headers (`Access-Control-Allow-Origin: *`) and optional edge caching
 * for the official Brazilian Ministry of Health Open Data API (apidadosabertos.saude.gov.br).
 */

const TARGET_HOST = "https://apidadosabertos.saude.gov.br";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, X-Requested-With",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request, env, ctx) {
    // 1. Handle CORS Preflight (OPTIONS)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { ...CORS_HEADERS, "Content-Type": "text/plain" },
      });
    }

    // 2. Parse target URL
    const url = new URL(request.url);
    
    // Support either direct path forwarding (e.g. /cnes/estabelecimentos?...)
    // or proxy query param (e.g. /proxy?url=...)
    let targetUrl;
    if (url.pathname.startsWith("/proxy") && url.searchParams.has("url")) {
      targetUrl = url.searchParams.get("url");
    } else {
      targetUrl = `${TARGET_HOST}${url.pathname}${url.search}`;
    }

    // Security check: only allow forwarding to saude.gov.br
    try {
      const parsed = new URL(targetUrl);
      if (!parsed.hostname.endsWith("saude.gov.br") && !parsed.hostname.endsWith("ibge.gov.br")) {
        return new Response("Forbidden: Target host not allowed", {
          status: 403,
          headers: { ...CORS_HEADERS, "Content-Type": "text/plain" },
        });
      }
    } catch {
      return new Response("Bad Request: Invalid target URL", {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "text/plain" },
      });
    }

    // 3. Fetch from upstream API
    const forwardHeaders = new Headers();
    forwardHeaders.set("User-Agent", "demas_playground_cors_proxy/1.0 (Cloudflare Worker)");
    forwardHeaders.set("Accept", "application/json");

    try {
      const response = await fetch(targetUrl, {
        method: request.method,
        headers: forwardHeaders,
        cf: {
          // Cache successful responses at Cloudflare Edge for 1 hour
          cacheTtl: 3600,
          cacheEverything: true,
        },
      });

      // 4. Return response with CORS headers
      const responseHeaders = new Headers(response.headers);
      Object.entries(CORS_HEADERS).forEach(([k, v]) => responseHeaders.set(k, v));
      
      // Add custom proxy identification header
      responseHeaders.set("X-Proxy-By", "DEMAS-Playground-Worker");

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 502,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json",
        },
      });
    }
  },
};
