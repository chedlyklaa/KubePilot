export const fmtTime = iso => new Date(iso).toLocaleTimeString('en-GB', { hour12: false })
export const fmtDT   = iso => new Date(iso).toLocaleString('en-GB', { hour12: false, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
