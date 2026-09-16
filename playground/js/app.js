/**
 * app.js - Controller for DEMAS Playground
 * 
 * Handles:
 * - State (UF) and Municipality selection via IBGE API
 * - Fast loading from pre-cached datasets (all capitals + Pato Branco)
 * - On-demand querying via Cloudflare Worker proxy
 * - MapLibre GL JS map rendering and OpenFreeMap vector basemaps
 * - Hover highlight, category filters, and search
 */

document.addEventListener('DOMContentLoaded', () => {
  // 1. Color and Icon Map per Category
  const CATEGORY_STYLES = {
    'UBS': { color: '#2563eb', label: 'UBS' },
    'UPA 24h': { color: '#dc2626', label: 'UPA 24h' },
    'CAPS': { color: '#7c3aed', label: 'CAPS' },
    'Hospital': { color: '#e11d48', label: 'Hospital' },
    'Hospital Público': { color: '#e11d48', label: 'Hospital' },
    'Farmácia': { color: '#059669', label: 'Farmácia' },
    'Farmácia Pública': { color: '#059669', label: 'Farmácia' },
    'SAMU': { color: '#ea580c', label: 'SAMU 192' },
    'SAMU 192': { color: '#ea580c', label: 'SAMU 192' },
    'Especialidades': { color: '#0891b2', label: 'Especialidades' },
    'Vigilância': { color: '#4b5563', label: 'Vigilância / Gestão' },
    'Vigilância / Gestão': { color: '#4b5563', label: 'Vigilância / Gestão' },
    'Outros': { color: '#64748b', label: 'Outros' },
  };

  /**
   * Classify any facility (from pre-cached files or live CNES API) into standard categories.
   */
  function resolveCategory(props) {
    if (!props) return 'Outros';
    const comment = String(props.comment || '').trim();
    const name = String(props.name || props.official_name || '').toUpperCase();
    const amenity = String(props.amenity || '').toLowerCase();
    const healthcare = String(props.healthcare || '').toLowerCase();

    // 1. UBS / Atenção Básica
    if (
      comment.startsWith('UBS') ||
      comment.includes('Básica') ||
      comment === 'Posto de Saúde' ||
      name.startsWith('UBS') ||
      name.includes('UNIDADE BASICA') ||
      name.includes('POSTO DE SAUDE') ||
      name.includes('CENTRO DE SAUDE') ||
      name.includes('ESF ') ||
      name.includes('ESTRATEGIA SAUDE DA FAMILIA')
    ) {
      return 'UBS';
    }

    // 2. UPA / Emergência / Pronto Atendimento
    if (
      comment.startsWith('UPA') ||
      comment.includes('Pronto Atendimento') ||
      comment.includes('Urgência') ||
      comment.includes('Pronto Socorro') ||
      name.startsWith('UPA') ||
      name.includes('PRONTO ATENDIMENTO') ||
      name.includes('PRONTO SOCORRO') ||
      name.includes('24H')
    ) {
      return 'UPA 24h';
    }

    // 3. CAPS / Saúde Mental
    if (
      comment.startsWith('CAPS') ||
      comment.includes('Psicossocial') ||
      name.startsWith('CAPS') ||
      name.includes('PSICOSSOCIAL') ||
      healthcare === 'psychiatry'
    ) {
      return 'CAPS';
    }

    // 4. Hospitais / Maternidades
    if (
      comment.includes('Hospital') ||
      comment.includes('Maternidade') ||
      name.includes('HOSPITAL') ||
      name.includes('MATERNIDADE') ||
      name.includes('SANTA CASA') ||
      amenity === 'hospital' ||
      healthcare === 'hospital'
    ) {
      return 'Hospital';
    }

    // 5. Farmácias Públicas / CAF
    if (
      comment.includes('Farmácia') ||
      comment.includes('CAF') ||
      comment.includes('Abastecimento Farmacêutico') ||
      name.includes('FARMACIA') ||
      amenity === 'pharmacy' ||
      healthcare === 'pharmacy'
    ) {
      return 'Farmácia';
    }

    // 6. SAMU / Atendimento Móvel de Urgência
    if (
      comment.includes('SAMU') ||
      comment.includes('192') ||
      name.includes('SAMU') ||
      name.includes('BASE DESCENTRALIZADA')
    ) {
      return 'SAMU';
    }

    // 7. Especialidades / Policlínicas / CEO / CER
    if (
      [
        'Centro de Especialidades',
        'Odontologia (CEO)',
        'Reabilitação (CER)',
        'Reabilitação Física',
        'Saúde da Mulher & Criança',
        'Apoio Sorológico (COAS)',
        'Consórcio Intermunicipal',
        'Diagnóstico por Imagem',
        'Serviço de Atenção Domiciliar',
        'Especialidades'
      ].includes(comment) ||
      comment.includes('Especialidade') ||
      comment.includes('Policlínica') ||
      comment.includes('CEO') ||
      comment.includes('CER') ||
      comment.includes('Reabilitação') ||
      comment.includes('Odontologia') ||
      name.includes('ESPECIALIDADE') ||
      name.includes('POLICLINICA') ||
      name.includes('CEO') ||
      name.includes('CER ') ||
      name.includes('REABILITACAO') ||
      name.includes('ODONTOLOG') ||
      name.includes('FISIOTERAPIA') ||
      name.includes('CLINICA') ||
      amenity === 'dentist' ||
      healthcare === 'dentist' ||
      healthcare === 'diagnostic_centre' ||
      healthcare === 'rehabilitation'
    ) {
      return 'Especialidades';
    }

    // 8. Vigilância / Gestão / Secretaria / CAS
    if (
      [
        'Vigilância Sanitária',
        'Vigilância Epidemiológica',
        'Secretaria Municipal de Saúde',
        'Regional de Saúde (Estadual)',
        'Saúde do Trabalhador (CEREST)',
        'Auditoria e Regulação',
        'Biossegurança em Saúde',
        'Sala de Vacinas',
        'Abastecimento de Saúde (CAS)',
        'Suprimentos / Logística',
        'Vigilância / Gestão'
      ].includes(comment) ||
      comment.includes('Vigilância') ||
      comment.includes('Secretaria') ||
      comment.includes('Regulação') ||
      comment.includes('Logística') ||
      name.includes('VIGILANCIA') ||
      name.includes('SECRETARIA') ||
      name.includes('REGULACAO') ||
      name.includes('CAS ') ||
      healthcare === 'vaccination'
    ) {
      return 'Vigilância';
    }

    return 'Outros';
  }

  function matchesCategory(props, activeCat) {
    if (!activeCat || activeCat === 'ALL') return true;
    const cat = resolveCategory(props);
    if (cat === activeCat) return true;
    if ((activeCat === 'Hospital' || activeCat === 'Hospital Público') && cat === 'Hospital') return true;
    if ((activeCat === 'Farmácia' || activeCat === 'Farmácia Pública') && cat === 'Farmácia') return true;
    if ((activeCat === 'SAMU' || activeCat === 'SAMU 192') && cat === 'SAMU') return true;
    if ((activeCat === 'Vigilância' || activeCat === 'Vigilância / Gestão') && cat === 'Vigilância') return true;
    return false;
  }

  function getCategoryStyle(props) {
    const cat = resolveCategory(props);
    return CATEGORY_STYLES[cat] || CATEGORY_STYLES['Outros'];
  }

  const BASEMAPS = {
    liberty: 'https://tiles.openfreemap.org/styles/liberty',
    positron: 'https://tiles.openfreemap.org/styles/positron',
    bright: 'https://tiles.openfreemap.org/styles/bright',
  };

  // 2. State & Driver Initialization
  const DEFAULT_PROXY = 'https://demas-cors-proxy.kauemv2.workers.dev';
  const savedProxy = localStorage.getItem('demas_proxy_url') || DEFAULT_PROXY;
  const driver = new DEMASDriver({ proxyUrl: savedProxy });

  let map = null;
  let currentStyleId = 'liberty';
  let hoveredFeatureId = null;
  let currentFeatures = [];
  let currentGeojson = null;
  let activeCategory = 'ALL';
  let searchQuery = '';
  let cachedManifest = {};
  let currentCityInfo = { code6: 411850, name: 'Pato Branco', uf: 'PR' };

  // DOM Elements
  const ufSelect = document.getElementById('uf-select');
  const muniSelect = document.getElementById('muni-select');
  const searchInput = document.getElementById('search-input');
  const filterChipsContainer = document.getElementById('filter-chips');
  const facilityListContainer = document.getElementById('facility-list');
  const totalCountEl = document.getElementById('total-count');
  const visibleCountEl = document.getElementById('visible-count');
  const currentCityTitle = document.getElementById('current-city-title');
  const currentCitySubtitle = document.getElementById('current-city-subtitle');
  const exportBtn = document.getElementById('export-geojson-btn');
  const proxyBtn = document.getElementById('proxy-settings-btn');
  const proxyModal = document.getElementById('proxy-modal');
  const proxyInput = document.getElementById('proxy-input');
  const saveProxyBtn = document.getElementById('save-proxy-btn');
  const closeProxyBtn = document.getElementById('close-proxy-btn');
  const proxyNoticeModal = document.getElementById('proxy-notice-modal');
  const progressBarContainer = document.getElementById('progress-container');
  const progressBar = document.getElementById('progress-bar');
  const progressText = document.getElementById('progress-text');

  if (proxyInput) proxyInput.value = savedProxy;

  // 3. Initialize MapLibre GL
  let popup = null;
  try {
    map = new maplibregl.Map({
      container: 'map',
      style: BASEMAPS.liberty,
      center: [-52.6799, -26.2252], // Default: Pato Branco
      zoom: 13,
      minZoom: 4,
      maxZoom: 19,
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    popup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: false,
      offset: 14,
      maxWidth: '320px',
    });

    window.__demasMap = map;
  } catch (webglErr) {
    console.warn('MapLibre GL failed to initialize (WebGL unavailable or disabled):', webglErr);
    const mapEl = document.getElementById('map');
    if (mapEl) {
      mapEl.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:24px;text-align:center;color:#64748b;background:#f8fafc;">
          <div style="font-size:36px;margin-bottom:12px;">🗺️</div>
          <div style="font-weight:600;font-size:16px;color:#334155;margin-bottom:6px;">Aceleração Gráfica / WebGL Indisponível</div>
          <p style="font-size:13px;max-width:380px;line-height:1.5;">O mapa interativo requer suporte WebGL no seu navegador. Os seletores de estado, municípios, filtros, listagem e exportação JOSM continuam funcionando normalmente.</p>
        </div>
      `;
    }
    map = null;
  }

  // Layer Preservation across basemaps
  function preserveHealthLayers(currentStyle, nextStyle) {
    if (!currentStyle || !currentStyle.sources) return nextStyle;
    const sourcesToPreserve = ['health-facilities'];
    const layersToPreserve = ['health-glow', 'health-circles', 'health-labels'];

    nextStyle.sources = nextStyle.sources || {};
    for (const sId of sourcesToPreserve) {
      if (currentStyle.sources[sId]) {
        nextStyle.sources[sId] = currentStyle.sources[sId];
      }
    }

    nextStyle.layers = nextStyle.layers || [];
    for (const lId of layersToPreserve) {
      const layer = currentStyle.layers.find(l => l.id === lId);
      if (layer && !nextStyle.layers.some(l => l.id === lId)) {
        nextStyle.layers.push(layer);
      }
    }
    return nextStyle;
  }

  function addHealthLayers() {
    if (!map || map.getSource('health-facilities')) return;

    map.addSource('health-facilities', {
      type: 'geojson',
      data: currentGeojson || { type: 'FeatureCollection', features: [] },
    });

    const COLOR_MAP = {
      // UBS
      'UBS': '#2563eb',
      'UBS Prisional': '#2563eb',
      'Posto de Saúde': '#2563eb',
      
      // UPA 24h
      'UPA 24h': '#dc2626',
      'Pronto Atendimento': '#dc2626',
      
      // CAPS
      'CAPS': '#7c3aed',
      'CAPS II': '#7c3aed',
      'CAPSi (Infanto-Juvenil)': '#7c3aed',
      'CAPS III': '#7c3aed',
      'CAPS ad': '#7c3aed',
      
      // Hospital
      'Hospital Público': '#e11d48',
      'Hospital': '#e11d48',
      'Maternidade': '#e11d48',
      
      // Farmácia
      'Farmácia Pública': '#059669',
      'Farmácia': '#059669',
      'Abastecimento Farmacêutico (CAF)': '#059669',
      
      // SAMU
      'SAMU 192': '#ea580c',
      'SAMU': '#ea580c',
      
      // Especialidades
      'Especialidades': '#0891b2',
      'Centro de Especialidades': '#0891b2',
      'Odontologia (CEO)': '#0891b2',
      'Reabilitação (CER)': '#0891b2',
      'Reabilitação Física': '#0891b2',
      'Saúde da Mulher & Criança': '#0891b2',
      'Apoio Sorológico (COAS)': '#0891b2',
      'Consórcio Intermunicipal': '#0891b2',
      'Diagnóstico por Imagem': '#0891b2',
      'Serviço de Atenção Domiciliar': '#0891b2',
      
      // Vigilância / Gestão
      'Vigilância / Gestão': '#4b5563',
      'Vigilância Sanitária': '#4b5563',
      'Vigilância Epidemiológica': '#4b5563',
      'Secretaria Municipal de Saúde': '#4b5563',
      'Regional de Saúde (Estadual)': '#4b5563',
      'Saúde do Trabalhador (CEREST)': '#4b5563',
      'Auditoria e Regulação': '#4b5563',
      'Biossegurança em Saúde': '#4b5563',
      'Sala de Vacinas': '#4b5563',
      'Abastecimento de Saúde (CAS)': '#4b5563',
      'Suprimentos / Logística': '#4b5563',
      
      // Outros
      'Academia da Saúde': '#64748b',
      'Doação de Sangue (HEMEPAR)': '#64748b',
      'Outros Serviços de Saúde': '#64748b',
      'Outros': '#64748b'
    };

    const matchCircleColor = ['match', ['get', 'comment']];
    for (const [comment, color] of Object.entries(COLOR_MAP)) {
      matchCircleColor.push(comment, color);
    }
    matchCircleColor.push('#64748b');

    // Outer Glow layer
    map.addLayer({
      id: 'health-glow',
      type: 'circle',
      source: 'health-facilities',
      paint: {
        'circle-radius': [
          'case',
          ['boolean', ['feature-state', 'hover'], false],
          18,
          9
        ],
        'circle-color': matchCircleColor,
        'circle-opacity': [
          'case',
          ['boolean', ['feature-state', 'hover'], false],
          0.38,
          0.20
        ],
        'circle-blur': 0.5,
      }
    });

    // Core circle layer
    map.addLayer({
      id: 'health-circles',
      type: 'circle',
      source: 'health-facilities',
      paint: {
        'circle-radius': [
          'case',
          ['boolean', ['feature-state', 'hover'], false],
          10,
          6
        ],
        'circle-color': matchCircleColor,
        'circle-stroke-width': [
          'case',
          ['boolean', ['feature-state', 'hover'], false],
          2.5,
          1.5
        ],
        'circle-stroke-color': '#ffffff',
      }
    });

    // Text labels at higher zooms
    map.addLayer({
      id: 'health-labels',
      type: 'symbol',
      source: 'health-facilities',
      minzoom: 14.5,
      layout: {
        'text-field': ['coalesce', ['get', 'short_name'], ['get', 'name'], ''],
        'text-font': ['Open Sans Semibold', 'Noto Sans Regular'],
        'text-size': 11,
        'text-offset': [0, 1.2],
        'text-anchor': 'top',
        'text-max-width': 12,
      },
      paint: {
        'text-color': '#0f172a',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.5,
      }
    });

    // Map Event Listeners
    map.on('mouseenter', 'health-circles', (e) => {
      map.getCanvas().style.cursor = 'pointer';
      if (e.features.length > 0) {
        setHoverFeature(e.features[0].id);
        showPopup(e.features[0]);
      }
    });

    map.on('mouseleave', 'health-circles', () => {
      map.getCanvas().style.cursor = '';
      clearHoverFeature();
      popup.remove();
    });

    map.on('click', 'health-circles', (e) => {
      if (e.features.length > 0) {
        const feat = e.features[0];
        showPopup(feat);
        highlightInList(feat.id);
      }
    });
  }

  function applyCameraForCurrentCity() {
    if (!map) return;
    const codeStr = String(currentCityInfo.code6);
    if (cachedManifest[codeStr] && cachedManifest[codeStr].center) {
      map.flyTo({
        center: cachedManifest[codeStr].center,
        zoom: 12.5,
        speed: 1.2,
      });
    } else if (currentFeatures.length > 0) {
      const bounds = new maplibregl.LngLatBounds();
      currentFeatures.forEach(f => bounds.extend(f.geometry.coordinates));
      map.fitBounds(bounds, { padding: 50, maxZoom: 14.5, speed: 1.2 });
    }
  }

  if (map) {
    map.on('load', () => {
      addHealthLayers();
      if (currentGeojson && map.getSource('health-facilities')) {
        map.getSource('health-facilities').setData(currentGeojson);
      }
      applyCameraForCurrentCity();
    });
  }

  // Basemap switcher buttons
  document.querySelectorAll('.btn-basemap').forEach(btn => {
    btn.addEventListener('click', () => {
      const styleKey = btn.dataset.style;
      if (styleKey === currentStyleId) return;
      document.querySelectorAll('.btn-basemap').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentStyleId = styleKey;
      if (map) {
        map.setStyle(BASEMAPS[styleKey], {
          diff: true,
          transformStyle: preserveHealthLayers,
        });
        map.once('styledata', () => {
          updateUI();
        });
      }
    });
  });

  // Hover state handlers
  function setHoverFeature(id) {
    if (!map || !map.getSource('health-facilities')) return;
    if (hoveredFeatureId !== null) {
      map.setFeatureState({ source: 'health-facilities', id: hoveredFeatureId }, { hover: false });
    }
    hoveredFeatureId = id;
    if (id !== null) {
      map.setFeatureState({ source: 'health-facilities', id: id }, { hover: true });
    }
  }

  function clearHoverFeature() {
    if (!map || !map.getSource('health-facilities')) return;
    if (hoveredFeatureId !== null) {
      map.setFeatureState({ source: 'health-facilities', id: hoveredFeatureId }, { hover: false });
      hoveredFeatureId = null;
    }
  }

  function showPopup(feature) {
    if (!popup || !map) return;
    const coords = feature.geometry.coordinates.slice();
    const p = feature.properties;
    const catStyle = getCategoryStyle(p);

    const content = `
      <div class="popup-inner">
        <div class="popup-badge" style="background: ${catStyle.color}15; color: ${catStyle.color}; border: 1px solid ${catStyle.color}40;">
          ${p.comment || catStyle.label}
        </div>
        <h4 class="popup-title">${p.name || p.official_name || 'Sem nome'}</h4>
        <div class="popup-meta">
          <div><strong>CNES:</strong> ${p['ref:CNES'] || '—'}</div>
          <div><strong>Endereço:</strong> ${[p['addr:street'], p['addr:housenumber'], p['addr:suburb']].filter(Boolean).join(', ') || 'Não informado'}</div>
          ${p.phone ? `<div><strong>Telefone:</strong> <a href="tel:${p.phone}">${p.phone}</a></div>` : ''}
          ${p.opening_hours ? `<div><strong>Horário:</strong> ${p.opening_hours}</div>` : ''}
        </div>
      </div>
    `;

    popup.setLngLat(coords).setHTML(content).addTo(map);
  }

  function highlightInList(featureId) {
    const card = document.querySelector(`.facility-card[data-id="${featureId}"]`);
    if (card) {
      document.querySelectorAll('.facility-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  // 4. Application Initialization
  async function initApplication() {
    try {
      // 1. Load manifest of cached cities
      cachedManifest = await driver.loadManifest('data/');

      // 2. Fetch all Brazilian states from IBGE
      const states = await driver.fetchStates();
      ufSelect.innerHTML = states.map(s => `
        <option value="${s.sigla}" ${s.sigla === 'PR' ? 'selected' : ''}>
          ${s.sigla} — ${s.nome}
        </option>
      `).join('');

      // 3. Populate municipalities for default UF (PR)
      await loadMunicipalitiesForState('PR', 411850);

      // 4. Load initial city (Pato Branco)
      await loadCityData(411850, 'Pato Branco', 'PR');
    } catch (err) {
      console.error('Initialization error:', err);
    }
  }

  // Handle UF dropdown changes
  ufSelect.addEventListener('change', async () => {
    const selectedUF = ufSelect.value;
    await loadMunicipalitiesForState(selectedUF);
  });

  async function loadMunicipalitiesForState(uf, selectCode = null) {
    muniSelect.disabled = true;
    muniSelect.innerHTML = '<option value="">Carregando municípios pelo IBGE...</option>';

    try {
      const munis = await driver.fetchMunicipalities(uf);

      muniSelect.innerHTML = munis.map(m => {
        const isCached = !!cachedManifest[String(m.code6)];
        const badge = isCached ? '⚡ ' : '';
        const suffix = isCached ? ' (Pré-carregado)' : '';
        return `
          <option value="${m.code6}" data-name="${m.nome}" ${selectCode === m.code6 ? 'selected' : ''}>
            ${badge}${m.nome}${suffix}
          </option>
        `;
      }).join('');

      muniSelect.disabled = false;

      // If no selectCode specified, pick the first cached city if available, or first in list
      if (!selectCode) {
        const firstCached = munis.find(m => cachedManifest[String(m.code6)]);
        if (firstCached) {
          muniSelect.value = String(firstCached.code6);
          await loadCityData(firstCached.code6, firstCached.nome, uf);
        } else if (munis.length > 0) {
          muniSelect.value = String(munis[0].code6);
          await loadCityData(munis[0].code6, munis[0].nome, uf);
        }
      }
    } catch (err) {
      muniSelect.innerHTML = '<option value="">Erro ao carregar municípios</option>';
      console.error(err);
    }
  }

  // Handle Municipality change
  muniSelect.addEventListener('change', async () => {
    const code6 = parseInt(muniSelect.value, 10);
    const selectedOption = muniSelect.options[muniSelect.selectedIndex];
    const name = selectedOption.dataset.name || selectedOption.text.replace(/^[⚡\s]+/, '').replace(/\s*\(Pré-carregado\)$/, '');
    const uf = ufSelect.value;
    await loadCityData(code6, name, uf);
  });

  // 5. Load City Data (Cache or Live via Proxy)
  async function loadCityData(code6, name, uf) {
    currentCityInfo = { code6, name, uf };
    currentCityTitle.textContent = `${name} — ${uf}`;
    currentCitySubtitle.textContent = `Código IBGE: ${code6}`;

    const isCached = !!cachedManifest[String(code6)];

    // Check if we need a proxy for non-cached cities
    if (!isCached && !driver.proxyUrl) {
      showProxyNotice(name, uf);
      return;
    }

    showProgress(true, `Carregando dados de ${name}...`, 10);

    try {
      const geojson = await driver.retrieveFacilities({
        code6: code6,
        name: name,
        uf: uf,
        publicOnly: true,
        onProgress: (p) => {
          showProgress(true, p.message || 'Consultando CNES...', p.percent || 50);
        }
      });

      showProgress(false);

      currentFeatures = geojson.features || [];
      currentGeojson = geojson;
      if (map) {
        if (map.getSource('health-facilities')) {
          map.getSource('health-facilities').setData(geojson);
        }
        applyCameraForCurrentCity();
      }

      updateUI();
    } catch (err) {
      showProgress(false);
      console.error('Error loading city facilities:', err);
      alert(`Falha ao consultar CNES para ${name} (${uf}): ${err.message}`);
    }
  }

  function showProgress(visible, text = '', percent = 0) {
    if (!progressBarContainer) return;
    if (visible) {
      progressBarContainer.style.display = 'block';
      progressBar.style.width = `${percent}%`;
      progressText.textContent = text;
    } else {
      progressBarContainer.style.display = 'none';
      progressBar.style.width = '0%';
    }
  }

  function showProxyNotice(cityName, uf) {
    if (!proxyNoticeModal) return;
    document.getElementById('notice-city-name').textContent = `${cityName} (${uf})`;
    proxyNoticeModal.style.display = 'flex';
  }

  // 6. UI Rendering & Filters
  function updateUI() {
    totalCountEl.textContent = currentFeatures.length;

    // Filter features
    const filtered = currentFeatures.filter(f => {
      const p = f.properties;
      const matchesCat = matchesCategory(p, activeCategory);
      const q = searchQuery.toLowerCase();
      const matchesSearch = !q ||
        (p.name && p.name.toLowerCase().includes(q)) ||
        (p.official_name && p.official_name.toLowerCase().includes(q)) ||
        (p['addr:street'] && p['addr:street'].toLowerCase().includes(q)) ||
        (p['addr:suburb'] && p['addr:suburb'].toLowerCase().includes(q)) ||
        (p['ref:CNES'] && String(p['ref:CNES']).includes(q)) ||
        (p.comment && p.comment.toLowerCase().includes(q));

      return matchesCat && matchesSearch;
    });

    visibleCountEl.textContent = filtered.length;

    // Update map filter using matching feature CNES codes
    if (map && map.getSource('health-facilities')) {
      const isFiltered = (activeCategory !== 'ALL' || searchQuery !== '');
      if (!isFiltered || filtered.length === currentFeatures.length) {
        if (map.getLayer('health-circles')) map.setFilter('health-circles', null);
        if (map.getLayer('health-glow')) map.setFilter('health-glow', null);
        if (map.getLayer('health-labels')) map.setFilter('health-labels', null);
      } else if (filtered.length === 0) {
        const hideFilter = ['==', ['get', 'ref:CNES'], '__NONE__'];
        if (map.getLayer('health-circles')) map.setFilter('health-circles', hideFilter);
        if (map.getLayer('health-glow')) map.setFilter('health-glow', hideFilter);
        if (map.getLayer('health-labels')) map.setFilter('health-labels', hideFilter);
      } else {
        const cnesList = filtered.map(f => String(f.properties['ref:CNES'] || f.id));
        const filterExpr = ['in', ['get', 'ref:CNES'], ['literal', cnesList]];
        if (map.getLayer('health-circles')) map.setFilter('health-circles', filterExpr);
        if (map.getLayer('health-glow')) map.setFilter('health-glow', filterExpr);
        if (map.getLayer('health-labels')) map.setFilter('health-labels', filterExpr);
      }
    }

    renderFacilityCards(filtered);
  }

  function renderFacilityCards(features) {
    if (features.length === 0) {
      facilityListContainer.innerHTML = `
        <div class="empty-state">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="8" y1="12" x2="16" y2="12"></line>
          </svg>
          <p>Nenhuma unidade encontrada para os filtros atuais.</p>
        </div>
      `;
      return;
    }

    facilityListContainer.innerHTML = features.map(f => {
      const p = f.properties;
      const catStyle = getCategoryStyle(p);
      const coords = f.geometry.coordinates;

      return `
        <article class="facility-card" data-id="${f.id}" data-lat="${coords[1]}" data-lon="${coords[0]}">
          <div class="card-header">
            <span class="card-badge" style="background: ${catStyle.color}15; color: ${catStyle.color}; border: 1px solid ${catStyle.color}35;">
              ${p.comment || catStyle.label}
            </span>
            <span class="card-cnes">CNES: ${p['ref:CNES'] || '—'}</span>
          </div>
          <h3 class="card-title">${p.name || p.official_name || 'Sem nome'}</h3>
          <p class="card-address">
            ${[p['addr:street'], p['addr:housenumber'], p['addr:suburb']].filter(Boolean).join(', ') || 'Endereço não disponível'}
          </p>
          <div class="card-footer">
            ${p.phone ? `<a href="tel:${p.phone}" class="card-phone" onclick="event.stopPropagation()">${p.phone}</a>` : '<span>Sem telefone</span>'}
            <span class="card-btn-zoom">Ver no mapa &rarr;</span>
          </div>
        </article>
      `;
    }).join('');

    // Add click listeners to cards
    facilityListContainer.querySelectorAll('.facility-card').forEach(card => {
      card.addEventListener('click', () => {
        const lat = parseFloat(card.dataset.lat);
        const lon = parseFloat(card.dataset.lon);
        const id = card.dataset.id;
        const feature = features.find(f => String(f.id) === id);

        if (map) {
          map.flyTo({ center: [lon, lat], zoom: 16, speed: 1.4 });
        }
        if (feature) {
          setHoverFeature(feature.id);
          showPopup(feature);
        }
      });
    });
  }

  // Filter Chips
  filterChipsContainer.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    filterChipsContainer.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    activeCategory = chip.dataset.category;
    updateUI();
  });

  // Search Input
  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value.trim();
    updateUI();
  });

  // Export GeoJSON
  exportBtn.addEventListener('click', () => {
    if (!currentFeatures || currentFeatures.length === 0) {
      alert('Nenhum dado disponível para exportar.');
      return;
    }
    const fc = {
      type: 'FeatureCollection',
      metadata: {
        municipality: currentCityInfo.name,
        uf: currentCityInfo.uf,
        ibge_code: currentCityInfo.code6,
        count: currentFeatures.length,
        exported_at: new Date().toISOString(),
      },
      features: currentFeatures,
    };
    const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `saude_${currentCityInfo.name.toLowerCase().replace(/\s+/g, '_')}_${currentCityInfo.uf.toLowerCase()}.geojson`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // Proxy Modal Handlers
  if (proxyBtn) {
    proxyBtn.addEventListener('click', () => {
      proxyModal.style.display = 'flex';
    });
  }
  if (closeProxyBtn) {
    closeProxyBtn.addEventListener('click', () => {
      proxyModal.style.display = 'none';
    });
  }
  if (saveProxyBtn) {
    saveProxyBtn.addEventListener('click', () => {
      const url = proxyInput.value.trim();
      localStorage.setItem('demas_proxy_url', url);
      driver.setProxyUrl(url);
      proxyModal.style.display = 'none';
      alert(url ? 'URL do Cloudflare Worker salva com sucesso!' : 'Proxy desativado.');
    });
  }

  // Close Notice Modal
  const closeNoticeBtn = document.getElementById('close-notice-btn');
  if (closeNoticeBtn) {
    closeNoticeBtn.addEventListener('click', () => {
      proxyNoticeModal.style.display = 'none';
    });
  }
  const openSettingsFromNotice = document.getElementById('open-settings-from-notice');
  if (openSettingsFromNotice) {
    openSettingsFromNotice.addEventListener('click', () => {
      proxyNoticeModal.style.display = 'none';
      proxyModal.style.display = 'flex';
    });
  }

  // 7. Start application loading immediately
  initApplication();
});
