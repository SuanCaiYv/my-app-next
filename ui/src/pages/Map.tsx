import { useEffect, useMemo, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import { getLocationDetail, listLocations, listPhotos, loadAppSettings } from "../api";
import type { LocationItem, PhotoItem } from "../types";
import L from "leaflet";

const photoIcon = L.icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

const locationIcon = L.divIcon({
  className: "map-location-marker",
  html: `<svg viewBox="0 0 24 24" width="28" height="28" fill="#b94a48" stroke="#fff" stroke-width="1.5"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5" fill="#fff"/></svg>`,
  iconSize: [28, 28],
  iconAnchor: [14, 28],
  popupAnchor: [0, -28],
});

const PI = Math.PI;
const A = 6378245.0;
const EE = 0.00669342162296594323;

function outOfChina(lat: number, lng: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * PI) + 320.0 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(y));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
  return ret;
}

function wgs84ToGcj02(lat: number, lng: number): [number, number] {
  if (outOfChina(lat, lng)) return [lat, lng];
  const dlat = transformLat(lng - 105.0, lat - 35.0);
  const dlng = transformLng(lng - 105.0, lat - 35.0);
  const radlat = lat / 180.0 * PI;
  const magic = 1.0 - EE * Math.sin(radlat) ** 2;
  const sqrtmagic = Math.sqrt(magic);
  const newLat = lat + dlat * 180.0 / ((A * (1.0 - EE)) / (magic * sqrtmagic) * PI);
  const newLng = lng + dlng * 180.0 / (A / sqrtmagic * Math.cos(radlat) * PI);
  return [newLat, newLng];
}

export default function MapPage() {
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [locations, setLocations] = useState<LocationItem[]>([]);
  const [amapKey, setAmapKey] = useState("");
  const [details, setDetails] = useState<Record<number, { posts: { id: number; title: string }[]; photos: PhotoItem[] }>>({});

  useEffect(() => {
    loadAppSettings()
      .then((settings) => setAmapKey(settings.amapKey || ""))
      .catch(() => {});
    Promise.all([listPhotos(), listLocations()])
      .then(([p, l]) => {
        setPhotos(p);
        setLocations(l);
      })
      .catch(() => {});
  }, []);

  const locatedPhotos = useMemo(
    () => photos.filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude)).map((p) => ({ ...p, gcj: wgs84ToGcj02(p.latitude!, p.longitude!) })),
    [photos]
  );

  const locatedLocations = useMemo(
    () => locations.filter((l) => Number.isFinite(l.latitude) && Number.isFinite(l.longitude) && !(l.latitude === 0 && l.longitude === 0)),
    [locations]
  );

  const bounds = useMemo(() => {
    const points: [number, number][] = [];
    locatedPhotos.forEach((p) => points.push([p.gcj[0], p.gcj[1]]));
    locatedLocations.forEach((l) => points.push([l.latitude, l.longitude]));
    if (!points.length) return null;
    return L.latLngBounds(points);
  }, [locatedPhotos, locatedLocations]);

  const loadLocationDetail = async (locationId: number) => {
    if (details[locationId]) return;
    try {
      const data = await getLocationDetail(locationId);
      setDetails((prev) => ({ ...prev, [locationId]: { posts: data.posts.map((p) => ({ id: p.id, title: p.title })), photos: data.photos } }));
    } catch {
      // ignore
    }
  };

  const hasContent = locatedPhotos.length > 0 || locatedLocations.length > 0;

  return (
    <section className="view active" id="mapView">
      {!amapKey ? (
        <div className="empty">请在设置页填写高德 Key</div>
      ) : !hasContent ? (
        <div className="empty">还没有带位置信息的照片或文章地点</div>
      ) : (
        <MapContainer
          style={{ height: "100%", width: "100%", borderRadius: "16px" }}
          bounds={bounds || undefined}
          boundsOptions={{ padding: [50, 50], maxZoom: 14 }}
          center={bounds ? undefined : [30, 105]}
          zoom={bounds ? undefined : 4}
        >
          <TileLayer
            attribution='&copy; 高德地图'
            url={`https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}&key=${amapKey}`}
            maxZoom={18}
            subdomains="1234"
          />
          {locatedPhotos.map((photo) => (
            <Marker
              key={`photo-${photo.id}`}
              position={[photo.gcj[0], photo.gcj[1]]}
              icon={photoIcon}
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
          {locatedLocations.map((location) => (
            <Marker
              key={`location-${location.id}`}
              position={[location.latitude, location.longitude]}
              icon={locationIcon}
              eventHandlers={{
                click: () => loadLocationDetail(location.id),
              }}
            >
              <Popup>
                <div className="map-popup location-popup">
                  <strong className="location-popup-name">{location.name}</strong>
                  {details[location.id] ? (
                    <>
                      {details[location.id].posts.length > 0 && (
                        <div className="location-popup-section">
                          <span className="location-popup-label">文章</span>
                          <ul>
                            {details[location.id].posts.map((post) => (
                              <li key={post.id}>{post.title || "无标题"}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {details[location.id].photos.length > 0 && (
                        <div className="location-popup-section">
                          <span className="location-popup-label">附近照片</span>
                          <div className="location-popup-photos">
                            {details[location.id].photos.map((photo) => (
                              <img
                                key={photo.id}
                                src={photo.thumbnail_url || photo.url}
                                alt={photo.title || photo.original_name}
                                loading="lazy"
                              />
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <span className="location-popup-loading">加载中...</span>
                  )}
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      )}
    </section>
  );
}
