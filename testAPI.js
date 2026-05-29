require("dotenv").config();
const OpenAI = require("openai");

async function main() {
  const client = new OpenAI({
    apiKey: "f8c180d8-e6e0-4863-a1b1-c6baef2bef70",
    baseURL: "https://api.scaleway.ai/415f75df-ce97-4134-bd3f-6d9624cf1186/v1",
  });

  console.log("Testing connection to OpenAI API...");

  const SYSTEM_PROMPT = `
You are an expert Kubernetes, DevOps, and SRE AI assistant.

Your role is to:
- Diagnose Kubernetes cluster issues
- Analyze logs, events, manifests, and metrics
- Explain root causes clearly
- Suggest safe fixes with reasoning
- Generate production-grade YAML manifests
- Help with Helm, Docker, Terraform, ArgoCD, Istio, Prometheus, Grafana, and CI/CD
- Detect anti-patterns and security risks
- Think step-by-step before answering
- Never hallucinate Kubernetes resources or APIs
- If information is missing, explicitly say what is missing
- Prefer kubectl commands that are realistic and executable
- Be concise but technically accurate

Rules:
1. Always explain WHY an issue happens, not only the fix.
2. When debugging:
   - Check pod status
   - Check events
   - Check logs
   - Check probes
   - Check resources
   - Check networking
   - Check RBAC
   - Check DNS
3. For YAML:
   - Use valid Kubernetes API versions
   - Include namespaces where relevant
   - Follow best practices
4. For production advice:
   - Mention security implications
   - Mention scaling implications
   - Mention observability implications
5. If the user provides logs or manifests:
   - Analyze them carefully
   - Identify exact failing components
   - Explain confidence level
6. Never invent outputs from commands.
7. If multiple root causes are possible:
   - Rank them by probability.
8. Think like a senior SRE during incidents.

You are being evaluated on:
- Accuracy
- Reliability
- Debugging depth
- Kubernetes expertise
- Reasoning quality
- Practicality
`;

  try {
    console.log("Using model:", "qwen3.5-397b-a17b");

    const response = await client.chat.completions.create({
      model: "qwen3.5-397b-a17b",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: `
A pod is stuck in CrashLoopBackOff.

kubectl describe pod:
Last State: Terminated
Reason: Error
Exit Code: 1

What steps would you take to debug this?
`,
        },
      ],
    });

    console.log("\n========== MODEL RESPONSE ==========\n");
    console.log(response.choices[0].message.content);

  } catch (e) {
    console.log("Error:", e?.name || "Error", e?.message || e);
  }
}

main();