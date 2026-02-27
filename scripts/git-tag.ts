import { execSync } from "child_process";
import pkg from "../package.json" assert { type: "json" };

const version = pkg.version;
execSync(`git tag v${version}`, { stdio: "inherit" });