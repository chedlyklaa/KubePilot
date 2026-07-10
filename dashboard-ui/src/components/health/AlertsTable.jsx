import { ALERT_LABELS } from './alertLabels'

const ALERT_SUGGESTIONS = {
  increase_memory:    { icon: '↑',  label: 'Increase memory limit'                      },
  increase_cpu_limit: { icon: '⚡', label: 'Increase CPU limit or requests'              },
  investigate_logs:   { icon: '📋', label: 'Check pod logs for crash cause'              },
  fix_image:          { icon: '📦', label: 'Fix image reference or pull credentials'     },
  check_node:         { icon: '🖥',  label: 'Inspect node resources'                     },
  check_config:       { icon: '⚙',  label: 'Check entrypoint, env vars or security context' },
  check_image:        { icon: '🔎', label: 'Binary not found — verify image entrypoint'  },
}

// "my-deploy-6c8fb8d957-xk2p9" → "my-deploy"
function podToWorkload(name) {
  if (!name) return name
  const parts = name.split('-')
  return parts.length > 2 ? parts.slice(0, -2).join('-') : name
}

function MiniBar({ pct, cls }) {
  return (
    <div className="alert-mbar">
      <div className="alert-mbar-track">
        <div className={`alert-mbar-fill ${cls}`} style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
      </div>
    </div>
  )
}

function AlertRow({ alert: e }) {
  const icon     = e.severity === 'critical' ? '🔴' : '🟠'
  const workload = e.pod ? podToWorkload(e.pod) : null
  const memCls   = e.memPct > 95 ? 'mf-danger' : e.memPct > 85 ? 'mf-warn' : 'mf-ok'
  const sug      = e.suggestion ? ALERT_SUGGESTIONS[e.suggestion] : null

  return (
    <tr className={`at-row at-${e.severity}`}>

      <td className="at-td at-td-sev">
        <span title={e.severity}>{icon}</span>
      </td>

      <td className="at-td">
        <span className="at-type-label">{ALERT_LABELS[e.type] ?? e.type}</span>
      </td>

      <td className="at-td at-td-target">
        {e.node && <span className="at-workload mono-small">{e.node}</span>}
        {e.namespace && e.pod && (
          <>
            <div>
              <span className="at-ns">{e.namespace}</span>
              <span className="at-sep"> / </span>
              <span className="at-workload">{workload}</span>
            </div>
            {workload !== e.pod && (
              <div className="at-pod-hash mono-small">···{e.pod.slice(-10)}</div>
            )}
          </>
        )}
      </td>

      <td className="at-td at-td-ctr">
        {e.container && <div className="at-ctr-name">{e.container}</div>}
        {e.exitCode != null && (
          <span className={`at-exit${e.exitCode !== 0 ? ' at-exit-bad' : ''}`}>exit {e.exitCode}</span>
        )}
        {!e.container && e.exitCode == null && <span className="hcell-dim">—</span>}
      </td>

      <td className="at-td at-td-mem">
        {e.memUsedMi != null && e.memLimitMi != null ? (
          <div className="at-mem-wrap">
            <MiniBar pct={e.memPct} cls={memCls} />
            <span className="at-mem-text">
              {e.memUsedMi}Mi / {e.memLimitMi}Mi
              <span className={`at-mem-pct${e.memPct > 85 ? ' pct-danger' : ''}`}> ({e.memPct}%)</span>
            </span>
          </div>
        ) : e.type === 'CPUThrottling' && e.throttlePct != null ? (
          <div className="at-mem-wrap">
            <MiniBar pct={e.throttlePct} cls="mf-danger" />
            <span className="at-mem-text pct-danger">{e.throttlePct}% throttled</span>
          </div>
        ) : (
          <span className="hcell-dim">—</span>
        )}
      </td>

      <td className="at-td at-td-rate">
        {e.type === 'HighRestarts' ? (
          <>
            <span className="at-restart-count">{e.count}</span>
            {e.restartRate > 0 && <div className="at-restart-rate">~{e.restartRate}/hr</div>}
          </>
        ) : (
          <span className="hcell-dim">—</span>
        )}
      </td>

      <td className="at-td">
        {e.lastTermReason && e.lastTermReason !== 'Completed'
          ? <span className={`alert-term-tag ${e.lastTermReason === 'OOMKilled' ? 'term-oom' : 'term-err'}`}>{e.lastTermReason}</span>
          : e.condition
          ? <span className="alert-term-tag term-err">{e.condition}</span>
          : e.reason
          ? <span className="alert-term-tag term-err">{e.reason}</span>
          : <span className="hcell-dim">—</span>}
      </td>

      <td className="at-td at-td-action">
        {sug
          ? <span className="at-suggestion">{sug.icon} {sug.label}</span>
          : <span className="hcell-dim">—</span>}
      </td>
    </tr>
  )
}

export default function AlertsTable({ errors }) {
  if (!errors?.length) return (
    <div className="alerts-empty">
      <span style={{ fontSize: 28 }}>✓</span>
      <span>No Prometheus alerts — all pods healthy</span>
    </div>
  )
  return (
    <div className="alerts-table-wrap">
      <table className="alerts-table">
        <thead>
          <tr>
            <th className="at-th at-th-sev"></th>
            <th className="at-th">Type</th>
            <th className="at-th">Target</th>
            <th className="at-th">Container / Exit</th>
            <th className="at-th" style={{ minWidth: 170 }}>Memory / CPU</th>
            <th className="at-th">Restarts</th>
            <th className="at-th">Last Exit</th>
            <th className="at-th">Suggested Action</th>
          </tr>
        </thead>
        <tbody>
          {errors.map((e, i) => (
            <AlertRow key={`${e.type}-${e.namespace}-${e.pod ?? e.node}-${i}`} alert={e} />
          ))}
        </tbody>
      </table>
    </div>
  )
}
