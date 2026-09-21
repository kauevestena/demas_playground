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
    dark: 'https://tiles.openfreemap.org/styles/dark',
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
  let currentBoundaryGeojson = null;
  let filteredOutliers = [];
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

  // Analysis DOM Elements and State
  const analysisSection = document.getElementById('analysis-section');
  const analysisHeader = document.getElementById('analysis-header');
  const analysisStatusBadge = document.getElementById('analysis-status-badge');
  const hexOptionsContainer = document.getElementById('hex-options');
  const voronoiOptionsContainer = document.getElementById('voronoi-options');
  const hexMethodSelect = document.getElementById('hex-method-select');
  const hexMetricRow = document.getElementById('hex-metric-row');
  const hexMetricSelect = document.getElementById('hex-metric-select');
  const voronoiMetricRow = document.getElementById('voronoi-metric-row');
  const voronoiMetricSelect = document.getElementById('voronoi-metric-select');
  const voronoiMethodRow = document.getElementById('voronoi-method-row');
  const voronoiMethodSelect = document.getElementById('voronoi-method-select');
  const btnDownloadCensusTracts = document.getElementById('btn-download-census-tracts');
  const censusBtnLabel = document.getElementById('census-btn-label');
  const censusStatusBadge = document.getElementById('census-status-badge');
  const censusEngineBadge = document.getElementById('census-engine-badge');
  const censusOptionsRow = document.getElementById('census-options-row');
  const toggleShowCensusTracts = document.getElementById('toggle-show-census-tracts');
  const themeRendaCheckbox = document.getElementById('theme-renda');
  const themeSaneamentoCheckbox = document.getElementById('theme-saneamento');

  // Point Clustering DOM Elements
  const clusterControlBox = document.getElementById('cluster-control-box');
  const toggleClusterPoints = document.getElementById('toggle-cluster-points');
  const clusterStatusBadge = document.getElementById('cluster-status-badge');
  const clusterSliderRow = document.getElementById('cluster-slider-row');
  const clusterDistanceSlider = document.getElementById('cluster-distance-slider');
  const clusterDistanceVal = document.getElementById('cluster-distance-val');

  const analysisLegend = document.getElementById('analysis-legend');
  const analysisLegendTitle = document.getElementById('analysis-legend-title');
  const analysisLegendSubtitle = document.getElementById('analysis-legend-subtitle');
  const analysisLegendBody = document.getElementById('analysis-legend-body');
  const closeAnalysisLegendBtn = document.getElementById('close-analysis-legend-btn');

  let analysisMode = 'none'; // 'none' | 'voronoi' | 'hexbin'
  let hexRadiusKm = 1.0;     // 0.5 | 1.0 | 5.0 | 10.0
  let hexMethod = 'continuous'; // 'continuous' | 'quartiles' | 'equal_5' | 'equal_10' | 'std_dev' | 'jenks'
  let voronoiMetric = 'category'; // 'category' | 'population' | 'income' | 'sobrecarga' | 'saneamento_agua' | 'saneamento_esgoto'
  let voronoiMethod = 'jenks';    // 'continuous' | 'quartiles' | 'equal_5' | 'equal_10' | 'std_dev' | 'jenks'
  let hexMetric = 'count';        // 'count' | 'population' | 'income' | 'hab_per_unit' | 'saneamento_agua' | 'saneamento_esgoto'
  let clusterPointsEnabled = false;
  let clusterDistanceMeters = 20;
  let currentCensusTractsGeojson = null;
  let lastFilteredFeatures = [];

  const METHOD_LABELS = {
    'continuous': 'Escala Contínua (Não agrupado)',
    'quartiles': 'Quartis (4 classes)',
    'equal_5': 'Intervalos Iguais (5 quebras)',
    'equal_10': 'Intervalos Iguais (10 quebras)',
    'std_dev': 'Desvio Padrão',
    'jenks': 'Quebras Naturais (Jenks)',
  };

  function isFloatVoronoiMetric(metric) {
    return ['population', 'income', 'saneamento_agua', 'saneamento_esgoto'].includes(metric);
  }

  function getSelectedCensusThemes() {
    const themes = ['basico'];
    if (themeRendaCheckbox && themeRendaCheckbox.checked) themes.push('renda');
    if (themeSaneamentoCheckbox && themeSaneamentoCheckbox.checked) themes.push('saneamento');
    return themes;
  }

  function updateVoronoiControlsVisibility() {
    const hasCensus = !!currentCensusTractsGeojson;
    if (voronoiMetricRow) {
      voronoiMetricRow.style.display = hasCensus ? 'flex' : 'none';
    }
    if (voronoiMethodRow) {
      const showMethod = hasCensus && isFloatVoronoiMetric(voronoiMetric) && (analysisMode === 'voronoi');
      voronoiMethodRow.style.display = showMethod ? 'flex' : 'none';
    }
  }

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
    const sourcesToPreserve = ['health-facilities', 'analysis-voronoi', 'analysis-hexbin', 'municipality-boundary', 'census-tracts'];
    const layersToPreserve = [
      'boundary-fill',
      'boundary-line',
      'census-tracts-fill',
      'census-tracts-line',
      'analysis-voronoi-fill',
      'analysis-voronoi-line',
      'analysis-hex-fill',
      'analysis-hex-line',
      'analysis-hex-labels',
      'health-glow',
      'health-circles',
      'health-labels'
    ];

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

    // 0. Municipality Boundary Sources and Layers (Rendered directly above basemap)
    if (!map.getSource('municipality-boundary')) {
      map.addSource('municipality-boundary', {
        type: 'geojson',
        data: currentBoundaryGeojson || { type: 'FeatureCollection', features: [] },
      });
    }

    if (!map.getLayer('boundary-fill')) {
      map.addLayer({
        id: 'boundary-fill',
        type: 'fill',
        source: 'municipality-boundary',
        paint: {
          'fill-color': '#2563eb',
          'fill-opacity': 0.03,
        },
      });
    }

    if (!map.getLayer('boundary-line')) {
      map.addLayer({
        id: 'boundary-line',
        type: 'line',
        source: 'municipality-boundary',
        paint: {
          'line-color': '#2563eb',
          'line-width': 2.0,
          'line-opacity': 0.85,
          'line-dasharray': [4, 2],
        },
      });
    }

    // 0.5. Census Tracts Source and Layers (Rendered above municipal boundary, below analysis)
    if (!map.getSource('census-tracts')) {
      map.addSource('census-tracts', {
        type: 'geojson',
        data: currentCensusTractsGeojson || { type: 'FeatureCollection', features: [] },
      });
    }

    if (!map.getLayer('census-tracts-fill')) {
      map.addLayer({
        id: 'census-tracts-fill',
        type: 'fill',
        source: 'census-tracts',
        paint: {
          'fill-color': '#0284c7',
          'fill-opacity': 0.04,
        },
      });
    }

    if (!map.getLayer('census-tracts-line')) {
      map.addLayer({
        id: 'census-tracts-line',
        type: 'line',
        source: 'census-tracts',
        paint: {
          'line-color': '#0284c7',
          'line-width': 0.75,
          'line-opacity': 0.45,
          'line-dasharray': [2, 2],
        },
      });
    }

    // 1. Spatial Analysis Sources
    if (!map.getSource('analysis-voronoi')) {
      map.addSource('analysis-voronoi', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }

    if (!map.getSource('analysis-hexbin')) {
      map.addSource('analysis-hexbin', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }

    // 2. Voronoi Layers (Rendered beneath health facilities)
    if (!map.getLayer('analysis-voronoi-fill')) {
      map.addLayer({
        id: 'analysis-voronoi-fill',
        type: 'fill',
        source: 'analysis-voronoi',
        paint: {
          'fill-color': ['coalesce', ['get', 'color'], '#7c3aed'],
          'fill-opacity': 0.20,
        },
      });
    }

    if (!map.getLayer('analysis-voronoi-line')) {
      map.addLayer({
        id: 'analysis-voronoi-line',
        type: 'line',
        source: 'analysis-voronoi',
        paint: {
          'line-color': ['coalesce', ['get', 'color'], '#7c3aed'],
          'line-width': 1.5,
          'line-opacity': 0.75,
          'line-dasharray': [3, 2],
        },
      });
    }

    // 3. Hexbin Layers (Rendered beneath health facilities)
    if (!map.getLayer('analysis-hex-fill')) {
      map.addLayer({
        id: 'analysis-hex-fill',
        type: 'fill',
        source: 'analysis-hexbin',
        paint: {
          'fill-color': ['coalesce', ['get', 'fillColor'], '#f03b20'],
          'fill-opacity': 0.65,
        },
      });
    }

    if (!map.getLayer('analysis-hex-line')) {
      map.addLayer({
        id: 'analysis-hex-line',
        type: 'line',
        source: 'analysis-hexbin',
        paint: {
          'line-color': '#ffffff',
          'line-width': 1.2,
          'line-opacity': 0.6,
        },
      });
    }

    if (!map.getLayer('analysis-hex-labels')) {
      map.addLayer({
        id: 'analysis-hex-labels',
        type: 'symbol',
        source: 'analysis-hexbin',
        layout: {
          'text-field': ['get', 'countLabel'],
          'text-font': ['Noto Sans Bold'],
          'text-size': 11,
          'text-anchor': 'center',
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': '#0f172a',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.5,
        },
      });
    }

    // 4. Core Facilities Source
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
        'text-font': ['Noto Sans Regular'],
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

    // Census Tracts map events
    map.on('mouseenter', 'census-tracts-fill', (e) => {
      if (analysisMode !== 'none' || !popup) return;
      map.getCanvas().style.cursor = 'pointer';
      if (e.features && e.features.length > 0) {
        const p = e.features[0].properties;
        const pop = Number(p.populacao_total ?? p.populacao ?? p.v0001 ?? 0);
        const inc = Number(p.renda_per_capita ?? 0);
        const dom = Number(p.domicilios ?? p.v0007 ?? 0);
        const morDom = p.moradores_por_domicilio || (dom > 0 ? (pop / dom).toFixed(1) : '—');

        popup.setLngLat(e.lngLat).setHTML(`
          <div class="popup-inner">
            <div class="popup-badge" style="background: rgba(2, 132, 199, 0.15); color: #0284c7; border: 1px solid rgba(2, 132, 199, 0.4);">
              Setor Censitário • IBGE 2022
            </div>
            <h4 class="popup-title">${p.nm_bairro || 'Setor ' + (p.cd_setor || '')}</h4>
            <div class="popup-meta">
              <div><strong>Código:</strong> ${p.cd_setor || '—'}</div>
              <div><strong>População Residente:</strong> ${pop.toLocaleString('pt-BR')} hab.</div>
              <div><strong>Renda Per Capita:</strong> ${inc > 0 ? 'R$ ' + inc.toLocaleString('pt-BR') : '—'}</div>
              <div><strong>Domicílios:</strong> ${dom.toLocaleString('pt-BR')} (${morDom} hab/dom)</div>
              <div><strong>Situação:</strong> ${p.situacao || 'Urbana'}</div>
            </div>
          </div>
        `).addTo(map);
      }
    });

    map.on('mouseleave', 'census-tracts-fill', () => {
      if (analysisMode !== 'none') return;
      map.getCanvas().style.cursor = '';
      if (popup) popup.remove();
    });

    // Voronoi map events
    map.on('mouseenter', 'analysis-voronoi-fill', (e) => {
      if (analysisMode !== 'voronoi' || !popup) return;
      map.getCanvas().style.cursor = 'pointer';
      if (e.features && e.features.length > 0) {
        const p = e.features[0].properties;

        let censusInfo = '';
        if (p.hasCensusData) {
          const pop = Number(p.populacao_total || p.populacao_estimada || 0);
          const inc = Number(p.renda_per_capita || p.renda_per_capita_estimada || 0);
          const pnab = Number(p.sobrecarga_pnab || 1.0);
          const pnabColor = p.pnab_color || '#10b981';
          const pnabClass = p.pnab_class || 'Adequada';
          const dom = Number(p.domicilios_estimados || 0);
          const area = p.area_km2 || '—';
          const qtdEsf = Number(p.qtd_equipes_esf || 1);
          const nominalCap = Number(p.capacidade_pnab || (qtdEsf * 3500));
          const teamsDesc = qtdEsf > 1 ? `${qtdEsf} equipes eSF` : `${qtdEsf} equipe eSF`;
          const eapText = p.qtd_equipes_eap > 0 ? ` + ${p.qtd_equipes_eap} eAP` : '';

          censusInfo = `
            <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #e2e8f0;">
              <div style="font-size: 11px; font-weight: 700; color: #1e293b; margin-bottom: 4px;">Demografia Censo 2022 (Estimada):</div>
              <div style="font-size: 11px; line-height: 1.45;">
                <div>👥 <strong>População Adscrita:</strong> ${pop.toLocaleString('pt-BR')} hab.</div>
                <div>🏥 <strong>Equipes CNES:</strong> ${teamsDesc}${eapText} (Capacidade: ~${nominalCap.toLocaleString('pt-BR')} hab.)</div>
                <div>💰 <strong>Renda Média:</strong> ${inc > 0 ? 'R$ ' + inc.toLocaleString('pt-BR') : '—'}</div>
                <div>🩺 <strong>Índice PNAB:</strong> ${pnab} • <span style="color:${pnabColor};font-weight:700;">${pnabClass}</span></div>
                <div>🏠 <strong>Domicílios:</strong> ~${dom.toLocaleString('pt-BR')} • <strong>Área:</strong> ${area} km²</div>
              </div>
            </div>
          `;
        }

        let clusterHtml = '';
        if (p.isCluster && p.clusteredFacilities) {
          let facList = [];
          try {
            facList = typeof p.clusteredFacilities === 'string'
              ? JSON.parse(p.clusteredFacilities)
              : p.clusteredFacilities;
          } catch (_) {}

          if (facList && facList.length > 1) {
            clusterHtml = `
              <div style="margin-top: 6px; padding: 6px 8px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 4px;">
                <div style="font-size: 10px; font-weight: 700; color: #1e40af; margin-bottom: 3px;">
                  🔗 Polo de Saúde • ${facList.length} estabelecimentos aglutinados (≤ ${p.clusterRadiusMeters || 20}m)
                </div>
                <div style="max-height: 90px; overflow-y: auto; font-size: 10px; line-height: 1.35; color: #1e293b;">
                  ${facList.map(cf => `
                    <div style="padding: 2px 0; border-bottom: 1px dashed #dbeafe;">
                      <strong>${cf.name}</strong> • <span style="color:#64748b;">CNES ${cf.cnes}</span> (${cf.category})
                    </div>
                  `).join('')}
                </div>
              </div>
            `;
          }
        }

        popup.setLngLat(e.lngLat).setHTML(`
          <div class="popup-inner">
            <div class="popup-badge" style="background: rgba(124, 58, 237, 0.15); color: #7c3aed; border: 1px solid rgba(124, 58, 237, 0.4);">
              Célula Voronoi • ${p.category || 'Saúde'}
            </div>
            <h4 class="popup-title">${p.facilityName || 'Estabelecimento'}</h4>
            <div class="popup-meta">
              <div><strong>CNES:</strong> ${p.cnes || '—'}</div>
              <div>${p.address || ''}</div>
              <div style="font-size: 10.5px; color: #64748b; margin-top: 4px;">Área de menor distância geográfica a este estabelecimento/polo.</div>
              ${clusterHtml}
              ${censusInfo}
            </div>
          </div>
        `).addTo(map);
      }
    });

    map.on('mouseleave', 'analysis-voronoi-fill', () => {
      if (analysisMode !== 'voronoi') return;
      map.getCanvas().style.cursor = '';
      if (popup) popup.remove();
    });

    // Hexbin map events
    map.on('mouseenter', 'analysis-hex-fill', (e) => {
      if (analysisMode !== 'hexbin' || !popup) return;
      map.getCanvas().style.cursor = 'pointer';
      if (e.features && e.features.length > 0) {
        const p = e.features[0].properties;
        let names = [];
        try {
          names = typeof p.facilityNames === 'string' ? JSON.parse(p.facilityNames) : (p.facilityNames || []);
        } catch (_) {}

        const namesList = names.map(name => `• ${name}`).join('<br>') || 'Estabelecimentos de saúde';
        const more = (p.count > names.length) ? `<div style="margin-top:3px; font-size:10px; color:#64748b;">+ ${p.count - names.length} outros estabelecimentos</div>` : '';
        const radiusStr = (p.radiusKm >= 1) ? `${p.radiusKm}km` : `${p.radiusKm * 1000}m`;

        let censusInfo = '';
        if (p.hasCensusData) {
          const pop = Number(p.populacao_total || p.populacao_estimada || 0);
          const inc = Number(p.renda_per_capita || p.renda_per_capita_estimada || 0);
          const habPerUnit = Number(p.hab_per_unit || pop);
          const dom = Number(p.domicilios_estimados || 0);

          censusInfo = `
            <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #e2e8f0;">
              <div style="font-size: 11px; font-weight: 700; color: #1e293b; margin-bottom: 4px;">Demografia Censo 2022 (Estimada):</div>
              <div style="font-size: 11px; line-height: 1.45;">
                <div>👥 <strong>População na Célula:</strong> ${pop.toLocaleString('pt-BR')} hab.</div>
                <div>💰 <strong>Renda Média:</strong> ${inc > 0 ? 'R$ ' + inc.toLocaleString('pt-BR') : '—'}</div>
                <div>⚖️ <strong>Razão:</strong> ${habPerUnit.toLocaleString('pt-BR')} hab / unidade</div>
                <div>🏠 <strong>Domicílios:</strong> ~${dom.toLocaleString('pt-BR')}</div>
              </div>
            </div>
          `;
        }

        const hexCountLabel = clusterPointsEnabled
          ? (p.count > 1 ? `${p.count} polos de saúde` : '1 polo de saúde')
          : (p.count > 1 ? `${p.count} estabelecimentos` : '1 estabelecimento');

        popup.setLngLat(e.lngLat).setHTML(`
          <div class="popup-inner">
            <div class="popup-badge" style="background: rgba(234, 88, 12, 0.15); color: #ea580c; border: 1px solid rgba(234, 88, 12, 0.4);">
              Célula Hexagonal (Raio: ${radiusStr})
            </div>
            <h4 class="popup-title">${hexCountLabel} nesta célula</h4>
            <div class="popup-meta" style="font-size: 11px; line-height: 1.4; max-height: 120px; overflow-y: auto;">
              ${namesList}
              ${more}
            </div>
            ${censusInfo}
          </div>
        `).addTo(map);
      }
    });

    map.on('mouseleave', 'analysis-hex-fill', () => {
      if (analysisMode !== 'hexbin') return;
      map.getCanvas().style.cursor = '';
      if (popup) popup.remove();
    });
  }

  function applyCameraForCurrentCity() {
    if (!map) return;
    if (currentBoundaryGeojson && window.turf && currentBoundaryGeojson.features && currentBoundaryGeojson.features.length > 0) {
      try {
        const bbox = window.turf.bbox(currentBoundaryGeojson);
        map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], {
          padding: 48,
          maxZoom: 14.5,
          speed: 1.3,
        });
        return;
      } catch (_) {}
    }
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
      if (currentBoundaryGeojson && map.getSource('municipality-boundary')) {
        map.getSource('municipality-boundary').setData(currentBoundaryGeojson);
      }
      if (currentGeojson && map.getSource('health-facilities')) {
        map.getSource('health-facilities').setData(currentGeojson);
      }
      applyCameraForCurrentCity();
      updateUI();
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
          if (currentBoundaryGeojson && map.getSource('municipality-boundary')) {
            map.getSource('municipality-boundary').setData(currentBoundaryGeojson);
          }
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
          ${p.qtd_equipes_esf !== undefined && Number(p.qtd_equipes_esf) > 0 ? `
            <div><strong>Equipes de Saúde:</strong> ${p.qtd_equipes_esf} eSF${p.qtd_equipes_eap ? ` + ${p.qtd_equipes_eap} eAP` : ''} (Capacidade nominal: ~${(p.capacidade_pnab || Number(p.qtd_equipes_esf) * 3500).toLocaleString('pt-BR')} hab.)</div>
          ` : ''}
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
      await loadCityData(411850, 'Pato Branco', 'PR', 4118501);
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
          <option value="${m.code6}" data-name="${m.nome}" data-id7="${m.id7}" ${selectCode === m.code6 ? 'selected' : ''}>
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
          await loadCityData(firstCached.code6, firstCached.nome, uf, firstCached.id7);
        } else if (munis.length > 0) {
          muniSelect.value = String(munis[0].code6);
          await loadCityData(munis[0].code6, munis[0].nome, uf, munis[0].id7);
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
    const id7 = selectedOption.dataset.id7 ? parseInt(selectedOption.dataset.id7, 10) : null;
    const uf = ufSelect.value;
    await loadCityData(code6, name, uf, id7);
  });

  // 5. Load City Data (Cache or Live via Proxy)
  async function loadCityData(code6, name, uf, id7 = null) {
    currentCityInfo = { code6, name, uf };
    currentCityTitle.textContent = `${name} — ${uf}`;
    currentCitySubtitle.textContent = `Código IBGE: ${code6}`;

    const isCached = !!cachedManifest[String(code6)];

    // Check if we need a proxy for non-cached cities
    if (!isCached && !driver.proxyUrl) {
      showProxyNotice(name, uf);
      return;
    }

    showProgress(true, `Carregando limites e unidades de ${name}...`, 10);

    try {
      // 1. Fetch official municipality boundary (a priori for cached, on-demand for others)
      const boundary = await driver.fetchMunicipalityBoundary(code6, id7, 'data/');
      currentBoundaryGeojson = boundary;
      if (map && map.getSource('municipality-boundary')) {
        map.getSource('municipality-boundary').setData(boundary || { type: 'FeatureCollection', features: [] });
      }

      // 2. Fetch facilities from CNES
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

      // 3. Filter points outside official municipal boundary
      let rawFeatures = geojson.features || [];
      if (boundary && window.GeospatialAnalysis && window.GeospatialAnalysis.filterPointsInBoundary) {
        const filterRes = window.GeospatialAnalysis.filterPointsInBoundary(rawFeatures, boundary);
        currentFeatures = filterRes.inside;
        filteredOutliers = filterRes.outside;
      } else {
        currentFeatures = rawFeatures;
        filteredOutliers = [];
      }

      currentGeojson = { ...geojson, features: currentFeatures };
      if (map) {
        if (map.getSource('health-facilities')) {
          map.getSource('health-facilities').setData(currentGeojson);
        }
        applyCameraForCurrentCity();
      }

      // 4. Check or reset census tracts for this municipality
      const cachedTracts = driver._censusTractsCache.get(String(code6));
      if (cachedTracts) {
        currentCensusTractsGeojson = cachedTracts;
        const totalPop = cachedTracts.features.reduce((acc, f) => acc + (f.properties.populacao || f.properties.populacao_total || 0), 0);
        if (censusStatusBadge) {
          censusStatusBadge.className = 'census-badge loaded';
          censusStatusBadge.textContent = `${cachedTracts.features.length} setores (${totalPop.toLocaleString('pt-BR')} hab)`;
        }
        if (censusOptionsRow) censusOptionsRow.style.display = 'flex';
        if (hexMetricRow) hexMetricRow.style.display = 'flex';
        updateVoronoiControlsVisibility();
        if (censusBtnLabel) censusBtnLabel.textContent = 'Atualizar Setores Censitários';
        if (map && map.getSource('census-tracts')) {
          map.getSource('census-tracts').setData(cachedTracts);
        }
      } else {
        currentCensusTractsGeojson = null;
        if (censusEngineBadge) censusEngineBadge.style.display = 'none';
        const hasPrecached = !!(cachedManifest[String(code6)] && cachedManifest[String(code6)].census_tracts);
        if (censusStatusBadge) {
          if (hasPrecached) {
            censusStatusBadge.className = 'census-badge available';
            censusStatusBadge.textContent = 'Disponível';
          } else {
            censusStatusBadge.className = 'census-badge';
            censusStatusBadge.textContent = 'Sob demanda';
          }
        }
        if (censusOptionsRow) censusOptionsRow.style.display = 'none';
        if (hexMetricRow) hexMetricRow.style.display = 'none';
        updateVoronoiControlsVisibility();
        if (censusBtnLabel) censusBtnLabel.textContent = 'Baixar Setores Censitários';
        if (map && map.getSource('census-tracts')) {
          map.getSource('census-tracts').setData({ type: 'FeatureCollection', features: [] });
        }
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

    if (filteredOutliers.length > 0) {
      currentCitySubtitle.textContent = `Código IBGE: ${currentCityInfo.code6} • ${currentFeatures.length} no município (${filteredOutliers.length} fora dos limites filtradas)`;
    } else {
      currentCitySubtitle.textContent = `Código IBGE: ${currentCityInfo.code6} • ${currentFeatures.length} unidades municipais`;
    }

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
    updateSpatialAnalysis(filtered);
  }

  function renderClassificationLegend(classification, cellCount) {
    if (!analysisLegendBody) return;
    if (!classification || cellCount === 0) {
      analysisLegendBody.innerHTML = `
        <div style="font-size:11px;color:var(--text-muted);">Nenhum dado na seleção atual.</div>
      `;
    } else if (classification.type === 'continuous') {
      analysisLegendBody.innerHTML = `
        <div class="colorbar-gradient-bar" style="background: ${classification.gradientCss};"></div>
        <div class="colorbar-range-labels">
          <span>Mín: ${classification.getClassLabel(classification.min)}</span>
          <span>Total: ${cellCount}</span>
          <span>Máx: ${classification.getClassLabel(classification.max)}</span>
        </div>
      `;
    } else if (classification.type === 'single') {
      analysisLegendBody.innerHTML = `
        <div class="colorbar-step-item">
          <div class="colorbar-step-left">
            <span class="colorbar-step-color" style="background: ${classification.getColor()};"></span>
            <span>${classification.getClassLabel()}</span>
          </div>
          <span class="colorbar-step-count">${cellCount} células</span>
        </div>
      `;
    } else if (classification.bins && classification.bins.length > 0) {
      analysisLegendBody.innerHTML = `
        <div class="colorbar-steps">
          ${classification.bins.map(bin => `
            <div class="colorbar-step-item">
              <div class="colorbar-step-left">
                <span class="colorbar-step-color" style="background: ${bin.color};"></span>
                <span>${bin.label}</span>
              </div>
              <span class="colorbar-step-count">${bin.count} cél.</span>
            </div>
          `).join('')}
        </div>
      `;
    }
  }

  function updateSpatialAnalysis(filteredFeatures) {
    lastFilteredFeatures = filteredFeatures || [];

    const voronoiSource = map ? map.getSource('analysis-voronoi') : null;
    const hexSource = map ? map.getSource('analysis-hexbin') : null;

    if (!window.GeospatialAnalysis || analysisMode === 'none' || lastFilteredFeatures.length === 0) {
      if (voronoiSource) voronoiSource.setData({ type: 'FeatureCollection', features: [] });
      if (hexSource) hexSource.setData({ type: 'FeatureCollection', features: [] });
      if (analysisLegend) analysisLegend.style.display = 'none';
      if (clusterControlBox) clusterControlBox.style.display = 'none';
      if (analysisStatusBadge) {
        analysisStatusBadge.className = 'analysis-badge';
        analysisStatusBadge.textContent = 'Desativada';
      }
      return;
    }

    // Keep controls in sync
    updateVoronoiControlsVisibility();

    // Show clustering controls when spatial analysis is active
    if (clusterControlBox) clusterControlBox.style.display = 'flex';

    // Apply point clustering if enabled
    let featuresForAnalysis = lastFilteredFeatures;
    if (clusterPointsEnabled && window.GeospatialAnalysis && window.GeospatialAnalysis.clusterNearbyPoints) {
      featuresForAnalysis = window.GeospatialAnalysis.clusterNearbyPoints(lastFilteredFeatures, clusterDistanceMeters);
      if (clusterStatusBadge) {
        clusterStatusBadge.style.display = 'inline-block';
        clusterStatusBadge.textContent = `${featuresForAnalysis.length} polos (${lastFilteredFeatures.length} unid.)`;
      }
    } else if (clusterStatusBadge) {
      clusterStatusBadge.style.display = 'none';
    }

    if (analysisMode === 'voronoi') {
      if (hexSource) hexSource.setData({ type: 'FeatureCollection', features: [] });

      // Determine category theme color
      const catColor = (activeCategory !== 'ALL' && CATEGORY_STYLES[activeCategory])
        ? CATEGORY_STYLES[activeCategory].color
        : '#7c3aed';

      const coloredFeatures = featuresForAnalysis.map(f => ({
        ...f,
        properties: { ...f.properties, color: catColor }
      }));

      const voronoiResult = window.GeospatialAnalysis.computeVoronoi(
        coloredFeatures,
        4.0,
        currentBoundaryGeojson,
        currentCensusTractsGeojson,
        voronoiMetric,
        voronoiMethod
      );
      if (voronoiSource) voronoiSource.setData(voronoiResult);

      const cellCount = voronoiResult.features.length;
      if (analysisStatusBadge) {
        analysisStatusBadge.className = 'analysis-badge active-voronoi';
        analysisStatusBadge.textContent = clusterPointsEnabled
          ? `Voronoi (${cellCount} polos)`
          : `Voronoi (${cellCount} células)`;
      }

      // Adjust fill opacity and border styling for demographic choropleth vs category
      if (map && map.getLayer('analysis-voronoi-fill')) {
        const opacity = (voronoiMetric === 'category') ? 0.20 : 0.40;
        map.setPaintProperty('analysis-voronoi-fill', 'fill-opacity', opacity);
      }
      if (map && map.getLayer('analysis-voronoi-line')) {
        const dash = (voronoiMetric === 'category') ? [3, 2] : [1, 0];
        map.setPaintProperty('analysis-voronoi-line', 'line-dasharray', dash);
      }

      // Render Voronoi legend
      if (analysisLegend) {
        analysisLegend.style.display = 'block';
        const clusterSuffix = clusterPointsEnabled ? ` • ${cellCount} polos aglutinados (≤ ${clusterDistanceMeters}m)` : '';

        if (voronoiMetric === 'population') {
          analysisLegendTitle.textContent = 'População Adscrita (Voronoi)';
          analysisLegendSubtitle.textContent = `Interpolação Censo IBGE 2022 • ${METHOD_LABELS[voronoiMethod] || voronoiMethod}${clusterSuffix}`;
          renderClassificationLegend(voronoiResult.classification, cellCount);
        } else if (voronoiMetric === 'income') {
          analysisLegendTitle.textContent = 'Renda Média Per Capita (Voronoi)';
          analysisLegendSubtitle.textContent = `Censo IBGE 2022 • ${METHOD_LABELS[voronoiMethod] || voronoiMethod}${clusterSuffix}`;
          renderClassificationLegend(voronoiResult.classification, cellCount);
        } else if (voronoiMetric === 'saneamento_agua') {
          analysisLegendTitle.textContent = '% Água Encanada (Voronoi)';
          analysisLegendSubtitle.textContent = `Abastecimento de Água • Censo IBGE 2022 • ${METHOD_LABELS[voronoiMethod] || voronoiMethod}${clusterSuffix}`;
          renderClassificationLegend(voronoiResult.classification, cellCount);
        } else if (voronoiMetric === 'saneamento_esgoto') {
          analysisLegendTitle.textContent = '% Esgoto Coletado (Voronoi)';
          analysisLegendSubtitle.textContent = `Esgotamento Sanitário • Censo IBGE 2022 • ${METHOD_LABELS[voronoiMethod] || voronoiMethod}${clusterSuffix}`;
          renderClassificationLegend(voronoiResult.classification, cellCount);
        } else if (voronoiMetric === 'sobrecarga') {
          analysisLegendTitle.textContent = 'Índice de Sobrecarga PNAB';
          analysisLegendSubtitle.textContent = `Referência: 2.000 a 3.500 hab/equipe (${cellCount} células)${clusterSuffix}`;
          renderClassificationLegend(voronoiResult.classification, cellCount);
        } else {
          // Category default
          analysisLegendTitle.textContent = 'Diagrama de Voronoi';
          analysisLegendSubtitle.textContent = `${cellCount} ${clusterPointsEnabled ? 'polos' : 'células'} para ${activeCategory === 'ALL' ? 'Todos os Estabelecimentos' : activeCategory}${clusterSuffix}`;
          analysisLegendBody.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px;margin-top:4px;">
              <span style="width:14px;height:14px;border:1.5px dashed ${catColor};background:${catColor}33;border-radius:2px;"></span>
              <span style="font-weight:600;color:#1e293b;">${activeCategory === 'ALL' ? 'Todos os Serviços' : activeCategory}</span>
            </div>
            <p style="margin-top:6px;font-size:10.5px;color:var(--text-muted);line-height:1.35;">
              Células de influência delimitando a área mais próxima a cada estabelecimento/polo dentro do município.
            </p>
          `;
        }
      }
    } else if (analysisMode === 'hexbin') {
      if (voronoiSource) voronoiSource.setData({ type: 'FeatureCollection', features: [] });

      const hexResult = window.GeospatialAnalysis.computeHexbins(
        featuresForAnalysis,
        hexRadiusKm,
        hexMethod,
        currentBoundaryGeojson,
        currentCensusTractsGeojson,
        hexMetric
      );
      if (hexSource) hexSource.setData(hexResult.featureCollection);

      const cellCount = hexResult.featureCollection.features.length;
      const radiusLabel = hexRadiusKm >= 1 ? `${hexRadiusKm}km` : `${hexRadiusKm * 1000}m`;
      if (analysisStatusBadge) {
        analysisStatusBadge.className = 'analysis-badge active-hex';
        analysisStatusBadge.textContent = clusterPointsEnabled
          ? `Hexágonos (${cellCount} células / polos)`
          : `Hexágonos (${cellCount} células)`;
      }

      // Render Hexbin Legend / Colorbar
      if (analysisLegend) {
        analysisLegend.style.display = 'block';

        const metricTitles = {
          'count': clusterPointsEnabled ? 'Densidade de Polos de Saúde' : 'Densidade de Estabelecimentos',
          'population': 'População Estimada (Censo 2022)',
          'income': 'Renda Média Per Capita',
          'hab_per_unit': clusterPointsEnabled ? 'Razão Habitantes / Polo' : 'Razão Habitantes / Unidade',
          'saneamento_agua': '% Domicílios com Água Encanada',
          'saneamento_esgoto': '% Domicílios com Esgoto Coletado'
        };

        const clusterSuffix = clusterPointsEnabled ? ` • Aglutinação: ≤ ${clusterDistanceMeters}m` : '';
        analysisLegendTitle.textContent = metricTitles[hexMetric] || 'Densidade Hexagonal';
        analysisLegendSubtitle.textContent = `Raio: ${radiusLabel} • ${METHOD_LABELS[hexMethod] || hexMethod}${clusterSuffix}`;

        renderClassificationLegend(hexResult.classification, cellCount);
      }
    }
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

  // Spatial Analysis Controls
  document.querySelectorAll('.btn-analysis-mode').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode === analysisMode) return;
      document.querySelectorAll('.btn-analysis-mode').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      analysisMode = mode;

      if (hexOptionsContainer) hexOptionsContainer.style.display = (mode === 'hexbin') ? 'flex' : 'none';
      if (voronoiOptionsContainer) voronoiOptionsContainer.style.display = (mode === 'voronoi') ? 'flex' : 'none';
      if (clusterControlBox) clusterControlBox.style.display = (mode !== 'none') ? 'flex' : 'none';
      updateVoronoiControlsVisibility();

      updateSpatialAnalysis(lastFilteredFeatures);
    });
  });

  // Collapsible Analysis Accordion
  if (analysisHeader && analysisSection) {
    analysisHeader.addEventListener('click', () => {
      analysisSection.classList.toggle('collapsed');
    });
  }

  // Census Tracts Download Button
  if (btnDownloadCensusTracts) {
    btnDownloadCensusTracts.addEventListener('click', async () => {
      btnDownloadCensusTracts.disabled = true;
      const originalText = censusBtnLabel ? censusBtnLabel.textContent : 'Baixar Setores Censitários';
      if (censusBtnLabel) censusBtnLabel.textContent = 'Processando (DuckDB-Wasm)...';

      try {
        const themes = getSelectedCensusThemes();
        const tracts = await driver.fetchCensusTracts(currentCityInfo.code6, currentCityInfo.id7, 'data/', {
          uf: currentCityInfo.uf,
          themes: themes
        });
        if (tracts && tracts.features && tracts.features.length > 0) {
          currentCensusTractsGeojson = tracts;
          const totalPop = tracts.features.reduce((acc, f) => acc + (f.properties.populacao || f.properties.populacao_total || 0), 0);
          if (censusStatusBadge) {
            censusStatusBadge.className = 'census-badge loaded';
            censusStatusBadge.textContent = `${tracts.features.length} setores (${totalPop.toLocaleString('pt-BR')} hab)`;
          }
          if (censusEngineBadge) {
            if (tracts.metadata && tracts.metadata.engine) {
              censusEngineBadge.style.display = 'inline-block';
              censusEngineBadge.textContent = `⚡ DuckDB-Wasm (${tracts.metadata.query_time_ms}ms)`;
              censusEngineBadge.title = `Processado via DuckDB-Wasm in-browser com GeoParquet & Parquet desacoplado.\nTemas: ${themes.join(', ')}`;
            } else {
              censusEngineBadge.style.display = 'none';
            }
          }
          if (censusOptionsRow) censusOptionsRow.style.display = 'flex';
          if (hexMetricRow) hexMetricRow.style.display = 'flex';
          updateVoronoiControlsVisibility();
          if (censusBtnLabel) censusBtnLabel.textContent = 'Atualizar Setores (DuckDB)';

          if (map && map.getSource('census-tracts')) {
            map.getSource('census-tracts').setData(tracts);
          }

          // If spatial analysis is active, recompute with enriched demographic data
          updateSpatialAnalysis(lastFilteredFeatures);
        } else {
          alert(`Os setores censitários do Censo 2022 ainda não estão disponíveis para ${currentCityInfo.name} (${currentCityInfo.uf}).`);
          if (censusBtnLabel) censusBtnLabel.textContent = originalText;
        }
      } catch (err) {
        console.error('Error loading census tracts:', err);
        alert('Erro ao carregar setores censitários: ' + err.message);
        if (censusBtnLabel) censusBtnLabel.textContent = originalText;
      } finally {
        btnDownloadCensusTracts.disabled = false;
      }
    });
  }

  // Auto-reload on Census Theme toggles if tracts are already loaded
  [themeRendaCheckbox, themeSaneamentoCheckbox].forEach(cb => {
    if (cb) {
      cb.addEventListener('change', () => {
        if (currentCensusTractsGeojson && btnDownloadCensusTracts) {
          btnDownloadCensusTracts.click();
        }
      });
    }
  });

  // Toggle census tracts layer visibility
  if (toggleShowCensusTracts) {
    toggleShowCensusTracts.addEventListener('change', (e) => {
      const isVisible = e.target.checked;
      const val = isVisible ? 'visible' : 'none';
      if (map) {
        if (map.getLayer('census-tracts-fill')) map.setLayoutProperty('census-tracts-fill', 'visibility', val);
        if (map.getLayer('census-tracts-line')) map.setLayoutProperty('census-tracts-line', 'visibility', val);
      }
    });
  }

  // Metric Selectors
  if (voronoiMetricSelect) {
    voronoiMetricSelect.addEventListener('change', () => {
      voronoiMetric = voronoiMetricSelect.value;
      updateVoronoiControlsVisibility();
      updateSpatialAnalysis(lastFilteredFeatures);
    });
  }

  if (voronoiMethodSelect) {
    voronoiMethodSelect.addEventListener('change', () => {
      voronoiMethod = voronoiMethodSelect.value;
      updateSpatialAnalysis(lastFilteredFeatures);
    });
  }

  if (hexMetricSelect) {
    hexMetricSelect.addEventListener('change', () => {
      hexMetric = hexMetricSelect.value;
      updateSpatialAnalysis(lastFilteredFeatures);
    });
  }

  document.querySelectorAll('#hex-radius-group .btn-segment').forEach(btn => {
    btn.addEventListener('click', () => {
      const radius = parseFloat(btn.dataset.radius);
      if (radius === hexRadiusKm) return;
      document.querySelectorAll('#hex-radius-group .btn-segment').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      hexRadiusKm = radius;
      updateSpatialAnalysis(lastFilteredFeatures);
    });
  });

  if (hexMethodSelect) {
    hexMethodSelect.addEventListener('change', () => {
      hexMethod = hexMethodSelect.value;
      updateSpatialAnalysis(lastFilteredFeatures);
    });
  }

  if (closeAnalysisLegendBtn) {
    closeAnalysisLegendBtn.addEventListener('click', () => {
      if (analysisLegend) analysisLegend.style.display = 'none';
    });
  }

  // Point Clustering Controls (Voronoi & Hexbins)
  if (toggleClusterPoints) {
    toggleClusterPoints.addEventListener('change', (e) => {
      clusterPointsEnabled = e.target.checked;
      if (clusterSliderRow) clusterSliderRow.style.display = clusterPointsEnabled ? 'flex' : 'none';
      if (clusterStatusBadge) clusterStatusBadge.style.display = clusterPointsEnabled ? 'inline-block' : 'none';
      updateSpatialAnalysis(lastFilteredFeatures);
    });
  }

  if (clusterDistanceSlider) {
    clusterDistanceSlider.addEventListener('input', (e) => {
      clusterDistanceMeters = parseInt(e.target.value, 10);
      if (clusterDistanceVal) clusterDistanceVal.textContent = `${clusterDistanceMeters}m`;
      if (clusterPointsEnabled) {
        updateSpatialAnalysis(lastFilteredFeatures);
      }
    });
  }

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
