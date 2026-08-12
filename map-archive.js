/**
 * map-archive.js — formato de archivo .mapa
 *
 * Un archivo .mapa es autocontenido: lleva las imágenes del mapa de un área,
 * más una cabecera con su nombre, límites y niveles de zoom. Se guarda en el
 * disco o en el celular como cualquier otro archivo, se copia entre equipos y
 * se abre sin internet.
 *
 * Estructura binaria:
 *   [0..7]      "MAPAOFF1"                 firma
 *   [8..11]     uint32 LE                  largo de la cabecera
 *   [12..12+H]  JSON UTF-8                 cabecera (metadatos + índice)
 *   [12+H..]    teselas concatenadas       datos crudos (JPEG/PNG)
 *
 * El índice guarda [clave, desplazamiento, largo] por tesela, así que para
 * dibujar una sola no hace falta leer el archivo entero: se corta el trozo
 * exacto con File.slice(), que no consume memoria.
 */
window.MapArchive = (function () {
  'use strict';

  var MAGIC = 'MAPAOFF1';
  var DB_NOMBRE = 'mapas-campo';
  var DB_STORE = 'archivos';

  /** Archivos abiertos en esta sesión. */
  var abiertos = [];

  /* ============ geometría de teselas ============ */

  function aTesela(lat, lng, z) {
    var n = Math.pow(2, z), rad = lat * Math.PI / 180;
    return {
      x: Math.floor((lng + 180) / 360 * n),
      y: Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n)
    };
  }

  /**
   * capas: [{ id:'s', url:'https://.../{z}/{y}/{x}', kb:25 }, ...]
   * Devuelve [{ clave:'s/17/38210/72455', url:'...', kb:25 }, ...]
   */
  function listarTeselas(bounds, zoomMin, zoomMax, capas) {
    var lista = [];
    var sw = bounds.getSouthWest(), ne = bounds.getNorthEast();

    for (var z = zoomMin; z <= zoomMax; z++) {
      var a = aTesela(ne.lat, sw.lng, z);
      var b = aTesela(sw.lat, ne.lng, z);
      for (var x = a.x; x <= b.x; x++) {
        for (var y = a.y; y <= b.y; y++) {
          for (var i = 0; i < capas.length; i++) {
            lista.push({
              clave: capas[i].id + '/' + z + '/' + x + '/' + y,
              url: capas[i].url.replace('{z}', z).replace('{x}', x).replace('{y}', y),
              kb: capas[i].kb || 25
            });
          }
        }
      }
    }
    return lista;
  }

  function estimar(bounds, zoomMin, zoomMax, capas) {
    var lista = listarTeselas(bounds, zoomMin, zoomMax, capas);
    var kb = lista.reduce(function (t, u) { return t + u.kb; }, 0);
    return { teselas: lista.length, mb: kb / 1024, lista: lista };
  }

  /** Ancho y alto del área en km, para que el usuario sepa qué está encuadrando. */
  function dimensiones(bounds) {
    var sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
    var R = 6371, rad = Math.PI / 180;
    var alto = (ne.lat - sw.lat) * rad * R;
    var ancho = (ne.lng - sw.lng) * rad * R * Math.cos((ne.lat + sw.lat) / 2 * rad);
    return { anchoKm: Math.abs(ancho), altoKm: Math.abs(alto) };
  }

  /* ============ crear el archivo ============ */

  /**
   * Descarga las teselas y arma el Blob del .mapa.
   * control = { cancelado:false } permite abortar.
   */
  function crear(opciones) {
    var lista = opciones.lista;
    var control = opciones.control || {};
    var onProgreso = opciones.onProgreso;

    var partes = [];          // Blobs de cada tesela, en orden
    var indice = [];          // [clave, desplazamiento, largo]
    var desplazamiento = 0;
    var hechas = 0, fallidas = 0, i = 0;
    var LOTE = 6;

    function bajarUna(t, reintento) {
      return fetch(t.url, { cache: 'force-cache' })
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.blob(); })
        .then(function (blob) { return { t: t, blob: blob }; })
        .catch(function (e) {
          if (!reintento) return bajarUna(t, true);   // un reintento por tesela
          return { t: t, blob: null };
        });
    }

    function lote() {
      if (control.cancelado || i >= lista.length) return Promise.resolve();
      var grupo = lista.slice(i, i + LOTE);
      i += LOTE;

      return Promise.all(grupo.map(function (t) { return bajarUna(t, false); }))
        .then(function (resultados) {
          resultados.forEach(function (r) {
            if (!r.blob) { fallidas++; return; }
            partes.push(r.blob);
            indice.push([r.t.clave, desplazamiento, r.blob.size]);
            desplazamiento += r.blob.size;
            hechas++;
          });
          if (onProgreso) onProgreso(hechas + fallidas, lista.length, desplazamiento / 1048576);
          return lote();
        });
    }

    return lote().then(function () {
      if (control.cancelado) return { cancelado: true };

      var meta = {
        formato: MAGIC,
        nombre: opciones.nombre || 'Área sin nombre',
        creado: new Date().toISOString(),
        bounds: {
          s: opciones.bounds.getSouth(), o: opciones.bounds.getWest(),
          n: opciones.bounds.getNorth(), e: opciones.bounds.getEast()
        },
        zoomMin: opciones.zoomMin,
        zoomMax: opciones.zoomMax,
        capas: opciones.capas.map(function (c) { return c.id; }),
        teselas: indice.length,
        bytes: desplazamiento,
        indice: indice
      };

      var cabecera = new TextEncoder().encode(JSON.stringify(meta));
      var largo = new Uint8Array(4);
      new DataView(largo.buffer).setUint32(0, cabecera.length, true);

      var blob = new Blob(
        [new TextEncoder().encode(MAGIC), largo, cabecera].concat(partes),
        { type: 'application/octet-stream' }
      );

      return { blob: blob, meta: meta, fallidas: fallidas };
    });
  }

  /** Dispara la descarga del archivo al almacenamiento del dispositivo. */
  function guardar(blob, nombre) {
    var a = document.createElement('a');
    var url = URL.createObjectURL(blob);
    a.href = url;
    a.download = nombre.replace(/[^\w\sáéíóúñÁÉÍÓÚÑ-]/g, '').trim().replace(/\s+/g, '-') + '.mapa';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }

  /* ============ abrir el archivo ============ */

  /** Lee solo la cabecera. El resto se corta bajo demanda. */
  function abrir(file) {
    return file.slice(0, 12).arrayBuffer().then(function (buf) {
      var firma = new TextDecoder().decode(new Uint8Array(buf, 0, 8));
      if (firma !== MAGIC) throw new Error('Este archivo no es un mapa .mapa válido.');

      var largo = new DataView(buf).getUint32(8, true);
      return file.slice(12, 12 + largo).arrayBuffer().then(function (h) {
        var meta = JSON.parse(new TextDecoder().decode(h));
        var inicio = 12 + largo;

        var indice = new Map();
        meta.indice.forEach(function (e) { indice.set(e[0], [inicio + e[1], e[2]]); });

        var archivo = {
          id: meta.nombre + '|' + meta.creado,
          file: file, meta: meta, indice: indice,
          bounds: L.latLngBounds([meta.bounds.s, meta.bounds.o], [meta.bounds.n, meta.bounds.e])
        };

        // Reemplaza si ya estaba abierto el mismo archivo.
        abiertos = abiertos.filter(function (a) { return a.id !== archivo.id; });
        abiertos.push(archivo);
        return archivo;
      });
    });
  }

  function cerrar(id) {
    abiertos = abiertos.filter(function (a) { return a.id !== id; });
  }

  /**
   * Busca una tesela en todos los archivos abiertos.
   * Devuelve el Blob del trozo exacto, o null.
   */
  function tesela(capaId, z, x, y) {
    var clave = capaId + '/' + z + '/' + x + '/' + y;
    for (var i = abiertos.length - 1; i >= 0; i--) {
      var e = abiertos[i].indice.get(clave);
      if (e) return abiertos[i].file.slice(e[0], e[0] + e[1]);
    }
    return null;
  }

  /* ============ recordar archivos en el dispositivo ============ */

  function db() {
    return new Promise(function (res, rej) {
      var req = indexedDB.open(DB_NOMBRE, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(DB_STORE, { keyPath: 'id' });
      };
      req.onsuccess = function () { res(req.result); };
      req.onerror = function () { rej(req.error); };
    });
  }

  function tx(modo, fn) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction(DB_STORE, modo);
        var r = fn(t.objectStore(DB_STORE));
        t.oncomplete = function () { res(r && r.result); };
        t.onerror = function () { rej(t.error); };
      });
    });
  }

  function recordar(archivo) {
    return tx('readwrite', function (s) {
      return s.put({ id: archivo.id, nombre: archivo.meta.nombre, blob: archivo.file });
    });
  }

  function olvidar(id) {
    return tx('readwrite', function (s) { return s.delete(id); });
  }

  /** Vuelve a abrir todos los archivos recordados (al arrancar la app). */
  function recordados() {
    return tx('readonly', function (s) { return s.getAll(); })
      .then(function (filas) {
        return Promise.all((filas || []).map(function (f) {
          var b = f.blob;
          if (!b.name) b = new File([b], f.nombre + '.mapa');
          return abrir(b).catch(function () { return null; });
        }));
      })
      .then(function (r) { return r.filter(Boolean); })
      .catch(function () { return []; });
  }

  return {
    MAGIC: MAGIC,
    get abiertos() { return abiertos; },
    listarTeselas: listarTeselas, estimar: estimar, dimensiones: dimensiones,
    crear: crear, guardar: guardar, abrir: abrir, cerrar: cerrar, tesela: tesela,
    recordar: recordar, olvidar: olvidar, recordados: recordados
  };
})();
