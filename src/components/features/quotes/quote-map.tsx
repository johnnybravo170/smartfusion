'use client';

/**
 * Google Maps satellite view with polygon drawing for the quoting engine.
 *
 * Flow:
 *   1. Address search (Places Autocomplete)
 *   2. Geocode → center map → satellite view → zoom ~19
 *   3. Drawing tools (polygon only)
 *   4. On polygon complete → compute area → pick surface type → add to surfaces
 *   5. Multiple polygons, each labeled
 *   6. Real-time total
 */

import {
  Autocomplete,
  DrawingManager,
  GoogleMap,
  Polygon,
  useJsApiLoader,
} from '@react-google-maps/api';
import { Loader2, MapPin } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { CatalogEntryRow } from '@/lib/db/queries/service-catalog';
import { type CatalogEntry, calculateSurfacePrice } from '@/lib/pricing/calculator';

const LIBRARIES: ('drawing' | 'geometry' | 'places')[] = ['drawing', 'geometry', 'places'];

const MAP_CONTAINER_STYLE = {
  width: '100%',
  height: '400px',
  borderRadius: '0.75rem',
};

const DEFAULT_CENTER = { lat: 49.0504, lng: -122.3045 }; // Abbotsford BC
const DEFAULT_ZOOM = 17;

type DrawnPolygon = {
  id: string;
  path: google.maps.LatLngLiteral[];
  sqft: number;
  surface_type: string;
  label: string;
  price_cents: number;
  polygon_geojson: unknown;
};

type QuoteMapProps = {
  catalog: CatalogEntryRow[];
  onSurfaceAdd: (surface: {
    id: string;
    surface_type: string;
    label: string;
    sqft: number;
    price_cents: number;
    polygon_geojson: unknown;
  }) => void;
  onSurfaceRemove: (id: string) => void;
  existingPolygons?: DrawnPolygon[];
};

function pathToGeoJson(path: google.maps.LatLngLiteral[]): unknown {
  const coords = path.map((p) => [p.lng, p.lat]);
  // Close the ring per GeoJSON spec.
  if (coords.length > 0) {
    coords.push(coords[0]);
  }
  return {
    type: 'Polygon',
    coordinates: [coords],
  };
}

export function QuoteMap({
  catalog,
  onSurfaceAdd,
  onSurfaceRemove,
  existingPolygons = [],
}: QuoteMapProps) {
  const { isLoaded, loadError } = useJsApiLoader({
    googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '',
    libraries: LIBRARIES,
  });

  const [map, setMap] = useState<google.maps.Map | null>(null);
  const [center, setCenter] = useState(DEFAULT_CENTER);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [polygons, setPolygons] = useState<DrawnPolygon[]>(existingPolygons);
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null);

  // Dialog state for surface type picker after polygon drawn.
  const [pendingPath, setPendingPath] = useState<google.maps.LatLngLiteral[] | null>(null);
  const [pendingSqft, setPendingSqft] = useState(0);
  const [selectedType, setSelectedType] = useState('');

  const onMapLoad = useCallback((mapInstance: google.maps.Map) => {
    setMap(mapInstance);
  }, []);

  const onAutocompletePlaceChanged = useCallback(() => {
    const autocomplete = autocompleteRef.current;
    if (!autocomplete) return;

    const place = autocomplete.getPlace();
    if (place.geometry?.location) {
      const loc = {
        lat: place.geometry.location.lat(),
        lng: place.geometry.location.lng(),
      };
      setCenter(loc);
      setZoom(19);
      map?.panTo(loc);
      map?.setZoom(19);
    }
  }, [map]);

  const onPolygonComplete = useCallback(
    (polygon: google.maps.Polygon) => {
      const path = polygon
        .getPath()
        .getArray()
        .map((p) => ({ lat: p.lat(), lng: p.lng() }));

      // Calculate area: m² → sqft.
      const areaM2 = google.maps.geometry.spherical.computeArea(polygon.getPath());
      const sqft = Math.round(areaM2 * 10.764 * 10) / 10;

      // Remove the raw drawn polygon (we'll render our own controlled ones).
      polygon.setMap(null);

      setPendingPath(path);
      setPendingSqft(sqft);
      setSelectedType(catalog[0]?.surface_type ?? '');
    },
    [catalog],
  );

  const handleConfirmSurface = useCallback(() => {
    if (!pendingPath || !selectedType) return;

    const entry = catalog.find((c) => c.surface_type === selectedType);
    if (!entry) return;

    const price_cents = calculateSurfacePrice(
      { surface_type: selectedType, sqft: pendingSqft },
      entry as CatalogEntry,
    );

    const id = crypto.randomUUID();
    const newPolygon: DrawnPolygon = {
      id,
      path: pendingPath,
      sqft: pendingSqft,
      surface_type: selectedType,
      label: entry.label,
      price_cents,
      polygon_geojson: pathToGeoJson(pendingPath),
    };

    setPolygons((prev) => [...prev, newPolygon]);
    onSurfaceAdd({
      id,
      surface_type: selectedType,
      label: entry.label,
      sqft: pendingSqft,
      price_cents,
      polygon_geojson: newPolygon.polygon_geojson,
    });

    setPendingPath(null);
    setPendingSqft(0);
  }, [pendingPath, pendingSqft, selectedType, catalog, onSurfaceAdd]);

  const handleRemovePolygon = useCallback(
    (id: string) => {
      setPolygons((prev) => prev.filter((p) => p.id !== id));
      onSurfaceRemove(id);
    },
    [onSurfaceRemove],
  );

  if (loadError) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-dashed bg-muted/50 p-12">
        <p className="text-sm text-muted-foreground">
          Failed to load Google Maps. You can still add surfaces manually below.
        </p>
      </div>
    );
  }

  if (!isLoaded) {
    return (
      <div className="flex items-center justify-center rounded-xl border bg-muted/50 p-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">Loading map...</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Address search */}
      <div className="flex items-center gap-2">
        <MapPin className="size-4 text-muted-foreground" />
        <Autocomplete
          onLoad={(auto) => {
            autocompleteRef.current = auto;
          }}
          onPlaceChanged={onAutocompletePlaceChanged}
          options={{ componentRestrictions: { country: 'ca' } }}
        >
          <input
            type="text"
            placeholder="Search address..."
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </Autocomplete>
      </div>

      {/* Map */}
      <GoogleMap
        mapContainerStyle={MAP_CONTAINER_STYLE}
        center={center}
        zoom={zoom}
        onLoad={onMapLoad}
        mapTypeId="hybrid"
        options={{
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: true,
          zoomControl: true,
        }}
      >
        <DrawingManager
          options={{
            drawingControl: true,
            drawingControlOptions: {
              position: google.maps.ControlPosition.TOP_CENTER,
              drawingModes: [google.maps.drawing.OverlayType.POLYGON],
            },
            polygonOptions: {
              fillColor: '#3b82f6',
              fillOpacity: 0.3,
              strokeColor: '#3b82f6',
              strokeWeight: 2,
              editable: false,
            },
          }}
          onPolygonComplete={onPolygonComplete}
        />

        {/* Render saved polygons */}
        {polygons.map((p) => (
          <Polygon
            key={p.id}
            path={p.path}
            options={{
              fillColor: '#3b82f6',
              fillOpacity: 0.25,
              strokeColor: '#3b82f6',
              strokeWeight: 2,
              clickable: true,
            }}
            onClick={() => handleRemovePolygon(p.id)}
          />
        ))}
      </GoogleMap>

      <p className="text-xs text-muted-foreground">
        Draw polygons around surfaces to measure area. Click a polygon to remove it.
      </p>

      {/* Surface type picker dialog */}
      <Dialog
        open={pendingPath !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingPath(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>What surface is this?</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <p className="text-sm text-muted-foreground">
              Area measured:{' '}
              <span className="font-semibold text-foreground">{pendingSqft.toFixed(1)} sq ft</span>
            </p>
            <Select value={selectedType} onValueChange={setSelectedType}>
              <SelectTrigger>
                <SelectValue placeholder="Pick surface type" />
              </SelectTrigger>
              <SelectContent>
                {catalog.map((c) => (
                  <SelectItem key={c.surface_type} value={c.surface_type}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedType && (
              <p className="text-sm">
                Estimated price:{' '}
                <span className="font-semibold">
                  {(() => {
                    const entry = catalog.find((c) => c.surface_type === selectedType);
                    if (!entry) return '$0.00';
                    const cents = calculateSurfacePrice(
                      { surface_type: selectedType, sqft: pendingSqft },
                      entry as CatalogEntry,
                    );
                    return `$${(cents / 100).toFixed(2)}`;
                  })()}
                </span>
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setPendingPath(null)}>
              Cancel
            </Button>
            <Button type="button" onClick={handleConfirmSurface} disabled={!selectedType}>
              Add surface
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
