import { createLLMService } from "./src/core/container/llm-service";

async function main() {
  const llm = createLLMService();
  
  console.log("Testing generateText...");
  const result = await llm.generateText("Say 'hello' in one word");
  console.log("Result:", result);
  
  console.log("\nTesting streamText...");
  for await (const chunk of llm.streamText("Say 'hello'")) {
    process.stdout.write(chunk);
  }
  console.log("\n\nDone!");
}

main().catch(console.error);
