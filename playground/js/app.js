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
    'Hospital Público': { color: '#e11d48', label: 'Hospital' },
    'Farmácia Pública': { color: '#059669', label: 'Farmácia' },
    'SAMU 192': { color: '#ea580c', label: 'SAMU 192' },
    'Especialidades': { color: '#0891b2', label: 'Especialidades' },
    'Vigilância / Gestão': { color: '#4b5563', label: 'Vigilância / Gestão' },
    'Outros': { color: '#64748b', label: 'Outros' },
  };

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
  map = new maplibre_gl.Map({
    container: 'map',
    style: BASEMAPS.liberty,
    center: [-52.6799, -26.2252], // Default: Pato Branco
    zoom: 13,
    minZoom: 4,
    maxZoom: 19,
  });

  map.addControl(new maplibre_gl.NavigationControl({ showCompass: true, visualizePitch: true }), 'top-right');
  map.addControl(new maplibre_gl.ScaleControl({ unit: 'metric' }), 'bottom-left');

  const popup = new maplibre_gl.Popup({
    closeButton: true,
    closeOnClick: false,
    offset: 14,
    maxWidth: '320px',
  });

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
    if (map.getSource('health-facilities')) return;

    map.addSource('health-facilities', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      generateId: true,
    });

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
        'circle-color': [
          'match',
          ['get', 'comment'],
          'UBS', '#2563eb',
          'UPA 24h', '#dc2626',
          'CAPS', '#7c3aed',
          'Hospital Público', '#e11d48',
          'Farmácia Pública', '#059669',
          'SAMU 192', '#ea580c',
          'Especialidades', '#0891b2',
          'Vigilância / Gestão', '#4b5563',
          '#64748b'
        ],
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
        'circle-color': [
          'match',
          ['get', 'comment'],
          'UBS', '#2563eb',
          'UPA 24h', '#dc2626',
          'CAPS', '#7c3aed',
          'Hospital Público', '#e11d48',
          'Farmácia Pública', '#059669',
          'SAMU 192', '#ea580c',
          'Especialidades', '#0891b2',
          'Vigilância / Gestão', '#4b5563',
          '#64748b'
        ],
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

  map.on('load', async () => {
    addHealthLayers();
    await initApplication();
  });

  // Basemap switcher buttons
  document.querySelectorAll('.btn-basemap').forEach(btn => {
    btn.addEventListener('click', () => {
      const styleKey = btn.dataset.style;
      if (styleKey === currentStyleId) return;
      document.querySelectorAll('.btn-basemap').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentStyleId = styleKey;
      map.setStyle(BASEMAPS[styleKey], {
        diff: true,
        transformStyle: preserveHealthLayers,
      });
    });
  });

  // Hover state handlers
  function setHoverFeature(id) {
    if (hoveredFeatureId !== null) {
      map.setFeatureState({ source: 'health-facilities', id: hoveredFeatureId }, { hover: false });
    }
    hoveredFeatureId = id;
    if (id !== null) {
      map.setFeatureState({ source: 'health-facilities', id: id }, { hover: true });
    }
  }

  function clearHoverFeature() {
    if (hoveredFeatureId !== null) {
      map.setFeatureState({ source: 'health-facilities', id: hoveredFeatureId }, { hover: false });
      hoveredFeatureId = null;
    }
  }

  function showPopup(feature) {
    const coords = feature.geometry.coordinates.slice();
    const p = feature.properties;
    const catStyle = CATEGORY_STYLES[p.comment] || { color: '#64748b' };

    const content = `
      <div class="popup-inner">
        <div class="popup-badge" style="background: ${catStyle.color}15; color: ${catStyle.color}; border: 1px solid ${catStyle.color}40;">
          ${p.comment || 'Estabelecimento'}
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
          muniSelect.value = firstCached.code6;
          await loadCityData(firstCached.code6, firstCached.nome, uf);
        } else if (munis.length > 0) {
          muniSelect.value = munis[0].code6;
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
      const source = map.getSource('health-facilities');
      if (source) {
        source.setData(geojson);
      }

      // Center map on city
      if (cachedManifest[String(code6)] && cachedManifest[String(code6)].center) {
        map.flyTo({
          center: cachedManifest[String(code6)].center,
          zoom: 12.5,
          speed: 1.2,
        });
      } else if (currentFeatures.length > 0) {
        const bounds = new maplibre_gl.LngLatBounds();
        currentFeatures.forEach(f => bounds.extend(f.geometry.coordinates));
        map.fitBounds(bounds, { padding: 50, maxZoom: 14.5, speed: 1.2 });
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
      const matchesCategory = activeCategory === 'ALL' || p.comment === activeCategory;
      const q = searchQuery.toLowerCase();
      const matchesSearch = !q ||
        (p.name && p.name.toLowerCase().includes(q)) ||
        (p.official_name && p.official_name.toLowerCase().includes(q)) ||
        (p['addr:street'] && p['addr:street'].toLowerCase().includes(q)) ||
        (p['addr:suburb'] && p['addr:suburb'].toLowerCase().includes(q)) ||
        (p['ref:CNES'] && p['ref:CNES'].includes(q));

      return matchesCategory && matchesSearch;
    });

    visibleCountEl.textContent = filtered.length;

    // Update map filter
    if (map.getLayer('health-circles')) {
      const filters = ['all'];
      if (activeCategory !== 'ALL') {
        filters.push(['==', ['get', 'comment'], activeCategory]);
      }
      if (searchQuery) {
        // Simple search query in map
      }
      map.setFilter('health-circles', activeCategory === 'ALL' ? null : ['==', ['get', 'comment'], activeCategory]);
      map.setFilter('health-glow', activeCategory === 'ALL' ? null : ['==', ['get', 'comment'], activeCategory]);
      map.setFilter('health-labels', activeCategory === 'ALL' ? null : ['==', ['get', 'comment'], activeCategory]);
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
      const catStyle = CATEGORY_STYLES[p.comment] || { color: '#64748b' };
      const coords = f.geometry.coordinates;

      return `
        <article class="facility-card" data-id="${f.id}" data-lat="${coords[1]}" data-lon="${coords[0]}">
          <div class="card-header">
            <span class="card-badge" style="background: ${catStyle.color}15; color: ${catStyle.color}; border: 1px solid ${catStyle.color}35;">
              ${p.comment || 'Estabelecimento'}
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

        map.flyTo({ center: [lon, lat], zoom: 16, speed: 1.4 });
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
});
