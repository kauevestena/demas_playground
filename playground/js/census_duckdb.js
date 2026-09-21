/**
 * CensusDuckDB - Client-side analytical engine powered by DuckDB-Wasm & GeoParquet.
 * Handles decoupled spatial-demographic queries directly in the browser with WebAssembly.
 */

class CensusDuckDB {
  constructor() {
    this.duckdb = null;
    this.db = null;
    this.conn = null;
    this.isInitialized = false;
    this.initPromise = null;
    this.registeredFiles = new Set();
  }

  /**
   * Initialize DuckDB-Wasm and load the spatial extension.
   */
  async init() {
    if (this.isInitialized) return true;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        console.log('[CensusDuckDB] Initializing DuckDB-Wasm via jsDelivr CDN...');
        // Dynamic import of DuckDB-Wasm
        const duckdbModule = await import('https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.0/+esm');
        this.duckdb = duckdbModule;

        const JSDELIVR_BUNDLES = duckdbModule.getJsDelivrBundles();
        const bundle = await duckdbModule.selectBundle(JSDELIVR_BUNDLES);

        const worker = await duckdbModule.createWorker(bundle.mainWorker);
        const logger = new duckdbModule.ConsoleLogger();
        this.db = new duckdbModule.AsyncDuckDB(logger, worker);

        await this.db.instantiate(bundle.mainModule, bundle.pthreadWorker);
        this.conn = await this.db.connect();

        console.log('[CensusDuckDB] DuckDB-Wasm instantiated with native Parquet engine!');
        this.isInitialized = true;
        return true;
      } catch (err) {
        console.warn('[CensusDuckDB] Failed to initialize DuckDB-Wasm:', err);
        this.isInitialized = false;
        return false;
      }
    })();

    return this.initPromise;
  }

  /**
   * Register a local relative URL as a virtual file in DuckDB's filesystem.
   */
  async registerVirtualFile(virtualName, relativeUrl) {
    if (!this.db) return false;
    if (this.registeredFiles.has(virtualName)) return true;

    try {
      const fullUrl = new URL(relativeUrl, window.location.href).href;
      await this.db.registerFileURL(virtualName, fullUrl, this.duckdb.DuckDBDataProtocol.HTTP, false);
      this.registeredFiles.add(virtualName);
      return true;
    } catch (e) {
      console.warn(`[CensusDuckDB] Error registering virtual file ${virtualName}:`, e);
      return false;
    }
  }

  /**
   * Execute a decoupled query joining geometry with selected demographic themes.
   * @param {string|number} code6 - 6-digit IBGE code
   * @param {string} uf - 2-letter state code
   * @param {string|number} id7 - 7-digit IBGE code
   * @param {Array<string>} themes - Array of themes, e.g. ['basico', 'renda', 'saneamento']
   * @returns {Promise<Object|null>} Standard GeoJSON FeatureCollection
   */
  async queryCensusTracts(code6, uf, id7, themes = ['basico', 'renda']) {
    const ready = await this.init();
    if (!ready || !this.conn) {
      console.warn('[CensusDuckDB] Engine not available, falling back.');
      return null;
    }

    try {
      const ufUpper = String(uf).toUpperCase();
      const munId = Number(id7) || (Number(code6) * 10);
      const geomVirtual = `geom_${ufUpper}.parquet`;
      const geomPath = `data/parquet/geom/${ufUpper}.parquet`;

      // 1. Register Geometry Parquet
      const geomOk = await this.registerVirtualFile(geomVirtual, geomPath);
      if (!geomOk) return null;

      // 2. Register Thematic Attribute Parquets
      const basicoOk = await this.registerVirtualFile('censo_basico.parquet', 'data/parquet/attributes/censo_basico.parquet');
      if (!basicoOk) return null;

      let hasRenda = false;
      if (themes.includes('renda')) {
        hasRenda = await this.registerVirtualFile('censo_renda.parquet', 'data/parquet/attributes/censo_renda.parquet');
      }

      let hasSaneamento = false;
      if (themes.includes('saneamento')) {
        hasSaneamento = await this.registerVirtualFile('censo_saneamento.parquet', 'data/parquet/attributes/censo_saneamento.parquet');
      }

      // 3. Construct Dynamic SQL Query
      let selectFields = [
        'g.cd_setor',
        'b.nm_bairro',
        'b.situacao',
        'b.cd_tipo',
        'b.populacao',
        'b.domicilios',
        'b.moradores_por_domicilio',
        'b.area_km2',
        'b.densidade_demografica',
        'g.geom_json AS geojson'
      ];

      let joins = [
        `LEFT JOIN read_parquet('censo_basico.parquet') b ON g.cd_setor = b.cd_setor`
      ];

      if (hasRenda) {
        selectFields.push('r.renda_per_capita');
        joins.push(`LEFT JOIN read_parquet('censo_renda.parquet') r ON g.cd_setor = r.cd_setor`);
      }

      if (hasSaneamento) {
        selectFields.push('s.pct_agua_encanada');
        selectFields.push('s.pct_esgoto_coletado');
        selectFields.push('s.pct_coleta_lixo');
        joins.push(`LEFT JOIN read_parquet('censo_saneamento.parquet') s ON g.cd_setor = s.cd_setor`);
      }

      const sql = `
        SELECT 
          ${selectFields.join(',\n          ')}
        FROM read_parquet('${geomVirtual}') g
        ${joins.join('\n        ')}
        WHERE g.cd_mun = ${munId};
      `;

      console.log(`[CensusDuckDB] Executing spatial-demographic join for ${code6} (${ufUpper})...`);
      const t0 = performance.now();
      const arrowTable = await this.conn.query(sql);
      const queryTime = Math.round(performance.now() - t0);
      console.log(`[CensusDuckDB] Query returned ${arrowTable.numRows} rows in ${queryTime}ms`);

      if (arrowTable.numRows === 0) {
        return null;
      }

      // 4. Map Arrow RecordBatches to standard GeoJSON FeatureCollection
      const features = [];
      let totalPop = 0;

      const rows = arrowTable.toArray();
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        let geom = null;
        try {
          geom = typeof row.geojson === 'string' ? JSON.parse(row.geojson) : row.geojson;
        } catch (e) {
          continue;
        }
        if (!geom) continue;

        const pop = Number(row.populacao || 0);
        totalPop += pop;

        const props = {
          cd_setor: String(row.cd_setor),
          nm_bairro: row.nm_bairro || 'Não informado',
          situacao: row.situacao || 'Urbana',
          cd_tipo: Number(row.cd_tipo || 0),
          populacao: pop,
          domicilios: Number(row.domicilios || 0),
          moradores_por_domicilio: Number(row.moradores_por_domicilio || 0),
          area_km2: Number(row.area_km2 || 0),
          densidade_demografica: Number(row.densidade_demografica || 0),
        };

        if (row.renda_per_capita !== undefined && row.renda_per_capita !== null) {
          props.renda_per_capita = Number(row.renda_per_capita);
        }
        if (row.pct_agua_encanada !== undefined && row.pct_agua_encanada !== null) {
          props.pct_agua_encanada = Number(row.pct_agua_encanada);
          props.pct_esgoto_coletado = Number(row.pct_esgoto_coletado);
          props.pct_coleta_lixo = Number(row.pct_coleta_lixo);
        }

        features.push({
          type: 'Feature',
          id: props.cd_setor,
          properties: props,
          geometry: geom
        });
      }

      return {
        type: 'FeatureCollection',
        metadata: {
          ibge_code: Number(code6),
          uf: ufUpper,
          census_year: 2022,
          total_tracts: features.length,
          total_population: totalPop,
          engine: 'DuckDB-Wasm (Decoupled Parquet)',
          themes: themes,
          query_time_ms: queryTime
        },
        features: features
      };
    } catch (err) {
      console.warn(`[CensusDuckDB] Query failed for ${code6}:`, err);
      return null;
    }
  }
}

// Export singleton instance for browser global access
window.censusDuckDB = new CensusDuckDB();
