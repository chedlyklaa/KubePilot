export default function SignOutModal({ onConfirm, onCancel }) {
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div className="modal signout-modal">
        <div className="signout-icon">⎈</div>
        <h3 className="signout-title">Sign out?</h3>
        <p className="signout-sub">You'll need to log in again to access the dashboard.</p>
        <div className="signout-actions">
          <button className="btn-secondary" onClick={onCancel}>Cancel</button>
          <button className="btn-danger-solid" onClick={onConfirm}>Sign out</button>
        </div>
      </div>
    </div>
  )
}
