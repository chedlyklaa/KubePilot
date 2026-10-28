// Confirmation modal
export default function ConfirmDialog({
  icon = '⚠',
  title,
  message,
  confirmLabel     = 'Confirm',
  cancelLabel      = 'Cancel',
  danger           = true,
  confirmDisabled  = false,
  onConfirm,
  onCancel,
}) {
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div className="modal confirm-modal">
        <div className="confirm-icon">{icon}</div>
        <h3 className="confirm-title">{title}</h3>
        {message && <p className="confirm-sub">{message}</p>}
        <div className="confirm-actions">
          <button className="btn-secondary" onClick={onCancel}>{cancelLabel}</button>
          <button className={danger ? 'btn-danger-solid' : 'btn-primary'} onClick={onConfirm} disabled={confirmDisabled}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
