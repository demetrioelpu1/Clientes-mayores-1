/**
 * GeolocationService
 * Envoltura sobre navigator.geolocation con watchPosition, control de precisión,
 * filtros de ruido y un emisor de eventos mínimo. Sin dependencias.
 *
 * Uso:
 *   const geo = new GeolocationService({ maxAccuracy: 50, minDistance: 3 });
 *   geo.on('position', p => console.log(p.lat, p.lng, p.accuracy));
 *   geo.on('error', e => console.warn(e.message));
 *   geo.start();
 *
 * Requiere contexto seguro (https:// o http://localhost).
 */
(function (global) {
  'use strict';

  var DEFAULTS = {
    enableHighAccuracy: true, // fuerza GPS en móvil (más batería, más precisión)
    timeout: 15000,           // ms máximos de espera por lectura
    maximumAge: 0,            // 0 = nunca usar caché del navegador
    maxAccuracy: 0,           // metros: descarta lecturas peores. 0 = sin filtro
    minDistance: 0,           // metros: no emite si el punto se movió menos que esto
    minInterval: 0            // ms: no emite más seguido que esto
  };

  var ERRORS = {
    1: 'Permiso de ubicación denegado por el usuario.',
    2: 'Posición no disponible: sin señal GPS ni red utilizable.',
    3: 'Se agotó el tiempo de espera al obtener la posición.'
  };

  function GeolocationService(options) {
    this.options = Object.assign({}, DEFAULTS, options || {});
    this._watchId = null;
    this._listeners = {};
    this._lastEmit = 0;

    this.watching = false;
    this.last = null;   // última posición emitida
    this.best = null;   // posición con mejor accuracy de la sesión
    this.samples = 0;   // lecturas recibidas (incluye descartadas)
  }

  GeolocationService.isSupported = function () {
    return typeof navigator !== 'undefined' && 'geolocation' in navigator;
  };

  /* ---------- eventos: 'position' | 'error' | 'status' ---------- */

  GeolocationService.prototype.on = function (event, handler) {
    (this._listeners[event] = this._listeners[event] || []).push(handler);
    return this;
  };

  GeolocationService.prototype.off = function (event, handler) {
    var list = this._listeners[event];
    if (!list) return this;
    this._listeners[event] = handler ? list.filter(function (h) { return h !== handler; }) : [];
    return this;
  };

  GeolocationService.prototype._emit = function (event, payload) {
    (this._listeners[event] || []).forEach(function (h) {
      try { h(payload); } catch (err) { console.error('[GeolocationService]', err); }
    });
  };

  /* ---------- estado del permiso ---------- */

  /** Devuelve 'granted' | 'denied' | 'prompt' | 'unknown' sin disparar el diálogo. */
  GeolocationService.prototype.permission = function () {
    if (!navigator.permissions || !navigator.permissions.query) {
      return Promise.resolve('unknown');
    }
    return navigator.permissions.query({ name: 'geolocation' })
      .then(function (status) { return status.state; })
      .catch(function () { return 'unknown'; });
  };

  /* ---------- seguimiento continuo ---------- */

  GeolocationService.prototype.start = function () {
    if (!GeolocationService.isSupported()) {
      this._emit('error', { code: 0, message: 'Este navegador no soporta geolocalización.' });
      return this;
    }
    if (!global.isSecureContext) {
      this._emit('error', {
        code: 0,
        message: 'La geolocalización solo funciona en https:// o en localhost.'
      });
      return this;
    }
    if (this.watching) return this;

    var self = this;
    this.watching = true;
    this._emit('status', { watching: true });

    this._watchId = navigator.geolocation.watchPosition(
      function (pos) { self._handle(pos); },
      function (err) {
        self._emit('error', { code: err.code, message: ERRORS[err.code] || err.message });
        // Un permiso denegado no se recupera solo: dejamos de escuchar.
        if (err.code === 1) self.stop();
      },
      {
        enableHighAccuracy: this.options.enableHighAccuracy,
        timeout: this.options.timeout,
        maximumAge: this.options.maximumAge
      }
    );
    return this;
  };

  GeolocationService.prototype.stop = function () {
    if (this._watchId !== null) navigator.geolocation.clearWatch(this._watchId);
    this._watchId = null;
    this.watching = false;
    this._emit('status', { watching: false });
    return this;
  };

  GeolocationService.prototype.toggle = function () {
    return this.watching ? this.stop() : this.start();
  };

  /** Lectura única, como promesa. */
  GeolocationService.prototype.once = function () {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (!GeolocationService.isSupported()) {
        return reject(new Error('Este navegador no soporta geolocalización.'));
      }
      navigator.geolocation.getCurrentPosition(
        function (pos) { resolve(self._normalize(pos)); },
        function (err) { reject(new Error(ERRORS[err.code] || err.message)); },
        {
          enableHighAccuracy: self.options.enableHighAccuracy,
          timeout: self.options.timeout,
          maximumAge: self.options.maximumAge
        }
      );
    });
  };

  /* ---------- interno ---------- */

  GeolocationService.prototype._normalize = function (pos) {
    var c = pos.coords;
    return {
      lat: c.latitude,
      lng: c.longitude,
      accuracy: c.accuracy,                   // metros, radio 68% de confianza
      altitude: c.altitude,                   // puede ser null
      altitudeAccuracy: c.altitudeAccuracy,
      heading: c.heading,                     // grados, null si no hay movimiento
      speed: c.speed,                         // m/s, null si no disponible
      timestamp: pos.timestamp,
      raw: pos
    };
  };

  GeolocationService.prototype._handle = function (pos) {
    var p = this._normalize(pos);
    this.samples++;

    var o = this.options;

    // 1. Filtro de precisión: descarta triangulaciones por wifi/celda muy imprecisas.
    if (o.maxAccuracy > 0 && p.accuracy > o.maxAccuracy) {
      this._emit('status', { rejected: 'accuracy', accuracy: p.accuracy, samples: this.samples });
      return;
    }

    // 2. Filtro de frecuencia.
    var now = Date.now();
    if (o.minInterval > 0 && this.last && (now - this._lastEmit) < o.minInterval) return;

    // 3. Filtro de deriva: el GPS "baila" varios metros aunque estés quieto.
    if (o.minDistance > 0 && this.last) {
      if (GeolocationService.distance(this.last, p) < o.minDistance) {
        this._emit('status', { rejected: 'distance', samples: this.samples });
        return;
      }
    }

    if (!this.best || p.accuracy < this.best.accuracy) this.best = p;
    this.last = p;
    this._lastEmit = now;
    this._emit('position', p);
  };

  /** Distancia en metros entre dos puntos {lat, lng} (Haversine). */
  GeolocationService.distance = function (a, b) {
    var R = 6371000;
    var toRad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toRad;
    var dLng = (b.lng - a.lng) * toRad;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  };

  /** Etiqueta cualitativa de la precisión. */
  GeolocationService.quality = function (accuracy) {
    if (accuracy == null) return 'sin dato';
    if (accuracy <= 10) return 'alta';
    if (accuracy <= 50) return 'media';
    return 'baja';
  };

  global.GeolocationService = GeolocationService;

  if (typeof module !== 'undefined' && module.exports) module.exports = GeolocationService;
})(typeof window !== 'undefined' ? window : this);
