import "dotenv/config";
import { createApp } from "./app.js";
import { ensureDevDataSeeded } from "./lib/dataPaths.js";

const PORT = process.env.PORT || 3000;

async function start(): Promise<void> {
  await ensureDevDataSeeded();

  const app = createApp();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

void start();
