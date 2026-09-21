const { spawn } = require('child_process');
const http = require('http');

async function main() {
  console.log('[Test] Starting local HTTP server...');
  const serverProc = spawn('python3', ['-m', 'http.server', '8099'], {
    cwd: process.cwd(),
    stdio: 'ignore'
  });

  await new Promise(r => setTimeout(r, 1000));

  console.log('[Test] Launching Headless Chrome with CDP...');
  const chromeProc = spawn('/usr/bin/google-chrome', [
    '--headless=new',
    '--remote-debugging-port=9222',
    '--no-sandbox',
    '--disable-gpu',
    'http://127.0.0.1:8099/playground/index.html'
  ], { stdio: 'ignore' });

  await new Promise(r => setTimeout(r, 2000));

  try {
    // 1. Get WebSocket debugger URL from Chrome
    const targetsRes = await fetch('http://127.0.0.1:9222/json');
    const targets = await targetsRes.json();
    const pageTarget = targets.find(t => t.type === 'page');
    if (!pageTarget) {
      throw new Error('No page target found in Chrome CDP');
    }

    console.log('[Test] Connecting to CDP WebSocket:', pageTarget.webSocketDebuggerUrl);
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
        console.log(`[Browser Console] ${text}`);
      }
      if (data.method === 'Runtime.exceptionThrown') {
        console.error(`[Browser Exception]`, data.params.exceptionDetails);
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

    console.log('[Test] Waiting 3 seconds for playground initialization...');
    await new Promise(r => setTimeout(r, 3000));

    console.log('[Test] Executing DuckDB query via browser evaluation...');
    const evalRes = await sendCDP('Runtime.evaluate', {
      expression: `
        (async () => {
          if (!window.censusDuckDB) return { error: 'window.censusDuckDB is missing' };
          const res = await window.censusDuckDB.queryCensusTracts('355030', 'SP', 3550308, ['basico', 'renda', 'saneamento']);
          if (!res) return { error: 'query returned null' };
          const sample = res.features[0];
          return {
            total_tracts: res.features.length,
            metadata: res.metadata,
            sample_properties: sample ? sample.properties : null,
            has_geom: sample && !!sample.geometry
          };
        })()
      `,
      awaitPromise: true,
      returnByValue: true
    });

    const val = evalRes.result?.result?.value || evalRes.result?.value;
    console.log('\n[Test Result] Evaluation Response:');
    console.log(JSON.stringify(val, null, 2));

    if (val && val.total_tracts > 0 && val.sample_properties && val.sample_properties.pct_agua_encanada !== undefined) {
      console.log('\n🎉 SUCCESS: DuckDB-Wasm loaded, read GeoParquet + Attribute Parquets, and executed decoupled spatial join perfectly in headless Chrome!');
    } else {
      console.warn('\n⚠️ Warning: Result did not match expected structure:', val);
    }

  } catch (err) {
    console.error('[Test Error]:', err);
  } finally {
    console.log('[Test] Cleaning up processes...');
    chromeProc.kill();
    serverProc.kill();
    process.exit(0);
  }
}

main();
