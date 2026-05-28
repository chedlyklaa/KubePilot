export default function Toasts({ toasts, dismiss }) {
  return (
    <div className="toasts">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          <span className="toast-icon">{t.type==='success'?'✓':t.type==='warn'?'⚠':t.type==='error'?'✕':'ℹ'}</span>
          <span className="toast-msg">{t.message}</span>
          <button className="toast-close" onClick={() => dismiss(t.id)}>×</button>
        </div>
      ))}
    </div>
  )
}
