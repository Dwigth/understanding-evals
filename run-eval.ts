import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

// --- Types ---

interface InitConfig {
  "system-task": string;
  "definition-of-good": string;
}

interface TestCase {
  id: string;
  input: string;
  expected: string;
  context?: string;
}

interface EvalScores {
  accuracy: number;
  completeness: number;
  relevance: number;
  tone: number;
  conciseness: number;
}

interface JudgeResult {
  verdict: "PASS" | "PARTIAL" | "FAIL";
  scores: EvalScores;
  average_score: number;
  reasoning: string;
}

interface EvalResult {
  test_id: string;
  input: string;
  ai_response: string;
  judge: JudgeResult;
}

// --- File loaders ---

function loadJson<T>(filename: string): T {
  const filepath = join(import.meta.dirname!, filename);
  if (!existsSync(filepath)) {
    throw new Error(`File not found: ${filepath}`);
  }
  return JSON.parse(readFileSync(filepath, "utf-8")) as T;
}

function loadPromptTemplate(): string {
  const filepath = join(import.meta.dirname!, "eval-prompt.md");
  if (!existsSync(filepath)) {
    throw new Error("eval-prompt.md not found");
  }
  return readFileSync(filepath, "utf-8");
}

// --- Core logic ---

function buildEvalPrompt(
  template: string,
  config: InitConfig,
  testCase: TestCase,
  aiResponse: string
): string {
  return template
    .replace("{{system_task}}", config["system-task"])
    .replace("{{definition_of_good}}", config["definition-of-good"])
    .replace("{{context}}", testCase.context ?? "No se proporcionó contexto.")
    .replace("{{user_input}}", testCase.input)
    .replace("{{expected}}", testCase.expected)
    .replace("{{ai_response}}", aiResponse);
}

async function generateChatbotResponse(
  client: Anthropic,
  config: InitConfig,
  testCase: TestCase
): Promise<string> {
  const systemPrompt = `${config["system-task"]}\n\nIMPORTANTE: Responde ÚNICAMENTE con base en el siguiente contexto. Si la pregunta no se puede responder con el contexto, dilo claramente.\n\nContexto:\n${testCase.context ?? "Sin contexto."}`;

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 500,
    system: systemPrompt,
    messages: [{ role: "user", content: testCase.input }],
  });

  const block = response.content[0];
  return block.type === "text" ? block.text : "";
}

async function judgeResponse(
  client: Anthropic,
  prompt: string
): Promise<JudgeResult> {
  const response = await client.messages.create({
    model: "claude-sonnet-4-6-20250514",
    max_tokens: 500,
    messages: [{ role: "user", content: prompt }],
  });

  const block = response.content[0];
  const text = block.type === "text" ? block.text : "";

  // Extract JSON from response (handles markdown code blocks)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Judge did not return valid JSON: ${text}`);
  }

  return JSON.parse(jsonMatch[0]) as JudgeResult;
}

function printResult(result: EvalResult): void {
  const icon =
    result.judge.verdict === "PASS"
      ? "[PASS]"
      : result.judge.verdict === "PARTIAL"
        ? "[PARTIAL]"
        : "[FAIL]";

  console.log(`\n${icon} ${result.test_id} — avg: ${result.judge.average_score}`);
  console.log(`  Input:    ${result.input}`);
  console.log(`  Response: ${result.ai_response.substring(0, 120)}...`);
  console.log(
    `  Scores:   accuracy=${result.judge.scores.accuracy} completeness=${result.judge.scores.completeness} relevance=${result.judge.scores.relevance} tone=${result.judge.scores.tone} conciseness=${result.judge.scores.conciseness}`
  );
  console.log(`  Reason:   ${result.judge.reasoning}`);
}

function printSummary(results: EvalResult[]): void {
  const total = results.length;
  const pass = results.filter((r) => r.judge.verdict === "PASS").length;
  const partial = results.filter((r) => r.judge.verdict === "PARTIAL").length;
  const fail = results.filter((r) => r.judge.verdict === "FAIL").length;
  const avgScore =
    results.reduce((sum, r) => sum + r.judge.average_score, 0) / total;

  console.log("\n" + "=".repeat(60));
  console.log("RESULTS SUMMARY");
  console.log("=".repeat(60));
  console.log(`Total:   ${total} test cases`);
  console.log(`PASS:    ${pass} (${((pass / total) * 100).toFixed(0)}%)`);
  console.log(`PARTIAL: ${partial} (${((partial / total) * 100).toFixed(0)}%)`);
  console.log(`FAIL:    ${fail} (${((fail / total) * 100).toFixed(0)}%)`);
  console.log(`Average: ${avgScore.toFixed(2)} / 5.0`);
  console.log("=".repeat(60));
}

// --- Main ---

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Error: ANTHROPIC_API_KEY environment variable is required.");
    console.error("Export it with: export ANTHROPIC_API_KEY=sk-ant-...");
    process.exit(1);
  }

  console.log("Loading configuration...");
  const config = loadJson<InitConfig>("init.json");
  const testCases = loadJson<TestCase[]>("test-dataset.json");
  const promptTemplate = loadPromptTemplate();

  console.log(`System task: ${config["system-task"].substring(0, 80)}...`);
  console.log(`Test cases:  ${testCases.length}`);
  console.log(`Eval model:  claude-sonnet-4-6 (judge)`);
  console.log(`Chat model:  claude-haiku-4-5 (chatbot under test)`);

  const client = new Anthropic();
  const results: EvalResult[] = [];

  for (const testCase of testCases) {
    process.stdout.write(`\nRunning ${testCase.id}...`);

    // Step 1: Generate chatbot response
    const aiResponse = await generateChatbotResponse(client, config, testCase);

    // Step 2: Build the eval prompt with the actual response
    const evalPrompt = buildEvalPrompt(
      promptTemplate,
      config,
      testCase,
      aiResponse
    );

    // Step 3: Judge the response
    const judgeResult = await judgeResponse(client, evalPrompt);

    const result: EvalResult = {
      test_id: testCase.id,
      input: testCase.input,
      ai_response: aiResponse,
      judge: judgeResult,
    };

    results.push(result);
    printResult(result);
  }

  printSummary(results);

  // Save detailed results
  const outputPath = join(import.meta.dirname!, "eval-results.json");
  writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\nDetailed results saved to: eval-results.json`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
