import { useState } from 'react'

const TOPICS = [
  { id: 'overview',       icon: '⎈',  label: 'Overview' },
  { id: 'pipeline',       icon: '⚙',  label: 'Agent Pipeline' },
  { id: 'agents',         icon: '🧠', label: 'Agent Management' },
  { id: 'dashboard',      icon: '📊', label: 'Dashboard' },
  { id: 'approvals',      icon: '✅', label: 'Approvals' },
  { id: 'escalations',    icon: '🚨', label: 'Escalations' },
  { id: 'orders',         icon: '⌨',  label: 'Orders (Chat)' },
  { id: 'chat',           icon: '💬', label: 'AI Chat' },
  { id: 'health',         icon: '🩺', label: 'Cluster Health' },
  { id: 'capacity',       icon: '📈', label: 'Capacity' },
  { id: 'rbac',           icon: '🔐', label: 'RBAC' },
  { id: 'notifications',  icon: '🔔', label: 'Notifications' },
  { id: 'users',          icon: '👥', label: 'Users & Teams' },
  { id: 'history',        icon: '📋', label: 'History' },
]

const CONTENT = {
  overview: (
    <div className="help-content">
      <h2>What is KubePilot?</h2>
      <p>KubePilot is an <strong>autonomous Kubernetes management platform</strong> that continuously monitors your clusters, automatically diagnoses pod issues using AI, and applies fixes — all with human oversight through approval gates and escalation workflows.</p>

      <h3>Key capabilities</h3>
      <ul>
        <li><strong>Self-healing</strong> — detects CrashLoopBackOff, OOMKilled, ImagePullBackOff, ContainerError, and PodNotReady, then attempts to fix them automatically</li>
        <li><strong>Investigation gate</strong> — for complex failures, the agent enriches evidence (previous logs, rollout history, describe events) before planning a fix, improving diagnosis accuracy</li>
        <li><strong>Multi-layer safety</strong> — every autonomous action passes through an AI Guardian, a risk engine, and optionally a human approval gate before execution</li>
        <li><strong>Root Cause Analysis (RCA)</strong> — structured post-mortem cards with suspected cause, confidence score, evidence list, and capacity context for OOM-type issues</li>
        <li><strong>Predictive Capacity</strong> — hybrid EWMA + weighted linear regression forecasts resource exhaustion with ETA countdowns and trend sparklines</li>
        <li><strong>Change Correlation</strong> — detects whether a recent deployment or config change caused a pod failure</li>
        <li><strong>Escalation workflow</strong> — after 3 failed fix attempts the issue is handed off to your team on the dashboard and via Microsoft Teams</li>
        <li><strong>Orders (Command Chat)</strong> — issue natural language kubectl commands with a built-in clarification system that never guesses missing information</li>
        <li><strong>AI Chat</strong> — ask anything about Kubernetes or query your live cluster state in read-only mode</li>
        <li><strong>RBAC Management</strong> — browse role bindings, create roles, manage service accounts, and audit permission changes — all with kubectl under the hood</li>
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
      <p>Every detected issue goes through a <strong>multi-step pipeline</strong> before any kubectl command is executed. Complex issues trigger an <strong>Investigation Gate</strong> that enriches evidence before planning.</p>

      <div className="help-steps">
        <div className="help-step">
          <span className="help-step-num">1</span>
          <div><strong>Detect</strong>
            <p>Five data sources are fetched in parallel every cycle (default: <strong>30 seconds</strong>): pods, nodes, events, per-pod Prometheus metrics, and per-node Prometheus metrics. The Pod Analyzer then identifies CrashLoopBackOff, OOMKilled, ImagePullBackOff, ContainerError, Unschedulable, PodNotReady, and init-container failures. The Node Analyzer flags NodeNotReady, resource pressure, flapping, and CPU/memory saturation. The Correlation Engine maps failing pods to their node to detect hot-node patterns.</p>
          </div>
        </div>
        <div className="help-step">
          <span className="help-step-num">2</span>
          <div><strong>Evidence Assessment &amp; Investigation Gate</strong>
            <p>Before calling the LLM, the agent evaluates whether the available evidence is sufficient. Signals assessed include: exit code presence, crash loop detection, backoff events, log sparsity, and restart count. If evidence is insufficient, the agent enriches it by fetching previous container logs, <code>kubectl describe</code> events, and rollout history before proceeding.</p>
          </div>
        </div>
        <div className="help-step">
          <span className="help-step-num">3</span>
          <div><strong>Diagnose — LLM</strong>
            <p>The AI reads pod logs, issue details, enriched evidence, and recent history, then returns a fix plan: <code>rootCause</code>, <code>action</code> (restart / rollback / delete_pod / scale_down / increase_memory / noop), and <code>risk</code> (LOW / MEDIUM / HIGH). For OOM-type issues, capacity forecast context is also injected.</p>
          </div>
        </div>
        <div className="help-step">
          <span className="help-step-num">4</span>
          <div><strong>Root Cause Analysis (RCA)</strong>
            <p>After the main diagnosis, a dedicated Investigator Agent generates a structured RCA with: suspected cause, risk level, confidence score (0–100%), supporting evidence list, and a recommended focus. For memory-related issues, it also includes a Capacity context banner (current usage %, slope, and saturation ETA).</p>
          </div>
        </div>
        <div className="help-step">
          <span className="help-step-num">5</span>
          <div><strong>Review — Guardian Agent</strong>
            <p>A second independent AI reviews the plan. It can APPROVE, REJECT, or MODIFY the action. If it classifies the action as DANGEROUS, it forces a human approval gate regardless of the risk score.</p>
          </div>
        </div>
        <div className="help-step">
          <span className="help-step-num">6</span>
          <div><strong>Risk Engine</strong>
            <p>A rule-based engine calculates a risk score based on action type, cluster tier, blast radius, and reversibility. If the score exceeds the threshold, it overrides the risk to HIGH and triggers the approval gate.</p>
          </div>
        </div>
        <div className="help-step">
          <span className="help-step-num">7</span>
          <div><strong>Approval Gate</strong>
            <p>HIGH risk actions pause. A card appears in the <strong>Approvals</strong> tab and a Teams message is sent to admins. The action only proceeds if an admin approves within 10 minutes. Denial or timeout = action skipped for this cycle.</p>
          </div>
        </div>
        <div className="help-step">
          <span className="help-step-num">8</span>
          <div><strong>Fix + Validate</strong>
            <p>The kubectl command runs. After 15 seconds the agent re-checks the pod. If the issue persists it retries next cycle. After <strong>3 failed attempts</strong>, the issue is escalated and the team is notified on Teams.</p>
          </div>
        </div>
        <div className="help-step">
          <span className="help-step-num">9</span>
          <div><strong>Reflect &amp; Learn</strong>
            <p>Each resolved or escalated episode is stored in the agent's long-term memory (vector store + MongoDB). Successful fix patterns are used to improve confidence scores for future identical issues.</p>
          </div>
        </div>
      </div>

      <h3>Parallel: Capacity Forecasting</h3>
      <p>Every agent cycle also runs the Capacity Forecast Engine in the background. It collects CPU, memory, and disk snapshots, applies a hybrid EWMA + weighted linear regression model, and fires alerts when resource exhaustion is projected within configurable thresholds. This is completely separate from the fix pipeline.</p>
    </div>
  ),

  agents: (
    <div className="help-content">
      <h2>Agent Management</h2>
      <p>The Agent Management page lets you monitor the status of every autonomous component, tune runtime configuration on the fly, review learned rules, and see which clusters are being watched.</p>

      <h3>Status bar</h3>
      <div className="help-table">
        <div className="help-tr"><span className="help-th">Total Agents</span><span>Number of registered agent modules (core agents + analyzers + engines)</span></div>
        <div className="help-tr"><span className="help-th">Active</span><span>How many are currently enabled and participating in the cycle</span></div>
        <div className="help-tr"><span className="help-th">Clusters</span><span>Number of clusters the orchestrator is monitoring</span></div>
        <div className="help-tr"><span className="help-th">Prometheus</span><span>Connected = metrics available. Offline = agent runs without CPU/memory data</span></div>
        <div className="help-tr"><span className="help-th">Vector Store</span><span>Ready = Qdrant is reachable and semantic search is active. Offline = memory-based fallback only</span></div>
      </div>

      <h3>Agent types</h3>
      <div className="help-table">
        <div className="help-tr"><span className="help-th">🧠 Core Agents</span><span>LLM-powered agents — Investigator (RCA), Planner (decision), Guardian (safety review), Reflection (learning). Each calls the LLM with a dedicated prompt and structured output.</span></div>
        <div className="help-tr"><span className="help-th">🔍 Analyzers</span><span>Deterministic rule-based modules — Pod Analyzer, Node Analyzer, Event Analyzer, Correlation Engine. No LLM, no network call — pure code running on raw kubectl JSON output.</span></div>
        <div className="help-tr"><span className="help-th">⚙ Engines</span><span>Specialized engines — Change Correlation Engine (detects if a recent deploy caused an issue), Capacity Forecast Engine (predicts resource exhaustion). Run alongside the main pipeline each cycle.</span></div>
      </div>

      <h3>Runtime Configuration</h3>
      <p>Settings you can change without restarting the server. Changes apply to the next cycle immediately.</p>
      <div className="help-table">
        <div className="help-tr"><span className="help-th">Cycle Interval</span><span>How often the orchestrator runs a full detection + remediation cycle. Default: 30 seconds. Expressed in milliseconds (<code>CYCLE_INTERVAL_MS</code>).</span></div>
        <div className="help-tr"><span className="help-th">LLM Model</span><span>The primary model used by Planner, Investigator, and Chat (<code>OPENAI_MODEL</code>). Change this to switch between GPT-4o, GPT-4-turbo, etc.</span></div>
        <div className="help-tr"><span className="help-th">Guardian Model</span><span>The model used by Guardian and Reflection agents (<code>GUARDIAN_MODEL</code>). Can differ from the primary model — e.g. use a faster/cheaper model for safety review.</span></div>
        <div className="help-tr"><span className="help-th">Capacity Forecast</span><span>Enable or disable the Capacity Forecast Engine (<code>CAPACITY_FORECAST_ENABLED</code>). When disabled, the Capacity page shows no new data.</span></div>
      </div>

      <h3>Learned Rules</h3>
      <p>Rules are automatically generated by the Reflection Agent when the same action fails repeatedly for the same issue type. They are injected into the Planner's prompt at the start of each diagnosis — preventing the LLM from repeating known-bad decisions.</p>
      <div className="help-table">
        <div className="help-tr"><span className="help-th">Issue Type</span><span>The Kubernetes issue this rule applies to (e.g. CrashLoopBackOff, OOMKilled)</span></div>
        <div className="help-tr"><span className="help-th">Condition</span><span>The trigger condition in human-readable form (e.g. "exit code 137 + restart count &gt; 5")</span></div>
        <div className="help-tr"><span className="help-th">Rule</span><span>The constraint given to the Planner (e.g. "do not restart — memory limit increase required first")</span></div>
        <div className="help-tr"><span className="help-th">Confidence</span><span>How strongly the rule should be weighted. Auto-generated rules start at 50% and grow with occurrences.</span></div>
        <div className="help-tr"><span className="help-th">Source</span><span>Auto-detected (generated by Reflection Agent) or Manual (created by an admin)</span></div>
      </div>
      <p>You can <strong>disable</strong> a rule temporarily without deleting it — useful if you want to test whether the LLM makes a different decision without the constraint. <strong>Delete</strong> removes it permanently.</p>

      <h3>Monitored Clusters</h3>
      <p>The list of clusters the orchestrator runs agents against each cycle. Defined in <code>clusters.yaml</code>. Each entry shows the cluster name, tier (dev / staging / production), kubectl context, and the monitored namespaces.</p>
      <p>Changes to <code>clusters.yaml</code> are detected automatically — new clusters are added and removed clusters are stopped <strong>without restarting the server</strong> (hot-reload via file watcher).</p>
      <div className="help-table">
        <div className="help-tr"><span className="help-th">dev</span><span>Low risk threshold — most actions auto-approved</span></div>
        <div className="help-tr"><span className="help-th">staging</span><span>Moderate — some actions need approval</span></div>
        <div className="help-tr"><span className="help-th">production</span><span>Strictest rules — most actions need admin approval</span></div>
      </div>
      <p>To add a new cluster, use the <strong>Orders tab</strong> and type <em>"create cluster &lt;name&gt;"</em> — or edit <code>clusters.yaml</code> directly.</p>
    </div>
  ),

  dashboard: (
    <div className="help-content">
      <h2>Dashboard</h2>
      <p>The main real-time operations screen. Split into a left log panel and a right action panel with three tabs.</p>

      <h3>Left — Agent Logs</h3>
      <p>Real-time log stream from the autonomous agent. Every decision, LLM call, fix attempt, and validation result appears here as it happens. Use the filter chips at the top to show only WARN or ERROR entries.</p>
      <div className="help-table">
        <div className="help-tr"><span className="help-th">[AI]</span><span>LLM returned a fix plan: root cause + action + risk level</span></div>
        <div className="help-tr"><span className="help-th">[INVESTIGATE]</span><span>Evidence gate triggered — fetching previous logs, describe events, rollout history</span></div>
        <div className="help-tr"><span className="help-th">[RCA]</span><span>Root cause analysis generated for the current issue</span></div>
        <div className="help-tr"><span className="help-th">[GUARDIAN]</span><span>Guardian agent reviewed the plan and gave its verdict</span></div>
        <div className="help-tr"><span className="help-th">[RISK]</span><span>Risk engine calculated a score and made a decision</span></div>
        <div className="help-tr"><span className="help-th">[APPROVAL]</span><span>High-risk action is paused and waiting for a human decision</span></div>
        <div className="help-tr"><span className="help-th">[FIX]</span><span>kubectl command was executed on the cluster</span></div>
        <div className="help-tr"><span className="help-th">[RESOLVED]</span><span>Pod re-checked after fix — issue is confirmed gone</span></div>
        <div className="help-tr"><span className="help-th">[UNRESOLVED]</span><span>Fix did not work — agent will retry next cycle</span></div>
        <div className="help-tr"><span className="help-th">[ESCALATE]</span><span>3 attempts exhausted — escalated to team, Teams notified</span></div>
        <div className="help-tr"><span className="help-th">[CAPACITY]</span><span>Capacity forecast alert — resource saturation approaching</span></div>
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
        <div className="help-tr"><span className="help-th">RCA card</span><span>Structured root cause analysis with confidence score and evidence list (when available)</span></div>
        <div className="help-tr"><span className="help-th">Timer</span><span>Auto-denied after 10 minutes if no decision is made</span></div>
      </div>

      <h3>How to respond</h3>
      <p><strong>Approve</strong> — the agent immediately executes the kubectl command and continues the pipeline.</p>
      <p><strong>Deny</strong> — the action is skipped for this cycle. The agent counts this as a failed attempt and will retry with a different approach next cycle.</p>

      <h3>Who can approve?</h3>
      <p>Only users with the <strong>admin</strong> role can see and respond to approval requests. Developers see the cards as read-only.</p>

      <h3>Teams notification</h3>
      <p>Simultaneously with the card appearing, a Teams message is sent to the <strong>admin channel</strong> webhook with all the same details and a link to the dashboard.</p>
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
      <p>A built-in <strong>Clarification System</strong> ensures the agent never invents, guesses, or silently assumes missing information. If it needs more details, it asks — then waits for your answer before generating any command.</p>

      <h3>How it works — step by step</h3>
      <div className="help-steps">
        <div className="help-step">
          <span className="help-step-num">1</span>
          <div><strong>You type a natural language order</strong>
            <p>Example: <em>"restart the payment service"</em> or <em>"scale the api deployment to 3 replicas in the backend namespace"</em></p>
          </div>
        </div>
        <div className="help-step">
          <span className="help-step-num">2</span>
          <div><strong>Intent extraction + completeness check</strong>
            <p>The system identifies what you want to do and what parameters you provided. It then checks whether all required information is present using a built-in schema for every Kubernetes operation. Missing anything? It asks — it never guesses.</p>
          </div>
        </div>
        <div className="help-step">
          <span className="help-step-num">3</span>
          <div><strong>Clarification (if needed)</strong>
            <p>If any required field is missing, ambiguous, or the confidence is too low, the agent returns a focused question instead of a command. You answer it in the same input box. The thread continues until all information is collected.</p>
          </div>
        </div>
        <div className="help-step">
          <span className="help-step-num">4</span>
          <div><strong>Command generation + safety classification</strong>
            <p>Once all required information is available, the AI generates the exact kubectl command and classifies its risk:</p>
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
          <span className="help-step-num">5</span>
          <div><strong>You review and confirm</strong>
            <p>The plan card shows the generated command, category, risk level, a short explanation, and Approve / Deny buttons. You see exactly what will run — before it runs.</p>
          </div>
        </div>
        <div className="help-step">
          <span className="help-step-num">6</span>
          <div><strong>Execution + output</strong>
            <p>If you approve, the command runs and the raw kubectl output is shown inline. If the command fails, the AI diagnoses the error and suggests a corrected command you can retry with one click.</p>
          </div>
        </div>
      </div>

      <h3>Clarification in action</h3>
      <div className="help-table">
        <div className="help-tr"><span className="help-th" style={{minWidth:180}}>You: "Create a pod"</span><span>→ "What resource name, image name, and namespace should I use?"</span></div>
        <div className="help-tr"><span className="help-th" style={{minWidth:180}}>You: "Scale auth-service"</span><span>→ "What replica count should auth-service be scaled to?"</span></div>
        <div className="help-tr"><span className="help-th" style={{minWidth:180}}>You: "Delete a deployment"</span><span>→ "Which deployment and namespace should be targeted?"</span></div>
        <div className="help-tr"><span className="help-th" style={{minWidth:180}}>You: "Update nginx"</span><span>→ "What deployment name, image name, and image tag should I use?"</span></div>
        <div className="help-tr"><span className="help-th" style={{minWidth:180}}>You: "Restart auth"</span><span>→ "I found multiple possible targets: Deployment/auth, Pod/auth-xxxxx. Which one should I target?"</span></div>
      </div>

      <h3>Supported operations</h3>
      <p>The system recognises all standard Kubernetes operations:</p>
      <ul>
        <li><strong>Pods &amp; Deployments</strong> — create, delete, describe, scale, restart, rollout undo/status, update image, set resources, patch</li>
        <li><strong>StatefulSets &amp; DaemonSets</strong> — restart, scale, delete</li>
        <li><strong>Services &amp; Ingress</strong> — create, delete, describe, expose deployment</li>
        <li><strong>ConfigMaps &amp; Secrets</strong> — create, delete</li>
        <li><strong>Namespaces &amp; PVCs</strong> — create, delete, describe</li>
        <li><strong>RBAC</strong> — create/delete roles, role bindings, cluster roles, cluster role bindings</li>
        <li><strong>Nodes</strong> — drain, cordon, uncordon, label, taint, describe</li>
        <li><strong>Read-only</strong> — get pods/deployments/services/nodes/events, top pods/nodes</li>
        <li><strong>Cluster provisioning</strong> — "create cluster mydev" provisions a Minikube profile and adds it to monitoring automatically</li>
      </ul>

      <h3>What the agent will NEVER do</h3>
      <ul>
        <li>Invent or guess a resource name, namespace, image tag, or replica count</li>
        <li>Default the namespace to "default" unless you explicitly said so</li>
        <li>Assume an image tag (e.g. will not use "latest" unless you said "latest")</li>
        <li>Pick a port number, node name, or label without asking first</li>
      </ul>

      <h3>Tips</h3>
      <ul>
        <li>Be specific: <em>"restart the payment-api deployment in the backend namespace"</em> is better than <em>"restart payment"</em></li>
        <li>The input box changes style when you are mid-clarification thread — type your answer and press Enter</li>
        <li>Command history is saved per user and persists across sessions</li>
        <li>If a command fails, click <strong>Try fix ↑</strong> in the error card to retry with the suggested correction</li>
      </ul>
    </div>
  ),

  notifications: (
    <div className="help-content">
      <h2>Notifications</h2>
      <p>KubePilot's notification system routes alerts to multiple channels based on severity. Configure channels and routing rules from the <strong>Notifications Settings</strong> page.</p>

      <h3>Supported channels</h3>
      <div className="help-table">
        <div className="help-tr"><span className="help-th">In-App</span><span>Bell icon in the top bar — real-time alerts inside the dashboard, visible to all users</span></div>
        <div className="help-tr"><span className="help-th">Microsoft Teams</span><span>Adaptive Card messages via webhook — separate webhooks for admin alerts and general alerts</span></div>
        <div className="help-tr"><span className="help-th">Email</span><span>SMTP-based email notifications — assignment emails when an escalation is assigned to a team member</span></div>
        <div className="help-tr"><span className="help-th">Slack</span><span>Webhook-based Slack messages (configurable)</span></div>
        <div className="help-tr"><span className="help-th">Telegram / Discord / Webhook</span><span>Additional channels configurable via the Notifications Settings page</span></div>
      </div>

      <h3>Severity routing</h3>
      <div className="help-table">
        <div className="help-tr"><span className="help-th">INFO</span><span>In-App only</span></div>
        <div className="help-tr"><span className="help-th">WARNING</span><span>In-App + Teams</span></div>
        <div className="help-tr"><span className="help-th">ERROR</span><span>In-App + Teams + Email</span></div>
        <div className="help-tr"><span className="help-th">CRITICAL</span><span>In-App + Teams + Email + Slack</span></div>
      </div>
      <p style={{marginTop:8}}>Routing rules are fully customizable from the Notifications Settings page.</p>

      <h3>Alert types</h3>
      <div className="help-table">
        <div className="help-tr"><span className="help-th">Approval Request</span><span>Sent to the admin Teams channel when the agent needs a human decision (risk = HIGH or DANGEROUS). Auto-denied after 10 minutes.</span></div>
        <div className="help-tr"><span className="help-th">Escalation</span><span>Sent when the agent exhausts 3 fix attempts. Includes issue key, cluster, namespace, and a link to the Escalations page.</span></div>
        <div className="help-tr"><span className="help-th">Assignment Email</span><span>Sent to a team member when an admin assigns an escalation to them.</span></div>
        <div className="help-tr"><span className="help-th">Capacity Alert</span><span>Sent when the Capacity Forecast Engine predicts resource exhaustion above the WARNING threshold. Includes usage %, trend slope, and ETA.</span></div>
        <div className="help-tr"><span className="help-th">Re-escalation</span><span>Sent when an acknowledged escalation is still unresolved — prevents issues from being silently forgotten.</span></div>
      </div>

      <h3>Teams setup</h3>
      <div className="help-table">
        <div className="help-tr"><span className="help-th">TEAMS_ADMIN_WEBHOOK_URL</span><span>Admin channel — receives approval requests</span></div>
        <div className="help-tr"><span className="help-th">TEAMS_WEBHOOK_URL</span><span>General channel — receives escalation alerts</span></div>
        <div className="help-tr"><span className="help-th">DASHBOARD_URL</span><span>Link included in every Teams card (e.g. http://localhost:5173)</span></div>
      </div>
      <p style={{marginTop: 8}}>To create a Teams webhook: go to your channel → <strong>Connectors</strong> → <strong>Incoming Webhook</strong> → copy the URL.</p>

      <h3>Per-user preferences</h3>
      <p>Each user can configure their own notification preferences from their <strong>Profile</strong> page: which channels they want to receive alerts on and their personal notification email address.</p>

      <h3>Not receiving notifications?</h3>
      <ul>
        <li>Check that the channel is enabled on the Notifications Settings page</li>
        <li>Verify webhook URLs are valid and not expired</li>
        <li>Check server logs for <code>[Notif]</code> errors</li>
        <li>Make sure <code>DASHBOARD_URL</code> is reachable from the external service (not localhost)</li>
      </ul>
    </div>
  ),

  users: (
    <div className="help-content">
      <h2>Users &amp; Teams</h2>
      <p>KubePilot has its own internal access control system separate from Kubernetes RBAC. Manage who can log in, what they can see, and which clusters they can act on.</p>

      <h3>Roles</h3>
      <div className="help-table">
        <div className="help-tr"><span className="help-th">admin</span><span>Full access — approve/deny agent actions, assign escalations, manage users and teams, apply RBAC YAML, configure notifications</span></div>
        <div className="help-tr"><span className="help-th">developer</span><span>Operational access — claim escalations, update status, request reassignment, use Orders and AI Chat</span></div>
      </div>

      <h3>Users page</h3>
      <p>Admins can create, edit, and deactivate user accounts. Each user has:</p>
      <ul>
        <li><strong>Email &amp; password</strong> — used for login (password stored as bcrypt hash)</li>
        <li><strong>Role</strong> — admin or developer</li>
        <li><strong>Cluster permissions</strong> — per-cluster, per-namespace access scopes (viewer / editor / admin)</li>
        <li><strong>Group membership</strong> — optionally assigned to a team that inherits group permissions</li>
        <li><strong>canProvision</strong> — allows the user to create new clusters via the Orders tab</li>
        <li><strong>Active flag</strong> — deactivated users cannot log in but their history is preserved</li>
      </ul>

      <h3>Teams page</h3>
      <p>Teams (groups) let you manage permissions for multiple users at once. A team has:</p>
      <ul>
        <li><strong>Name &amp; description</strong></li>
        <li><strong>Permission scopes</strong> — a list of cluster + namespace + role combinations that all members inherit</li>
      </ul>
      <p>Assigning a user to a team automatically grants them the team's permissions on top of their individual permissions.</p>

      <h3>Cluster permission scopes</h3>
      <div className="help-table">
        <div className="help-tr"><span className="help-th">viewer</span><span>Read-only — can see cluster state, escalations, and history</span></div>
        <div className="help-tr"><span className="help-th">editor</span><span>Can use Orders to send kubectl commands on the scoped cluster/namespace</span></div>
        <div className="help-tr"><span className="help-th">admin</span><span>Full control including RBAC management and approvals for the scoped cluster</span></div>
      </div>

      <h3>Who can manage users?</h3>
      <p>Only users with the <strong>admin</strong> role can create, edit, or deactivate accounts and manage teams.</p>
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
      <p>If Prometheus is connected, a red panel appears at the top showing pods that were recently OOMKilled or have abnormally high restart counts. These are the pods most likely to be escalated next.</p>
    </div>
  ),

  capacity: (
    <div className="help-content">
      <h2>Predictive Capacity</h2>
      <p>The Capacity page shows resource exhaustion forecasts for every monitored workload. The forecast engine runs automatically in the background every agent cycle and stores metric snapshots in MongoDB for trend analysis.</p>

      <h3>How the forecast works</h3>
      <p>The engine uses a <strong>hybrid model</strong> combining two independent forecasts:</p>
      <div className="help-table">
        <div className="help-tr"><span className="help-th">EWMA (6-hour)</span><span>Exponentially weighted moving average — catches rapid short-term spikes (α = 0.3). Best for fast memory leaks.</span></div>
        <div className="help-tr"><span className="help-th">WLR (7-day)</span><span>Weighted linear regression over the last 7 days — identifies slow steady growth trends. Best for gradual disk fill.</span></div>
      </div>
      <p style={{marginTop:8}}>The <strong>lower ETA</strong> (more urgent) of the two models is chosen as the forecast result. Both models apply spike suppression — individual data points that jump more than 30% from the previous reading are excluded to prevent noise from distorting the trend.</p>

      <h3>Alert levels</h3>
      <div className="help-table">
        <div className="help-tr"><span className="help-th" style={{color:'var(--success)'}}>OK</span><span>Resource saturation is not projected within the monitored window, or usage is stable/decreasing</span></div>
        <div className="help-tr"><span className="help-th" style={{color:'var(--warn)'}}>WARNING</span><span>Saturation projected within 7 days — keep an eye on it</span></div>
        <div className="help-tr"><span className="help-th" style={{color:'var(--danger)'}}>HIGH</span><span>Saturation projected within 48 hours — plan action soon</span></div>
        <div className="help-tr"><span className="help-th" style={{color:'#ef4444'}}>CRITICAL</span><span>Saturation projected within 6 hours — act immediately</span></div>
      </div>

      <h3>Confidence gating</h3>
      <p>If fewer than 12 data points are available for a target, the alert level is automatically downgraded one step (e.g. CRITICAL → HIGH). This prevents false alarms from new workloads with insufficient history.</p>

      <h3>Sparkline charts</h3>
      <p>Each resource card shows a mini sparkline of the last N snapshots. The bars after the <strong>divider line</strong> are projected future values (dashed outline, 35% opacity). Color matches the current alert level.</p>

      <h3>ETA countdown</h3>
      <p>The nearest exhaustion time is displayed as a live countdown (e.g. <em>4h 23m</em>) updated every 30 seconds.</p>

      <h3>RCA integration</h3>
      <p>When the agent generates a Root Cause Analysis for an OOMKilled, HighRestarts, or MemNearLimit issue, it automatically injects the current capacity context (alert level, usage %, trend slope, ETA) into the RCA card so the diagnosis and the resource trend are visible together.</p>

      <h3>Enabling capacity forecasting</h3>
      <p>Set <code>CAPACITY_FORECAST_ENABLED=true</code> in your <code>.env</code> file. Optional tuning variables:</p>
      <div className="help-table">
        <div className="help-tr"><span className="help-th">FORECAST_INTERVAL_CYCLES</span><span>Run forecast every N agent cycles (default: 5)</span></div>
        <div className="help-tr"><span className="help-th">FORECAST_LOOKBACK_HOURS</span><span>History window for the WLR model (default: 168 = 7 days)</span></div>
        <div className="help-tr"><span className="help-th">FORECAST_ALERT_COOLDOWN_MS</span><span>Minimum time between repeat alerts for the same target (default: 4 h)</span></div>
      </div>
    </div>
  ),

  rbac: (
    <div className="help-content">
      <h2>RBAC Management</h2>
      <p>The RBAC page provides a UI for viewing and managing Kubernetes Role-Based Access Control. All actions run real kubectl commands against your monitored clusters and require admin role in KubePilot.</p>

      <h3>Tabs</h3>
      <div className="help-table">
        <div className="help-tr"><span className="help-th">Bindings</span><span>Lists all RoleBindings and ClusterRoleBindings in the selected namespace. Shows the subject (user, group, or service account), the bound role, and the binding kind.</span></div>
        <div className="help-tr"><span className="help-th">Roles</span><span>Lists all Roles in the selected namespace with their rules (API groups, resources, and verbs). Admins can apply new YAML role definitions directly from the UI.</span></div>
        <div className="help-tr"><span className="help-th">Service Accounts</span><span>Lists all ServiceAccounts in the selected namespace. Admins can create new service accounts.</span></div>
        <div className="help-tr"><span className="help-th">Audit</span><span>A log of all RBAC changes made through KubePilot (applies, creates, deletes). Filterable by resource name and shows only dangerous operations if needed.</span></div>
      </div>

      <h3>Applying YAML</h3>
      <p>On the Roles tab, admins can paste any valid Kubernetes RBAC YAML (Role, ClusterRole, RoleBinding, ClusterRoleBinding) and click <strong>Apply</strong>. The system runs <code>kubectl apply -f</code> with the selected context and shows the raw output inline.</p>

      <h3>Dangerous role detection</h3>
      <p>Binding a subject to <code>cluster-admin</code>, <code>admin</code>, or <code>edit</code> is flagged as a dangerous operation. These bindings are highlighted in the Bindings list and logged prominently in the Audit tab.</p>

      <h3>Cluster and namespace selection</h3>
      <p>Use the dropdowns at the top of the page to select which cluster context and namespace to inspect. The namespace list is fetched live from the selected cluster.</p>

      <h3>Who can use this page?</h3>
      <p>All authenticated users can view RBAC resources. Only <strong>admin</strong> users can apply YAML, create service accounts, or delete bindings.</p>
    </div>
  ),

  chat: (
    <div className="help-content">
      <h2>AI Chat</h2>
      <p>A conversational Kubernetes expert powered by the same LLM as the agent. This is separate from the Orders tab — it answers questions and analyses your cluster, it does not execute commands.</p>

      <h3>⎈ Cluster button — Live mode</h3>
      <p>When the button is <strong>green</strong>, the AI has read-only access to your live cluster via 8 built-in tools: <code>list_pods</code>, <code>describe_pod</code>, <code>get_pod_logs</code>, <code>get_pod_events</code>, <code>get_node_status</code>, <code>query_prometheus</code>, <code>get_escalations</code>, <code>get_deployments</code>. The AI decides which tools to call, fetches real data from the cluster, and composes its answer from the live results. A <em>Fetching live data…</em> indicator appears while tools are running.</p>

      <h3>General mode (button off)</h3>
      <p>A senior Kubernetes SRE expert for any general question — YAML, Helm, HPA, debugging, architecture, networking, cloud providers, CI/CD. No cluster access, answers from knowledge only.</p>

      <h3>📥 Download PDF</h3>
      <p>When your question contains the words <em>report</em>, <em>pdf</em>, <em>download</em>, <em>export</em>, <em>summary</em>, or <em>incident</em>, a <strong>📥 Download PDF</strong> button appears automatically below the AI's response. Click it to open a formatted print-ready page and save as PDF from your browser print dialog.</p>

      <h3>Example prompts (Live mode)</h3>
      <ul>
        <li>"Give me a full cluster health report as PDF"</li>
        <li>"Which pods have the most restarts and what is causing them?"</li>
        <li>"Explain the active escalations and what I should do to resolve them"</li>
        <li>"Should I approve or deny the pending approvals? Explain the risk of each one"</li>
        <li>"Generate an incident summary report for all failing pods"</li>
        <li>"Which workloads are projected to exhaust their memory in the next 24 hours?"</li>
      </ul>
    </div>
  ),

  history: (
    <div className="help-content">
      <h2>History</h2>
      <p>A permanent audit trail of all agent decisions and human actions.</p>

      <h3>Approvals history</h3>
      <p>Every approval request the agent ever made — including who approved or denied it, the action taken, the risk level, and the timestamp. Filterable by date range, decision (approved / denied / timeout), decided-by user, and handled-by user.</p>
      <p>Use this for compliance reviews, post-mortems, and understanding why a certain action was or wasn't taken.</p>

      <h3>Escalations history</h3>
      <p>Every escalation ever created, including resolved ones. Shows: who was assigned, how many fix attempts were made, what the final status was, and when it was resolved.</p>
      <p>Admins can reassign historical escalation records from this page even after the active escalation is closed — useful for tracking accountability after the fact.</p>

      <h3>Filtering</h3>
      <div className="help-table">
        <div className="help-tr"><span className="help-th">Date range</span><span>Filter by From / To date (calendar pickers)</span></div>
        <div className="help-tr"><span className="help-th">Decision</span><span>Approvals: approved, denied, timeout, silenced</span></div>
        <div className="help-tr"><span className="help-th">Risk</span><span>LOW / MEDIUM / HIGH</span></div>
        <div className="help-tr"><span className="help-th">Decided By</span><span>Which admin approved or denied the request</span></div>
        <div className="help-tr"><span className="help-th">Handled By</span><span>Which team member was assigned to the escalation</span></div>
        <div className="help-tr"><span className="help-th">Cluster</span><span>Filter escalations by the cluster where the issue occurred</span></div>
      </div>
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
