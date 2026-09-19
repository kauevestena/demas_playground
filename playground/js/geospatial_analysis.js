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
   * Compute Voronoi polygons around point features.
   * Delimited by padded bounding box and clipped by official municipal boundary when available.
   * @param {Array} features
   * @param {number} [marginKm=4.0]
   * @param {Object} [boundaryGeojson=null]
   */
  function computeVoronoi(features, marginKm = 4.0, boundaryGeojson = null) {
    if (!window.turf) {
      console.error('Turf.js is not loaded.');
      return { type: 'FeatureCollection', features: [] };
    }

    if (!features || features.length === 0) {
      return { type: 'FeatureCollection', features: [] };
    }

    const bFeat = (boundaryGeojson && boundaryGeojson.features && boundaryGeojson.features.length > 0)
      ? boundaryGeojson.features[0]
      : null;

    // Single facility case: municipality boundary polygon or circular buffer
    if (features.length === 1) {
      const pt = features[0];
      let polyGeom = null;
      if (bFeat && bFeat.geometry) {
        polyGeom = JSON.parse(JSON.stringify(bFeat.geometry));
      } else {
        const buffer = window.turf.buffer(pt, marginKm, { units: 'kilometers' });
        if (buffer) polyGeom = buffer.geometry;
      }

      if (polyGeom) {
        return {
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            id: 'voronoi-' + (pt.properties['ref:CNES'] || '0'),
            geometry: polyGeom,
            properties: {
              ...pt.properties,
              pointId: pt.id,
              facilityName: pt.properties.name || pt.properties.official_name || 'Estabelecimento de Saúde',
              cnes: pt.properties['ref:CNES'] || '—',
              category: pt.properties.comment || 'Saúde',
              address: [pt.properties['addr:street'], pt.properties['addr:housenumber'], pt.properties['addr:suburb']].filter(Boolean).join(', ')
            }
          }]
        };
      }
    }

    try {
      const fc = window.turf.featureCollection(features);
      let bbox = bFeat ? window.turf.bbox(bFeat) : window.turf.bbox(fc);

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
        return { type: 'FeatureCollection', features: [] };
      }

      // Filter valid polygons, link back properties, and crop to boundary if provided
      const validPolygons = [];
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

          // Crop by municipality boundary if provided
          if (bFeat) {
            try {
              const clipped = window.turf.intersect(poly, bFeat);
              if (clipped && clipped.geometry) {
                finalGeom = clipped.geometry;
              } else {
                return;
              }
            } catch (clipErr) {
              console.warn('Voronoi cell clipping warning:', clipErr);
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
              address: [genPt.properties['addr:street'], genPt.properties['addr:housenumber'], genPt.properties['addr:suburb']].filter(Boolean).join(', ')
            }
          };
          validPolygons.push(clippedPoly);
        }
      });

      return {
        type: 'FeatureCollection',
        features: validPolygons
      };
    } catch (err) {
      console.error('Error computing Voronoi diagram:', err);
      return { type: 'FeatureCollection', features: [] };
    }
  }

  /**
   * 1D Statistical Classification Engine
   */
  function classify1D(values, method) {
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
      return {
        method,
        type: 'single',
        min,
        max,
        bins: [{ min, max, label: `${min}`, color, count: n }],
        getColor: () => color,
        getClassIndex: () => 0,
        getClassLabel: () => `${min} unidades`,
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
        getClassLabel: (v) => `${v} estabelecimentos`,
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
        const label = (bMin === bMax) ? `${bMin}` : `${Math.round(bMin)} - ${Math.round(bMax)}`;
        bins.push({
          min: bMin,
          max: bMax,
          label: `Q${i + 1}: ${label}`,
          shortLabel: label,
          color: COLOR_RAMP_4[i],
          count: sorted.filter(v => i === 0 ? (v >= bMin && v <= bMax) : (v > bMin && v <= bMax)).length
        });
      }

      return createBinnedClassifier('quartiles', bins);
    }

    // 3. Intervalos Iguais com 5 Quebras
    if (method === 'equal_5') {
      const step = (max - min) / 5;
      const bins = [];
      for (let i = 0; i < 5; i++) {
        const bMin = min + i * step;
        const bMax = (i === 4) ? max : min + (i + 1) * step;
        const label = `${Math.round(bMin)} - ${Math.round(bMax)}`;
        bins.push({
          min: bMin,
          max: bMax,
          label,
          shortLabel: label,
          color: COLOR_RAMP_5[i],
          count: sorted.filter(v => i === 0 ? (v >= bMin && v <= bMax) : (v > bMin && v <= bMax)).length
        });
      }
      return createBinnedClassifier('equal_5', bins);
    }

    // 4. Intervalos Iguais com 10 Quebras
    if (method === 'equal_10') {
      const step = (max - min) / 10;
      const bins = [];
      for (let i = 0; i < 10; i++) {
        const bMin = min + i * step;
        const bMax = (i === 9) ? max : min + (i + 1) * step;
        const label = `${Math.round(bMin)} - ${Math.round(bMax)}`;
        bins.push({
          min: bMin,
          max: bMax,
          label,
          shortLabel: label,
          color: COLOR_RAMP_10[i],
          count: sorted.filter(v => i === 0 ? (v >= bMin && v <= bMax) : (v > bMin && v <= bMax)).length
        });
      }
      return createBinnedClassifier('equal_10', bins);
    }

    // 5. Desvio Padrão
    if (method === 'std_dev') {
      const mean = ss && ss.mean ? ss.mean(sorted) : sorted.reduce((a, b) => a + b, 0) / n;
      const sd = ss && ss.standardDeviation ? ss.standardDeviation(sorted) : Math.sqrt(sorted.reduce((sq, n) => sq + Math.pow(n - mean, 2), 0) / (n - 1 || 1));

      if (sd === 0) {
        return classify1D(values, 'equal_5');
      }

      // Define standard deviation bands around mean:
      // Band 1: < mean - 1.0 sd
      // Band 2: mean - 1.0 sd to mean - 0.5 sd
      // Band 3: mean - 0.5 sd to mean + 0.5 sd
      // Band 4: mean + 0.5 sd to mean + 1.0 sd
      // Band 5: > mean + 1.0 sd
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
        bins.push({
          min: bMin,
          max: bMax,
          label: `${sdLabels[i]} (${Math.round(bMin)}-${Math.round(bMax)})`,
          shortLabel: `${Math.round(bMin)}-${Math.round(bMax)}`,
          color: COLOR_RAMP_5[i],
          count: sorted.filter(v => i === 0 ? (v >= bMin && v <= bMax) : (v > bMin && v <= bMax)).length
        });
      }

      return createBinnedClassifier('std_dev', bins);
    }

    // 6. Quebras Naturais (Jenks / Fisher-Ckmeans)
    if (method === 'jenks') {
      const uniqueVals = Array.from(new Set(sorted));
      const k = Math.min(5, uniqueVals.length);

      if (k <= 1 || !ss || !ss.ckmeans) {
        return classify1D(values, 'equal_5');
      }

      try {
        const clusters = ss.ckmeans(sorted, k);
        const ramp = (k === 4) ? COLOR_RAMP_4 : (k === 5 ? COLOR_RAMP_5 : COLOR_RAMP_6);
        const bins = clusters.map((cluster, i) => {
          const cMin = cluster[0];
          const cMax = cluster[cluster.length - 1];
          const label = (cMin === cMax) ? `${cMin}` : `${cMin} - ${cMax}`;
          return {
            min: cMin,
            max: cMax,
            label,
            shortLabel: label,
            color: ramp[i] || ramp[ramp.length - 1],
            count: cluster.length
          };
        });

        return createBinnedClassifier('jenks', bins);
      } catch (err) {
        console.warn('Jenks ckmeans failed, falling back to equal intervals:', err);
        return classify1D(values, 'equal_5');
      }
    }

    // Default fallback
    return classify1D(values, 'continuous');
  }

  function createBinnedClassifier(method, bins) {
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
   * @param {Array} features
   * @param {number} [radiusKm=1.0]
   * @param {string} [classificationMethod='continuous']
   * @param {Object} [boundaryGeojson=null]
   */
  function computeHexbins(features, radiusKm = 1.0, classificationMethod = 'continuous', boundaryGeojson = null) {
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

    const bFeat = (boundaryGeojson && boundaryGeojson.features && boundaryGeojson.features.length > 0)
      ? boundaryGeojson.features[0]
      : null;

    try {
      const fc = window.turf.featureCollection(features);
      const bbox = window.turf.bbox(fc);

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

      // Collect facilities inside each hexagon
      const occupiedHexagons = [];

      for (let i = 0; i < hexGrid.features.length; i++) {
        const hex = hexGrid.features[i];
        const hexBbox = window.turf.bbox(hex);

        // Fast bounding-box pre-filtering
        const candidatePoints = features.filter(pt => {
          const [lon, lat] = pt.geometry.coordinates;
          return lon >= hexBbox[0] && lon <= hexBbox[2] && lat >= hexBbox[1] && lat <= hexBbox[3];
        });

        if (candidatePoints.length === 0) continue;

        // Exact point-in-polygon verification
        const insidePoints = candidatePoints.filter(pt => window.turf.booleanPointInPolygon(pt, hex));

        if (insidePoints.length > 0) {
          let finalGeom = hex.geometry;

          // Crop hexagon boundary by municipal perimeter if provided
          if (bFeat) {
            try {
              const clipped = window.turf.intersect(hex, bFeat);
              if (clipped && clipped.geometry) {
                finalGeom = clipped.geometry;
              }
            } catch (clipErr) {
              console.warn('Hexagon clipping warning:', clipErr);
            }
          }

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
          hex.id = 'hex-' + occupiedHexagons.length;
          occupiedHexagons.push(hex);
        }
      }

      // Perform 1D Classification
      const counts = occupiedHexagons.map(h => h.properties.count);
      const classification = classify1D(counts, classificationMethod);

      // Apply styling properties
      occupiedHexagons.forEach(hex => {
        const count = hex.properties.count;
        hex.properties.fillColor = classification.getColor(count);
        hex.properties.classIndex = classification.getClassIndex(count);
        hex.properties.classLabel = classification.getClassLabel(count);
        hex.properties.countLabel = String(count);
      });

      return {
        featureCollection: {
          type: 'FeatureCollection',
          features: occupiedHexagons
        },
        classification,
        totalFacilities: features.length,
        radiusKm,
        activeMethod: classificationMethod
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
    computeVoronoi,
    computeHexbins,
    classify1D,
    interpolateColor,
    rgbToHex,
    COLOR_RAMP_4,
    COLOR_RAMP_5,
    COLOR_RAMP_10
  };

})(typeof window !== 'undefined' ? window : this);
