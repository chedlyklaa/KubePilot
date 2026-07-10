// Shared between AlertsTable.jsx (AlertRow) and PrometheusPodsTable.jsx (ErrorTypeBadges)
// — both need the same alert-type → human label mapping.
export const ALERT_LABELS = {
  OOMKilled:       'OOM Killed',
  HighRestarts:    'High Restarts',
  CPUThrottling:   'CPU Throttling',
  MemNearLimit:    'Memory Near Limit',
  ImagePullFailed: 'Image Pull Failed',
  NodePressure:    'Node Pressure',
}
