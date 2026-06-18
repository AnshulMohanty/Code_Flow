import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { connectMongo } from "./db/connectMongo.js";

try {
  await connectMongo();
  const app = createApp();

  app.listen(env.apiPort, () => {
    console.log(`codeflow-api listening on port ${env.apiPort}`);
  });
} catch {
  process.exit(1);
}
