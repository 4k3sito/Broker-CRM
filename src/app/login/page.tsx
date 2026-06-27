'use client'

import { FormEvent, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const router = useRouter()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')

    // Try Supabase auth first
    const supabase = createClient()
    const { error: supaError } = await supabase.auth.signInWithPassword({ email, password })
    if (!supaError) {
      router.push('/')
      return
    }

    // Fallback to hardcoded auth
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (res.ok) {
        router.push('/')
        return
      }
      const data = await res.json()
      setError(data.error || 'Error al iniciar sesión')
    } catch {
      setError('Error de conexión')
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f5f5f5',
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          background: '#fff',
          padding: '2rem',
          borderRadius: 8,
          boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
          width: '100%',
          maxWidth: 400,
        }}
      >
        <h1 style={{ marginBottom: '1.5rem', fontSize: '1.5rem', textAlign: 'center' }}>
          Iniciar Sesión
        </h1>

        {error && (
          <p style={{ color: '#dc2626', marginBottom: '1rem', fontSize: '0.875rem', textAlign: 'center' }}>
            {error}
          </p>
        )}

        <div style={{ marginBottom: '1rem' }}>
          <label htmlFor="email" style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem', fontWeight: 500 }}>
            Correo electrónico
          </label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="input" />
        </div>

        <div style={{ marginBottom: '1.5rem' }}>
          <label htmlFor="password" style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem', fontWeight: 500 }}>
            Contraseña
          </label>
          <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required className="input" />
        </div>

        <button type="submit" className="btn btn-primary" style={{ width: '100%' }}>
          Entrar
        </button>
      </form>
    </div>
  )
}
