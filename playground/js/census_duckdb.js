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
   * @param {string} [situacao='ambos'] - Territorial filter: 'ambos', 'urbanos', or 'rurais'
   * @returns {Promise<Object|null>} Standard GeoJSON FeatureCollection
   */
  async queryCensusTracts(code6, uf, id7, themes = ['basico', 'renda'], situacao = 'ambos') {
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

      let whereClause = `WHERE g.cd_mun = ${munId}`;
      if (situacao && situacao !== 'ambos') {
        const targetSit = situacao.toLowerCase().includes('urban') ? 'urban' : 'rural';
        whereClause += ` AND LOWER(b.situacao) LIKE '%${targetSit}%'`;
      }

      const sql = `
        SELECT 
          ${selectFields.join(',\n          ')}
        FROM read_parquet('${geomVirtual}') g
        ${joins.join('\n        ')}
        ${whereClause};
      `;

      console.log(`[CensusDuckDB] Executing spatial-demographic join for ${code6} (${ufUpper}, situacao=${situacao})...`);
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
          filter_situacao: situacao,
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

  inferFacilityCategory(name, amenity, healthcare) {
  const n = String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  const a = String(amenity || '').toLowerCase();
  const h = String(healthcare || '').toLowerCase();

  // 1. UPA 24h / Pronto Atendimento
  if (
    n.includes('UPA') || n.includes('PRONTO ATENDIMENTO') || n.includes('PRONTO SOCORRO') ||
    n.includes('24H') || n.includes('24 HORAS') || h.includes('emergency')
  ) {
    return 'UPA 24h';
  }

  // 2. CAPS / Saúde Mental
  if (
    n.includes('CAPS') || n.includes('PSICOSSOCIAL') || n.includes('SAUDE MENTAL') ||
    h === 'psychiatry'
  ) {
    return 'CAPS';
  }

  // 3. Hospitais / Maternidades
  if (
    n.includes('HOSPITAL') || n.includes('MATERNIDADE') || n.includes('SANTA CASA') ||
    a === 'hospital' || h === 'hospital'
  ) {
    return 'Hospital';
  }

  // 4. Farmácias Públicas / CAF
  if (
    n.includes('FARMACIA') || n.includes('CAF') || n.includes('ABASTECIMENTO FARMACEUTICO') ||
    a === 'pharmacy' || h === 'pharmacy'
  ) {
    return 'Farmácia';
  }

  // 5. SAMU / 192
  if (
    n.includes('SAMU') || n.includes('192') || n.includes('BASE DESCENTRALIZADA')
  ) {
    return 'SAMU';
  }

  // 6. Especialidades / Policlínicas / CEO / CER
  if (
    n.includes('ESPECIALIDADE') || n.includes('POLICLINICA') || n.includes('CEO') ||
    n.includes('CER ') || n.includes('REABILITACAO') || n.includes('ODONTOLOG') ||
    n.includes('FISIOTERAPIA') || a === 'dentist' ||
    ['dentist', 'diagnostic_centre', 'rehabilitation'].includes(h)
  ) {
    return 'Especialidades';
  }

  // 7. Vigilância / Gestão / Secretaria / Regulação
  if (
    n.includes('VIGILANCIA') || n.includes('SECRETARIA') || n.includes('REGULACAO') ||
    n.includes('AUDITORIA') || n.includes('CAS ') ||
    ['vaccination', 'occupational_health'].includes(h)
  ) {
    return 'Vigilância';
  }

  // 8. UBS / Atenção Básica (Default)
  if (
    n.includes('UBS') || n.includes('BASICA') || n.includes('POSTO DE SAUDE') ||
    n.includes('CENTRO DE SAUDE') || n.includes('ESF') || n.includes('ESTRATEGIA')
  ) {
    return 'UBS';
  }

  return 'UBS';
}

  /**
   * Query geocoded health facilities (polos de saúde) for any municipality in Brazil.
   * Reads from data/geoparquet/polos_saude/{UF}.parquet via HTTP Range Requests.
   * @param {string|number} code6 - 6-digit IBGE code
   * @param {string} uf - 2-letter state code
   * @returns {Promise<Object|null>} Standard GeoJSON FeatureCollection
   */
  async queryPolos(code6, uf) {
    const ready = await this.init();
    if (!ready || !this.conn) return null;

    try {
      const ufUpper = String(uf).toUpperCase();
      const munCode = parseInt(code6, 10);
      const virtualName = `polos_${ufUpper}.parquet`;
      const relativeUrl = `data/geoparquet/polos_saude/${ufUpper}.parquet`;

      const regOk = await this.registerVirtualFile(virtualName, relativeUrl);
      if (!regOk) return null;

      const sql = `
        SELECT 
          cd_mun, uf, cnes, name, amenity, healthcare,
          qtd_equipes_esf, qtd_equipes_eap, qtd_equipes_total,
          capacidade_pnab, nomes_equipes, cluster_size, clustered,
          geometry
        FROM read_parquet('${virtualName}')
        WHERE cd_mun = ${munCode};
      `;

      const t0 = performance.now();
      const arrowTable = await this.conn.query(sql);
      const queryTime = Math.round(performance.now() - t0);
      if (arrowTable.numRows === 0) return null;

      const features = [];
      const rows = arrowTable.toArray();
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        let geom = null;
        try {
          geom = parseWKB(row.geometry);
        } catch (e) {
          continue;
        }
        if (!geom) continue;

        const cat = this.inferFacilityCategory(row.name, row.amenity, row.healthcare);
        const cnesStr = String(row.cnes || '');

        features.push({
          type: 'Feature',
          id: cnesStr || String(i + 1),
          geometry: geom,
          properties: {
            cd_mun: Number(row.cd_mun),
            uf: String(row.uf),
            cnes: cnesStr,
            'ref:CNES': cnesStr,
            name: String(row.name || 'Estabelecimento de Saúde'),
            amenity: row.amenity || 'clinic',
            healthcare: row.healthcare || 'centre',
            qtd_equipes_esf: Number(row.qtd_equipes_esf || 0),
            qtd_equipes_eap: Number(row.qtd_equipes_eap || 0),
            qtd_equipes_total: Number(row.qtd_equipes_total || 0),
            capacidade_pnab: Number(row.capacidade_pnab || 0),
            nomes_equipes: String(row.nomes_equipes || ''),
            cluster_size: Number(row.cluster_size || 1),
            clustered: Boolean(row.clustered),
            comment: cat
          }
        });
      }

      console.log(`[CensusDuckDB] Loaded ${features.length} health hubs for ${code6} (${ufUpper}) in ${queryTime}ms via Parquet`);

      return {
        type: 'FeatureCollection',
        features: features,
        metadata: {
          ibge_code: munCode,
          uf: ufUpper,
          total_facilities: features.length,
          query_time_ms: queryTime,
          source: 'geoparquet_national'
        }
      };
    } catch (err) {
      console.warn('[CensusDuckDB] queryPolos failed:', err);
      return null;
    }
  }

  /**
   * Query pre-computed, Censo 2022 enriched Voronoi catchment cells for any municipality.
   * Reads from data/geoparquet/voronoi_{modalidade}/{UF}.parquet via HTTP Range Requests.
   * @param {string|number} code6 - 6-digit IBGE code
   * @param {string} uf - 2-letter state code
   * @param {string} [modalidade='ambos'] - 'ambos', 'urbanos', or 'rurais'
   * @returns {Promise<Object|null>} Standard GeoJSON FeatureCollection
   */
  async queryVoronoi(code6, uf, modalidade = 'ambos') {
    const ready = await this.init();
    if (!ready || !this.conn) return null;

    try {
      const ufUpper = String(uf).toUpperCase();
      const munCode = parseInt(code6, 10);
      let mod = String(modalidade).toLowerCase();
      if (!['ambos', 'urbanos', 'rurais'].includes(mod)) mod = 'ambos';

      const virtualName = `voronoi_${mod}_${ufUpper}.parquet`;
      const relativeUrl = `data/geoparquet/voronoi_${mod}/${ufUpper}.parquet`;

      const regOk = await this.registerVirtualFile(virtualName, relativeUrl);
      if (!regOk) return null;

      const sql = `
        SELECT 
          cd_mun, uf, facility_name, cnes,
          qtd_equipes_esf, qtd_equipes_eap, qtd_equipes_total,
          capacidade_pnab, nomes_equipes, cluster_size,
          populacao_total, domicilios, renda_per_capita,
          pct_agua_encanada, pct_esgoto_coletado,
          sobrecarga_pnab, classificacao_pnab, cor_pnab,
          area_km2, densidade_demografica, modalidade,
          geometry
        FROM read_parquet('${virtualName}')
        WHERE cd_mun = ${munCode};
      `;

      const t0 = performance.now();
      const arrowTable = await this.conn.query(sql);
      const queryTime = Math.round(performance.now() - t0);
      if (arrowTable.numRows === 0) return null;

      const features = [];
      const rows = arrowTable.toArray();
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        let geom = null;
        try {
          geom = parseWKB(row.geometry);
        } catch (e) {
          continue;
        }
        if (!geom) continue;

        features.push({
          type: 'Feature',
          geometry: geom,
          properties: {
            cd_mun: Number(row.cd_mun),
            uf: String(row.uf),
            facilityName: String(row.facility_name || ''),
            facility_name: String(row.facility_name || ''),
            cnes: String(row.cnes || ''),
            category: 'Saúde',
            hasCensusData: true,
            situacao_filtro: mod,
            qtd_equipes_esf: Number(row.qtd_equipes_esf || 0),
            qtd_equipes_eap: Number(row.qtd_equipes_eap || 0),
            qtd_equipes_total: Number(row.qtd_equipes_total || 0),
            capacidade_pnab: Number(row.capacidade_pnab || 0),
            nomes_equipes: String(row.nomes_equipes || ''),
            cluster_size: Number(row.cluster_size || 1),
            populacao_total: Number(row.populacao_total || 0),
            populacao_estimada: Number(row.populacao_total || 0),
            domicilios: Number(row.domicilios || 0),
            domicilios_estimados: Number(row.domicilios || 0),
            renda_per_capita: Number(row.renda_per_capita || 0),
            renda_per_capita_estimada: Number(row.renda_per_capita || 0),
            pct_agua_encanada: Number(row.pct_agua_encanada || 0),
            pct_esgoto_coletado: Number(row.pct_esgoto_coletado || 0),
            sobrecarga_pnab: Number(row.sobrecarga_pnab || 0),
            classificacao_pnab: String(row.classificacao_pnab || ''),
            pnab_class: String(row.classificacao_pnab || ''),
            cor_pnab: String(row.cor_pnab || '#10b981'),
            pnab_color: String(row.cor_pnab || '#10b981'),
            color: String(row.cor_pnab || '#10b981'),
            area_km2: Number(row.area_km2 || 0).toFixed(2),
            densidade_demografica: Number(row.densidade_demografica || 0).toFixed(1),
            modalidade: String(row.modalidade || mod)
          }
        });
      }

      console.log(`[CensusDuckDB] Loaded ${features.length} Voronoi cells (${mod}) for ${code6} (${ufUpper}) in ${queryTime}ms via Parquet`);

      return {
        type: 'FeatureCollection',
        features: features,
        metadata: {
          ibge_code: munCode,
          uf: ufUpper,
          modalidade: mod,
          total_cells: features.length,
          query_time_ms: queryTime,
          source: 'geoparquet_national'
        }
      };
    } catch (err) {
      console.warn('[CensusDuckDB] queryVoronoi failed:', err);
      return null;
    }
  }
}

/**
 * Lightweight WKB (Well-Known Binary) parser for Point, Polygon, and MultiPolygon geometries.
 */
function parseWKB(input) {
  if (!input) return null;
  let bytes;
  if (typeof input === 'string') {
    const hex = input.startsWith('\\x') ? input.slice(2) : input;
    bytes = new Uint8Array(hex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
  } else if (input instanceof Uint8Array) {
    bytes = input;
  } else if (Array.isArray(input)) {
    bytes = new Uint8Array(input);
  } else if (input.buffer) {
    bytes = new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength || input.length);
  } else {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  function readGeom() {
    if (offset + 5 > bytes.byteLength) return null;
    const isLittle = view.getUint8(offset) === 1;
    offset += 1;
    const type = view.getUint32(offset, isLittle);
    offset += 4;

    if (type === 1) { // Point
      const x = view.getFloat64(offset, isLittle); offset += 8;
      const y = view.getFloat64(offset, isLittle); offset += 8;
      return { type: 'Point', coordinates: [x, y] };
    } else if (type === 3) { // Polygon
      const numRings = view.getUint32(offset, isLittle); offset += 4;
      const rings = [];
      for (let r = 0; r < numRings; r++) {
        const numPts = view.getUint32(offset, isLittle); offset += 4;
        const ring = [];
        for (let p = 0; p < numPts; p++) {
          const x = view.getFloat64(offset, isLittle); offset += 8;
          const y = view.getFloat64(offset, isLittle); offset += 8;
          ring.push([x, y]);
        }
        rings.push(ring);
      }
      return { type: 'Polygon', coordinates: rings };
    } else if (type === 6) { // MultiPolygon
      const numPolys = view.getUint32(offset, isLittle); offset += 4;
      const polys = [];
      for (let p = 0; p < numPolys; p++) {
        const poly = readGeom();
        if (poly && poly.coordinates) {
          polys.push(poly.coordinates);
        }
      }
      return { type: 'MultiPolygon', coordinates: polys };
    }
    return null;
  }

  return readGeom();
}

// Export singleton instance for browser global access
window.censusDuckDB = new CensusDuckDB();
