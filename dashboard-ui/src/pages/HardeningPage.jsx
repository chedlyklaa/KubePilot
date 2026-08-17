import { useMonitoredClusters } from '../hooks/useMonitoredClusters'
import { useSecurityFindings } from '../hooks/useSecurityFindings'
import SecurityFindingsTable from '../components/SecurityFindingsTable'

export default function HardeningPage() {
  const { clusters, selected, setSelected } = useMonitoredClusters()
  const { findings, loading, error, busyId, reload, accept, rescan, escalate } =
    useSecurityFindings(selected, 'WorkloadHardening')

  return (
    <div className="cp-page">
      <div className="page-header">
        <div>
          <h2>Workload Hardening</h2>
          <p className="page-subtitle">Privileged containers, host access, and missing pod-security settings — admin-only</p>
        </div>
        <div className="cp-controls">
          <select value={selected} onChange={e => setSelected(e.target.value)}>
            {clusters.map(c => <option key={c.name} value={c.config?.name ?? c.name}>{c.config?.name ?? c.name}</option>)}
          </select>
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
          `Enable WORKLOAD_HARDENING_ENABLED=true and wait for a scan cycle if this cluster hasn't been scanned yet.`
        }
      />
    </div>
  )
}
