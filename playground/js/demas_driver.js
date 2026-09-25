/**
 * demas_driver.js - JavaScript port of demas_driver for client-side and browser execution.
 * 
 * Provides:
 * 1. IBGE Localidades resolver (States and Municipalities with native CORS).
 * 2. CNES Open Data API client (with concurrency, pagination, and configurable proxy).
 * 3. OSM tag mappings and categorization into JOSM-ready GeoJSON FeatureCollection.
 */

(function (global, factory) {
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    global.DEMASDriver = factory();
  }
})(typeof window !== 'undefined' ? window : this, function () {

  const IBGE_BASE_URL = "https://servicodados.ibge.gov.br/api/v1/localidades";
  const CNES_BASE_URL = "https://apidadosabertos.saude.gov.br";

  class DEMASDriver {
    /**
     * @param {Object} options
     * @param {string} options.proxyUrl - Optional Cloudflare Worker / CORS proxy URL (e.g. 'https://my-proxy.workers.dev')
     */
    constructor(options = {}) {
      this.proxyUrl = options.proxyUrl ? options.proxyUrl.replace(/\/+$/, '') : '';
      this._statesCache = null;
      this._manifestCache = null;
      this._boundaryCache = new Map();
      this._censusTractsCache = new Map();
    }

    /**
     * Set or update the CORS proxy URL.
     * @param {string} url 
     */
    setProxyUrl(url) {
      this.proxyUrl = url ? url.replace(/\/+$/, '') : '';
    }

    /**
     * Fetch all 27 Brazilian States (UFs) from IBGE.
     * Native CORS supported.
     * @returns {Promise<Array<{id: number, sigla: string, nome: string}>>}
     */
    async fetchStates() {
      if (this._statesCache) return this._statesCache;
      const res = await fetch(`${IBGE_BASE_URL}/estados`);
      if (!res.ok) throw new Error(`Failed to fetch states from IBGE: ${res.statusText}`);
      const data = await res.json();
      data.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
      this._statesCache = data;
      return data;
    }

    /**
     * Fetch all municipalities for a specific state from IBGE.
     * Native CORS supported.
     * @param {string|number} uf - State sigla (e.g. 'PR') or IBGE ID (e.g. 41)
     * @returns {Promise<Array<{id: number, code6: number, nome: string, uf: string}>>}
     */
    async fetchMunicipalities(uf) {
      const res = await fetch(`${IBGE_BASE_URL}/estados/${uf}/municipios`);
      if (!res.ok) throw new Error(`Failed to fetch municipalities from IBGE: ${res.statusText}`);
      const data = await res.json();
      const munis = data.map(m => ({
        id7: m.id,
        code6: Math.floor(m.id / 10),
        nome: m.nome,
        uf: (m.microrregiao && m.microrregiao.mesorregiao && m.microrregiao.mesorregiao.UF)
          ? m.microrregiao.mesorregiao.UF.sigla : String(uf).toUpperCase()
      }));
      munis.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
      return munis;
    }

    /**
     * Load the pre-cached cities manifest.
     * @param {string} basePath - Path where data/manifest.json is located (default: 'data/')
     * @returns {Promise<Object>}
     */
    async loadManifest(basePath = 'data/') {
      try {
        const res = await fetch(`${basePath}manifest.json`);
        if (!res.ok) return {};
        this._manifestCache = await res.json();
        return this._manifestCache;
      } catch (err) {
        console.warn('Could not load pre-cached manifest:', err);
        return {};
      }
    }

    /**
     * Load pre-cached GeoJSON for a city.
     * @param {number|string} code6 - 6-digit IBGE code
     * @param {string} basePath - Directory containing cached files (default: 'data/')
     * @returns {Promise<Object|null>}
     */
    async loadCachedCity(code6, basePath = 'data/') {
      try {
        const res = await fetch(`${basePath}${code6}.geojson`);
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    }

    /**
     * Compute the standard 7-digit IBGE code with verification digit from a 6-digit code.
     * Incorporates known exceptions in the IBGE code table.
     * @param {number|string} code6
     * @returns {number} 7-digit IBGE code
     */
    calculateIbgeId7(code6) {
      const exceptions = {
        220191: 2201919,
        220198: 2201988,
        220225: 2202251,
        261153: 2611533,
        311783: 3117836,
        315213: 3152131,
        430587: 4305871,
        520017: 5200175,
        520077: 5200772,
      };
      const num = parseInt(code6, 10);
      if (exceptions[num]) return exceptions[num];
      const s = String(num);
      if (s.length !== 6) return num;
      const weights = [1, 2, 1, 2, 1, 2];
      let total = 0;
      for (let i = 0; i < 6; i++) {
        let prod = parseInt(s[i], 10) * weights[i];
        if (prod > 9) prod = Math.floor(prod / 10) + (prod % 10);
        total += prod;
      }
      const rem = total % 10;
      const dv = (10 - rem) % 10;
      return parseInt(`${s}${dv}`, 10);
    }

    /**
     * Fetch municipality boundary GeoJSON from local cache/preloaded files or on-demand from IBGE Malhas API.
     * @param {number|string} code6 - 6-digit IBGE code
     * @param {number|string} [id7] - Optional 7-digit IBGE code
     * @param {string} [basePath='data/'] - Base data directory
     * @returns {Promise<Object|null>} GeoJSON FeatureCollection containing municipal boundary
     */
    async fetchMunicipalityBoundary(code6, id7 = null, basePath = 'data/') {
      const key = String(code6);
      if (this._boundaryCache.has(key)) {
        return this._boundaryCache.get(key);
      }

      // 1. Try local pre-cached boundary
      try {
        const localPath = `${basePath}boundaries/${key}.geojson`;
        const res = await fetch(localPath);
        if (res.ok) {
          const data = await res.json();
          if (data && data.features && data.features.length > 0) {
            this._boundaryCache.set(key, data);
            return data;
          }
        }
      } catch (_) {
        // Fall through to on-demand fetch
      }

      // 2. Fetch on demand from official IBGE Malhas API (supports native CORS)
      const targetId7 = id7 || (this._manifestCache && this._manifestCache[key] && this._manifestCache[key].id7) || this.calculateIbgeId7(code6);
      const ibgeMalhaUrl = `https://servicodados.ibge.gov.br/api/v3/malhas/municipios/${targetId7}?formato=application/vnd.geo+json`;

      try {
        const res = await fetch(ibgeMalhaUrl);
        if (res.ok) {
          const data = await res.json();
          if (data && data.features && data.features.length > 0) {
            if (!data.features[0].properties) data.features[0].properties = {};
            data.features[0].properties.code6 = parseInt(code6, 10);
            data.features[0].properties.id7 = parseInt(targetId7, 10);
            this._boundaryCache.set(key, data);
            return data;
          }
        }
      } catch (err) {
        console.warn(`Direct IBGE Malhas fetch failed for ${targetId7}:`, err);
      }

      // 3. Fallback via proxy if configured
      if (this.proxyUrl) {
        try {
          const proxyTarget = `${this.proxyUrl}/api/v3/malhas/municipios/${targetId7}?formato=application/vnd.geo+json`;
          const res = await fetch(proxyTarget);
          if (res.ok) {
            const data = await res.json();
            if (data && data.features && data.features.length > 0) {
              this._boundaryCache.set(key, data);
              return data;
            }
          }
        } catch (proxyErr) {
          console.warn(`Proxy IBGE Malhas fetch failed for ${targetId7}:`, proxyErr);
        }
      }

      return null;
    }

    /**
     * Fetch census tracts GeoJSON for a municipality (from local cache or remote proxy).
     * @param {number|string} code6 - 6-digit IBGE code
     * @param {number|string} [id7] - 7-digit IBGE code
     * @param {string} [basePath='data/']
     * @param {Object} [options={}]
     * @param {string} [options.uf] - 2-letter state abbreviation
     * @param {Array<string>} [options.themes] - Census themes, e.g. ['basico', 'renda', 'saneamento']
     * @param {boolean} [options.useDuckDB=true] - Try DuckDB-Wasm first
     * @returns {Promise<Object|null>} GeoJSON FeatureCollection of census tracts
     */
    async fetchCensusTracts(code6, id7 = null, basePath = 'data/', options = {}) {
      const key = String(code6);
      const themes = options.themes || ['basico', 'renda', 'saneamento'];
      const cacheKey = `${key}_${themes.slice().sort().join('_')}`;
      if (this._censusTractsCache.has(cacheKey)) {
        return this._censusTractsCache.get(cacheKey);
      }
      if (this._censusTractsCache.has(key)) {
        return this._censusTractsCache.get(key);
      }

      // 1. Try DuckDB-Wasm decoupled query if available and enabled
      if (window.censusDuckDB && options.useDuckDB !== false) {
        try {
          const uf = options.uf || (this._manifestCache && this._manifestCache[key] && this._manifestCache[key].uf);
          const targetId7 = id7 || (this._manifestCache && this._manifestCache[key] && this._manifestCache[key].id7) || this.calculateIbgeId7(code6);
          if (uf) {
            const duckData = await window.censusDuckDB.queryCensusTracts(code6, uf, targetId7, themes);
            if (duckData && duckData.features && duckData.features.length > 0) {
              console.log(`[DEMASDriver] Loaded ${duckData.features.length} census tracts via DuckDB-Wasm for ${key}`);
              this._censusTractsCache.set(cacheKey, duckData);
              return duckData;
            }
          }
        } catch (duckErr) {
          console.warn('[DEMASDriver] DuckDB query failed, falling back to GeoJSON:', duckErr);
        }
      }

      // 2. Fallback to local pre-cached census tracts GeoJSON file
      try {
        const localPath = `${basePath}census_tracts/${key}.geojson`;
        const res = await fetch(localPath);
        if (res.ok) {
          const data = await res.json();
          if (data && data.features && data.features.length > 0) {
            this._censusTractsCache.set(cacheKey, data);
            return data;
          }
        }
      } catch (_) {}

      // 3. Fallback to proxy / remote if configured
      if (this.proxyUrl) {
        const targetId7 = id7 || (this._manifestCache && this._manifestCache[key] && this._manifestCache[key].id7) || this.calculateIbgeId7(code6);
        try {
          const proxyUrl = `${this.proxyUrl}/census_tracts/${targetId7}.geojson`;
          const res = await fetch(proxyUrl);
          if (res.ok) {
            const data = await res.json();
            if (data && data.features && data.features.length > 0) {
              this._censusTractsCache.set(cacheKey, data);
              return data;
            }
          }
        } catch (err) {
          console.warn(`Remote census tracts fetch failed for ${key}:`, err);
        }
      }

      return null;
    }

    /**
     * Build the request URL for a CNES endpoint, factoring in proxy if configured.
     * @private
     */
    _buildCNESUrl(endpointPath, params = {}) {
      const search = new URLSearchParams(params).toString();
      const fullPath = `${endpointPath}?${search}`;
      if (this.proxyUrl) {
        return `${this.proxyUrl}${fullPath}`;
      }
      return `${CNES_BASE_URL}${fullPath}`;
    }

    /**
     * Fetch a single page from the CNES API.
     * @param {number} municipalityCode 
     * @param {number} offset 
     * @param {number} limit 
     * @param {Object} extraParams 
     * @returns {Promise<Array>}
     */
    async fetchCNESPage(municipalityCode, offset = 0, limit = 20, extraParams = {}) {
      const params = {
        codigo_municipio: municipalityCode,
        offset: offset,
        limit: limit,
        status: 1,
        ...extraParams,
      };

      const url = this._buildCNESUrl('/cnes/estabelecimentos', params);
      
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(url, {
            headers: { 'Accept': 'application/json' },
          });
          if (!res.ok) {
            if (res.status === 404) return [];
            throw new Error(`HTTP ${res.status}`);
          }
          const data = await res.json();
          return data.estabelecimentos || [];
        } catch (err) {
          if (attempt === 2) throw err;
          await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
        }
      }
      return [];
    }

    /**
     * Accurately determine the total number of establishments in CNES using binary search.
     * @param {number} municipalityCode 
     * @param {Object} extraParams 
     * @returns {Promise<number>}
     */
    async fetchTotalRecords(municipalityCode, extraParams = {}) {
      let high = 100;
      while (true) {
        const check = await this.fetchCNESPage(municipalityCode, high, 1, extraParams);
        if (check.length > 0) {
          high *= 2;
        } else {
          break;
        }
      }

      let low = Math.floor(high / 2);
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        const check = await this.fetchCNESPage(municipalityCode, mid, 1, extraParams);
        if (check.length > 0) {
          low = mid + 1;
        } else {
          high = mid;
        }
      }

      return low;
    }

    /**
     * Concurrently fetch all establishments for a municipality with progress tracking.
     * @param {number} municipalityCode 
     * @param {Object} options
     * @param {Function} options.onProgress - Callback with { fetched, total, percent }
     * @param {number} options.concurrency - Concurrent HTTP requests (default: 8)
     * @returns {Promise<Array>}
     */
    async fetchAllEstablishments(municipalityCode, options = {}) {
      const onProgress = options.onProgress || (() => {});
      const concurrency = options.concurrency || 8;

      // 1. Fetch first page
      onProgress({ status: 'connecting', message: 'Iniciando consulta ao CNES...', percent: 5 });
      const firstPage = await this.fetchCNESPage(municipalityCode, 0, 20);
      if (!firstPage || firstPage.length === 0) {
        return [];
      }
      if (firstPage.length < 20) {
        onProgress({ fetched: firstPage.length, total: firstPage.length, percent: 100 });
        return firstPage;
      }

      // 2. Determine total records via binary search
      onProgress({ status: 'counting', message: 'Calculando total de estabelecimentos...', percent: 15 });
      const totalRecords = await this.fetchTotalRecords(municipalityCode);
      
      const allDict = new Map();
      firstPage.forEach(item => allDict.set(item.codigo_cnes, item));

      // 3. Concurrently fetch all chunks of 20
      const offsets = [];
      for (let off = 20; off < totalRecords; off += 20) {
        offsets.push(off);
      }

      let completedChunks = 0;
      const totalChunks = offsets.length;

      const fetchWorker = async (offsetQueue) => {
        while (offsetQueue.length > 0) {
          const off = offsetQueue.shift();
          try {
            const items = await this.fetchCNESPage(municipalityCode, off, 20);
            items.forEach(item => allDict.set(item.codigo_cnes, item));
          } catch (err) {
            console.warn(`Chunk at offset ${off} failed:`, err);
          }
          completedChunks++;
          const percent = Math.min(98, Math.round(20 + (completedChunks / totalChunks) * 78));
          onProgress({
            status: 'fetching',
            message: `Baixando registros: ${allDict.size} de ~${totalRecords}...`,
            fetched: allDict.size,
            total: totalRecords,
            percent: percent,
          });
        }
      };

      const queue = [...offsets];
      const workers = [];
      for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
        workers.push(fetchWorker(queue));
      }
      await Promise.all(workers);

      onProgress({
        status: 'done',
        message: `Concluído: ${allDict.size} estabelecimentos obtidos.`,
        fetched: allDict.size,
        total: allDict.size,
        percent: 100,
      });

      return Array.from(allDict.values());
    }

    /**
     * Filter records to public administration only (Natureza Jurídica 1xxx).
     * @param {Array} records 
     * @returns {Array}
     */
    filterPublicServices(records) {
      return records.filter(r => {
        const nat = String(r.descricao_natureza_juridica_estabelecimento || "");
        return nat.startsWith("1");
      });
    }

    /**
     * Format Title Case Portuguese text with standard medical acronym preservation.
     */
    formatTitleCase(text) {
      if (!text) return "";
      const lowerWords = new Set(["de", "da", "do", "das", "dos", "e", "em", "por", "para"]);
      const acronyms = {
        "UBS": "UBS", "UPA": "UPA", "ESF": "ESF", "CAPS": "CAPS", "CAPSI": "CAPSi",
        "CEO": "CEO", "CER": "CER", "CEREST": "CEREST", "COAS": "COAS", "SAMU": "SAMU",
        "SAD": "SAD", "CAF": "CAF", "CAS": "CAS", "SESA": "SESA", "SUS": "SUS",
        "LACEN": "LACEN", "PR": "PR", "SP": "SP", "RJ": "RJ", "MG": "MG", "SC": "SC",
        "RS": "RS", "BA": "BA", "DF": "DF", "24H": "24h", "24": "24", "II": "II",
        "III": "III", "IV": "IV", "192": "192"
      };

      return text.trim().split(/\s+/).map((w, i) => {
        const clean = w.toUpperCase().replace(/[,\.-]+$/, "");
        const trailing = w.slice(clean.length);
        if (acronyms[clean]) return acronyms[clean] + trailing;
        if (i > 0 && lowerWords.has(w.toLowerCase())) return w.toLowerCase();
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      }).join(" ");
    }

    /**
     * Clean and format phone number into E.164-style '+55 XX XXXXX-XXXX'.
     */
    cleanPhone(phoneStr) {
      if (!phoneStr) return "";
      let digits = String(phoneStr).replace(/\D/g, "");
      if (digits.startsWith("55")) digits = digits.slice(2);
      if (digits.startsWith("0")) digits = digits.slice(1);
      if (digits.length === 10) {
        return `+55 ${digits.slice(0, 2)} ${digits.slice(2, 6)}-${digits.slice(6)}`;
      } else if (digits.length === 11) {
        return `+55 ${digits.slice(0, 2)} ${digits.slice(2, 7)}-${digits.slice(7)}`;
      }
      return phoneStr.trim();
    }

    /**
     * Map a raw CNES establishment record into standard OSM tags and comment category.
     * Matches python `osm.py` logic.
     */
    determineCategoryAndTags(estab, muniName = "", ufSigla = "") {
      const cnes = estab.codigo_cnes;
      const tipo = estab.codigo_tipo_unidade;
      const fantasia = (estab.nome_fantasia || "").trim();
      const fantasiaUpper = fantasia.toUpperCase();
      const razao = (estab.nome_razao_social || "").trim();
      const natJur = String(estab.descricao_natureza_juridica_estabelecimento || "");
      const logr = (estab.endereco_estabelecimento || "").trim();
      const num = (estab.numero_estabelecimento || "").trim();
      const bairro = (estab.bairro_estabelecimento || "").trim();
      const cep = (estab.codigo_cep_estabelecimento || "").trim().replace(/\D/g, "");
      const tel = this.cleanPhone(estab.numero_telefone_estabelecimento);
      const email = (estab.endereco_email_estabelecimento || "").trim().toLowerCase();

      // Determine operator
      let operator = `Prefeitura Municipal de ${muniName || 'Município'}`;
      if (natJur === "1023") {
        operator = `Governo do Estado (${ufSigla || 'Estadual'})`;
      } else if (natJur === "1210") {
        operator = "Consórcio Intermunicipal de Saúde";
      }

      const tags = {
        "operator": operator,
        "operator:type": "public",
        "ref:CNES": String(cnes),
        "source": "cnes;datasus;dados_abertos_saude",
        "official_name": fantasia || razao,
      };

      if (logr) {
        let cleanStreet = logr.replace(/^RUA\s+TRAVESSA\b/i, "TRAVESSA");
        if (!/^(RUA|AVENIDA|AV\.|TRAVESSA|RODOVIA|ESTRADA|ALAMEDA|PRACA)\s+/i.test(cleanStreet)) {
          cleanStreet = `Rua ${cleanStreet}`;
        }
        tags["addr:street"] = this.formatTitleCase(cleanStreet);
      }

      if (num && !/^(S\/N|0000|0|SN)$/i.test(num)) {
        tags["addr:housenumber"] = num;
      }
      if (bairro && !/^(INTERIOR|CENTRO)$/i.test(bairro.toUpperCase())) {
        tags["addr:suburb"] = this.formatTitleCase(bairro);
      }
      if (muniName) tags["addr:city"] = muniName;
      if (ufSigla) tags["addr:state"] = ufSigla;
      tags["addr:country"] = "BR";

      if (cep.length === 8) tags["addr:postcode"] = `${cep.slice(0, 5)}-${cep.slice(5)}`;
      if (tel) tags["phone"] = tel;
      if (email && email.includes('@')) tags["email"] = email;

      let comment = "Outros";

      // Classification
      if (tipo === 1 || tipo === 2) { // Posto de Saúde / Centro de Saúde / UBS
        comment = "UBS";
        tags["amenity"] = "clinic";
        tags["healthcare"] = "clinic";
        let sub = fantasiaUpper.replace(/^(UNIDADE (BASICA|DE) SAUDE|CENTRO DE SAUDE|UBS|POSTO DE SAUDE)\s*/i, "");
        sub = this.formatTitleCase(sub || fantasia);
        tags["name"] = `Unidade Básica de Saúde ${sub}`;
        tags["short_name"] = `UBS ${sub}`;
      } else if (tipo === 20 || tipo === 73 || fantasiaUpper.includes("UPA") || fantasiaUpper.includes("PRONTO ATENDIMENTO")) {
        comment = "UPA 24h";
        tags["amenity"] = "clinic";
        tags["healthcare"] = "clinic";
        tags["emergency"] = "yes";
        tags["opening_hours"] = "24/7";
        tags["name"] = this.formatTitleCase(fantasia || "Unidade de Pronto Atendimento 24h");
        tags["short_name"] = "UPA 24h";
      } else if (tipo === 70 || fantasiaUpper.includes("CAPS")) {
        comment = "CAPS";
        tags["amenity"] = "clinic";
        tags["healthcare"] = "psychologist";
        tags["social_facility"] = "mental_health";
        tags["name"] = this.formatTitleCase(fantasia || "Centro de Atenção Psicossocial");
        tags["short_name"] = "CAPS";
      } else if (tipo === 5 || tipo === 7 || tipo === 15) { // Hospital Geral / Especializado / Unidade Mista
        comment = "Hospital Público";
        tags["amenity"] = "hospital";
        tags["healthcare"] = "hospital";
        tags["emergency"] = "yes";
        tags["name"] = this.formatTitleCase(fantasia || razao);
      } else if (tipo === 43 || fantasiaUpper.includes("FARMACIA")) {
        comment = "Farmácia Pública";
        tags["amenity"] = "pharmacy";
        tags["healthcare"] = "pharmacy";
        tags["dispensing"] = "yes";
        tags["name"] = this.formatTitleCase(fantasia || "Farmácia Municipal");
      } else if (tipo === 42 || tipo === 76 || fantasiaUpper.includes("SAMU")) {
        comment = "SAMU 192";
        tags["emergency"] = "ambulance_station";
        tags["name"] = this.formatTitleCase(fantasia || "Base SAMU 192");
        tags["short_name"] = "SAMU 192";
        tags["phone"] = "192";
      } else if (tipo === 36 || tipo === 4 || fantasiaUpper.includes("ESPECIALIDADE") || fantasiaUpper.includes("CEO") || fantasiaUpper.includes("CER")) {
        comment = "Especialidades";
        tags["amenity"] = "clinic";
        tags["healthcare"] = "clinic";
        tags["name"] = this.formatTitleCase(fantasia || "Centro de Especialidades");
      } else if (tipo === 50 || tipo === 68 || fantasiaUpper.includes("VIGILANCIA") || fantasiaUpper.includes("SECRETARIA")) {
        comment = "Vigilância / Gestão";
        tags["office"] = "government";
        tags["government"] = "healthcare";
        tags["name"] = this.formatTitleCase(fantasia || "Vigilância em Saúde");
      } else {
        tags["amenity"] = "clinic";
        tags["healthcare"] = "clinic";
        tags["name"] = this.formatTitleCase(fantasia || razao);
      }

      return { comment, tags };
    }

    /**
     * Convert an array of establishment records into a JOSM-ready GeoJSON FeatureCollection.
     * Applies coordinate jittering for coincident facilities (e.g. co-located centers).
     * @param {Array} records 
     * @param {string} muniName 
     * @param {string} ufSigla 
     * @returns {Object} GeoJSON FeatureCollection
     */
    toGeoJSON(records, muniName = "", ufSigla = "") {
      const coordGroups = new Map();
      const features = [];

      for (const estab of records) {
        const lat = parseFloat(estab.latitude_estabelecimento_decimo_grau);
        const lon = parseFloat(estab.longitude_estabelecimento_decimo_grau);

        // Validate coordinate bounds (Brazil is approximately -34 to +5 lat, -74 to -34 lon)
        if (isNaN(lat) || isNaN(lon) || lat < -35 || lat > 6 || lon < -75 || lon > -30) {
          continue;
        }

        const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
        if (!coordGroups.has(key)) coordGroups.set(key, []);
        coordGroups.get(key).push(estab);
      }

      for (const [key, group] of coordGroups.entries()) {
        const [baseLat, baseLon] = key.split(',').map(Number);
        const n = group.length;

        group.forEach((estab, idx) => {
          let lat = baseLat;
          let lon = baseLon;

          // Apply micro-offset spiral if multiple facilities share identical coordinates
          if (n > 1) {
            const angle = (2 * Math.PI * idx) / n;
            const radiusDeg = 0.00018; // ~20 meters
            lat += radiusDeg * Math.sin(angle);
            lon += radiusDeg * Math.cos(angle);
          }

          const { comment, tags } = this.determineCategoryAndTags(estab, muniName, ufSigla);

          features.push({
            type: "Feature",
            id: estab.codigo_cnes,
            geometry: {
              type: "Point",
              coordinates: [parseFloat(lon.toFixed(6)), parseFloat(lat.toFixed(6))]
            },
            properties: {
              comment: comment,
              ...tags,
            }
          });
        });
      }

      return {
        type: "FeatureCollection",
        metadata: {
          generated_by: "demas_driver.js",
          municipality: muniName,
          uf: ufSigla,
          total_features: features.length,
          timestamp: new Date().toISOString(),
        },
        features: features
      };
    }

    /**
     * Retrieve facilities for a municipality (from cache if available, or via CNES API).
     * @param {Object} query
     * @param {number} query.code6 - 6-digit IBGE code
     * @param {string} [query.name] - Municipality name
     * @param {string} [query.uf] - State sigla
     * @param {boolean} [query.publicOnly=true]
     * @param {Function} [query.onProgress]
     * @returns {Promise<Object>} GeoJSON FeatureCollection
     */
    async retrieveFacilities({ code6, name = "", uf = "", publicOnly = true, onProgress = () => {} }) {
      // 1. Try pre-cached local dataset first (covers the 27 state capitals with verified rich OSM attributes)
      onProgress({ status: 'checking_cache', message: 'Verificando cache pré-carregado...', percent: 20 });
      const cached = await this.loadCachedCity(code6);
      if (cached && cached.features && cached.features.length > 0) {
        onProgress({ status: 'cache_hit', message: `Carregado do cache: ${cached.features.length} unidades`, percent: 100 });
        return cached;
      }

      // 2. Try DuckDB-Wasm National GeoParquet (covers all 5,571 Brazilian municipalities!)
      if (window.censusDuckDB) {
        onProgress({ status: 'checking_parquet', message: 'Consultando base nacional GeoParquet (DuckDB-Wasm)...', percent: 50 });
        try {
          const parquetData = await window.censusDuckDB.queryPolos(code6, uf);
          if (parquetData && parquetData.features && parquetData.features.length > 0) {
            onProgress({ status: 'parquet_hit', message: `Carregado via GeoParquet: ${parquetData.features.length} unidades`, percent: 100 });
            return parquetData;
          }
        } catch (pqErr) {
          console.warn('[DEMASDriver] GeoParquet query failed, falling back:', pqErr);
        }
      }

      // 3. Fetch live from API via proxy if configured
      if (this.proxyUrl) {
        onProgress({ status: 'fetching_live', message: 'Consultando Ministério da Saúde via Proxy...', percent: 70 });
        let records = await this.fetchAllEstablishments(code6, { onProgress });
        
        if (publicOnly) {
          records = this.filterPublicServices(records);
        }

        return this.toGeoJSON(records, name, uf);
      }

      return { type: 'FeatureCollection', features: [] };
    }
  }

  return DEMASDriver;
});
