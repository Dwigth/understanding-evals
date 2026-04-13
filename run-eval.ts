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

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

// --- LLM Provider abstraction ---

interface LLMProvider {
  chat(messages: ChatMessage[], maxTokens: number): Promise<string>;
}

class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private model: string;

  constructor(model: string) {
    this.client = new Anthropic();
    this.model = model;
  }

  async chat(messages: ChatMessage[], maxTokens: number): Promise<string> {
    const systemMsg = messages.find((m) => m.role === "system");
    const userMessages = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      ...(systemMsg ? { system: systemMsg.content } : {}),
      messages: userMessages,
    });

    const block = response.content[0];
    return block.type === "text" ? block.text : "";
  }
}

class OllamaProvider implements LLMProvider {
  private baseUrl: string;
  private model: string;

  constructor(model: string, baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
  }

  async chat(messages: ChatMessage[], maxTokens: number): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
        options: { num_predict: maxTokens },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as { message?: { content?: string } };
    return data.message?.content ?? "";
  }
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

// --- Provider factory ---

function createProvider(model: string, role: "chat" | "judge"): LLMProvider {
  const provider = (process.env.LLM_PROVIDER ?? "anthropic").toLowerCase();

  if (provider === "ollama") {
    const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
    return new OllamaProvider(model, baseUrl);
  }

  if (provider === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error("Error: ANTHROPIC_API_KEY environment variable is required.");
      console.error("Export it with: export ANTHROPIC_API_KEY=sk-ant-...");
      process.exit(1);
    }
    return new AnthropicProvider(model);
  }

  throw new Error(`Unknown LLM_PROVIDER: "${provider}". Use "anthropic" or "ollama".`);
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
  provider: LLMProvider,
  config: InitConfig,
  testCase: TestCase
): Promise<string> {
  const systemPrompt = `${config["system-task"]}\n\nIMPORTANTE: Responde ÚNICAMENTE con base en el siguiente contexto. Si la pregunta no se puede responder con el contexto, dilo claramente.\n\nContexto:\n${testCase.context ?? "Sin contexto."}`;

  return provider.chat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: testCase.input },
    ],
    500
  );
}

async function judgeResponse(
  provider: LLMProvider,
  prompt: string
): Promise<JudgeResult> {
  const text = await provider.chat([{ role: "user", content: prompt }], 500);

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
  const provider = (process.env.LLM_PROVIDER ?? "anthropic").toLowerCase();
  const isOllama = provider === "ollama";

  const defaultChatModel = isOllama ? "llama3.2" : "claude-haiku-4-5-20251001";
  const defaultJudgeModel = isOllama ? "llama3.2" : "claude-sonnet-4-6-20250514";

  const chatModel = process.env.CHAT_MODEL ?? defaultChatModel;
  const judgeModel = process.env.JUDGE_MODEL ?? defaultJudgeModel;
  const ollamaUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

  console.log("Loading configuration...");
  const config = loadJson<InitConfig>("init.json");
  const testCases = loadJson<TestCase[]>("test-dataset.json");
  const promptTemplate = loadPromptTemplate();

  console.log(`Provider:    ${provider}${isOllama ? ` (${ollamaUrl})` : ""}`);
  console.log(`System task: ${config["system-task"].substring(0, 80)}...`);
  console.log(`Test cases:  ${testCases.length}`);
  console.log(`Judge model: ${judgeModel}`);
  console.log(`Chat model:  ${chatModel}`);

  const chatProvider = createProvider(chatModel, "chat");
  const judgeProvider = createProvider(judgeModel, "judge");
  const results: EvalResult[] = [];

  for (const testCase of testCases) {
    process.stdout.write(`\nRunning ${testCase.id}...`);

    // Step 1: Generate chatbot response
    const aiResponse = await generateChatbotResponse(chatProvider, config, testCase);

    // Step 2: Build the eval prompt with the actual response
    const evalPrompt = buildEvalPrompt(
      promptTemplate,
      config,
      testCase,
      aiResponse
    );

    // Step 3: Judge the response
    const judgeResult = await judgeResponse(judgeProvider, evalPrompt);

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
