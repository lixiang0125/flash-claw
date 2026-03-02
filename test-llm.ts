import { createLLMService } from "./src/core/container/llm-service";

async function main() {
  const llm = createLLMService();
  
  console.log("Testing generateText...");
  const result = await llm.generateText("Say 'hello' in one word");
  console.log("Result:", result);
  
  console.log("\nDone!");
}

main().catch(console.error);
