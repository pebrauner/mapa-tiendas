/* js/geo.js — MT.geo: coordinates parsing, distances, bounding boxes and the two public OSM
 * services (Nominatim geocoding, Overpass queries) with their usage policies built in.
 *
 * Policies (SPEC §2.3, docs/TECH-NOTES.md §3):
 *  - Nominatim: max 1 request/second (global queue, ≥1.1 s between request starts), results
 *    cached per session, NEVER search-as-you-type (callers only search on Enter/button).
 *  - Overpass: one query at a time (global queue), endpoint fallback, timeout. overpass-api.de
 *    rejects file:// pages (no Referer → HTTP 406 without CORS headers), so on file:// mirrors
 *    that accept Origin:null are tried first.
 */
(function () {
  'use strict';
  var MT = window.MT;

  // Peru's bounding box (with a small margin) — used to flag suspicious coordinates.
  var PERU = { w: -81.5, s: -18.5, e: -68.5, n: 0.1 };

  var geo = (MT.geo = {
    PERU_BBOX: [PERU.w, PERU.s, PERU.e, PERU.n],

    inPeru: function (lat, lng) { return lat >= PERU.s && lat <= PERU.n && lng >= PERU.w && lng <= PERU.e; },

    /**
     * Parse coordinates typed or pasted by the user.
     * Accepts "-12.1219, -77.0297", "-12.1219 -77.0297", "-12,1219; -77,0297", "12.12 S 77.03 W",
     * Google Maps URLs (…/place/…/@-12.12,-77.03,17z/data=…!3d-12.1219!4d-77.0297, ?q=lat,lng,
     * ?query=lat,lng, ll=lat,lng, center=lat,lng). In place URLs the !3d!4d pin wins over @ (view centre).
     * Returns {lat, lng, source, swapped?} or null. See parseCoordsDetailed for the reason on failure.
     */
    parseCoords: function (text) {
      var r = geo.parseCoordsDetailed(text);
      return r && !r.error ? r : null;
    },

    /** Like parseCoords but returns {error:'empty'|'shortlink'|'invalid'|'range'} on failure. */
    parseCoordsDetailed: function (text) {
      var s = String(text || '').trim();
      if (!s) return { error: 'empty' };
      if (/^(https?:\/\/)?(maps\.app\.goo\.gl|goo\.gl\/maps)\//i.test(s)) return { error: 'shortlink' };
      var num = '(-?\\d{1,3}(?:\\.\\d+)?)';
      var m;
      if (/^https?:\/\/|google\.[a-z.]+\/maps|maps\.google/i.test(s)) {
        var dec = s;
        try { dec = decodeURIComponent(s); } catch (e) { /* keep raw */ }
        if ((m = new RegExp('!3d' + num + '!4d' + num).exec(dec))) return finish(+m[1], +m[2], 'pin');
        if ((m = new RegExp('[?&](?:q|query|ll|center|destination|daddr)=' + num + '\\s*,\\s*' + num).exec(dec))) return finish(+m[1], +m[2], 'query');
        if ((m = new RegExp('@' + num + ',' + num).exec(dec))) return finish(+m[1], +m[2], 'view');
        return { error: 'invalid' };
      }
      // Hemisphere letters: "12.12 S, 77.03 W" / "12.12°S 77.03°O"
      if ((m = /^(\d{1,2}(?:[.,]\d+)?)\s*°?\s*([NS])[\s,;]+(\d{1,3}(?:[.,]\d+)?)\s*°?\s*([EWO])$/i.exec(s))) {
        var la = parseFloat(m[1].replace(',', '.')) * (/s/i.test(m[2]) ? -1 : 1);
        var ln = parseFloat(m[3].replace(',', '.')) * (/[wo]/i.test(m[4]) ? -1 : 1);
        return finish(la, ln, 'text');
      }
      // Decimal comma ("-12,1219; -77,0297") — only when a ';' separates the pair.
      if ((m = /^(-?\d{1,3}(?:,\d+)?)\s*;\s*(-?\d{1,3}(?:,\d+)?)$/.exec(s))) {
        return finish(parseFloat(m[1].replace(',', '.')), parseFloat(m[2].replace(',', '.')), 'text');
      }
      if ((m = /^\(?\s*(-?\d{1,3}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*\)?$/.exec(s))) {
        return finish(+m[1], +m[2], 'text');
      }
      return { error: 'invalid' };
    },

    /** Great-circle distance in meters. Points as {lat,lng} or [lng,lat]. */
    distanceMeters: function (a, b) {
      var p1 = pt(a), p2 = pt(b), R = 6371008.8, rad = Math.PI / 180;
      var dLat = (p2.lat - p1.lat) * rad, dLng = (p2.lng - p1.lng) * rad;
      var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(p1.lat * rad) * Math.cos(p2.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
      return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    },

    /* ---- Bounding boxes [west, south, east, north] ---------------------------------------- */
    bboxOfPoints: function (points) {
      if (!points || !points.length) return null;
      var b = [Infinity, Infinity, -Infinity, -Infinity];
      points.forEach(function (p) { var q = pt(p); b[0] = Math.min(b[0], q.lng); b[1] = Math.min(b[1], q.lat); b[2] = Math.max(b[2], q.lng); b[3] = Math.max(b[3], q.lat); });
      return b;
    },
    bboxUnion: function (boxes) {
      var list = (boxes || []).filter(Boolean);
      if (!list.length) return null;
      return list.reduce(function (a, b) { return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]; });
    },
    /** Grow a bbox by a fraction of its size on each side (frac 0.1 = +10%). */
    bboxPad: function (b, frac) {
      if (!b) return null;
      var dx = (b[2] - b[0]) * frac, dy = (b[3] - b[1]) * frac;
      return [b[0] - dx, b[1] - dy, b[2] + dx, b[3] + dy];
    },
    /** Ensure a bbox spans at least `meters` in both directions (single store → sensible zoom). */
    bboxMinSize: function (b, meters) {
      if (!b) return null;
      var cy = (b[1] + b[3]) / 2, cx = (b[0] + b[2]) / 2;
      var dLat = meters / 111320 / 2, dLng = meters / (111320 * Math.cos(cy * Math.PI / 180)) / 2;
      return [Math.min(b[0], cx - dLng), Math.min(b[1], cy - dLat), Math.max(b[2], cx + dLng), Math.max(b[3], cy + dLat)];
    },
    bboxContains: function (b, lat, lng) { return !!b && lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3]; },
    /** MapLibre LngLatBoundsLike from a bbox. */
    bboxToBounds: function (b) { return b ? [[b[0], b[1]], [b[2], b[3]]] : null; },

    /* ---- Web Mercator helpers for saved views ---------------------------------------------
     * A saved view is {center:[lng,lat], zoomRef}: zoomRef is the MapLibre zoom at which the map
     * frame is exactly 1000 px (reference units) wide. For a frame W px wide use
     * zoom = zoomRef + log2(W / 1000)  (geo.zoomForWidth). MapLibre's world is 512·2^z px.   */
    zoomForWidth: function (zoomRef, widthPx) { return zoomRef + Math.log2(widthPx / 1000); },
    zoomRefFor: function (zoom, widthPx) { return zoom - Math.log2(widthPx / 1000); },
    /** Mercator pixel coords of [lng,lat] in a 512·2^z world. */
    project: function (lngLat, zoom) {
      var size = 512 * Math.pow(2, zoom), lat = U_clampLat(lngLat[1]);
      var x = (lngLat[0] + 180) / 360 * size;
      var y = (1 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / Math.PI) / 2 * size;
      return [x, y];
    },
    unproject: function (xy, zoom) {
      var size = 512 * Math.pow(2, zoom);
      var lng = xy[0] / size * 360 - 180;
      var n = Math.PI - 2 * Math.PI * xy[1] / size;
      return [lng, 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))];
    },
    /** bbox [w,s,e,n] covered by a saved view in the reference frame (1000 × refHeight units). */
    viewBounds: function (view, refWidth, refHeight) {
      if (!view || !view.center || !isFinite(view.zoomRef)) return null;
      refWidth = refWidth || 1000;
      refHeight = refHeight || (MT.theme ? MT.theme.frame.refHeight : 838.7);
      var c = geo.project(view.center, view.zoomRef);
      var nw = geo.unproject([c[0] - refWidth / 2, c[1] - refHeight / 2], view.zoomRef);
      var se = geo.unproject([c[0] + refWidth / 2, c[1] + refHeight / 2], view.zoomRef);
      return [nw[0], se[1], se[0], nw[1]];
    },
  });
  function U_clampLat(lat) { return Math.max(-85.051129, Math.min(85.051129, lat)); }

  function pt(p) {
    if (Array.isArray(p)) return { lng: +p[0], lat: +p[1] };
    return { lat: +p.lat, lng: +(p.lng !== undefined ? p.lng : p.lon) };
  }
  function finish(lat, lng, source) {
    if (!isFinite(lat) || !isFinite(lng)) return { error: 'invalid' };
    var swapped = false;
    // A Peru point typed as "lng, lat" (e.g. "-77.03, -12.12") — swap it back.
    if (!geo.inPeru(lat, lng) && geo.inPeru(lng, lat)) { var t = lat; lat = lng; lng = t; swapped = true; }
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return { error: 'range' };
    var r = { lat: MT.util.round(lat, 6), lng: MT.util.round(lng, 6), source: source, inPeru: geo.inPeru(lat, lng) };
    if (swapped) r.swapped = true;
    return r;
  }

  /* ------------------------------------------------------------------------------------------
   * Nominatim (geocoding). Global queue: ≥1100 ms between request starts.
   * ---------------------------------------------------------------------------------------- */
  var NOMINATIM = 'https://nominatim.openstreetmap.org';
  var nomQueue = Promise.resolve();
  var nomLast = 0;
  var nomCache = new Map();

  function nominatimGet(path, params, signal) {
    var qs = new URLSearchParams(Object.assign({ format: 'jsonv2', 'accept-language': MT.i18n.lang === 'en' ? 'es,en' : 'es' }, params)).toString();
    var url = NOMINATIM + path + '?' + qs;
    if (nomCache.has(url)) return Promise.resolve(MT.util.clone(nomCache.get(url)));
    var job = nomQueue.then(function () {
      if (signal && signal.aborted) throw abortError();
      var wait = Math.max(0, nomLast + 1100 - Date.now());
      return MT.util.sleep(wait).then(function () {
        if (signal && signal.aborted) throw abortError();
        nomLast = Date.now();
        return fetch(url, { signal: signal, headers: { Accept: 'application/json' } });
      });
    }).then(function (r) {
      if (!r.ok) throw httpError('nominatim', r.status);
      return r.json();
    }).then(function (json) { nomCache.set(url, json); return MT.util.clone(json); });
    nomQueue = job.catch(function () { /* keep the queue alive */ });
    return job;
  }

  function placeFromNominatim(r) {
    var a = r.address || {};
    return {
      lat: MT.util.round(+r.lat, 6), lng: MT.util.round(+r.lon, 6),
      label: r.display_name,
      name: r.name || '',
      type: r.type, category: r.category || r.class,
      street: [a.road || a.pedestrian || a.footway || '', a.house_number || ''].filter(Boolean).join(' '),
      district: a.city_district || a.suburb || a.city || a.town || a.village || '',
      address: a,
      bbox: r.boundingbox ? [+r.boundingbox[2], +r.boundingbox[0], +r.boundingbox[3], +r.boundingbox[1]] : null,
      osm: r.osm_type ? r.osm_type[0] + r.osm_id : null,
    };
  }

  /**
   * Address/place search in Peru. Call ONLY on explicit submit (Enter/button).
   * opts: {limit=6, signal, bbox:[w,s,e,n] (bias, not bounded)}. Resolves [place].
   */
  geo.search = function (q, opts) {
    opts = opts || {};
    q = String(q || '').trim();
    if (!q) return Promise.resolve([]);
    var params = { q: q, countrycodes: 'pe', addressdetails: 1, limit: opts.limit || 6 };
    if (opts.bbox) { params.viewbox = opts.bbox.join(','); params.bounded = 0; }
    return nominatimGet('/search', params, opts.signal).then(function (list) { return list.map(placeFromNominatim); });
  };

  /** Reverse geocoding → place (street/district) or null. */
  geo.reverse = function (lat, lng, opts) {
    opts = opts || {};
    return nominatimGet('/reverse', { lat: lat, lon: lng, zoom: 18, addressdetails: 1 }, opts.signal)
      .then(function (r) { return r && !r.error ? placeFromNominatim(r) : null; });
  };

  /**
   * Geocode many addresses sequentially (1 req/s) — for imports.
   * items: [{query, ...}]; onProgress(doneCount, total, item, place|null, failure|null) where
   * failure = {error, status} when the SERVICE failed (offline, HTTP error) — not the same as
   * "address not found" (place null, failure null). opts: {signal, maxFailures=3}.
   * A rate limit / block (HTTP 429/403), the browser going offline or `maxFailures` failures in a
   * row stop the batch: the service is not hit again for every remaining row.
   * Resolves [{item, place|null, error?, status?}] for the items tried, with
   * `results.stopped = {error, status} | null`.
   */
  geo.geocodeBatch = function (items, onProgress, opts) {
    opts = opts || {};
    var results = [], failures = 0, stopped = null, maxFailures = opts.maxFailures || 3;
    return items.reduce(function (p, item) {
      return p.then(function () {
        if (stopped) return;
        if (opts.signal && opts.signal.aborted) throw abortError();
        var res;
        var offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        var call = offline ? Promise.reject(Object.assign(new Error('offline'), { status: 0 })) : geo.search(item.query, { limit: 1, signal: opts.signal });
        return call.then(function (list) {
          failures = 0;
          res = { item: item, place: list[0] || null };
        }, function (err) {
          if (err && err.name === 'AbortError') throw err;
          failures++;
          var status = (err && err.status) || 0;
          res = { item: item, place: null, error: (err && err.message) || 'error', status: status };
          if (offline || status === 429 || status === 403 || failures >= maxFailures) stopped = { error: res.error, status: status };
        }).then(function () {
          results.push(res);
          if (onProgress) onProgress(results.length, items.length, item, res.place, res.error ? { error: res.error, status: res.status } : null);
        });
      });
    }, Promise.resolve()).then(function () { results.stopped = stopped; return results; });
  };

  /* ------------------------------------------------------------------------------------------
   * Overpass. One query at a time; endpoint fallback on network/CORS error, 406, 429, 5xx.
   * ---------------------------------------------------------------------------------------- */
  var OVERPASS = {
    main: 'https://overpass-api.de/api/interpreter',
    coffee: 'https://overpass.private.coffee/api/interpreter',
    kumi: 'https://overpass.kumi.systems/api/interpreter',
    mailru: 'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  };
  geo.overpassEndpoints = function () {
    // overpass-api.de needs a Referer (sent from https pages, absent on file://) — TECH-NOTES §3.2.
    return MT.env.isFile
      ? [OVERPASS.coffee, OVERPASS.kumi, OVERPASS.mailru, OVERPASS.main]
      : [OVERPASS.main, OVERPASS.coffee, OVERPASS.kumi, OVERPASS.mailru];
  };
  var opQueue = Promise.resolve();

  /**
   * Run an Overpass QL query (should start with [out:json]). opts: {signal, timeoutMs=180000,
   * onStatus(info)} where info = {endpoint, attempt, state:'trying'|'failed', error?}.
   * Resolves {json, endpoint, timestamp} (timestamp = osm3s.timestamp_osm_base — data freshness).
   */
  geo.overpass = function (query, opts) {
    opts = opts || {};
    var job = opQueue.then(function () {
      var endpoints = geo.overpassEndpoints();
      var errors = [];
      // The browser knows it is offline: say so at once instead of trying every server.
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        var off = new Error('overpass-unavailable'); off.offline = true; off.network = true;
        off.details = [{ endpoint: '', error: 'offline' }];
        throw off;
      }
      function attempt(i) {
        if (i >= endpoints.length) {
          var e = new Error('overpass-unavailable'); e.details = errors;
          // Every server failed at the network level (no HTTP answer at all): no connection, or a
          // proxy blocking them. Callers stop instead of retrying for minutes.
          e.network = errors.length > 0 && errors.every(function (x) { return x.network; });
          throw e;
        }
        if (opts.signal && opts.signal.aborted) throw abortError();
        var ep = endpoints[i];
        if (opts.onStatus) opts.onStatus({ endpoint: ep, attempt: i + 1, state: 'trying' });
        var ctrl = new AbortController();
        var timer = setTimeout(function () { ctrl.abort(); }, opts.timeoutMs || 180000);
        var onAbort = function () { ctrl.abort(); };
        if (opts.signal) opts.signal.addEventListener('abort', onAbort);
        // URL-encoded form body = CORS "simple request" (no preflight).
        return fetch(ep, { method: 'POST', body: new URLSearchParams({ data: query }), signal: ctrl.signal })
          .then(function (r) {
            if (!r.ok) throw httpError('overpass', r.status);
            return r.json();
          })
          .then(function (json) {
            return { json: json, endpoint: ep, timestamp: json.osm3s && json.osm3s.timestamp_osm_base };
          }, function (err) {
            if (opts.signal && opts.signal.aborted) throw abortError();
            // TypeError "Failed to fetch" = no HTTP response (offline, DNS, blocked); our own
            // timeout is an AbortError and HTTP errors carry a status — those are worth retrying.
            errors.push({ endpoint: ep, error: err.message || String(err), status: err.status || 0, network: !err.status && err.name === 'TypeError' });
            if (opts.onStatus) opts.onStatus({ endpoint: ep, attempt: i + 1, state: 'failed', error: err.message });
            // 400 = bad query: do not hammer the other mirrors with it.
            if (err.status === 400) throw err;
            return MT.util.sleep(1000).then(function () { return attempt(i + 1); });
          })
          .finally(function () { clearTimeout(timer); if (opts.signal) opts.signal.removeEventListener('abort', onAbort); });
      }
      return attempt(0);
    });
    opQueue = job.catch(function () { /* keep queue alive */ });
    return job;
  };

  function httpError(service, status) {
    var e = new Error(service + '-http-' + status);
    e.status = status;
    return e;
  }
  function abortError() {
    try { return new DOMException('Aborted', 'AbortError'); } catch (e) { var x = new Error('Aborted'); x.name = 'AbortError'; return x; }
  }
  geo.abortError = abortError;
})();
