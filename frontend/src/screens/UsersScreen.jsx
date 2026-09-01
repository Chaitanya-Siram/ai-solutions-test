import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { listUsers, updateUser } from '../api/users.js'
import { useAuth } from '../auth/AuthContext.jsx'
import { ArrowLeftIcon, EditIcon, SearchIcon } from '../components/Icons.jsx'
import { paths } from '../router/nav.js'

export default function UsersScreen() {
  const navigate = useNavigate()
  const { user: currentUser, patchUser } = useAuth()
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await listUsers()
      setUsers(Array.isArray(data) ? data : [])
    } catch (err) {
      setError(err.message || 'Failed to load users.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return users
    return users.filter(
      (u) =>
        u.email.toLowerCase().includes(q) ||
        (u.full_name || '').toLowerCase().includes(q),
    )
  }, [users, query])

  const handleSaved = useCallback(
    (updated) => {
      setUsers((list) => list.map((u) => (u.id === updated.id ? updated : u)))
      patchUser(updated) // keep the topbar/self in sync if editing own account
      setEditing(null)
    },
    [patchUser],
  )

  return (
    <>
      <button className="backlink" onClick={() => navigate(paths.projects())}>
        <ArrowLeftIcon width={18} height={18} /> All projects
      </button>

      <section className="hero hero--compact">
        <div className="hero__text">
          <h1 className="hero__title">Users</h1>
          <p className="hero__sub">Manage the people who can access this workspace.</p>
        </div>
        <div className="users__search">
          <SearchIcon width={16} height={16} />
          <input
            className="users__search-input"
            type="search"
            placeholder="Search by name or email…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </section>

      {loading && <div className="state"><div className="loader" /><p>Loading users…</p></div>}

      {!loading && error && (
        <div className="state state--error">
          <p>{error}</p>
          <button className="btn btn--ghost" onClick={load}>Retry</button>
        </div>
      )}

      {!loading && !error && filtered.length === 0 && (
        <div className="state"><p>No users match your search.</p></div>
      )}

      {!loading && !error && filtered.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>User</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div className="usercell">
                      <span className="usercell__avatar">
                        {(u.full_name || u.email || '?').charAt(0).toUpperCase()}
                      </span>
                      <div className="usercell__meta">
                        <span className="usercell__name">
                          {u.full_name || u.email}
                          {currentUser?.id === u.id && <span className="tag tag--you">You</span>}
                        </span>
                        {u.full_name && <span className="usercell__sub">{u.email}</span>}
                      </div>
                    </div>
                  </td>
                  <td>{u.email}</td>
                  <td>
                    <span className={`tag ${u.is_admin ? 'tag--admin' : 'tag--muted'}`}>
                      {u.is_admin ? 'Admin' : 'Member'}
                    </span>
                  </td>
                  <td>
                    <span className={`tag ${u.is_active ? 'tag--active' : 'tag--inactive'}`}>
                      {u.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="table__actions">
                    <button className="btn btn--ghost btn--mini" onClick={() => setEditing(u)}>
                      <EditIcon width={15} height={15} /> Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <EditUserModal
        user={editing}
        onClose={() => setEditing(null)}
        onSaved={handleSaved}
      />
    </>
  )
}

function EditUserModal({ user, onClose, onSaved }) {
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (user) {
      setForm({
        email: user.email || '',
        full_name: user.full_name || '',
        password: '',
        is_active: !!user.is_active,
        is_admin: !!user.is_admin,
      })
      setError('')
    }
  }, [user])

  if (!user || !form) return null

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }))

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    // Build a partial payload: only send fields that actually changed.
    const fields = {}
    if (form.email !== (user.email || '')) fields.email = form.email.trim()
    if (form.full_name !== (user.full_name || '')) fields.full_name = form.full_name.trim() || null
    if (form.is_active !== !!user.is_active) fields.is_active = form.is_active
    if (form.is_admin !== !!user.is_admin) fields.is_admin = form.is_admin
    if (form.password) fields.password = form.password

    if (Object.keys(fields).length === 0) {
      onClose()
      return
    }

    setSaving(true)
    try {
      const updated = await updateUser(user.id, fields)
      onSaved(updated)
    } catch (err) {
      setError(err.message || 'Could not save changes.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <h2 className="modal__title">Edit user</h2>
        <p className="modal__sub">{user.email}</p>

        <form className="form" onSubmit={handleSubmit}>
          <div className="field">
            <label className="field__label" htmlFor="edit-email">
              Email <span className="field__req">*</span>
            </label>
            <input
              id="edit-email"
              className="field__input"
              type="email"
              value={form.email}
              onChange={(e) => set('email', e.target.value)}
              required
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="edit-fullname">
              Full name <span className="field__opt">(optional)</span>
            </label>
            <input
              id="edit-fullname"
              className="field__input"
              type="text"
              value={form.full_name}
              onChange={(e) => set('full_name', e.target.value)}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="edit-password">
              New password <span className="field__opt">(leave blank to keep)</span>
            </label>
            <input
              id="edit-password"
              className="field__input"
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => set('password', e.target.value)}
              placeholder="••••••••"
              minLength={6}
            />
          </div>

          <div className="field field--row">
            <label className="toggle">
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={(e) => set('is_active', e.target.checked)}
              />
              <span>Active</span>
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={form.is_admin}
                onChange={(e) => set('is_admin', e.target.checked)}
              />
              <span>Administrator</span>
            </label>
          </div>

          {error && <p className="form__error">{error}</p>}

          <div className="form__actions">
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
