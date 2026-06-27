'use client'

import { FormEvent, useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'

interface Property {
  id: string
  title: string
  price: number
  price_per_m2: number | null
  area_m2: number | null
  location_text: string | null  // WKT from ST_AsText: "POINT(lng lat)"
  address: string | null
  images: any
  status: string | null
}

/** Parse WKT "POINT(lng lat)" → [lng, lat] or null */
function parseWkt(wkt: string): [number, number] | null {
  const m = wkt.match(/POINT\(([\d.-]+)\s([\d.-]+)\)/i)
  return m ? [parseFloat(m[1]), parseFloat(m[2])] : null
}

export default function DashboardPage() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const map = useRef<mapboxgl.Map | null>(null)
  const markers = useRef<mapboxgl.Marker[]>([])
  const [ready, setReady] = useState(false)

  const [lat, setLat] = useState('25.6866')
  const [lng, setLng] = useState('-100.3161')
  const [radius, setRadius] = useState('5000')
  const [results, setResults] = useState<Property[]>([])
  const [loading, setLoading] = useState(false)

  // Init map once
  useEffect(() => {
    if (map.current || !mapContainer.current) return
    ;(async () => {
      const res = await fetch('/api/mapbox/token')
      const { token } = await res.json()
      mapboxgl.accessToken = token

      map.current = new mapboxgl.Map({
        container: mapContainer.current!,
        style: 'mapbox://styles/mapbox/light-v11',
        center: [-100.3161, 25.6866], // Monterrey
        zoom: 12,
      })
      map.current.addControl(new mapboxgl.NavigationControl(), 'top-right')
      map.current.on('load', () => setReady(true))
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Update markers when results change
  useEffect(() => {
    markers.current.forEach((m) => m.remove())
    markers.current = []

    if (!map.current || !results.length) return

    results.forEach((p) => {
      const coords = p.location_text ? parseWkt(p.location_text) : null
      if (!coords) return

      const el = document.createElement('div')
      el.className = 'marker'
      el.innerHTML = `<svg viewBox="0 0 24 24" width="28" height="28" fill="#2563eb"><path d="M12 0C7.58 0 4 3.58 4 8c0 5.4 7.5 14.5 7.8 14.9.1.1.2.2.3.2h0c.1 0 .2-.1.3-.2C12.5 22.5 20 13.4 20 8c0-4.42-3.58-8-8-8z"/><circle cx="12" cy="8" r="3" fill="#fff"/></svg>`

      const popup = new mapboxgl.Popup({ offset: 25 }).setHTML(
        `<strong>${p.title || 'Sin título'}</strong>` +
          (p.price != null ? `<br/>$${p.price.toLocaleString('es-MX')}` : '') +
          (p.price_per_m2 != null
            ? `<br/><small>$${p.price_per_m2.toLocaleString('es-MX')}/m²</small>`
            : '') +
          (p.address ? `<br/><small>${p.address}</small>` : '') +
          `<br/><span style="font-size:0.75rem;color:#6b7280">${p.status ?? ''}</span>`,
      )

      const marker = new mapboxgl.Marker({ element: el })
        .setLngLat(coords)
        .setPopup(popup)
        .addTo(map.current!)
      markers.current.push(marker)
    })

    // Fit bounds if any markers
    if (markers.current.length) {
      const bounds = new mapboxgl.LngLatBounds()
      markers.current.forEach((m) => bounds.extend(m.getLngLat()))
      map.current.fitBounds(bounds, { padding: 60, maxZoom: 15 })
    }
  }, [results])

  async function handleSearch(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    const params = new URLSearchParams({ lat, lng, radius })
    const res = await fetch(`/api/properties/search?${params}`)
    const data = await res.json()
    setResults(data)
    setLoading(false)
  }

  return (
    <div className="container">
      <h1 style={{ marginBottom: '1.5rem', fontSize: '1.75rem' }}>CRM Inmobiliario</h1>

      <div ref={mapContainer} id="map">
        {!ready && (
          <div
            style={{
              height: 400,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#6b7280',
            }}
          >
            Cargando mapa…
          </div>
        )}
      </div>

      <form onSubmit={handleSearch} className="card" style={{ marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 500, marginBottom: '0.25rem' }}>
              Latitud
            </label>
            <input
              className="input"
              style={{ width: 140 }}
              value={lat}
              onChange={(e) => setLat(e.target.value)}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 500, marginBottom: '0.25rem' }}>
              Longitud
            </label>
            <input
              className="input"
              style={{ width: 140 }}
              value={lng}
              onChange={(e) => setLng(e.target.value)}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 500, marginBottom: '0.25rem' }}>
              Radio (m)
            </label>
            <input
              className="input"
              style={{ width: 120 }}
              value={radius}
              onChange={(e) => setRadius(e.target.value)}
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Buscando…' : 'Buscar'}
          </button>
        </div>
      </form>

      <div>
        {results.length === 0 && !loading && (
          <p style={{ color: '#6b7280', fontSize: '0.875rem' }}>
            Realiza una búsqueda para ver resultados.
          </p>
        )}
        {results.length > 0 && (
          <p style={{ marginBottom: '0.75rem', fontSize: '0.875rem', color: '#6b7280' }}>
            {results.length} propiedad(es) encontrada(s)
          </p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {results.map((p) => (
            <div key={p.id} className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <h3 style={{ fontSize: '1rem', fontWeight: 600 }}>{p.title || 'Sin título'}</h3>
                  {p.address && <p style={{ fontSize: '0.875rem', color: '#6b7280' }}>{p.address}</p>}
                </div>
                <div style={{ textAlign: 'right' }}>
                  {p.price != null && <p style={{ fontWeight: 600 }}>${p.price.toLocaleString('es-MX')}</p>}
                  {p.price_per_m2 != null && (
                    <p style={{ fontSize: '0.75rem', color: '#6b7280' }}>
                      ${p.price_per_m2.toLocaleString('es-MX')} / m²
                    </p>
                  )}
                </div>
              </div>
              {p.status && (
                <span
                  style={{
                    display: 'inline-block',
                    marginTop: '0.5rem',
                    padding: '0.125rem 0.5rem',
                    fontSize: '0.75rem',
                    borderRadius: 4,
                    background: '#dbeafe',
                    color: '#1e40af',
                  }}
                >
                  {p.status}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
