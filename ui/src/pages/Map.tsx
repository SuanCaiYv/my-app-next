import { useEffect, useMemo, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import { listPhotos } from "../api";
import type { PhotoItem } from "../types";
import L from "leaflet";

const defaultIcon = L.icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

export default function MapPage() {
  const [photos, setPhotos] = useState<PhotoItem[]>([]);

  useEffect(() => {
    listPhotos().then(setPhotos).catch(() => {});
  }, []);

  const located = useMemo(
    () => photos.filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude)),
    [photos]
  );

  const bounds = useMemo(() => {
    if (!located.length) return null;
    return L.latLngBounds(located.map((p) => [p.latitude!, p.longitude!]));
  }, [located]);

  return (
    <section className="view active" id="mapView">
      {located.length === 0 ? (
        <div className="empty">还没有带位置信息的照片</div>
      ) : (
        <MapContainer
          style={{ height: "100%", width: "100%", borderRadius: "16px" }}
          bounds={bounds || undefined}
          boundsOptions={{ padding: [50, 50], maxZoom: 14 }}
          center={bounds ? undefined : [30, 105]}
          zoom={bounds ? undefined : 4}
        >
          <TileLayer
            attribution="&copy; OpenStreetMap contributors"
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            maxZoom={19}
          />
          {located.map((photo) => (
            <Marker
              key={photo.id}
              position={[photo.latitude!, photo.longitude!]}
              icon={defaultIcon}
            >
              <Popup>
                <div className="map-popup">
                  <img
                    src={photo.thumbnail_url || photo.url}
                    alt={photo.title || photo.original_name}
                    loading="lazy"
                    style={{ width: "120px", borderRadius: "8px", marginBottom: "6px" }}
                  />
                  <strong>{photo.title || photo.original_name}</strong>
                  {photo.description && <p style={{ margin: "4px 0 0", fontSize: "12px" }}>{photo.description}</p>}
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      )}
    </section>
  );
}
