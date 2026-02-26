import "dotenv/config";
import { createApp } from "./app.js";
import { ensureDevDataSeeded } from "./lib/dataPaths.js";
import { isDemoMode } from "./lib/demoMode.js";

const PORT = process.env.PORT || 3000;

async function start(): Promise<void> {
  await ensureDevDataSeeded();

  if (isDemoMode()) {
    console.log("⚠️  DEMO MODE ENABLED - All write operations will be simulated");
  }

  const app = createApp();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

void start();
