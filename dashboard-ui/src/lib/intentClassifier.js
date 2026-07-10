// Hand-rolled regex/keyword-scoring intent classifier for the chat input — decides
// whether a message wants a PDF export, is about the live cluster, or is a general
// Kubernetes question. Extracted from ChatPage.jsx, which previously mixed this with
// the PDF report renderer and the chat UI itself in one 771-line file.

const PDF_PATTERNS = [
  { re: /\b(generate|create|make|build|give\s+me)\s+(\w+\s+){0,3}report\b/,   score: 6 },
  { re: /\b(download|export|save)\s+(\w+\s+){0,2}report\b/,                   score: 6 },
  { re: /\b(generate|create|export|save|make)\s+(\w+\s+){0,2}pdf\b/,           score: 6 },
  { re: /\bgive\s+me\s+(\w+\s+){0,3}pdf\b/,                                   score: 6 },
  { re: /\bgive\s+me\s+(\w+\s+){0,3}report\b/,                                score: 6 },
  { re: /\b(make|create|give)\s+me\s+(\w+\s+){0,2}document\b/,                score: 5 },
  { re: /\bexport\s+as\s+pdf\b/,                                               score: 6 },
  { re: /\bsave\s+as\s+pdf\b/,                                                 score: 6 },
  { re: /\bhealth\s+report\b/,                                                 score: 5 },
  { re: /\bcluster\s+(\w+\s+)?report\b/,                                       score: 6 },
  { re: /\bstatus\s+report\b/,                                                 score: 5 },
  { re: /\brapport\b/,                                                         score: 4 },
]

const INTENTS = {
  export_pdf: {
    patterns: PDF_PATTERNS,
    keywords: [
      { text: 'pdf',      score: 3 },
      { text: 'report',   score: 2 },
      { text: 'download', score: 2 },
      { text: 'export',   score: 2 },
    ],
  },
  cluster_debug: {
    phrases: [
      { text: 'my pods are crashing',             score: 5 },
      { text: 'cluster is down',                  score: 5 },
      { text: 'what is wrong with my cluster',    score: 5 },
      { text: 'show cluster health',              score: 5 },
      { text: 'show me all pods',                 score: 5 },
      { text: 'which pods have',                  score: 5 },
      { text: 'active escalations',               score: 5 },
      { text: 'health of the default namespace',  score: 5 },
      { text: 'pending approvals',                score: 4 },
      { text: 'my cluster',                       score: 4 },
      { text: 'my pods',                          score: 4 },
      { text: 'my nodes',                         score: 4 },
      { text: 'right now',                        score: 3 },
      { text: 'currently running',                score: 4 },
      { text: 'currently failing',                score: 4 },
      { text: 'show me',                          score: 3 },
    ],
    keywords: [
      { text: 'cluster',    score: 2 },
      { text: 'pods',       score: 2 },
      { text: 'nodes',      score: 2 },
      { text: 'crash',      score: 2 },
      { text: 'crashing',   score: 2 },
      { text: 'failing',    score: 2 },
      { text: 'restart',    score: 2 },
      { text: 'kubernetes', score: 2 },
      { text: 'namespace',  score: 2 },
      { text: 'deployment', score: 2 },
      { text: 'escalation', score: 2 },
      { text: 'minikube',   score: 3 },
    ],
  },
  explain: {
    phrases: [
      { text: 'what is the difference', score: 5 },
      { text: 'how does',               score: 5 },
      { text: 'how do i',               score: 5 },
      { text: 'how to',                 score: 5 },
      { text: 'what is',                score: 4 },
      { text: 'what is a',              score: 6 },
      { text: 'what is an',             score: 6 },
      { text: 'what are',               score: 4 },
      { text: 'explain the',            score: 5 },
      { text: 'can you explain',        score: 5 },
      { text: 'difference between',     score: 5 },
      { text: 'why does',               score: 4 },
      { text: 'why is',                 score: 4 },
      { text: 'what does',              score: 4 },
      { text: 'what do',                score: 4 },
      { text: 'give me the definition', score: 7 },
      { text: 'definition of',          score: 7 },
      { text: 'why do we need',         score: 6 },
      { text: 'why need',               score: 5 },
      { text: 'why use',                score: 5 },
      { text: 'tell me about',          score: 5 },
      { text: 'give me an overview',    score: 5 },
      { text: 'give me an explanation', score: 6 },
      { text: 'what are the benefits',  score: 5 },
      { text: 'what are the advantages',score: 5 },
    ],
    keywords: [
      { text: 'explain',    score: 2 },
      { text: 'definition', score: 5 },
      { text: 'meaning',    score: 3 },
      { text: 'overview',   score: 2 },
      { text: 'concept',    score: 3 },
    ],
  },
}

export function detectIntent(text) {
  const lower = text.toLowerCase()

  const scores = {}
  for (const [intent, def] of Object.entries(INTENTS)) {
    let score = 0
    for (const pat of (def.patterns ?? [])) {
      if (pat.re.test(lower)) score += pat.score
    }
    for (const phrase of (def.phrases ?? [])) {
      if (lower.includes(phrase.text)) score += phrase.score
    }
    for (const kw of def.keywords) {
      const re = new RegExp(`\\b${kw.text}\\b`)
      if (re.test(lower)) score += kw.score + Math.floor(kw.text.length / 4)
    }
    scores[intent] = score
  }

  const maxScore = Math.max(...Object.values(scores))
  if (maxScore < 2) return { intent: 'chat', confidence: 0, scores }

  const [bestIntent] = Object.entries(scores).reduce(
    (best, curr) => (curr[1] > best[1] ? curr : best),
    ['chat', 0]
  )

  return { intent: bestIntent, confidence: Math.min(maxScore / 15, 1.0), scores }
}
