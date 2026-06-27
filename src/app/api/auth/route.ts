import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export async function POST(request: NextRequest) {
  const { email, password } = await request.json()

  if (email === 'alex170800@hotmail.com' && password === 'Wasaquepaso2.!') {
    const response = NextResponse.json({ ok: true })
    response.cookies.set('session', 'authenticated', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    })
    return response
  }

  return NextResponse.json({ error: 'Credenciales inválidas' }, { status: 401 })
}
