const kubectl = require("./src/tools/kubectl");
const PodAnalyzer = require("./src/agents/podAnalyzer");

async function run() {
  try {
    console.log("🔍 Getting pods...\n");

    const pods = await kubectl.getPods("default", "minikube", true);
    
    console.log(`Found ${pods.items.length} pods in cluster\n`);

    console.log("🔍 Analyzing with PodAnalyzer...\n");

    const issues = PodAnalyzer.extractIssues(pods);
    
    if (issues.length === 0) {
      console.log("✅ No issues detected - cluster healthy!");
    } else {
      console.log(`⚠️  ${issues.length} issue(s) detected:\n`);
      issues.forEach((issue, i) => {
        console.log(`Issue ${i + 1}: ${issue.type}`);
        console.log(`  Pod: ${issue.podName}`);
        console.log(`  Deployment: ${issue.deployment}`);
        console.log(`  Container: ${issue.containerName}`);
        console.log(`  Image: ${issue.containerImage}`);
        console.log(`  Message: ${issue.message}\n`);
      });
    }

  } catch (err) {
    console.error("Error running agent test:", err.message);
  }
}

run();