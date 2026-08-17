export const fmtTime = iso => new Date(iso).toLocaleTimeString('en-GB', { hour12: false })
export const fmtDT   = iso => new Date(iso).toLocaleString('en-GB', { hour12: false, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

// Costs are usually well under €0.01 at normal usage — 2 decimals would show "€0.00"
// for almost everything, so scale precision down as the amount shrinks.
export const fmtCost = eur => {
  if (!eur) return '€0.00'
  if (eur < 0.0001) return '<€0.0001'
  return `€${(eur < 1 ? eur.toFixed(4) : eur.toFixed(2))}`
}
