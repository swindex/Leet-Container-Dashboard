#!/usr/bin/env bun

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.resolve(__dirname, "..");
const vendorDir = path.join(projectRoot, "src", "public", "vendor");

interface CopyTask {
  from: string;
  to: string;
  recursive?: boolean;
}

const copyTasks: CopyTask[] = [
  // Bootstrap CSS
  {
    from: path.join(projectRoot, "node_modules", "bootstrap", "dist", "css", "bootstrap.min.css"),
    to: path.join(vendorDir, "bootstrap", "css", "bootstrap.min.css"),
  },
  {
    from: path.join(projectRoot, "node_modules", "bootstrap", "dist", "css", "bootstrap.min.css.map"),
    to: path.join(vendorDir, "bootstrap", "css", "bootstrap.min.css.map"),
  },
  // Bootstrap JS
  {
    from: path.join(projectRoot, "node_modules", "bootstrap", "dist", "js", "bootstrap.bundle.min.js"),
    to: path.join(vendorDir, "bootstrap", "js", "bootstrap.bundle.min.js"),
  },
  {
    from: path.join(projectRoot, "node_modules", "bootstrap", "dist", "js", "bootstrap.bundle.min.js.map"),
    to: path.join(vendorDir, "bootstrap", "js", "bootstrap.bundle.min.js.map"),
  },
  // Font Awesome CSS
  {
    from: path.join(projectRoot, "node_modules", "@fortawesome", "fontawesome-free", "css", "all.min.css"),
    to: path.join(vendorDir, "fontawesome", "css", "all.min.css"),
  },
  // Font Awesome Webfonts (entire directory)
  {
    from: path.join(projectRoot, "node_modules", "@fortawesome", "fontawesome-free", "webfonts"),
    to: path.join(vendorDir, "fontawesome", "webfonts"),
    recursive: true,
  },
  // Vue
  {
    from: path.join(projectRoot, "node_modules", "vue", "dist", "vue.global.prod.js"),
    to: path.join(vendorDir, "vue", "vue.global.prod.js"),
  },
];

async function copyFile(from: string, to: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
    console.log(`✓ Copied: ${path.relative(projectRoot, from)} → ${path.relative(projectRoot, to)}`);
  } catch (error) {
    console.warn(`⚠ Warning: Could not copy ${path.relative(projectRoot, from)}: ${(error as Error).message}`);
  }
}

async function copyDirectory(from: string, to: string): Promise<void> {
  try {
    await fs.mkdir(to, { recursive: true });
    const entries = await fs.readdir(from, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(from, entry.name);
      const destPath = path.join(to, entry.name);

      if (entry.isDirectory()) {
        await copyDirectory(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    }
    console.log(`✓ Copied directory: ${path.relative(projectRoot, from)} → ${path.relative(projectRoot, to)}`);
  } catch (error) {
    console.warn(`⚠ Warning: Could not copy directory ${path.relative(projectRoot, from)}: ${(error as Error).message}`);
  }
}

async function main() {
  console.log("📦 Copying vendor files from node_modules...\n");

  // Clean vendor directory first
  try {
    await fs.rm(vendorDir, { recursive: true, force: true });
    console.log("🧹 Cleaned vendor directory\n");
  } catch (error) {
    // Directory might not exist, that's fine
  }

  // Execute copy tasks
  for (const task of copyTasks) {
    if (task.recursive) {
      await copyDirectory(task.from, task.to);
    } else {
      await copyFile(task.from, task.to);
    }
  }

  console.log("\n✅ Vendor files copied successfully!");
}

main().catch((error) => {
  console.error("❌ Error copying vendor files:", error);
  process.exit(1);
});
