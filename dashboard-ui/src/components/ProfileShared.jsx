// Shared UI primitives used by ProfilePage and UserProfileModal.
// Keeping them here avoids duplicating ~60 lines across both files.

export function StatCard({ icon, label, value, color, small = false }) {
  return (
    <div className={`stat-card stat-card-${color}${small ? ' stat-card-sm' : ''}`}>
      <div className="stat-icon">{icon}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  )
}

export function ActivityChart({ daily }) {
  const days = []
  const now = new Date()
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    days.push({
      key,
      label: d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }),
      count: daily[key] ?? 0,
    })
  }
  const max = Math.max(...days.map(d => d.count), 1)
  return (
    <div className="activity-chart">
      <div className="activity-chart-title">Activity — Last 30 Days</div>
      <div className="activity-bars">
        {days.map(d => (
          <div key={d.key} className="activity-bar-wrap"
            title={`${d.label}: ${d.count} action${d.count !== 1 ? 's' : ''}`}>
            <div
              className={`activity-bar${d.count > 0 ? ' activity-bar-active' : ''}`}
              style={{ height: `${Math.max((d.count / max) * 100, d.count > 0 ? 8 : 0)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="activity-axis">
        <span>{days[0].label}</span>
        <span>{days[14].label}</span>
        <span>{days[29].label}</span>
      </div>
    </div>
  )
}
