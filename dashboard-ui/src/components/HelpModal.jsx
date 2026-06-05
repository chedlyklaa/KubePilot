import { useState } from 'react'

const TOPICS = [
  { id: 'overview',    icon: '⎈',  label: 'Overview' },
  { id: 'pipeline',    icon: '⚙',  label: 'Agent Pipeline' },
  { id: 'dashboard',   icon: '📊', label: 'Dashboard' },
  { id: 'approvals',   icon: '✅', label: 'Approvals' },
  { id: 'escalations', icon: '🚨', label: 'Escalations' },
  { id: 'orders',      icon: '⌨',  label: 'Orders (Chat)' },
  { id: 'teams',       icon: '🔔', label: 'Teams Alerts' },
  { id: 'health',      icon: '🩺', label: 'Cluster Health' },
  { id: 'chat',        icon: '💬', label: 'AI Chat' },
  { id: 'history',     icon: '📋', label: 'History' },
]

const CONTENT = {
  overview: (
    <div className="help-content">
      <h2>What is KubePilot?</h2>
      <p>KubePilot is an <strong>autonomous Kubernetes management platform</strong> that continuously monitors your clusters, automatically diagnoses pod issues using AI, and applies fixes — all with human oversight through approval gates and escalation workflows.</p>

      <h3>Key capabilities</h3>
      <ul>
        <li><strong>Self-healing</strong> — detects CrashLoopBackOff, OOMKilled, ImagePullBackOff, and other pod failures, then attempts to fix them automatically</li>
        <li><strong>Multi-layer safety</strong> — every action passes through an AI Guardian, a risk engine, and optionally a human approval gate before execution</li>
        <li><strong>Escalation workflow</strong> — after 3 failed fix attempts, the issue is escalated to your team on the dashboard and via Microsoft Teams</li>
        <li><strong>AI Chat</strong> — ask anything about Kubernetes or query your live cluster state in read-only mode</li>
        <li><strong>Orders</strong> — send natural language commands to kubectl with safety classification before execution</li>
        <li><strong>Observability</strong> — real-time agent logs, Prometheus metrics, and full audit history</li>
      </ul>

      <h3>Cluster tiers</h3>
      <div className="help-table">
        <div className="help-tr"><span className="help-th">dev</span><span>Agent acts freely, low risk threshold — most actions auto-approved</span></div>
        <div className="help-tr"><span className="help-th">staging</span><span>Moderate restrictions — some actions require human approval</span></div>
        <div className="help-tr"><span className="help-th">production</span><span>Strictest rules — most actions require admin approval before executing</span></div>
      </div>
    </div>
  ),

  pipeline: (
    <div className="help-content">
      <h2>How the Agent Works</h2>
      <p>Every detected issue goes through a <strong>6-step pipeline</strong> before any kubectl command is executed.</p>

      <div className="help-steps">
        <div className="help-step">
          <span className="help-step-num">1</span>
          <div><strong>Detect</strong>
            <p>The Pod Analyzer scans all pods every cycle (default: 5 min). It identifies CrashLoopBackOff, OOMKilled, ImagePullBackOff, ContainerError, and PodNotReady states.</p>
          </div>
        </div>
        <div className="help-step">
          <span className="help-step-num">2</span>
          <div><strong>Diagnose — LLM</strong>
            <p>The AI reads pod logs, issue details, and recent history, then returns a fix plan: <code>rootCause</code>, <code>action</code> (restart / rollback / delete_pod / scale_down / increase_memory / noop), and <code>risk</code> (LOW / MEDIUM / HIGH).</p>
          </div>
        </div>
        <div className="help-step">
          <span className="help-step-num">3</span>
          <div><strong>Review — Guardian Agent</strong>
            <p>A second independent AI reviews the plan. It can APPROVE, REJECT, or MODIFY the action. If it classifies the action as DANGEROUS, it forces a human approval gate regardless of the risk score.</p>
          </div>
        </div>
        <div className="help-step">
          <span className="help-step-num">4</span>
          <div><strong>Risk Engine</strong>
            <p>A rule-based engine calculates a risk score based on action type, cluster tier, blast radius, and reversibility. If the score exceeds the threshold, it overrides the risk to HIGH and triggers the approval gate.</p>
          </div>
        </div>
        <div className="help-step">
          <span className="help-step-num">5</span>
          <div><strong>Approval Gate</strong>
            <p>HIGH risk actions pause. A card appears in the <strong>Approvals</strong> tab and a Teams message is sent to admins. The action only proceeds if an admin approves it within 10 minutes. Denial or timeout = action skipped for this cycle.</p>
          </div>
        </div>
        <div className="help-step">
          <span className="help-step-num">6</span>
          <div><strong>Fix + Validate</strong>
            <p>The kubectl command runs. After 15 seconds the agent re-checks the pod. If the issue persists it retries next cycle. After <strong>3 failed attempts</strong>, the issue is escalated and the team is notified on Teams.</p>
          </div>
        </div>
      </div>
    </div>
  ),

  dashboard: (
    <div className="help-content">
      <h2>Dashboard</h2>
      <p>The main real-time operations screen. Split into a left log panel and a right action panel.</p>

      <h3>Left — Agent Logs</h3>
      <p>Real-time log stream from the autonomous agent. Every decision, LLM call, fix attempt, and validation result appears here as it happens. Use the filter chips at the top to show only WARN or ERROR entries.</p>
      <div className="help-table">
        <div className="help-tr"><span className="help-th">[AI]</span><span>LLM returned a fix plan: root cause + action + risk level</span></div>
        <div className="help-tr"><span className="help-th">[GUARDIAN]</span><span>Guardian agent reviewed the plan and gave its verdict</span></div>
        <div className="help-tr"><span className="help-th">[RISK]</span><span>Risk engine calculated a score and made a decision</span></div>
        <div className="help-tr"><span className="help-th">[APPROVAL]</span><span>High-risk action is paused and waiting for a human decision</span></div>
        <div className="help-tr"><span className="help-th">[FIX]</span><span>kubectl command was executed on the cluster</span></div>
        <div className="help-tr"><span className="help-th">[RESOLVED]</span><span>Pod re-checked after fix — issue is confirmed gone</span></div>
        <div className="help-tr"><span className="help-th">[UNRESOLVED]</span><span>Fix did not work — agent will retry next cycle</span></div>
        <div className="help-tr"><span className="help-th">[ESCALATE]</span><span>3 attempts exhausted — escalated to team, Teams notified</span></div>
        <div className="help-tr"><span className="help-th">[SKIP]</span><span>Issue is in cooldown period — will be retried later</span></div>
      </div>

      <h3>Right panel — 3 tabs</h3>
      <p>See the <strong>Approvals</strong>, <strong>Escalations</strong>, and <strong>Orders</strong> sections in this help for full details on each tab.</p>
      <p>The <strong>Dashboard nav button</strong> shows a red badge with the total count of pending approvals + unclaimed escalations so you always know when action is needed.</p>
    </div>
  ),

  approvals: (
    <div className="help-content">
      <h2>Approvals</h2>
      <p>When the agent plans a <strong>HIGH risk action</strong> (e.g. increasing memory limits, scaling down in production), it stops and waits for an admin to decide. The action will NOT execute until approved.</p>

      <h3>When does an approval appear?</h3>
      <ul>
        <li>The LLM classified the action risk as <strong>HIGH</strong></li>
        <li>The Risk Engine overrode the risk to HIGH based on cluster tier and blast radius</li>
        <li>The Guardian Agent classified the action as <strong>DANGEROUS</strong></li>
        <li>The action type is in the always-approve list (e.g. <code>increase_memory</code>)</li>
      </ul>

      <h3>What the card shows</h3>
      <div className="help-table">
        <div className="help-tr"><span className="help-th">Issue Key</span><span>The pod/deployment and namespace being affected</span></div>
        <div className="help-tr"><span className="help-th">Action</span><span>What the agent wants to do (restart, rollback, scale_down…)</span></div>
        <div className="help-tr"><span className="help-th">Risk</span><span>LOW / MEDIUM / HIGH as assessed by the LLM + risk engine</span></div>
        <div className="help-tr"><span className="help-th">Root Cause</span><span>The AI's one-sentence diagnosis of why the pod is failing</span></div>
        <div className="help-tr"><span className="help-th">Guardian note</span><span>The safety reviewer's reason for flagging this action</span></div>
        <div className="help-tr"><span className="help-th">Timer</span><span>Auto-denied after 10 minutes if no decision is made</span></div>
      </div>

      <h3>How to respond</h3>
      <p><strong>Approve</strong> — the agent immediately executes the kubectl command and continues the pipeline.</p>
      <p><strong>Deny</strong> — the action is skipped for this cycle. The agent counts this as a failed attempt and will retry with a different approach next cycle.</p>

      <h3>Who can approve?</h3>
      <p>Only users with the <strong>admin</strong> role can see and respond to approval requests. Developers see the cards as read-only.</p>

      <h3>Teams notification</h3>
      <p>Simultaneously with the card appearing, a Teams message is sent to the <strong>admin channel</strong> webhook with all the same details and a link to the dashboard. See the <em>Teams Alerts</em> section for details.</p>
    </div>
  ),

  escalations: (
    <div className="help-content">
      <h2>Escalations</h2>
      <p>An escalation is created when the agent has tried and failed to fix a pod issue <strong>3 times in a row</strong>. The agent stops retrying and hands off to a human. A Teams notification is sent to the general channel.</p>

      <h3>Where to find them</h3>
      <ul>
        <li><strong>Dashboard → Unclaimed tab</strong> — only shows <em>pending</em> escalations (nobody has claimed them yet). This is your action queue.</li>
        <li><strong>Escalations page</strong> — full table of all active escalations with filtering, search, status management, and reassignment.</li>
        <li><strong>History page</strong> — all escalations including resolved ones, full audit trail.</li>
      </ul>

      <h3>Status lifecycle</h3>
      <div className="help-steps">
        <div className="help-step"><span className="help-step-num hs-pending">●</span><div><strong>Pending</strong><p>Just created. Nobody has claimed it. Appears in the Dashboard Unclaimed tab and triggers a Teams notification.</p></div></div>
        <div className="help-step"><span className="help-step-num hs-ack">●</span><div><strong>Acknowledged</strong><p>A team member clicked "Take it" or an admin assigned it to someone. That person is now the owner.</p></div></div>
        <div className="help-step"><span className="help-step-num hs-progress">●</span><div><strong>In Progress</strong><p>Owner has set it to in-progress — they are actively investigating and applying a manual fix.</p></div></div>
        <div className="help-step"><span className="help-step-num hs-fixed">●</span><div><strong>Fixed</strong><p>Owner confirmed the pod is healthy. The escalation is closed and removed from the active list.</p></div></div>
        <div className="help-step"><span className="help-step-num hs-notfixed">●</span><div><strong>Not Fixed</strong><p>Owner investigated but could not resolve it. Escalation stays open and visible.</p></div></div>
        <div className="help-step"><span className="help-step-num hs-help">●</span><div><strong>Need Help</strong><p>Owner is stuck. Admins receive a Teams notification and can reassign to someone else.</p></div></div>
      </div>

      <h3>Re-escalation</h3>
      <p>If an acknowledged escalation is not resolved and the agent keeps failing, it will automatically <strong>reset the status back to Pending</strong> and send a new Teams notification — so the issue is never silently forgotten.</p>

      <h3>Actions by role</h3>
      <div className="help-table">
        <div className="help-tr"><span className="help-th">Developer</span><span>Claim (Take it), update status, request reassignment</span></div>
        <div className="help-tr"><span className="help-th">Admin</span><span>All of the above + assign to any user + delete escalation</span></div>
      </div>
    </div>
  ),

  orders: (
    <div className="help-content">
      <h2>Orders — Natural Language kubectl</h2>
      <p>The <strong>Orders tab</strong> (inside the Dashboard right panel) lets you send direct kubectl commands to your clusters using plain English. The AI translates your intent into the exact kubectl command, classifies its risk, and shows it to you before executing.</p>

      <h3>How it works — step by step</h3>
      <div className="help-steps">
        <div className="help-step">
          <span className="help-step-num">1</span>
          <div><strong>You type a natural language order</strong>
            <p>Example: <em>"restart the payment service in the backend namespace"</em> or <em>"scale the api deployment to 3 replicas"</em></p>
          </div>
        </div>
        <div className="help-step">
          <span className="help-step-num">2</span>
          <div><strong>AI generates the kubectl command</strong>
            <p>The LLM reads your configured clusters (names, contexts, namespaces) and produces the exact kubectl command with the right <code>--context</code> and <code>-n</code> flags.</p>
          </div>
        </div>
        <div className="help-step">
          <span className="help-step-num">3</span>
          <div><strong>Safety classification</strong>
            <p>The command is classified into a category and risk level:</p>
          </div>
        </div>
      </div>

      <div className="help-table">
        <div className="help-tr"><span className="help-th">read-only</span><span>get, describe, logs, top — <strong style={{color:'var(--success)'}}>LOW</strong> risk — safe to execute</span></div>
        <div className="help-tr"><span className="help-th">rolling-update</span><span>rollout restart / undo — <strong style={{color:'var(--warn)'}}>MEDIUM</strong> risk — pods recycled</span></div>
        <div className="help-tr"><span className="help-th">scaling</span><span>scale replicas up or down — <strong style={{color:'var(--warn)'}}>MEDIUM</strong> risk</span></div>
        <div className="help-tr"><span className="help-th">config-change</span><span>set resources, patch, apply — <strong style={{color:'var(--danger)'}}>HIGH</strong> risk</span></div>
        <div className="help-tr"><span className="help-th">destructive</span><span>delete pod/deployment/namespace — <strong style={{color:'var(--danger)'}}>HIGH</strong> risk</span></div>
      </div>

      <div className="help-steps" style={{marginTop: 12}}>
        <div className="help-step">
          <span className="help-step-num">4</span>
          <div><strong>You review and confirm</strong>
            <p>The card shows the generated command, the risk level, a short explanation, and an Approve / Deny button. You see exactly what will run before it runs.</p>
          </div>
        </div>
        <div className="help-step">
          <span className="help-step-num">5</span>
          <div><strong>Execution + output</strong>
            <p>If you approve, the command runs and the raw kubectl output is shown inline. If the command fails, the AI diagnoses the error and suggests a corrected command.</p>
          </div>
        </div>
      </div>

      <h3>Example orders you can type</h3>
      <div className="help-table">
        <div className="help-tr"><span className="help-th" style={{minWidth: 180}}>show all pods in backend</span><span>→ kubectl get pods -n backend</span></div>
        <div className="help-tr"><span className="help-th" style={{minWidth: 180}}>restart the api service</span><span>→ kubectl rollout restart deployment/api</span></div>
        <div className="help-tr"><span className="help-th" style={{minWidth: 180}}>show logs for payment pod</span><span>→ kubectl logs &lt;pod&gt; -n backend --tail=50</span></div>
        <div className="help-tr"><span className="help-th" style={{minWidth: 180}}>scale order-service to 2</span><span>→ kubectl scale deployment/order-service --replicas=2</span></div>
        <div className="help-tr"><span className="help-th" style={{minWidth: 180}}>describe the failing pod</span><span>→ kubectl describe pod &lt;pod&gt; -n &lt;ns&gt;</span></div>
      </div>

      <h3>Important notes</h3>
      <ul>
        <li>Orders execute on your <strong>real cluster</strong> — always review the command before approving</li>
        <li>The AI picks the cluster and namespace from your configuration — specify explicitly if you have multiple clusters</li>
        <li>Command history is saved per user and persists across sessions</li>
      </ul>
    </div>
  ),

  teams: (
    <div className="help-content">
      <h2>Microsoft Teams Alerts</h2>
      <p>KubePilot sends Adaptive Card messages to Teams automatically. Two separate webhooks are used so different channels can receive different alert types.</p>

      <h3>Setup — .env configuration</h3>
      <div className="help-table">
        <div className="help-tr"><span className="help-th">TEAMS_ADMIN_WEBHOOK_URL</span><span>Admin channel — receives approval requests</span></div>
        <div className="help-tr"><span className="help-th">TEAMS_WEBHOOK_URL</span><span>General channel — receives escalation alerts</span></div>
        <div className="help-tr"><span className="help-th">DASHBOARD_URL</span><span>Link included in every Teams card (e.g. http://localhost:5173)</span></div>
      </div>
      <p style={{marginTop: 8}}>To create a webhook: in Teams, go to your channel → <strong>Connectors</strong> → <strong>Incoming Webhook</strong> → copy the URL into your <code>.env</code> file.</p>

      <h3>Alert type 1 — Approval Request</h3>
      <p>Sent to <strong>TEAMS_ADMIN_WEBHOOK_URL</strong> when the agent needs a human decision on a high-risk action.</p>
      <div className="help-table">
        <div className="help-tr"><span className="help-th">When</span><span>Agent reaches the approval gate (risk = HIGH or DANGEROUS)</span></div>
        <div className="help-tr"><span className="help-th">Content</span><span>Issue key, cluster, namespace, proposed action, risk level, root cause, Guardian note</span></div>
        <div className="help-tr"><span className="help-th">Action button</span><span>"Open Dashboard to Approve / Deny" → takes you straight to the Approvals tab</span></div>
        <div className="help-tr"><span className="help-th">Urgency</span><span>Auto-denied after 10 minutes if nobody acts</span></div>
      </div>

      <h3>Alert type 2 — Escalation</h3>
      <p>Sent to <strong>TEAMS_WEBHOOK_URL</strong> when the agent gives up after 3 failed fix attempts.</p>
      <div className="help-table">
        <div className="help-tr"><span className="help-th">When</span><span>Agent exhausts MAX_FIX_ATTEMPTS (3) without resolving the issue</span></div>
        <div className="help-tr"><span className="help-th">Content</span><span>Issue key, cluster, namespace, issue type, number of attempts made</span></div>
        <div className="help-tr"><span className="help-th">Action button</span><span>"Open Escalations Dashboard" → takes you to the Escalations tab</span></div>
        <div className="help-tr"><span className="help-th">Re-alert</span><span>If the escalation is acknowledged but still not fixed, a new message is sent when the agent re-escalates</span></div>
      </div>

      <h3>Alert type 3 — Need Help</h3>
      <p>Sent to admins (in-app notification) when a developer marks an escalation as <strong>Need Help</strong> or requests reassignment. This does not send a Teams message — it uses the in-app notification bell instead.</p>

      <h3>Not receiving messages?</h3>
      <ul>
        <li>Check <code>TEAMS_WEBHOOK_URL</code> and <code>TEAMS_ADMIN_WEBHOOK_URL</code> are set in your <code>.env</code> file</li>
        <li>Check the server logs for <code>[Teams] Failed to send</code> errors</li>
        <li>Verify the webhook URL is still valid in your Teams channel settings (they expire if unused)</li>
        <li>Make sure <code>DASHBOARD_URL</code> points to a reachable address (not localhost if Teams is external)</li>
      </ul>
    </div>
  ),

  health: (
    <div className="help-content">
      <h2>Cluster Health</h2>
      <p>A live view of every pod across all configured clusters, refreshed every 30 seconds.</p>

      <h3>Status summary bar</h3>
      <p>Shows counts of Running, Degraded, Pending, and Failed pods across all clusters at a glance.</p>

      <h3>Pod table columns</h3>
      <div className="help-table">
        <div className="help-tr"><span className="help-th">Pod</span><span>Pod name + colored status dot (green = running, orange = degraded, red = failed)</span></div>
        <div className="help-tr"><span className="help-th">Namespace</span><span>Kubernetes namespace the pod belongs to</span></div>
        <div className="help-tr"><span className="help-th">Phase</span><span>Kubernetes pod phase badge (Running / Pending / Failed / Succeeded)</span></div>
        <div className="help-tr"><span className="help-th">Ready</span><span>Ready containers / total containers (e.g. 2/2)</span></div>
        <div className="help-tr"><span className="help-th">Restarts</span><span>Total container restarts — orange badge ≥5, red badge ≥15</span></div>
        <div className="help-tr"><span className="help-th">CPU</span><span>Live CPU usage. A ~ tilde means it's a Prometheus 5-min average (kubectl top unavailable)</span></div>
        <div className="help-tr"><span className="help-th">Memory</span><span>Memory bar showing usage vs. limit as a percentage</span></div>
        <div className="help-tr"><span className="help-th">Age</span><span>Time since the pod started</span></div>
      </div>

      <h3>Prometheus Error Panel</h3>
      <p>If Prometheus is connected, a red panel appears at the top showing pods that were recently OOMKilled or have abnormally high restart counts (above threshold). These are the pods most likely to be escalated next.</p>
    </div>
  ),

  chat: (
    <div className="help-content">
      <h2>AI Chat</h2>
      <p>A conversational Kubernetes expert powered by the same LLM as the agent. This is separate from the Orders tab — it answers questions, it does not execute commands.</p>

      <h3>⎈ Cluster button — Live mode</h3>
      <p>When the button is <strong>green</strong>, the AI has read-only access to your live cluster. Before every message, the dashboard fetches real pod states, active escalations, pending approvals, and Prometheus alerts and injects them directly into your question. The AI will reference real pod names, namespaces, and restart counts.</p>

      <h3>General mode (button off)</h3>
      <p>A senior Kubernetes SRE for any general question — YAML, Helm, HPA, debugging, architecture, networking, cloud providers, CI/CD.</p>

      <h3>📥 Download PDF</h3>
      <p>When your question contains the words <em>report</em>, <em>pdf</em>, <em>download</em>, <em>export</em>, <em>summary</em>, or <em>incident</em>, a <strong>📥 Download PDF</strong> button appears automatically below the AI's response. Click it to open a formatted print-ready page and save as PDF from your browser print dialog.</p>

      <h3>Example prompts (Live mode)</h3>
      <ul>
        <li>"Give me a full cluster health report as PDF"</li>
        <li>"Which pods have the most restarts and what is causing them?"</li>
        <li>"Explain the active escalations and what I should do to resolve them"</li>
        <li>"Should I approve or deny the pending approvals? Explain the risk of each one"</li>
        <li>"Generate an incident summary report for all failing pods"</li>
      </ul>
    </div>
  ),

  history: (
    <div className="help-content">
      <h2>History</h2>
      <p>A permanent audit trail of all agent decisions and human actions.</p>

      <h3>Approvals history</h3>
      <p>Every approval request the agent ever made — including who approved or denied it, the action taken, the risk level, and the timestamp. Use this for compliance reviews, post-mortems, and understanding why a certain action was or wasn't taken.</p>

      <h3>Escalations history</h3>
      <p>Every escalation ever created, including resolved ones. Shows: who was assigned, how many fix attempts were made, what the final status was, and when it was resolved.</p>
      <p>Admins can reassign historical escalation records from this page even after the active escalation is closed — useful for tracking accountability after the fact.</p>
    </div>
  ),
}

export default function HelpModal({ onClose }) {
  const [topic, setTopic] = useState('overview')

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="help-modal">
        <div className="help-sidebar">
          <div className="help-sidebar-title">KubePilot Help</div>
          {TOPICS.map(t => (
            <button
              key={t.id}
              className={`help-nav-btn ${topic === t.id ? 'active' : ''}`}
              onClick={() => setTopic(t.id)}
            >
              <span className="help-nav-icon">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>

        <div className="help-body">
          <button className="help-close" onClick={onClose} title="Close">✕</button>
          {CONTENT[topic]}
        </div>
      </div>
    </div>
  )
}
