// Format a byte count
export function fmtBytes(b) {
  if (b == null) return null
  if (b < 1024)      return `${b} B`
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} Ki`
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(0)} Mi`
  return                    `${(b / 1024 ** 3).toFixed(2)} Gi`
}

export function RestartCount({ n }) {
  if (n === 0) return <span className="hcell-dim">—</span>
  const cls = n > 15 ? 'rc-high' : n > 5 ? 'rc-med' : 'rc-low'
  return <span className={`rc ${cls}`}>{n}</span>
}
