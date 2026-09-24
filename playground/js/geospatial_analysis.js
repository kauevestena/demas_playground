/**
 * geospatial_analysis.js - Spatial Analysis Engine for DEMAS Playground
 * 
 * Provides:
 * - Voronoi / Thiessen polygons computation bounded by extent
 * - Hexagonal binning (hexbins) at 500m, 1km, 5km, 10km radius
 * - 1D statistical classification / clustering:
 *    1. unclustered continuous colorscale
 *    2. quartiles (4 classes)
 *    3. equal interval with 5 breaks
 *    4. equal interval with 10 breaks
 *    5. standard deviation
 *    6. jenks natural breaks (Fisher-Ckmeans)
 * - Colorbar scale and dynamic legend metadata generation
 */

(function (window) {
  'use strict';

  // Perceptually uniform Sequential Color Ramps (YlOrRd family)
  const COLOR_RAMP_4 = ['#ffffb2', '#fecc5c', '#f03b20', '#bd0026'];
  const COLOR_RAMP_5 = ['#ffffb2', '#fecc5c', '#fd8d3c', '#f03b20', '#bd0026'];
  const COLOR_RAMP_6 = ['#ffffb2', '#fed976', '#feb24c', '#fd8d3c', '#f03b20', '#bd0026'];
  const COLOR_RAMP_10 = [
    '#ffffd4', '#fee391', '#fec44f', '#fe9929', '#ec7014',
    '#cc4c02', '#993404', '#7a2202', '#5e1502', '#3f0c02'
  ];

  // Standard continuous color scale gradient stops [0 to 1]
  const CONTINUOUS_STOPS = [
    { t: 0.0, color: [255, 255, 178] }, // #ffffb2
    { t: 0.25, color: [254, 204, 92] }, // #fecc5c
    { t: 0.5, color: [253, 141, 60] },  // #fd8d3c
    { t: 0.75, color: [240, 59, 32] },  // #f03b20
    { t: 1.0, color: [189, 0, 38] }     // #bd0026
  ];

  function interpolateColor(t) {
    const clampedT = Math.max(0, Math.min(1, t));
    let lower = CONTINUOUS_STOPS[0];
    let upper = CONTINUOUS_STOPS[CONTINUOUS_STOPS.length - 1];

    for (let i = 0; i < CONTINUOUS_STOPS.length - 1; i++) {
      if (clampedT >= CONTINUOUS_STOPS[i].t && clampedT <= CONTINUOUS_STOPS[i + 1].t) {
        lower = CONTINUOUS_STOPS[i];
        upper = CONTINUOUS_STOPS[i + 1];
        break;
      }
    }

    const range = upper.t - lower.t || 1;
    const factor = (clampedT - lower.t) / range;

    const r = Math.round(lower.color[0] + factor * (upper.color[0] - lower.color[0]));
    const g = Math.round(lower.color[1] + factor * (upper.color[1] - lower.color[1]));
    const b = Math.round(lower.color[2] + factor * (upper.color[2] - lower.color[2]));

    const hex = (x) => ('0' + parseInt(x, 10).toString(16)).slice(-2);
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  }

  function rgbToHex(rgbStr) {
    const m = rgbStr.match(/\d+/g);
    if (!m) return '#bd0026';
    const hex = (x) => ('0' + parseInt(x, 10).toString(16)).slice(-2);
    return `#${hex(m[0])}${hex(m[1])}${hex(m[2])}`;
  }

  /**
   * Filter point features to only those inside the official municipal boundary.
   * @param {Array} features - GeoJSON point features
   * @param {Object} boundaryGeojson - GeoJSON FeatureCollection of municipality boundary
   * @returns {{ inside: Array, outside: Array }}
   */
  function filterPointsInBoundary(features, boundaryGeojson) {
    if (!window.turf || !features || features.length === 0) {
      return { inside: features || [], outside: [] };
    }
    if (!boundaryGeojson || !boundaryGeojson.features || boundaryGeojson.features.length === 0) {
      return { inside: features, outside: [] };
    }

    const bFeats = boundaryGeojson.features;
    const inside = [];
    const outside = [];

    for (let i = 0; i < features.length; i++) {
      const feat = features[i];
      let isInside = false;
      for (let j = 0; j < bFeats.length; j++) {
        if (window.turf.booleanPointInPolygon(feat, bFeats[j])) {
          isInside = true;
          break;
        }
      }
      if (isInside) {
        inside.push(feat);
      } else {
        outside.push(feat);
      }
    }

    return { inside, outside };
  }

  /**
   * Clusters point features that are within a specified distance threshold (in meters).
   * Aggregates very close facilities into single composite point features.
   * 
   * @param {Array<Object>} features - GeoJSON point features
   * @param {number} maxDistanceMeters - Maximum distance threshold in meters (e.g. 10m to 100m)
   * @returns {Array<Object>} Array of clustered point features
   */
  function clusterNearbyPoints(features, maxDistanceMeters = 20) {
    if (!features || features.length <= 1 || !maxDistanceMeters || maxDistanceMeters <= 0) {
      return features || [];
    }

    const n = features.length;
    const coords = features.map(f => f.geometry.coordinates);

    // Fast geodesic/metric distance for nearby points
    function getDistanceMeters(c1, c2) {
      const latRad = ((c1[1] + c2[1]) / 2) * (Math.PI / 180);
      const dx = (c2[0] - c1[0]) * (Math.PI / 180) * 6371000 * Math.cos(latRad);
      const dy = (c2[1] - c1[1]) * (Math.PI / 180) * 6371000;
      return Math.sqrt(dx * dx + dy * dy);
    }

    // Connected components grouping using BFS
    const visited = new Uint8Array(n);
    const clusters = [];

    for (let i = 0; i < n; i++) {
      if (visited[i]) continue;
      visited[i] = 1;

      const clusterIndices = [i];
      const queue = [i];

      while (queue.length > 0) {
        const curr = queue.shift();
        const currCoord = coords[curr];

        for (let j = 0; j < n; j++) {
          if (!visited[j]) {
            const d = getDistanceMeters(currCoord, coords[j]);
            if (d <= maxDistanceMeters) {
              visited[j] = 1;
              clusterIndices.push(j);
              queue.push(j);
            }
          }
        }
      }

      clusters.push(clusterIndices.map(idx => features[idx]));
    }

    return clusters.map((clusterPts, clusterIdx) => {
      if (clusterPts.length === 1) {
        return clusterPts[0];
      }

      // Compute centroid of cluster coordinates
      let sumLon = 0, sumLat = 0;
      for (let p = 0; p < clusterPts.length; p++) {
        sumLon += clusterPts[p].geometry.coordinates[0];
        sumLat += clusterPts[p].geometry.coordinates[1];
      }
      const centerLon = sumLon / clusterPts.length;
      const centerLat = sumLat / clusterPts.length;

      const primary = clusterPts[0];
      const names = clusterPts.map(f => f.properties.name || f.properties.official_name || 'Sem nome');
      const cnesList = clusterPts.map(f => f.properties['ref:CNES']).filter(Boolean);
      const categories = Array.from(new Set(clusterPts.map(f => f.properties.comment || 'Saúde')));

      const compositeTitle = `${primary.properties.name || primary.properties.official_name || 'Complexo de Saúde'} (+${clusterPts.length - 1} un.)`;

      // Aggregate health teams properties across cluster
      const sumEsf = clusterPts.reduce((acc, f) => acc + Number(f.properties.qtd_equipes_esf || 0), 0);
      const sumEap = clusterPts.reduce((acc, f) => acc + Number(f.properties.qtd_equipes_eap || 0), 0);
      const sumTot = clusterPts.reduce((acc, f) => acc + Number(f.properties.qtd_equipes_total || 0), 0);
      const sumCap = clusterPts.reduce((acc, f) => acc + Number(f.properties.capacidade_pnab || 3500), 0);
      const allTeamNames = clusterPts.map(f => f.properties.nomes_equipes).filter(Boolean).join('; ');

      return {
        type: 'Feature',
        id: `cluster-${clusterIdx}-${primary.id}`,
        geometry: {
          type: 'Point',
          coordinates: [centerLon, centerLat]
        },
        properties: {
          ...primary.properties,
          isCluster: true,
          clusterCount: clusterPts.length,
          clusterRadiusMeters: maxDistanceMeters,
          clusteredFacilities: clusterPts.map(f => ({
            id: f.id,
            name: f.properties.name || f.properties.official_name || 'Sem nome',
            cnes: f.properties['ref:CNES'] || '—',
            category: f.properties.comment || 'Saúde',
            address: [f.properties['addr:street'], f.properties['addr:housenumber'], f.properties['addr:suburb']].filter(Boolean).join(', ')
          })),
          facilityNames: names,
          name: compositeTitle,
          official_name: compositeTitle,
          cnes: cnesList.join(', ') || primary.properties['ref:CNES'] || '—',
          category: categories.length === 1 ? categories[0] : (categories.includes('UBS') ? 'UBS' : categories[0]),
          compositeCategories: categories,
          qtd_equipes_esf: sumEsf > 0 ? sumEsf : (clusterPts.some(f => (f.properties.comment || '').toLowerCase().includes('ubs')) ? 1 : 0),
          qtd_equipes_eap: sumEap,
          qtd_equipes_total: sumTot > 0 ? sumTot : 1,
          capacidade_pnab: sumCap > 0 ? sumCap : 3500,
          nomes_equipes: allTeamNames,
        }
      };
    });
  }

  /**
   * Enriches spatial partitions (Voronoi cells or Hexagons) with census tract attributes
   * using Areal Weighting (Interpolação de Área Ponderada).
   * 
   * @param {Object} cellsFC - GeoJSON FeatureCollection of spatial cells (Voronoi or Hexbins)
   * @param {Object} tractsFC - GeoJSON FeatureCollection of census tracts (IBGE Censo 2022)
   * @param {string} [situacao='ambos'] - Territorial filter: 'ambos', 'urbanos', or 'rurais'
   * @returns {Object} Enriched GeoJSON FeatureCollection
   */
  function enrichWithCensusTracts(cellsFC, tractsFC, situacao = 'ambos') {
    if (!window.turf || !cellsFC || !cellsFC.features || cellsFC.features.length === 0) {
      return cellsFC;
    }
    if (!tractsFC || !tractsFC.features || tractsFC.features.length === 0) {
      return cellsFC;
    }

    let tracts = tractsFC.features;
    if (situacao && situacao !== 'ambos') {
      const target = situacao.toLowerCase().includes('urban') ? 'urban' : 'rural';
      tracts = tracts.filter(t => {
        const s = String(t.properties?.situacao || '').toLowerCase();
        return s.includes(target);
      });
    }

    if (tracts.length === 0) {
      // If no tracts match the filter, assign 0 values to cells
      cellsFC.features.forEach(cell => {
        if (!cell.geometry) return;
        const cellArea = window.turf.area(cell);
        const cellProps = cell.properties || {};
        const qtdEsf = Number(cellProps.qtd_equipes_esf) > 0 ? Number(cellProps.qtd_equipes_esf) : 1;
        const nominalCap = Number(cellProps.capacidade_pnab) > 0 ? Number(cellProps.capacidade_pnab) : (qtdEsf * 3500);
        cell.properties = {
          ...cell.properties,
          hasCensusData: true,
          populacao_total: 0,
          populacao_estimada: 0,
          renda_per_capita: 0,
          renda_per_capita_estimada: 0,
          domicilios_estimados: 0,
          pct_agua_encanada: null,
          pct_esgoto_coletado: null,
          qtd_equipes_esf: qtdEsf,
          capacidade_pnab: nominalCap,
          sobrecarga_pnab: 0,
          pnab_class: `Adequada (≤ ${nominalCap.toLocaleString('pt-BR')} hab)`,
          pnab_color: '#10b981',
          intersecting_tracts_count: 0,
          situacao_filtro: situacao,
          area_km2: Number((cellArea / 1e6).toFixed(2))
        };
        if (cell.properties.facilitiesCount !== undefined) {
          cell.properties.hab_per_unit = 0;
        }
      });
      return cellsFC;
    }

    // Precalculate and cache bbox, area, and demographic properties for each tract
    const preparedTracts = tracts.map(t => {
      let b = t._bbox;
      if (!b && t.geometry) {
        b = window.turf.bbox(t);
        t._bbox = b;
      }
      let a = t._area;
      if (!a && t.geometry) {
        a = window.turf.area(t);
        t._area = a;
      }
      const p = t.properties || {};
      const pop = Number(p.populacao_total ?? p.populacao ?? p.v0001 ?? 0);
      const income = Number(p.renda_per_capita ?? 0);
      const dom = Number(p.domicilios ?? p.v0007 ?? 0);
      const agua = p.pct_agua_encanada !== undefined ? Number(p.pct_agua_encanada) : null;
      const esgoto = p.pct_esgoto_coletado !== undefined ? Number(p.pct_esgoto_coletado) : null;
      return {
        feature: t,
        bbox: b,
        area: a,
        pop,
        income,
        dom,
        agua,
        esgoto
      };
    });

    const cells = cellsFC.features;

    cells.forEach(cell => {
      if (!cell.geometry) return;
      const cellBbox = window.turf.bbox(cell);
      const cellArea = window.turf.area(cell);

      // Fast bounding box overlap filtering
      const candidateTracts = preparedTracts.filter(pt => {
        if (!pt.bbox) return false;
        return !(
          pt.bbox[2] < cellBbox[0] ||
          pt.bbox[0] > cellBbox[2] ||
          pt.bbox[3] < cellBbox[1] ||
          pt.bbox[1] > cellBbox[3]
        );
      });

      let totalAllocatedPop = 0;
      let totalAllocatedDom = 0;
      let weightedIncomeSum = 0;
      let weightedAguaSum = 0;
      let weightedEsgotoSum = 0;
      let aguaPopSum = 0;
      let esgotoPopSum = 0;
      let hasAguaCount = 0;
      let hasEsgotoCount = 0;
      let intersectingTractsCount = 0;

      for (let i = 0; i < candidateTracts.length; i++) {
        const pt = candidateTracts[i];
        if (pt.area <= 0) continue;

        try {
          const inter = window.turf.intersect(cell, pt.feature);
          if (inter && inter.geometry) {
            const interArea = window.turf.area(inter);
            if (interArea > 0) {
              const weight = Math.min(1.0, interArea / pt.area);
              const partPop = pt.pop * weight;
              const partDom = pt.dom * weight;

              totalAllocatedPop += partPop;
              totalAllocatedDom += partDom;
              if (pt.income > 0) {
                weightedIncomeSum += pt.income * partPop;
              }
              if (pt.agua !== null) {
                weightedAguaSum += pt.agua * partPop;
                aguaPopSum += partPop;
                hasAguaCount++;
              }
              if (pt.esgoto !== null) {
                weightedEsgotoSum += pt.esgoto * partPop;
                esgotoPopSum += partPop;
                hasEsgotoCount++;
              }
              intersectingTractsCount++;
            }
          }
        } catch (_) {
          // Ignore occasional topology glitches during intersection
        }
      }

      const finalPop = Math.round(totalAllocatedPop);
      const finalDom = Math.round(totalAllocatedDom);
      const finalIncome = totalAllocatedPop > 0 && weightedIncomeSum > 0
        ? Math.round(weightedIncomeSum / totalAllocatedPop)
        : 0;

      const finalAgua = aguaPopSum > 0
        ? Number((weightedAguaSum / aguaPopSum).toFixed(1))
        : null;

      const finalEsgoto = esgotoPopSum > 0
        ? Number((weightedEsgotoSum / esgotoPopSum).toFixed(1))
        : null;

      // PNAB Overload Ratio: dynamic calculation per active health teams (eSF)
      const cellProps = cell.properties || {};
      const qtdEsf = Number(cellProps.qtd_equipes_esf) > 0 ? Number(cellProps.qtd_equipes_esf) : 1;
      const nominalCap = Number(cellProps.capacidade_pnab) > 0 ? Number(cellProps.capacidade_pnab) : (qtdEsf * 3500);
      const sobrecargaPnab = Number((finalPop / nominalCap).toFixed(2));
      const critPop = Math.round(nominalCap * 1.714);

      let pnabClassification = `Adequada (≤ ${nominalCap.toLocaleString('pt-BR')} hab)`;
      let pnabClassColor = '#10b981'; // Green
      if (sobrecargaPnab > 1.8 || finalPop > critPop) {
        pnabClassification = `Crítica (> ${critPop.toLocaleString('pt-BR')} hab)`;
        pnabClassColor = '#ef4444'; // Red
      } else if (sobrecargaPnab > 1.0 || finalPop > nominalCap) {
        pnabClassification = `Atenção (${(nominalCap + 1).toLocaleString('pt-BR')} a ${critPop.toLocaleString('pt-BR')} hab)`;
        pnabClassColor = '#f59e0b'; // Amber
      }

      cell.properties = {
        ...cell.properties,
        hasCensusData: true,
        populacao_total: finalPop,
        populacao_estimada: finalPop,
        renda_per_capita: finalIncome,
        renda_per_capita_estimada: finalIncome,
        domicilios_estimados: finalDom,
        pct_agua_encanada: finalAgua,
        pct_esgoto_coletado: finalEsgoto,
        qtd_equipes_esf: qtdEsf,
        capacidade_pnab: nominalCap,
        sobrecarga_pnab: sobrecargaPnab,
        pnab_class: pnabClassification,
        pnab_color: pnabClassColor,
        intersecting_tracts_count: intersectingTractsCount,
        situacao_filtro: situacao,
        area_km2: Number((cellArea / 1e6).toFixed(2)),
        densidade_demografica: cellArea > 0 ? Number((finalPop / (cellArea / 1e6)).toFixed(1)) : 0
      };

      if (cell.properties.facilitiesCount !== undefined) {
        const count = cell.properties.facilitiesCount;
        cell.properties.hab_per_unit = count > 0 ? Math.round(finalPop / count) : finalPop;
      }
    });

    return cellsFC;
  }

  /**
   * Helper formatting functions for labels
   */
  function formatMetricValue(val, unit = '') {
    if (val === undefined || val === null || isNaN(val)) return '0';
    const num = Math.round(val);
    if (unit === 'R$') {
      return `R$ ${num.toLocaleString('pt-BR')}`;
    }
    if (unit === 'hab.') {
      return `${num.toLocaleString('pt-BR')} hab.`;
    }
    if (unit === 'hab/unid') {
      return `${num.toLocaleString('pt-BR')} hab/unid`;
    }
    if (unit) {
      return `${num.toLocaleString('pt-BR')} ${unit}`;
    }
    return num.toLocaleString('pt-BR');
  }

  function formatRange(bMin, bMax, unit = '') {
    const minStr = Math.round(bMin).toLocaleString('pt-BR');
    const maxStr = Math.round(bMax).toLocaleString('pt-BR');
    if (bMin === bMax) {
      return unit === 'R$' ? `R$ ${minStr}` : `${minStr}${unit ? ' ' + unit : ''}`;
    }
    if (unit === 'R$') {
      return `R$ ${minStr} a R$ ${maxStr}`;
    }
    return `${minStr} - ${maxStr}${unit ? ' ' + unit : ''}`;
  }

  const _maskCache = new Map();

  /**
   * Clears the cached territorial masks.
   */
  function clearMaskCache() {
    _maskCache.clear();
  }

  /**
   * Hierarchical union of polygon features to prevent call stack limits and maximize speed.
   * Handles non-contiguous MultiPolygons (e.g. multiple distinct urban clusters).
   */
  function hierarchicalUnion(features) {
    if (!features || features.length === 0) return null;
    if (features.length === 1) return features[0];
    let current = [...features];
    while (current.length > 1) {
      const next = [];
      for (let i = 0; i < current.length; i += 2) {
        if (i + 1 < current.length) {
          try {
            const u = window.turf.union(current[i], current[i + 1]);
            next.push(u || current[i]);
          } catch (_) {
            next.push(current[i]);
          }
        } else {
          next.push(current[i]);
        }
      }
      current = next;
    }
    return current[0];
  }

  /**
   * Extracts territorial clipping mask (e.g. urban or rural non-contiguous MultiPolygon, or municipal boundary).
   */
  function getTerritorialMask(boundaryGeojson, censusTractsFC, situacao = 'ambos') {
    const bFeat = (boundaryGeojson && boundaryGeojson.features && boundaryGeojson.features.length > 0)
      ? boundaryGeojson.features[0]
      : (boundaryGeojson && boundaryGeojson.geometry ? boundaryGeojson : null);

    const sitClean = (situacao || 'ambos').toLowerCase();
    if (sitClean === 'ambos' || sitClean === 'todas' || sitClean === 'todos' || !censusTractsFC || !censusTractsFC.features || censusTractsFC.features.length === 0) {
      return bFeat;
    }

    const munCode = censusTractsFC.metadata?.ibge_code || 'mun';
    const cacheKey = `${munCode}_${sitClean}`;
    if (_maskCache.has(cacheKey)) {
      return _maskCache.get(cacheKey);
    }

    const target = sitClean.includes('urban') ? 'urban' : 'rural';
    const matchingTracts = censusTractsFC.features.filter(f => {
      const sit = String(f.properties?.situacao || '').toLowerCase();
      return sit.includes(target);
    });

    if (matchingTracts.length === 0) {
      _maskCache.set(cacheKey, bFeat);
      return bFeat;
    }

    try {
      let mask = hierarchicalUnion(matchingTracts);
      if (bFeat && mask) {
        try {
          const inter = window.turf.intersect(mask, bFeat);
          if (inter && inter.geometry && inter.geometry.coordinates) {
            mask = inter;
          }
        } catch (_) {}
      }
      _maskCache.set(cacheKey, mask);
      return mask;
    } catch (err) {
      console.warn('[GeospatialAnalysis] Failed to create territorial mask:', err);
      _maskCache.set(cacheKey, bFeat);
      return bFeat;
    }
  }

  /**
   * Compute Voronoi polygons around point features.
   * Delimited by padded bounding box and clipped by active territorial mask (or municipal boundary).
   * Enriched with census demographics and colored by selected metric.
   * Properly handles non-contiguous MultiPolygons (e.g. multiple urban clusters).
   * 
   * @param {Array} features
   * @param {number} [marginKm=4.0]
   * @param {Object} [boundaryGeojson=null]
   * @param {Object} [censusTractsFC=null]
   * @param {string} [metric='category'] - 'category' | 'population' | 'income' | 'sobrecarga'
   * @param {string} [classificationMethod='jenks'] - 'continuous' | 'quartiles' | 'equal_5' | 'equal_10' | 'std_dev' | 'jenks'
   * @param {string} [situacao='ambos'] - 'ambos' | 'urbanos' | 'rurais'
   */
  function computeVoronoi(features, marginKm = 4.0, boundaryGeojson = null, censusTractsFC = null, metric = 'category', classificationMethod = 'jenks', situacao = 'ambos') {
    if (!window.turf) {
      console.error('Turf.js is not loaded.');
      const emptyFC = { type: 'FeatureCollection', features: [] };
      emptyFC.classification = null;
      emptyFC.metric = metric;
      emptyFC.activeMethod = classificationMethod;
      return emptyFC;
    }

    if (!features || features.length === 0) {
      const emptyFC = { type: 'FeatureCollection', features: [] };
      emptyFC.classification = null;
      emptyFC.metric = metric;
      emptyFC.activeMethod = classificationMethod;
      return emptyFC;
    }

    const clipFeat = getTerritorialMask(boundaryGeojson, censusTractsFC, situacao);
    const bFeat = (boundaryGeojson && boundaryGeojson.features && boundaryGeojson.features.length > 0)
      ? boundaryGeojson.features[0]
      : (boundaryGeojson && boundaryGeojson.geometry ? boundaryGeojson : null);
    const targetMask = clipFeat || bFeat;

    let validPolygons = [];

    // Single facility case: target mask geometry or circular buffer
    if (features.length === 1) {
      const pt = features[0];
      let polyGeom = null;
      if (targetMask && targetMask.geometry) {
        polyGeom = JSON.parse(JSON.stringify(targetMask.geometry));
      } else {
        const buffer = window.turf.buffer(pt, marginKm, { units: 'kilometers' });
        if (buffer) polyGeom = buffer.geometry;
      }

      if (polyGeom) {
        validPolygons.push({
          type: 'Feature',
          id: 'voronoi-' + (pt.properties['ref:CNES'] || '0'),
          geometry: polyGeom,
          properties: {
            ...pt.properties,
            pointId: pt.id,
            facilityName: pt.properties.name || pt.properties.official_name || 'Estabelecimento de Saúde',
            cnes: pt.properties['ref:CNES'] || '—',
            category: pt.properties.comment || 'Saúde',
            address: [pt.properties['addr:street'], pt.properties['addr:housenumber'], pt.properties['addr:suburb']].filter(Boolean).join(', '),
            baseColor: pt.properties.color || '#7c3aed'
          }
        });
      }
    } else {
      try {
        const fc = window.turf.featureCollection(features);
        let bbox = targetMask ? window.turf.bbox(targetMask) : window.turf.bbox(fc);

        // Pad bounding box in degrees (1 deg lat ~ 111km)
        const padDegLat = Math.max(marginKm / 111.0, 0.04);
        const avgLat = (bbox[1] + bbox[3]) / 2;
        const padDegLon = Math.max(marginKm / (111.0 * Math.cos((avgLat * Math.PI) / 180)), 0.04);

        const paddedBbox = [
          bbox[0] - padDegLon,
          bbox[1] - padDegLat,
          bbox[2] + padDegLon,
          bbox[3] + padDegLat,
        ];

        const voronoiResult = window.turf.voronoi(fc, { bbox: paddedBbox });
        if (!voronoiResult || !voronoiResult.features) {
          const emptyFC = { type: 'FeatureCollection', features: [] };
          emptyFC.classification = null;
          emptyFC.metric = metric;
          return emptyFC;
        }

        voronoiResult.features.forEach((poly, idx) => {
          if (!poly || !poly.geometry || !poly.geometry.coordinates) return;

          // Associate generating point
          let genPt = features[idx];
          if (!genPt || !window.turf.booleanPointInPolygon(genPt, poly)) {
            const matched = features.find(p => window.turf.booleanPointInPolygon(p, poly));
            if (matched) genPt = matched;
          }

          if (genPt) {
            let finalGeom = poly.geometry;

            // Crop by active territorial mask (or municipal boundary)
            if (targetMask) {
              try {
                const clipped = window.turf.intersect(poly, targetMask);
                if (clipped && clipped.geometry && clipped.geometry.coordinates) {
                  finalGeom = clipped.geometry;
                } else {
                  return; // Cell lies outside active territorial mask
                }
              } catch (clipErr) {
                console.warn('Voronoi cell clipping warning:', clipErr);
                return;
              }
            }

            const clippedPoly = {
              type: 'Feature',
              id: 'voronoi-' + (genPt.properties['ref:CNES'] || idx),
              geometry: finalGeom,
              properties: {
                ...genPt.properties,
                pointId: genPt.id,
                facilityName: genPt.properties.name || genPt.properties.official_name || 'Estabelecimento de Saúde',
                cnes: genPt.properties['ref:CNES'] || '—',
                category: genPt.properties.comment || 'Saúde',
                address: [genPt.properties['addr:street'], genPt.properties['addr:housenumber'], genPt.properties['addr:suburb']].filter(Boolean).join(', '),
                baseColor: genPt.properties.color || '#7c3aed'
              }
            };
            validPolygons.push(clippedPoly);
          }
        });
      } catch (err) {
        console.error('Error computing Voronoi diagram:', err);
        const emptyFC = { type: 'FeatureCollection', features: [] };
        emptyFC.classification = null;
        emptyFC.metric = metric;
        return emptyFC;
      }
    }

    const resultFC = {
      type: 'FeatureCollection',
      features: validPolygons
    };

    // Enrich with census demographics if census tracts are provided
    if (censusTractsFC && censusTractsFC.features && censusTractsFC.features.length > 0) {
      enrichWithCensusTracts(resultFC, censusTractsFC, situacao);
    }

    return applyMetricToFeatures(resultFC, metric, classificationMethod);
  }

  /**
   * Applies 1D statistical or PNAB classification to a Voronoi FeatureCollection.
   */
  function applyMetricToFeatures(resultFC, metric = 'category', classificationMethod = 'jenks') {
    if (!resultFC || !resultFC.features) return resultFC;

    let classification = null;

    if (metric === 'population') {
      const pops = resultFC.features.map(f => f.properties.populacao_total || 0);
      classification = classify1D(pops, classificationMethod || 'jenks', 'hab.');
      resultFC.features.forEach(f => {
        const p = f.properties.populacao_total || 0;
        f.properties.color = classification.getColor(p);
        f.properties.classIndex = classification.getClassIndex(p);
        f.properties.classLabel = classification.getClassLabel(p);
        f.properties.metricValue = p;
        f.properties.metricLabel = classification.getClassLabel(p);
      });
    } else if (metric === 'income') {
      const incomes = resultFC.features.map(f => f.properties.renda_per_capita || 0);
      classification = classify1D(incomes, classificationMethod || 'jenks', 'R$');
      resultFC.features.forEach(f => {
        const inc = f.properties.renda_per_capita || 0;
        f.properties.color = classification.getColor(inc);
        f.properties.classIndex = classification.getClassIndex(inc);
        f.properties.classLabel = classification.getClassLabel(inc);
        f.properties.metricValue = inc;
        f.properties.metricLabel = classification.getClassLabel(inc);
      });
    } else if (metric === 'saneamento_agua') {
      const aguas = resultFC.features.map(f => f.properties.pct_agua_encanada !== null && f.properties.pct_agua_encanada !== undefined ? f.properties.pct_agua_encanada : 0);
      classification = classify1D(aguas, classificationMethod || 'jenks', '%');
      resultFC.features.forEach(f => {
        const v = f.properties.pct_agua_encanada !== null && f.properties.pct_agua_encanada !== undefined ? f.properties.pct_agua_encanada : 0;
        f.properties.color = classification.getColor(v);
        f.properties.classIndex = classification.getClassIndex(v);
        f.properties.classLabel = classification.getClassLabel(v);
        f.properties.metricValue = v;
        f.properties.metricLabel = `${v}%`;
      });
    } else if (metric === 'saneamento_esgoto') {
      const esgotos = resultFC.features.map(f => f.properties.pct_esgoto_coletado !== null && f.properties.pct_esgoto_coletado !== undefined ? f.properties.pct_esgoto_coletado : 0);
      classification = classify1D(esgotos, classificationMethod || 'jenks', '%');
      resultFC.features.forEach(f => {
        const v = f.properties.pct_esgoto_coletado !== null && f.properties.pct_esgoto_coletado !== undefined ? f.properties.pct_esgoto_coletado : 0;
        f.properties.color = classification.getColor(v);
        f.properties.classIndex = classification.getClassIndex(v);
        f.properties.classLabel = classification.getClassLabel(v);
        f.properties.metricValue = v;
        f.properties.metricLabel = `${v}%`;
      });
    } else if (metric === 'sobrecarga' || metric === 'sobrecarga_pnab') {
      const adequateCount = resultFC.features.filter(f => (f.properties.pnab_color || f.properties.cor_pnab) === '#10b981').length;
      const attentionCount = resultFC.features.filter(f => (f.properties.pnab_color || f.properties.cor_pnab) === '#f59e0b').length;
      const criticalCount = resultFC.features.filter(f => (f.properties.pnab_color || f.properties.cor_pnab) === '#ef4444').length;

      classification = {
        method: 'pnab',
        type: 'binned',
        bins: [
          { label: 'Adequada (≤ 3.500 hab)', color: '#10b981', count: adequateCount },
          { label: 'Atenção (3.501 a 6.000 hab)', color: '#f59e0b', count: attentionCount },
          { label: 'Crítica / Sobrecarga (> 6.000 hab)', color: '#ef4444', count: criticalCount }
        ],
        getColor: (v) => v.pnab_color || v.cor_pnab,
        getClassIndex: (v) => 0,
        getClassLabel: (v) => v.pnab_class || v.classificacao_pnab || 'Adequada'
      };

      resultFC.features.forEach(f => {
        const c = f.properties.pnab_color || f.properties.cor_pnab || '#10b981';
        f.properties.color = c;
        f.properties.pnab_color = c;
        f.properties.metricValue = f.properties.sobrecarga_pnab || 1.0;
        f.properties.metricLabel = f.properties.pnab_class || f.properties.classificacao_pnab || 'Adequada';
      });
    } else {
      // Default: category color
      resultFC.features.forEach(f => {
        f.properties.color = f.properties.baseColor || '#7c3aed';
      });
    }

    resultFC.classification = classification;
    resultFC.metric = metric;
    resultFC.activeMethod = classificationMethod;
    return resultFC;
  }

  /**
   * 1D Statistical Classification Engine
   * @param {Array<number>} values
   * @param {string} method
   * @param {string} [unit='']
   */
  function classify1D(values, method, unit = '') {
    if (!values || values.length === 0) {
      return {
        method: method || 'continuous',
        type: 'empty',
        bins: [],
        getColor: () => '#ffffb2',
        getClassLabel: () => '0',
      };
    }

    const sorted = [...values].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const n = sorted.length;
    const ss = window.ss;

    // Handle uniform / single-value case
    if (min === max) {
      const color = '#fecc5c';
      const label = formatMetricValue(min, unit);
      return {
        method,
        type: 'single',
        min,
        max,
        bins: [{ min, max, label, color, count: n }],
        getColor: () => color,
        getClassIndex: () => 0,
        getClassLabel: () => label,
      };
    }

    // 1. Escala Contínua (Não agrupado)
    if (method === 'continuous' || !method) {
      return {
        method: 'continuous',
        type: 'continuous',
        min,
        max,
        gradientCss: 'linear-gradient(to right, #ffffb2, #fecc5c, #fd8d3c, #f03b20, #bd0026)',
        getColor: (v) => {
          const t = (v - min) / (max - min || 1);
          return interpolateColor(t);
        },
        getClassIndex: () => 0,
        getClassLabel: (v) => formatMetricValue(v, unit),
      };
    }

    // 2. Quartis (4 classes)
    if (method === 'quartiles') {
      let q1 = min, q2 = min, q3 = max;
      if (ss && ss.quantile) {
        q1 = ss.quantile(sorted, 0.25);
        q2 = ss.quantile(sorted, 0.50);
        q3 = ss.quantile(sorted, 0.75);
      } else {
        q1 = sorted[Math.floor(n * 0.25)];
        q2 = sorted[Math.floor(n * 0.50)];
        q3 = sorted[Math.floor(n * 0.75)];
      }

      // Build intervals
      const breaks = [min, q1, q2, q3, max];
      const bins = [];
      for (let i = 0; i < 4; i++) {
        const bMin = breaks[i];
        const bMax = breaks[i + 1];
        const label = formatRange(bMin, bMax, unit);
        bins.push({
          min: bMin,
          max: bMax,
          label: `Q${i + 1}: ${label}`,
          shortLabel: label,
          color: COLOR_RAMP_4[i],
          count: sorted.filter(v => i === 0 ? (v >= bMin && v <= bMax) : (v > bMin && v <= bMax)).length
        });
      }

      return createBinnedClassifier('quartiles', bins, unit);
    }

    // 3. Intervalos Iguais com 5 Quebras
    if (method === 'equal_5') {
      const step = (max - min) / 5;
      const bins = [];
      for (let i = 0; i < 5; i++) {
        const bMin = min + i * step;
        const bMax = (i === 4) ? max : min + (i + 1) * step;
        const label = formatRange(bMin, bMax, unit);
        bins.push({
          min: bMin,
          max: bMax,
          label,
          shortLabel: label,
          color: COLOR_RAMP_5[i],
          count: sorted.filter(v => i === 0 ? (v >= bMin && v <= bMax) : (v > bMin && v <= bMax)).length
        });
      }
      return createBinnedClassifier('equal_5', bins, unit);
    }

    // 4. Intervalos Iguais com 10 Quebras
    if (method === 'equal_10') {
      const step = (max - min) / 10;
      const bins = [];
      for (let i = 0; i < 10; i++) {
        const bMin = min + i * step;
        const bMax = (i === 9) ? max : min + (i + 1) * step;
        const label = formatRange(bMin, bMax, unit);
        bins.push({
          min: bMin,
          max: bMax,
          label,
          shortLabel: label,
          color: COLOR_RAMP_10[i],
          count: sorted.filter(v => i === 0 ? (v >= bMin && v <= bMax) : (v > bMin && v <= bMax)).length
        });
      }
      return createBinnedClassifier('equal_10', bins, unit);
    }

    // 5. Desvio Padrão
    if (method === 'std_dev') {
      const mean = ss && ss.mean ? ss.mean(sorted) : sorted.reduce((a, b) => a + b, 0) / n;
      const sd = ss && ss.standardDeviation ? ss.standardDeviation(sorted) : Math.sqrt(sorted.reduce((sq, n) => sq + Math.pow(n - mean, 2), 0) / (n - 1 || 1));

      if (sd === 0) {
        return classify1D(values, 'equal_5', unit);
      }

      const rawBreaks = [
        min,
        Math.max(min, mean - 1.0 * sd),
        Math.max(min, mean - 0.5 * sd),
        Math.min(max, mean + 0.5 * sd),
        Math.min(max, mean + 1.0 * sd),
        max
      ];

      const sdLabels = ['< -1.0 σ', '-1.0 a -0.5 σ', 'Média (±0.5 σ)', '+0.5 a +1.0 σ', '> +1.0 σ'];
      const bins = [];
      for (let i = 0; i < 5; i++) {
        const bMin = rawBreaks[i];
        const bMax = rawBreaks[i + 1];
        const rangeText = formatRange(bMin, bMax, unit);
        bins.push({
          min: bMin,
          max: bMax,
          label: `${sdLabels[i]} (${rangeText})`,
          shortLabel: rangeText,
          color: COLOR_RAMP_5[i],
          count: sorted.filter(v => i === 0 ? (v >= bMin && v <= bMax) : (v > bMin && v <= bMax)).length
        });
      }

      return createBinnedClassifier('std_dev', bins, unit);
    }

    // 6. Quebras Naturais (Jenks / Fisher-Ckmeans)
    if (method === 'jenks') {
      const uniqueVals = Array.from(new Set(sorted));
      const k = Math.min(5, uniqueVals.length);

      if (k <= 1 || !ss || !ss.ckmeans) {
        return classify1D(values, 'equal_5', unit);
      }

      try {
        const clusters = ss.ckmeans(sorted, k);
        const ramp = (k === 4) ? COLOR_RAMP_4 : (k === 5 ? COLOR_RAMP_5 : COLOR_RAMP_6);
        const bins = clusters.map((cluster, i) => {
          const cMin = cluster[0];
          const cMax = cluster[cluster.length - 1];
          const label = formatRange(cMin, cMax, unit);
          return {
            min: cMin,
            max: cMax,
            label,
            shortLabel: label,
            color: ramp[i] || ramp[ramp.length - 1],
            count: cluster.length
          };
        });

        return createBinnedClassifier('jenks', bins, unit);
      } catch (err) {
        console.warn('Jenks ckmeans failed, falling back to equal intervals:', err);
        return classify1D(values, 'equal_5', unit);
      }
    }

    // Default fallback
    return classify1D(values, 'continuous', unit);
  }

  function createBinnedClassifier(method, bins, unit = '') {
    return {
      method,
      type: 'binned',
      bins,
      min: bins[0].min,
      max: bins[bins.length - 1].max,
      getColor: (v) => {
        for (let i = 0; i < bins.length; i++) {
          const bin = bins[i];
          if (i === 0 && v <= bin.max) return bin.color;
          if (v > bin.min && v <= bin.max) return bin.color;
        }
        return bins[bins.length - 1].color;
      },
      getClassIndex: (v) => {
        for (let i = 0; i < bins.length; i++) {
          const bin = bins[i];
          if (i === 0 && v <= bin.max) return i;
          if (v > bin.min && v <= bin.max) return i;
        }
        return bins.length - 1;
      },
      getClassLabel: (v) => {
        for (let i = 0; i < bins.length; i++) {
          const bin = bins[i];
          if (i === 0 && v <= bin.max) return bin.label;
          if (v > bin.min && v <= bin.max) return bin.label;
        }
        return bins[bins.length - 1].label;
      }
    };
  }

  /**
   * Compute Hexagonal binning for given point features.
   * Delimited by points extent and cropped by official municipal boundary when available.
   * Optionally enriched with census tracts demographics and colored by selected metric.
   * 
   * @param {Array} features
   * @param {number} [radiusKm=1.0]
   * @param {string} [classificationMethod='continuous']
   * @param {Object} [boundaryGeojson=null]
   * @param {Object} [censusTractsFC=null]
   * @param {string} [metric='count'] - 'count' | 'population' | 'income' | 'hab_per_unit'
   * @param {string} [situacao='ambos'] - 'ambos' | 'urbanos' | 'rurais'
   * @param {boolean} [occupiedOnly=true] - Only return hexagons containing facilities
   */
  function computeHexbins(features, radiusKm = 1.0, classificationMethod = 'continuous', boundaryGeojson = null, censusTractsFC = null, metric = 'count', situacao = 'ambos', occupiedOnly = true) {
    if (!window.turf) {
      console.error('Turf.js is not loaded.');
      return { featureCollection: { type: 'FeatureCollection', features: [] }, classification: null };
    }

    if (!features || features.length === 0) {
      return {
        featureCollection: { type: 'FeatureCollection', features: [] },
        classification: classify1D([], classificationMethod)
      };
    }

    const clipFeat = getTerritorialMask(boundaryGeojson, censusTractsFC, situacao);
    const bFeat = (boundaryGeojson && boundaryGeojson.features && boundaryGeojson.features.length > 0)
      ? boundaryGeojson.features[0]
      : (boundaryGeojson && boundaryGeojson.geometry ? boundaryGeojson : null);
    const targetMask = clipFeat || bFeat;

    try {
      const fc = window.turf.featureCollection(features);
      const bbox = targetMask ? window.turf.bbox(targetMask) : window.turf.bbox(fc);

      // Expand bounding box with buffer
      const padKm = radiusKm * 1.5;
      const padLat = Math.max(padKm / 111.0, 0.02);
      const avgLat = (bbox[1] + bbox[3]) / 2;
      const padLon = Math.max(padKm / (111.0 * Math.cos((avgLat * Math.PI) / 180)), 0.02);

      const paddedBbox = [
        bbox[0] - padLon,
        bbox[1] - padLat,
        bbox[2] + padLon,
        bbox[3] + padLat
      ];

      // Turf hexGrid: cellSide is the circumradius
      const hexGrid = window.turf.hexGrid(paddedBbox, radiusKm, { units: 'kilometers' });
      if (!hexGrid || !hexGrid.features || hexGrid.features.length === 0) {
        return { featureCollection: { type: 'FeatureCollection', features: [] }, classification: null };
      }

      // Collect hexagons (occupied only or full grid clipped to mask)
      const selectedHexagons = [];

      for (let i = 0; i < hexGrid.features.length; i++) {
        const hex = hexGrid.features[i];
        let finalGeom = hex.geometry;

        // Crop hexagon boundary by active territorial mask (or municipal boundary)
        if (targetMask) {
          try {
            const clipped = window.turf.intersect(hex, targetMask);
            if (clipped && clipped.geometry && clipped.geometry.coordinates) {
              finalGeom = clipped.geometry;
            } else {
              continue; // Hexagon lies outside active territorial mask
            }
          } catch (clipErr) {
            console.warn('Hexagon clipping warning:', clipErr);
            continue;
          }
        }

        const hexBbox = window.turf.bbox({ type: 'Feature', geometry: finalGeom });

        // Fast bounding-box pre-filtering
        const candidatePoints = features.filter(pt => {
          const [lon, lat] = pt.geometry.coordinates;
          return lon >= hexBbox[0] && lon <= hexBbox[2] && lat >= hexBbox[1] && lat <= hexBbox[3];
        });

        // Exact point-in-polygon verification against the clipped geometry
        const insidePoints = candidatePoints.filter(pt =>
          window.turf.booleanPointInPolygon(pt, { type: 'Feature', geometry: finalGeom })
        );

        if (insidePoints.length === 0 && occupiedOnly) continue;

        hex.geometry = finalGeom;
        hex.properties = {
          count: insidePoints.length,
          radiusKm,
          facilityNames: insidePoints.map(p => p.properties.name || p.properties.official_name || 'Sem nome').slice(0, 5),
          facilitiesCount: insidePoints.length,
          facilities: insidePoints.map(p => ({
            id: p.id,
            name: p.properties.name || p.properties.official_name || 'Sem nome',
            cnes: p.properties['ref:CNES'] || '—',
            comment: p.properties.comment || 'Saúde'
          }))
        };
        hex.id = 'hex-' + selectedHexagons.length;
        selectedHexagons.push(hex);
      }

      const hexFC = {
        type: 'FeatureCollection',
        features: selectedHexagons
      };

      // Enrich with census tracts demographics if provided
      if (censusTractsFC && censusTractsFC.features && censusTractsFC.features.length > 0) {
        enrichWithCensusTracts(hexFC, censusTractsFC, situacao);
      }

      // Determine metric values and label unit
      let values = [];
      let unit = '';
      if (metric === 'population') {
        values = selectedHexagons.map(h => h.properties.populacao_total || 0);
        unit = 'hab.';
      } else if (metric === 'income') {
        values = selectedHexagons.map(h => h.properties.renda_per_capita || 0);
        unit = 'R$';
      } else if (metric === 'hab_per_unit') {
        values = selectedHexagons.map(h => h.properties.hab_per_unit || 0);
        unit = 'hab/unid';
      } else if (metric === 'saneamento_agua') {
        values = selectedHexagons.map(h => h.properties.pct_agua_encanada !== null && h.properties.pct_agua_encanada !== undefined ? h.properties.pct_agua_encanada : 0);
        unit = '%';
      } else if (metric === 'saneamento_esgoto') {
        values = selectedHexagons.map(h => h.properties.pct_esgoto_coletado !== null && h.properties.pct_esgoto_coletado !== undefined ? h.properties.pct_esgoto_coletado : 0);
        unit = '%';
      } else if (metric === 'sobrecarga' || metric === 'sobrecarga_pnab') {
        values = selectedHexagons.map(h => h.properties.sobrecarga_pnab || 0);
        unit = '';
      } else {
        values = selectedHexagons.map(h => h.properties.count);
        unit = 'unid.';
      }

      // Perform 1D Classification
      const classification = (metric === 'sobrecarga' || metric === 'sobrecarga_pnab')
        ? {
            method: 'pnab',
            type: 'binned',
            bins: [
              { label: 'Adequada (≤ 3.500 hab)', color: '#10b981' },
              { label: 'Atenção (3.501 a 6.000 hab)', color: '#f59e0b' },
              { label: 'Crítica / Sobrecarga (> 6.000 hab)', color: '#ef4444' }
            ],
            getColor: () => '#10b981',
            getClassIndex: () => 0,
            getClassLabel: () => 'Adequada'
          }
        : classify1D(values, classificationMethod, unit);

      // Apply styling properties
      selectedHexagons.forEach(hex => {
        let val = hex.properties.count;
        let countLabel = String(hex.properties.count);

        if (metric === 'population') {
          val = hex.properties.populacao_total || 0;
          countLabel = val >= 1000 ? `${(val / 1000).toFixed(1)}k` : String(val);
        } else if (metric === 'income') {
          val = hex.properties.renda_per_capita || 0;
          countLabel = val > 0 ? `R$${val >= 1000 ? (val / 1000).toFixed(1) + 'k' : val}` : 'R$0';
        } else if (metric === 'hab_per_unit') {
          val = hex.properties.hab_per_unit || 0;
          countLabel = val >= 1000 ? `${(val / 1000).toFixed(1)}k` : String(val);
        } else if (metric === 'saneamento_agua') {
          val = hex.properties.pct_agua_encanada !== null && hex.properties.pct_agua_encanada !== undefined ? hex.properties.pct_agua_encanada : 0;
          countLabel = `${val}%`;
        } else if (metric === 'saneamento_esgoto') {
          val = hex.properties.pct_esgoto_coletado !== null && hex.properties.pct_esgoto_coletado !== undefined ? hex.properties.pct_esgoto_coletado : 0;
          countLabel = `${val}%`;
        } else if (metric === 'sobrecarga' || metric === 'sobrecarga_pnab') {
          val = hex.properties.sobrecarga_pnab || 0;
          countLabel = String(val);
          hex.properties.fillColor = hex.properties.pnab_color || '#10b981';
          hex.properties.classIndex = 0;
          hex.properties.classLabel = hex.properties.pnab_class || 'Adequada';
          hex.properties.countLabel = countLabel;
          hex.properties.metricValue = val;
          return;
        }

        hex.properties.fillColor = classification.getColor(val);
        hex.properties.classIndex = classification.getClassIndex(val);
        hex.properties.classLabel = classification.getClassLabel(val);
        hex.properties.countLabel = countLabel;
        hex.properties.metricValue = val;
      });

      return {
        featureCollection: hexFC,
        classification,
        totalFacilities: features.length,
        radiusKm,
        activeMethod: classificationMethod,
        metric
      };
    } catch (err) {
      console.error('Error computing Hexagonal grid:', err);
      return {
        featureCollection: { type: 'FeatureCollection', features: [] },
        classification: null
      };
    }
  }

  // Export to global window object
  window.GeospatialAnalysis = {
    filterPointsInBoundary,
    clusterNearbyPoints,
    computeVoronoi,
    computeHexbins,
    classify1D,
    applyMetricToFeatures,
    enrichWithCensusTracts,
    getTerritorialMask,
    clearMaskCache,
    interpolateColor,
    rgbToHex,
    COLOR_RAMP_4,
    COLOR_RAMP_5,
    COLOR_RAMP_10
  };

})(typeof window !== 'undefined' ? window : this);
