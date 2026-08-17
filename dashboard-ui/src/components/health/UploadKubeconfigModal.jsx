import { useState } from 'react'
import { apiFetch } from '../../lib/api'

// Standalone modal for uploading a cluster's kubeconfig — kept separate from
// ClusterManager so the "test connection" flow has its own focused state instead of
// living as an ad hoc form squeezed into the cluster table's header.
//
// Verification is enforced twice, deliberately:
//  - "Test Connection" here calls /api/kube/clusters/test-credential for fast feedback
//    while the admin is still filling in the form (nothing is saved by this call).
//  - The real guarantee is server-side: /api/kube/clusters/upload runs the exact same
//    check again inside sessionManager.storeCredential() before it ever persists
//    anything, so a bad kubeconfig can't get saved even if this button is skipped.
function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export default function UploadKubeconfigModal({ onClose, onUploaded }) {
  const [form, setForm] = useState({ name: '', tier: 'dev', kubeconfig: '' })
  const [fileName, setFileName] = useState(null)
  const [fileSize, setFileSize] = useState(0)
  const [fileError, setFileError] = useState(null)
  const [dragging, setDragging] = useState(false)

  const [testStatus, setTestStatus] = useState('idle') // idle | testing | ok | fail
  const [testError,  setTestError]  = useState(null)

  const [uploading,   setUploading]   = useState(false)
  const [uploadError, setUploadError] = useState(null)

  function setKubeconfig(value) {
    setForm(f => ({ ...f, kubeconfig: value }))
    setTestStatus('idle') // a stale "connected" badge for edited text would be misleading
    setTestError(null)
  }

  function loadFile(file) {
    if (!file) return
    setFileError(null)
    const reader = new FileReader()
    reader.onload = () => {
      setFileName(file.name)
      setFileSize(file.size)
      setKubeconfig(String(reader.result || ''))
    }
    reader.onerror = () => setFileError('Could not read that file')
    reader.readAsText(file)
  }

  function clearFile() {
    setFileName(null)
    setFileSize(0)
    setFileError(null)
    setKubeconfig('')
  }

  function handleDrop(e) {
    e.preventDefault()
    setDragging(false)
    loadFile(e.dataTransfer.files?.[0])
  }

  async function handleTest() {
    if (!form.kubeconfig.trim()) { setTestStatus('fail'); setTestError('Choose a kubeconfig file first'); return }
    setTestStatus('testing'); setTestError(null)
    try {
      const r = await apiFetch('/api/kube/clusters/test-credential', { method: 'POST', body: { kubeconfig: form.kubeconfig } })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || !d.ok) { setTestStatus('fail'); setTestError(d.error || 'Could not connect'); return }
      setTestStatus('ok')
    } catch (err) { setTestStatus('fail'); setTestError(err.message) }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setUploading(true); setUploadError(null)
    try {
      const r = await apiFetch('/api/kube/clusters/upload', { method: 'POST', body: form })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) { setUploadError(d.error || 'Upload failed'); return }
      onUploaded()
    } catch (err) { setUploadError(err.message) }
    finally { setUploading(false) }
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide">
        <div className="modal-header">
          <h3>Upload Cluster Kubeconfig</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <form onSubmit={handleSubmit} className="modal-form">
          <div className="field">
            <label>Cluster name</label>
            <input value={form.name} required
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. azure-prod" />
          </div>

          <div className="field">
            <label>Tier</label>
            <select value={form.tier} onChange={e => setForm(f => ({ ...f, tier: e.target.value }))}>
              <option value="dev">dev</option>
              <option value="staging">staging</option>
              <option value="production">production</option>
            </select>
            <span className="field-hint">Locked once uploaded — delete and re-add the cluster to change it</span>
          </div>

          <div className="field">
            <label>Kubeconfig file</label>

            {!fileName ? (
              <label
                className={`kc-dropzone${dragging ? ' kc-dropzone-active' : ''}${fileError ? ' kc-dropzone-error' : ''}`}
                onDragOver={e => { e.preventDefault(); setDragging(true) }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
              >
                <input type="file" className="kc-dropzone-input"
                  accept=".yaml,.yml,.conf,.config,text/yaml,text/plain"
                  onChange={e => loadFile(e.target.files?.[0])} required />
                <span className="kc-dropzone-icon">⬆</span>
                <span className="kc-dropzone-text">
                  <strong>Click to choose a file</strong> or drag it here
                </span>
              </label>
            ) : (
              <div className="kc-file-chip">
                <span className="kc-file-icon">📄</span>
                <span className="kc-file-meta">
                  <span className="kc-file-name">{fileName}</span>
                  <span className="kc-file-size">{formatBytes(fileSize)}</span>
                </span>
                <button type="button" className="kc-file-remove" title="Remove file" onClick={clearFile}>×</button>
              </div>
            )}

            {fileError && <div className="cm-error">{fileError}</div>}
            <span className="field-hint">
              Must contain exactly one cluster/context — export with: <code>kubectl config view --minify --flatten</code>
            </span>
          </div>

          <div className="cm-test-row">
            <button type="button" className="btn-secondary" onClick={handleTest} disabled={testStatus === 'testing'}>
              {testStatus === 'testing' ? 'Testing…' : 'Test Connection'}
            </button>
            {testStatus === 'ok'   && <span className="cm-test-badge cm-test-ok">✓ Connected</span>}
            {testStatus === 'fail' && <span className="cm-test-badge cm-test-fail">✗ {testError}</span>}
          </div>

          {uploadError && <div className="cm-error">{uploadError}</div>}

          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={uploading}>
              {uploading ? 'Uploading…' : 'Upload & Monitor'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
