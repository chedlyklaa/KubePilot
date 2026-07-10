// Shared cluster/namespace/role permission-scope editor — used by RbacPage.jsx for both
// group permissions and per-user permissions. Previously duplicated: the original copy
// lived in the now-deleted TeamsPage.jsx (dead code, zero imports) while RbacPage.jsx
// carried its own near-identical inline copy.
import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/api'

const PERM_ROLES = ['viewer', 'editor', 'admin']
const EMPTY_SCOPE = { cluster: '', namespace: '*', role: 'viewer' }

function _updateScopeAt(arr, i, field, val) {
  const next = [...arr]; next[i] = { ...next[i], [field]: val }; return next
}

function NsCombo({ value, onChange, options }) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const filtered = options.filter(ns => !text || ns.toLowerCase().includes(text.toLowerCase()))
  function pick(val) { onChange(val); setText(''); setEditing(false); setOpen(false) }
  return (
    <div className="tp-ns-combo">
      <input value={editing ? text : (value || '')}
        onChange={e => { setText(e.target.value); setEditing(true); if (!open) setOpen(true) }}
        onFocus={() => { setOpen(true); setEditing(true); setText(value === '*' ? '' : (value || '')) }}
        onBlur={() => {
          setTimeout(() => {
            setOpen(false)
            if (editing) { onChange(text || '*'); setEditing(false) }
          }, 150)
        }}
        placeholder="* = all" />
      {open && (
        <div className="tp-ns-dropdown">
          <div className={`tp-ns-option${value === '*' ? ' tp-ns-active' : ''}`} onMouseDown={e => e.preventDefault()} onClick={() => pick('*')}>* (all namespaces)</div>
          {filtered.map(ns => (
            <div key={ns} className={`tp-ns-option${value === ns ? ' tp-ns-active' : ''}`}
              onMouseDown={e => e.preventDefault()} onClick={() => pick(ns)}>{ns}</div>
          ))}
          {filtered.length === 0 && text && <div className="tp-ns-option tp-ns-empty">Use "{text}"</div>}
        </div>
      )}
    </div>
  )
}

export default function ScopeEditor({ scopes, setScopes, clusters }) {
  const [nsCache, setNsCache] = useState({})
  function fetchNs(cluster) {
    if (!cluster || cluster === '*' || nsCache[cluster]) return
    apiFetch(`/api/rbac/namespaces?context=${encodeURIComponent(cluster)}`)
      .then(r => r.json())
      .then(ns => { if (Array.isArray(ns)) setNsCache(c => ({ ...c, [cluster]: ns })) })
      .catch(() => {})
  }
  const scopedClusters = scopes.map(s => s.cluster).filter(c => c && c !== '*').join(',')
  useEffect(() => {
    scopes.forEach(s => { if (s.cluster && s.cluster !== '*') fetchNs(s.cluster) })
  }, [scopedClusters])  // eslint-disable-line react-hooks/exhaustive-deps
  function onClusterChange(i, val) {
    const next = [...scopes]; next[i] = { ...next[i], cluster: val, namespace: '*' }; setScopes(next)
    if (val && val !== '*') fetchNs(val)
  }
  return (
    <div className="tp-scopes">
      {scopes.length > 0 && (
        <div className="tp-scope-labels">
          <span>Cluster</span><span>Namespace</span><span>Role</span><span />
        </div>
      )}
      {scopes.map((s, i) => (
        <div key={i} className="tp-scope-row">
          <select value={s.cluster} onChange={e => onClusterChange(i, e.target.value)}>
            <option value="">— cluster —</option>
            <option value="*">* (all)</option>
            {clusters.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <NsCombo value={s.namespace} options={nsCache[s.cluster] ?? []}
            onChange={val => setScopes(_updateScopeAt(scopes, i, 'namespace', val))} />
          <select value={s.role} onChange={e => setScopes(_updateScopeAt(scopes, i, 'role', e.target.value))}>
            {PERM_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <button type="button" className="tp-scope-remove" onClick={() => setScopes(scopes.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button type="button" className="tp-scope-add" onClick={() => setScopes([...scopes, { ...EMPTY_SCOPE }])}>+ Add scope</button>
    </div>
  )
}
