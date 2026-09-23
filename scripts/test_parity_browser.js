const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

async function main() {
  console.log('[Browser Test] Starting local HTTP server...');
  const serverProc = spawn('python3', ['-m', 'http.server', '8099'], {
    cwd: process.cwd(),
    stdio: 'ignore'
  });

  await new Promise(r => setTimeout(r, 1000));

  console.log('[Browser Test] Launching Headless Chrome with CDP...');
  const chromeProc = spawn('/usr/bin/google-chrome', [
    '--headless=new',
    '--remote-debugging-port=9222',
    '--no-sandbox',
    '--disable-gpu',
    '--incognito',
    '--disable-application-cache',
    '--disable-cache',
    'http://127.0.0.1:8099/playground/index.html'
  ], { stdio: 'ignore' });

  await new Promise(r => setTimeout(r, 2000));

  try {
    const targetsRes = await fetch('http://127.0.0.1:9222/json');
    const targets = await targetsRes.json();
    const pageTarget = targets.find(t => t.type === 'page');
    if (!pageTarget) {
      throw new Error('No page target found in Chrome CDP');
    }

    console.log('[Browser Test] Connecting to CDP WebSocket...');
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);

    let msgId = 1;
    const callbacks = new Map();

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id && callbacks.has(data.id)) {
        callbacks.get(data.id)(data);
        callbacks.delete(data.id);
      }
      if (data.method === 'Runtime.consoleAPICalled') {
        const text = data.params.args.map(a => a.value || a.description || '').join(' ');
        // Filter out noisy logs
        if (text.includes('[DEMASDriver]') || text.includes('Error')) {
          console.log(`[Browser Console] ${text}`);
        }
      }
    };

    function sendCDP(method, params = {}) {
      return new Promise((resolve) => {
        const id = msgId++;
        callbacks.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    await new Promise(r => ws.onopen = r);
    await sendCDP('Runtime.enable');
    await sendCDP('Page.enable');

    console.log('[Browser Test] Waiting 2.5s for page init...');
    await new Promise(r => setTimeout(r, 2500));

    console.log('[Browser Test] Running Geospatial Analysis in Chrome runtime...');

    const evalRes = await sendCDP('Runtime.evaluate', {
      expression: `
        (async () => {
          const results = {};
          const munCodes = ['411850', '410690'];

          for (const mun of munCodes) {
            // Fetch inputs
            const [facRes, boundRes, tractRes] = await Promise.all([
              fetch('/playground/data/' + mun + '.geojson').then(r => r.json()),
              fetch('/playground/data/boundaries/' + mun + '.geojson').then(r => r.json()),
              fetch('/playground/data/census_tracts/' + mun + '.geojson').then(r => r.json())
            ]);

            // Clear cache
            window.GeospatialAnalysis.clearMaskCache();

            // 1. Clustering
            const rawFeatures = facRes.features || [];
            const clustered = window.GeospatialAnalysis.clusterNearbyPoints(rawFeatures, 30);

            const munResult = {
              mun_code: mun,
              raw_facilities_count: rawFeatures.length,
              clustered_count: clustered.length,
              voronoi: {},
              hexbins_occupied: {},
              hexbins_full: {}
            };

            const situations = ['ambos', 'urbanos', 'rurais'];

            for (const sit of situations) {
              // 2. Voronoi
              const vor = window.GeospatialAnalysis.computeVoronoi(
                clustered, 4.0, boundRes, tractRes, 'sobrecarga', 'jenks', sit
              );

              let totalPop = 0;
              let totalDom = 0;
              let totalArea = 0;
              let pnabAdequada = 0;
              let pnabAtencao = 0;
              let pnabCritica = 0;

              (vor.features || []).forEach(f => {
                const p = f.properties || {};
                totalPop += (p.populacao_total || 0);
                totalDom += (p.domicilios_estimados || 0);
                totalArea += (p.area_km2 || 0);
                if (p.pnab_color === '#10b981') pnabAdequada++;
                else if (p.pnab_color === '#f59e0b') pnabAtencao++;
                else if (p.pnab_color === '#ef4444') pnabCritica++;
              });

              munResult.voronoi[sit] = {
                cell_count: (vor.features || []).length,
                total_pop: totalPop,
                total_dom: totalDom,
                total_area_km2: Number(totalArea.toFixed(2)),
                pnab_dist: {
                  adequada: pnabAdequada,
                  atencao: pnabAtencao,
                  critica: pnabCritica
                }
              };

              // 3. Hexbins occupied only
              const hexOcc = window.GeospatialAnalysis.computeHexbins(
                clustered, 1.0, 'continuous', boundRes, tractRes, 'count', sit, true
              );
              let hexOccPop = 0;
              let hexOccPoints = 0;
              (hexOcc.featureCollection.features || []).forEach(h => {
                hexOccPop += (h.properties.populacao_total || 0);
                hexOccPoints += (h.properties.count || 0);
              });
              munResult.hexbins_occupied[sit] = {
                cell_count: (hexOcc.featureCollection.features || []).length,
                total_pop: hexOccPop,
                total_points: hexOccPoints
              };

              // 4. Hexbins full grid
              const hexFull = window.GeospatialAnalysis.computeHexbins(
                clustered, 1.0, 'continuous', boundRes, tractRes, 'count', sit, false
              );
              let hexFullPop = 0;
              let hexFullPoints = 0;
              (hexFull.featureCollection.features || []).forEach(h => {
                hexFullPop += (h.properties.populacao_total || 0);
                hexFullPoints += (h.properties.count || 0);
              });
              munResult.hexbins_full[sit] = {
                cell_count: (hexFull.featureCollection.features || []).length,
                total_pop: hexFullPop,
                total_points: hexFullPoints
              };
            }

            results[mun] = munResult;
          }

          return results;
        })()
      `,
      awaitPromise: true,
      returnByValue: true
    });

    const resVal = evalRes.result?.result?.value || evalRes.result?.value;
    if (resVal) {
      const outputPath = path.join(__dirname, 'parity_js_results.json');
      fs.writeFileSync(outputPath, JSON.stringify(resVal, null, 2));
      console.log('[Browser Test] Wrote results to', outputPath);
    } else {
      console.error('[Browser Test] Execution returned empty result:', evalRes);
    }

  } catch (err) {
    console.error('[Browser Test Error]:', err);
  } finally {
    chromeProc.kill();
    serverProc.kill();
    process.exit(0);
  }
}

main();
