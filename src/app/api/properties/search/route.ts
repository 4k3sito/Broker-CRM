import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const lat = parseFloat(searchParams.get('lat') ?? '')
  const lng = parseFloat(searchParams.get('lng') ?? '')
  const radius = parseFloat(searchParams.get('radius') ?? '')

  if (isNaN(lat) || isNaN(lng) || isNaN(radius)) {
    return NextResponse.json(
      { error: 'lat, lng and radius are required query parameters (floats)' },
      { status: 400 }
    )
  }

  const properties = await prisma.$queryRaw`
    SELECT
      id,
      title,
      price,
      price_per_m2,
      area_m2,
      ST_AsText(location) AS location_text,
      address,
      images,
      status
    FROM "Property"
    WHERE ST_DWithin(
      location::geography,
      ST_SetSRID(ST_MakePoint(${lng}::float, ${lat}::float), 4326)::geography,
      ${radius}::float
    )
  `

  return NextResponse.json(properties)
}
