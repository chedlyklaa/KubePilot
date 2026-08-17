import { useMonitoredClusters } from '../hooks/useMonitoredClusters'
import { useSecurityFindings } from '../hooks/useSecurityFindings'
import SecurityFindingsTable from '../components/SecurityFindingsTable'

export default function SecretsPage() {
  const { clusters, selected, setSelected } = useMonitoredClusters()
  const { findings, loading, error, busyId, reload, accept, rescan, escalate } =
    useSecurityFindings(selected, 'SecretsHygiene')

  return (
    <div className="cp-page">
      <div className="page-header">
        <div>
          <h2>Secrets</h2>
          <p className="page-subtitle">Secret usage patterns in running workloads — admin-only, read-only (never reads Secret values)</p>
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
          `Enable SECRETS_HYGIENE_ENABLED=true and wait for a scan cycle if this cluster hasn't been scanned yet.`
        }
      />
    </div>
  )
}
