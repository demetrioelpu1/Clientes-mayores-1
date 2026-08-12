/**
 * offline-layer.js
 *  1. L.tileLayer.archivo — capa que dibuja las teselas desde los archivos .mapa
 *     abiertos y solo va a internet si no las encuentra.
 *  2. AreaSelector — arrastrar sobre el mapa para encuadrar el área de trabajo.
 */

/* ============ capa que lee del archivo ============ */

L.TileLayer.Archivo = L.TileLayer.extend({
  options: { capaId: 's' },

  createTile: function (coords, done) {
    var tile = document.createElement('img');
    tile.alt = '';
    var self = this;

    L.DomEvent.on(tile, 'load', L.Util.bind(this._tileOnLoad, this, done, tile));
    L.DomEvent.on(tile, 'error', L.Util.bind(this._tileOnError, this, done, tile));

    var trozo = MapArchive.tesela(this.options.capaId, coords.z, coords.x, coords.y);

    if (trozo) {
      // Del archivo: instantáneo y sin red.
      tile._objectUrl = URL.createObjectURL(trozo);
      tile.src = tile._objectUrl;
      tile.classList.add('desde-archivo');
    } else if (navigator.onLine) {
      tile.crossOrigin = '';
      tile.src = this.getTileUrl(coords);
    } else {
      // Sin red y fuera del área descargada: cuadro gris en vez de un hueco.
      tile.src = L.TileLayer.Archivo.VACIA;
    }
    return tile;
  },

  // Liberamos el objectURL cuando Leaflet descarta la tesela, no antes:
  // el navegador puede necesitar redecodificar la imagen.
  _removeTile: function (key) {
    var t = this._tiles[key];
    if (t && t.el && t.el._objectUrl) URL.revokeObjectURL(t.el._objectUrl);
    L.TileLayer.prototype._removeTile.call(this, key);
  }
});

L.TileLayer.Archivo.VACIA =
  'data:image/svg+xml;base64,' + btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">' +
    '<rect width="256" height="256" fill="#16202B"/>' +
    '<text x="128" y="130" fill="#3A4B5F" font-family="sans-serif" font-size="12" ' +
    'text-anchor="middle">fuera del area descargada</text></svg>'
  );

L.tileLayer.archivo = function (url, opciones) {
  return new L.TileLayer.Archivo(url, opciones);
};

/* ============ selector de área ============ */

/**
 * Arrastra sobre el mapa para dibujar el rectángulo de trabajo.
 * Usa eventos de puntero, así funciona igual con mouse y con dedo.
 */
function AreaSelector(map, opciones) {
  opciones = opciones || {};
  var contenedor = map.getContainer();
  var rect = null, inicio = null, activo = false;

  function aLatLng(ev) {
    var r = contenedor.getBoundingClientRect();
    return map.containerPointToLatLng([ev.clientX - r.left, ev.clientY - r.top]);
  }

  function onDown(ev) {
    if (!activo || ev.button > 0) return;
    ev.preventDefault();
    inicio = aLatLng(ev);
    if (rect) { map.removeLayer(rect); rect = null; }
    contenedor.setPointerCapture(ev.pointerId);
    contenedor.addEventListener('pointermove', onMove);
    contenedor.addEventListener('pointerup', onUp);
  }

  function onMove(ev) {
    if (!inicio) return;
    var b = L.latLngBounds(inicio, aLatLng(ev));
    if (rect) rect.setBounds(b);
    else rect = L.rectangle(b, { className: 'area-box', weight: 1.5, interactive: false }).addTo(map);
    if (opciones.onCambio) opciones.onCambio(b, true);
  }

  function onUp(ev) {
    contenedor.removeEventListener('pointermove', onMove);
    contenedor.removeEventListener('pointerup', onUp);
    inicio = null;
    detener();
    if (rect && opciones.onCambio) opciones.onCambio(rect.getBounds(), false);
  }

  function iniciar() {
    activo = true;
    map.dragging.disable();
    contenedor.style.cursor = 'crosshair';
    contenedor.style.touchAction = 'none';
    contenedor.addEventListener('pointerdown', onDown);
  }

  function detener() {
    activo = false;
    map.dragging.enable();
    contenedor.style.cursor = '';
    contenedor.style.touchAction = '';
    contenedor.removeEventListener('pointerdown', onDown);
    if (opciones.onFin) opciones.onFin();
  }

  function limpiar() {
    if (rect) { map.removeLayer(rect); rect = null; }
  }

  function mostrar(bounds) {
    limpiar();
    rect = L.rectangle(bounds, { className: 'area-box', weight: 1.5, interactive: false }).addTo(map);
  }

  return {
    iniciar: iniciar,
    detener: detener,
    limpiar: limpiar,
    mostrar: mostrar,
    get bounds() { return rect ? rect.getBounds() : null; },
    get activo() { return activo; }
  };
}
