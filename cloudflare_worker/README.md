# DEMAS CORS Proxy (Cloudflare Worker)

A transparent, edge-caching reverse proxy that enables client-side web applications (such as GitHub Pages) to query the official Brazilian Ministry of Health Open Data API (`apidadosabertos.saude.gov.br`) without CORS restrictions.

## Quick Deployment (Free Tier: 100,000 requests/day)

### Option 1: Web Dashboard (No terminal needed, ~2 minutes)
1. Go to [dash.cloudflare.com](https://dash.cloudflare.com/) and navigate to **Workers & Pages** &rarr; **Overview**.
2. Click **Create Application** &rarr; **Create Worker**.
3. Name it (e.g. `demas-cors-proxy`) and click **Deploy**.
4. Click **Edit code**, paste the contents of [`worker.js`](worker.js), and click **Save and Deploy**.
5. Copy your worker URL (e.g. `https://demas-cors-proxy.<your-subdomain>.workers.dev`).
6. Paste the URL into the **DEMAS Playground** settings bar to query any of Brazil's 5,570 municipalities on demand!

---

### Option 2: Wrangler CLI
```bash
cd cloudflare_worker
npx wrangler deploy
```

---

## How It Works
- Forwards requests to `https://apidadosabertos.saude.gov.br`.
- Injects standard CORS headers: `Access-Control-Allow-Origin: *`.
- Handles `OPTIONS` preflight requests.
- Caches responses at Cloudflare's Edge (`cacheTtl: 3600`) to accelerate repeated queries and avoid overloading the government servers.
