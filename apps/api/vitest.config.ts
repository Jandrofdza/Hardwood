import { defineProject } from "vitest/config";

export default defineProject({
  // DB tests share one database; run files one at a time.
  test: { name: "api", fileParallelism: false },
});
