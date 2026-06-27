// ponytail: single route to hand the Mapbox token to the client without exposing .env
import { NextResponse } from 'next/server'

export async function GET() {
  const token = process.env.MAPBOX_API
  if (!token) return NextResponse.json({ error: 'MAPBOX_API not set' }, { status: 500 })
  return NextResponse.json({ token })
}
