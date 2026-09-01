import { useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext.jsx'

export default function LoginScreen() {
  const { user, loading, login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const from = location.state?.from?.pathname || '/'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Already signed in → skip the login page.
  if (!loading && user) return <Navigate to={from} replace />

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      await login(email.trim(), password)
      navigate(from, { replace: true })
    } catch (err) {
      setError(err.message || 'Login failed. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="page auth">
      <div className="page__glow" aria-hidden="true" />
      <div className="auth__card">
        <div className="brand auth__brand">
          <span className="brand__dot" />
          INFOVISION INTELLIGENCE
        </div>
        <h1 className="auth__title">Welcome back</h1>
        <p className="auth__sub">Sign in to your workspace to continue.</p>

        <form className="form" onSubmit={handleSubmit}>
          <div className="field">
            <label className="field__label" htmlFor="email">
              Email <span className="field__req">*</span>
            </label>
            <input
              id="email"
              className="field__input"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoFocus
              required
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="password">
              Password <span className="field__req">*</span>
            </label>
            <input
              id="password"
              className="field__input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>

          {error && <p className="form__error">{error}</p>}

          <button
            className="btn btn--primary btn--lg auth__submit"
            type="submit"
            disabled={submitting || !email.trim() || !password}
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
