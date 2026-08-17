import { useState, useMemo } from 'react'
import { apiFetch } from '../lib/api'
import { useMonitoredClusters } from '../hooks/useMonitoredClusters'
import { useSecurityFindings } from '../hooks/useSecurityFindings'
import SecurityFindingsTable from '../components/SecurityFindingsTable'

const NETWORK_POLICY_TEMPLATE = ns =>
`apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
  namespace: ${ns}
spec:
  podSelector: {}
  policyTypes:
    - Ingress`

export default function NetworkPage() {
  const { clusters, selected, setSelected } = useMonitoredClusters()
  const { findings, loading, error, busyId, reload, accept, rescan, escalate } =
    useSecurityFindings(selected, 'NetworkExposure')

  // useMonitoredClusters() resolves `selected` to the cluster's friendly name
  // (what /api/security/findings expects), but /api/network/apply needs the
  // underlying kubectl context — recover it from the same list.
  const context = useMemo(
    () => clusters.find(c => (c.config?.name ?? c.name) === selected)?.name ?? selected,
    [clusters, selected]
  )

  const [showApply, setShowApply] = useState(false)
  const [yamlDraft, setYamlDraft] = useState('')
  const [applyBusy, setApplyBusy] = useState(false)
  const [applyOut,  setApplyOut]  = useState('')
  const [applyErr,  setApplyErr]  = useState('')

  function openApply() {
    setYamlDraft(NETWORK_POLICY_TEMPLATE('default'))
    setApplyOut(''); setApplyErr(''); setShowApply(true)
  }

  async function submitApply() {
    setApplyBusy(true); setApplyErr(''); setApplyOut('')
    try {
      const r = await apiFetch('/api/network/apply', {
        method: 'POST',
        body: { yaml: yamlDraft, context },
      })
      const d = await r.json()
      if (d.error) setApplyErr(d.detail ? `${d.error}\n\n${d.detail}` : d.error)
      else {
        const prefix = d.appliedCount > 1 ? `Applied ${d.appliedCount} documents:\n\n` : ''
        setApplyOut(prefix + d.output)
        reload()
      }
    } catch (err) { setApplyErr(err.message) }
    finally { setApplyBusy(false) }
  }

  return (
    <div className="cp-page">
      <div className="page-header">
        <div>
          <h2>Network</h2>
          <p className="page-subtitle">Missing NetworkPolicies, exposed Services, and Ingresses without TLS — admin-only</p>
        </div>
        <div className="cp-controls">
          <select value={selected} onChange={e => setSelected(e.target.value)}>
            {clusters.map(c => <option key={c.name} value={c.config?.name ?? c.name}>{c.config?.name ?? c.name}</option>)}
          </select>
          <button className="btn-primary-sm" onClick={openApply}>+ Apply YAML</button>
          <button className="btn-primary" onClick={reload} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      <SecurityFindingsTable
        findings={findings}
        loading={loading}
        error={error}
        busyId={busyId}
        onAccept={accept}
        onRescan={rescan}
        onEscalate={escalate}
        emptyMessage={
          `No open findings${selected ? ` for ${selected}` : ''}. ` +
          `Enable NETWORK_EXPOSURE_ENABLED=true and wait for a scan cycle if this cluster hasn't been scanned yet.`
        }
      />

      {showApply && (
        <div className="modal-backdrop" onClick={() => setShowApply(false)}>
          <div className="modal-box rbac-apply-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span>Apply Network Manifest</span>
              <button className="modal-close" onClick={() => setShowApply(false)}>✕</button>
            </div>
            <div className="modal-body">
              <p className="rbac-apply-hint">
                Paste one or more manifests separated by <code>---</code>. Supported kinds: NetworkPolicy, Service, Ingress. Cluster: <strong>{selected}</strong>
              </p>
              <textarea
                className="rbac-yaml-editor"
                value={yamlDraft}
                onChange={e => setYamlDraft(e.target.value)}
                rows={16}
                spellCheck={false}
              />
              {applyErr && <div className="rbac-apply-error">{applyErr}</div>}
              {applyOut && <div className="rbac-apply-output">{applyOut}</div>}
            </div>
            <div className="modal-footer">
              <button className="btn-cancel" onClick={() => setShowApply(false)}>Cancel</button>
              <button className="btn-primary-sm" onClick={submitApply} disabled={applyBusy || !yamlDraft.trim()}>
                {applyBusy ? 'Applying…' : 'Apply'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
