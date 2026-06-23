import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../lib/api'
import { useNotify } from '../contexts/NotifyContext'

const TYPE_ICON  = { core: '🧠', analyzer: '🔍', engine: '⚙' }
const TYPE_LABEL = { core: 'Core Agent', analyzer: 'Analyzer', engine: 'Engine' }

export default function AgentsPage() {
  const notify = useNotify()
  const [data, setData]       = useState(null)
  const [loading, setLoading] = useState(true)
  const [editKey, setEditKey] = useState(null)
  const [editVal, setEditVal] = useState('')
  const [saving, setSaving]   = useState(false)
  const [rules, setRules]     = useState([])
  const [rulesLoading, setRulesLoading] = useState(true)
  const [showRules, setShowRules]       = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await apiFetch('/api/agents')
      setData(await r.json())
    } catch {}
    setLoading(false)
  }, [])

  const loadRules = useCallback(async () => {
    setRulesLoading(true)
    try {
      const r = await apiFetch('/api/agents/rules')
      setRules(await r.json())
    } catch {}
    setRulesLoading(false)
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (showRules && rules.length === 0) loadRules() }, [showRules])

  async function toggleRule(id, active) {
    try {
      const r = await apiFetch(`/api/agents/rules/${id}`, { method: 'PUT', body: { active } })
      if (r.ok) {
        setRules(prev => prev.map(rl => rl._id === id ? { ...rl, active } : rl))
        notify('success', active ? 'Rule enabled' : 'Rule disabled')
      }
    } catch (err) { notify('error', err.message) }
  }

  async function deleteRule(id) {
    try {
      const r = await apiFetch(`/api/agents/rules/${id}`, { method: 'DELETE' })
      if (r.ok) {
        setRules(prev => prev.filter(rl => rl._id !== id))
        notify('success', 'Rule deleted')
      }
    } catch (err) { notify('error', err.message) }
  }

  async function saveConfig(key, value) {
    setSaving(true)
    try {
      const r = await apiFetch('/api/agents/config', { method: 'PUT', body: { key, value } })
      if (r.ok) {
        notify('success', `Updated ${key}`)
        setEditKey(null)
        load()
      } else {
        const d = await r.json()
        notify('error', d.error)
      }
    } catch (err) { notify('error', err.message) }
    setSaving(false)
  }

  function startEdit(key, currentValue) {
    setEditKey(key)
    setEditVal(String(currentValue))
  }

  if (loading && !data) return <div className="ag-page"><div className="ag-loading">Loading agents...</div></div>

  const { agents = [], clusters = [], config = {} } = data ?? {}

  const coreAgents    = agents.filter(a => a.type === 'core')
  const analyzers     = agents.filter(a => a.type === 'analyzer')
  const engines       = agents.filter(a => a.type === 'engine')

  const configItems = [
    { key: 'CYCLE_INTERVAL_MS',          label: 'Cycle Interval',       value: config.cycleIntervalMs, display: `${(config.cycleIntervalMs / 1000).toFixed(0)}s`, hint: 'Milliseconds between orchestrator cycles' },
    { key: 'OPENAI_MODEL',               label: 'LLM Model',           value: config.llmModel,        display: config.llmModel || '(not set)', hint: 'Primary model for Planner, Investigator, Chat' },
    { key: 'GUARDIAN_MODEL',             label: 'Guardian Model',       value: config.guardianModel,   display: config.guardianModel || '(uses primary)', hint: 'Model for Guardian + Reflection (can differ)' },
    { key: 'CAPACITY_FORECAST_ENABLED',  label: 'Capacity Forecast',   value: String(engines.find(e => e.id === 'capacity')?.enabled ?? false), display: engines.find(e => e.id === 'capacity')?.enabled ? 'Enabled' : 'Disabled', hint: 'Toggle resource exhaustion prediction', toggle: true },
  ]

  return (
    <div className="ag-page">
      <div className="page-header">
        <div>
          <h2>Agent Management</h2>
          <p className="page-subtitle">Monitor and configure KubePilot's autonomous agents</p>
        </div>
        <button className="btn-primary" onClick={load} disabled={loading}>{loading ? 'Loading...' : 'Refresh'}</button>
      </div>

      {/* ── Status cards ────────────────────────────────────────────── */}
      <div className="ag-status-row">
        <div className="ag-status-card">
          <div className="ag-status-value">{agents.length}</div>
          <div className="ag-status-label">Total Agents</div>
        </div>
        <div className="ag-status-card">
          <div className="ag-status-value ag-status-ok">{agents.filter(a => a.enabled).length}</div>
          <div className="ag-status-label">Active</div>
        </div>
        <div className="ag-status-card">
          <div className="ag-status-value">{clusters.length}</div>
          <div className="ag-status-label">Clusters</div>
        </div>
        <div className="ag-status-card">
          <div className={`ag-status-value ${config.prometheusAvailable ? 'ag-status-ok' : 'ag-status-err'}`}>
            {config.prometheusAvailable ? 'Connected' : 'Offline'}
          </div>
          <div className="ag-status-label">Prometheus</div>
        </div>
        <div className="ag-status-card">
          <div className={`ag-status-value ${config.vectorStoreReady ? 'ag-status-ok' : 'ag-status-err'}`}>
            {config.vectorStoreReady ? 'Ready' : 'Offline'}
          </div>
          <div className="ag-status-label">Vector Store</div>
        </div>
      </div>

      {/* ── Agent groups ────────────────────────────────────────────── */}
      {[['Core Agents', 'LLM-powered agents that plan, validate, and learn', coreAgents],
        ['Analyzers', 'Rule-based modules that detect issues from cluster state', analyzers],
        ['Engines', 'Specialized engines for correlation and forecasting', engines],
      ].map(([title, desc, list]) => (
        <div key={title} className="ag-section">
          <div className="ag-section-head">
            <h3 className="ag-section-title">{title}</h3>
            <span className="ag-section-desc">{desc}</span>
          </div>
          <div className="ag-grid">
            {list.map(agent => (
              <div key={agent.id} className={`ag-card ${!agent.enabled ? 'ag-card-disabled' : ''}`}>
                <div className="ag-card-top">
                  <div className="ag-card-icon">{TYPE_ICON[agent.type]}</div>
                  <div className="ag-card-info">
                    <div className="ag-card-name">{agent.name}</div>
                    <span className="ag-card-type">{TYPE_LABEL[agent.type]}</span>
                  </div>
                  <div className={`ag-card-status ${agent.enabled ? 'ag-on' : 'ag-off'}`}>
                    {agent.enabled ? 'Active' : 'Off'}
                  </div>
                </div>
                <div className="ag-card-desc">{agent.description}</div>
                {agent.model && (
                  <div className="ag-card-model">
                    <span className="ag-card-model-label">Model</span>
                    <code>{agent.model}</code>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* ── Runtime Config ──────────────────────────────────────────── */}
      <div className="ag-section">
        <div className="ag-section-head">
          <h3 className="ag-section-title">Runtime Configuration</h3>
          <span className="ag-section-desc">Changes apply immediately without restart</span>
        </div>
        <div className="ag-config-list">
          {configItems.map(item => (
            <div key={item.key} className="ag-config-row">
              <div className="ag-config-info">
                <div className="ag-config-label">{item.label}</div>
                <div className="ag-config-hint">{item.hint}</div>
              </div>
              {editKey === item.key ? (
                <div className="ag-config-edit">
                  {item.toggle ? (
                    <select value={editVal} onChange={e => setEditVal(e.target.value)}>
                      <option value="true">Enabled</option>
                      <option value="false">Disabled</option>
                    </select>
                  ) : (
                    <input value={editVal} onChange={e => setEditVal(e.target.value)} autoFocus />
                  )}
                  <button className="btn-primary-sm" onClick={() => saveConfig(item.key, editVal)} disabled={saving}>Save</button>
                  <button className="btn-secondary btn-sm" onClick={() => setEditKey(null)}>Cancel</button>
                </div>
              ) : (
                <div className="ag-config-val-row">
                  <code className="ag-config-val">{item.display}</code>
                  <button className="btn-sm" onClick={() => startEdit(item.key, item.value)}>Edit</button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ── Learned Rules ──────────────────────────────────────────── */}
      <div className="ag-section">
        <div className="ag-section-head">
          <div>
            <h3 className="ag-section-title">Learned Rules {showRules && rules.length > 0 && <span className="ag-rules-count">{rules.length}</span>}</h3>
            <span className="ag-section-desc">Auto-generated from repeated failure patterns — injected into Planner prompts to avoid known-bad actions</span>
          </div>
          <button className="ag-rules-toggle-btn" onClick={() => setShowRules(v => !v)}>
            {showRules ? 'Hide Rules' : 'Show Rules'}
            <span className="ag-rules-chevron">{showRules ? '▲' : '▼'}</span>
          </button>
        </div>
        {showRules && (rulesLoading && rules.length === 0
          ? <div className="ag-loading">Loading rules...</div>
          : rules.length === 0
            ? <div className="ag-rules-empty">
                <span className="ag-rules-empty-icon">📋</span>
                <div>No learned rules yet. Rules are created automatically when the same action fails repeatedly for the same issue type.</div>
              </div>
            : (
              <div className="ag-rules-list">
                {rules.map(rl => (
                  <div key={rl._id} className={`ag-rule-card ${!rl.active ? 'ag-rule-disabled' : ''}`}>
                    <div className="ag-rule-top">
                      <div className="ag-rule-issue">
                        <span className="ag-rule-issue-label">Issue Type</span>
                        <span className="ag-rule-issue-val">{rl.issueType}</span>
                      </div>
                      <div className="ag-rule-badges">
                        <span className="ag-rule-source">{rl.source === 'manual' ? 'Manual' : 'Auto-detected'}</span>
                        <span className={`ag-rule-conf ag-conf-${rl.confidence >= 0.8 ? 'high' : rl.confidence >= 0.6 ? 'med' : 'low'}`}>
                          {Math.round(rl.confidence * 100)}% confidence
                        </span>
                        <span className="ag-rule-occ">{rl.occurrences} occurrence{rl.occurrences !== 1 ? 's' : ''}</span>
                      </div>
                    </div>
                    <div className="ag-rule-body">
                      <div className="ag-rule-condition">
                        <span className="ag-rule-label">Condition</span>
                        <code>{rl.condition}</code>
                      </div>
                      <div className="ag-rule-text">
                        <span className="ag-rule-label">Rule</span>
                        <p>{rl.rule}</p>
                      </div>
                    </div>
                    <div className="ag-rule-footer">
                      <span className="ag-rule-date">Updated {new Date(rl.updatedAt).toLocaleDateString()}</span>
                      <div className="ag-rule-actions">
                        <button
                          className={`ag-rule-toggle ${rl.active ? 'ag-rule-toggle-on' : ''}`}
                          onClick={() => toggleRule(rl._id, !rl.active)}
                          title={rl.active ? 'Disable this rule' : 'Enable this rule'}>
                          <div className={`ag-rule-switch ${rl.active ? 'on' : ''}`}><div className="ag-rule-knob" /></div>
                          <span>{rl.active ? 'Active' : 'Disabled'}</span>
                        </button>
                        <button className="ag-rule-delete" onClick={() => deleteRule(rl._id)} title="Delete this rule permanently">Delete</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )
        )}
      </div>

      {/* ── Monitored Clusters ──────────────────────────────────────── */}
      <div className="ag-section">
        <div className="ag-section-head">
          <h3 className="ag-section-title">Monitored Clusters</h3>
          <span className="ag-section-desc">Clusters the orchestrator runs agents against each cycle</span>
        </div>
        <div className="ag-cluster-grid">
          {clusters.map(c => (
            <div key={c.name} className="ag-cluster-card">
              <div className="ag-cluster-name">⎈ {c.name}</div>
              <div className="ag-cluster-meta">
                <span className={`ag-tier ag-tier-${c.tier ?? 'dev'}`}>{c.tier ?? 'dev'}</span>
                <span className="ag-cluster-ctx">{c.context}</span>
              </div>
              <div className="ag-cluster-ns">
                {(c.namespaces ?? ['default']).map(ns => (
                  <span key={ns} className="ag-ns-chip">{ns}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
