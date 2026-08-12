/**
 * GeolocationService — versión Angular / Ionic (RxJS).
 * Misma lógica que geolocation.service.js pero con Observables e inyección de dependencias.
 *
 *   constructor(private geo: GeolocationService) {}
 *   ngOnInit() {
 *     this.geo.position$.subscribe(p => this.marcador.setLatLng([p.lat, p.lng]));
 *     this.geo.start();
 *   }
 *   ngOnDestroy() { this.geo.stop(); }
 */
import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { BehaviorSubject, Observable, Subject } from 'rxjs';

export interface Position {
  lat: number;
  lng: number;
  accuracy: number;            // metros (radio de 68% de confianza)
  altitude: number | null;
  altitudeAccuracy: number | null;
  heading: number | null;      // grados
  speed: number | null;        // m/s
  timestamp: number;
}

export interface GeoOptions {
  enableHighAccuracy?: boolean;
  timeout?: number;
  maximumAge?: number;
  maxAccuracy?: number;        // descarta lecturas peores a N metros (0 = sin filtro)
  minDistance?: number;        // metros mínimos de desplazamiento para emitir
}

export type Quality = 'alta' | 'media' | 'baja' | 'sin dato';

const ERRORS: Record<number, string> = {
  1: 'Permiso de ubicación denegado por el usuario.',
  2: 'Posición no disponible: sin señal GPS ni red utilizable.',
  3: 'Se agotó el tiempo de espera al obtener la posición.'
};

@Injectable({ providedIn: 'root' })
export class GeolocationService implements OnDestroy {
  private watchId: number | null = null;

  private readonly _position$ = new Subject<Position>();
  private readonly _error$ = new Subject<string>();
  private readonly _watching$ = new BehaviorSubject<boolean>(false);

  /** Cada posición válida. */
  readonly position$: Observable<Position> = this._position$.asObservable();
  /** Mensajes de error legibles. */
  readonly error$: Observable<string> = this._error$.asObservable();
  /** true mientras watchPosition está activo. */
  readonly watching$: Observable<boolean> = this._watching$.asObservable();

  last: Position | null = null;
  best: Position | null = null;
  samples = 0;

  private options: Required<GeoOptions> = {
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 0,
    maxAccuracy: 100,
    minDistance: 2
  };

  // NgZone: los callbacks del GPS vienen de fuera de Angular y sin esto
  // la vista no se refresca.
  constructor(private zone: NgZone) {}

  configure(options: GeoOptions): void {
    this.options = { ...this.options, ...options };
  }

  get isWatching(): boolean {
    return this._watching$.value;
  }

  async permission(): Promise<PermissionState | 'unknown'> {
    if (!navigator.permissions?.query) return 'unknown';
    try {
      const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
      return status.state;
    } catch {
      return 'unknown';
    }
  }

  start(): void {
    if (this.isWatching) return;
    if (!('geolocation' in navigator)) {
      this._error$.next('Este navegador no soporta geolocalización.');
      return;
    }
    if (!window.isSecureContext) {
      this._error$.next('La geolocalización requiere https:// o localhost.');
      return;
    }

    this._watching$.next(true);
    this.watchId = navigator.geolocation.watchPosition(
      pos => this.zone.run(() => this.handle(pos)),
      err => this.zone.run(() => {
        this._error$.next(ERRORS[err.code] ?? err.message);
        if (err.code === 1) this.stop();   // permiso denegado: no se recupera solo
      }),
      {
        enableHighAccuracy: this.options.enableHighAccuracy,
        timeout: this.options.timeout,
        maximumAge: this.options.maximumAge
      }
    );
  }

  stop(): void {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this._watching$.next(false);
  }

  toggle(): void {
    this.isWatching ? this.stop() : this.start();
  }

  /** Lectura única. */
  once(): Promise<Position> {
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        pos => this.zone.run(() => resolve(this.normalize(pos))),
        err => this.zone.run(() => reject(new Error(ERRORS[err.code] ?? err.message))),
        {
          enableHighAccuracy: this.options.enableHighAccuracy,
          timeout: this.options.timeout,
          maximumAge: this.options.maximumAge
        }
      );
    });
  }

  private handle(pos: GeolocationPosition): void {
    const p = this.normalize(pos);
    this.samples++;

    if (this.options.maxAccuracy > 0 && p.accuracy > this.options.maxAccuracy) return;
    if (this.options.minDistance > 0 && this.last &&
        GeolocationService.distance(this.last, p) < this.options.minDistance) return;

    if (!this.best || p.accuracy < this.best.accuracy) this.best = p;
    this.last = p;
    this._position$.next(p);
  }

  private normalize(pos: GeolocationPosition): Position {
    const c = pos.coords;
    return {
      lat: c.latitude,
      lng: c.longitude,
      accuracy: c.accuracy,
      altitude: c.altitude,
      altitudeAccuracy: c.altitudeAccuracy,
      heading: c.heading,
      speed: c.speed,
      timestamp: pos.timestamp
    };
  }

  /** Distancia en metros entre dos puntos (Haversine). */
  static distance(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
    const R = 6371000;
    const toRad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toRad;
    const dLng = (b.lng - a.lng) * toRad;
    const s = Math.sin(dLat / 2) ** 2 +
              Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }

  static quality(accuracy: number | null): Quality {
    if (accuracy == null) return 'sin dato';
    if (accuracy <= 10) return 'alta';
    if (accuracy <= 50) return 'media';
    return 'baja';
  }

  ngOnDestroy(): void {
    this.stop();
    this._position$.complete();
    this._error$.complete();
    this._watching$.complete();
  }
}
