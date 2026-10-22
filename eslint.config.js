import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

const internal = (allowed) => ({
  "no-restricted-imports": [
    "error",
    {
      patterns: [
        {
          regex: allowed.length ? `^@hardwood/(?!(${allowed.join("|")})$)` : "^@hardwood/",
          message: "Dependency rule: see PLAN.md section 3.",
        },
      ],
    },
  ],
});

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/coverage/**", "**/.next/**", "**/generated/**", "**/next-env.d.ts"],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  prettier,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  // agents-core imports no other package; agents and connectors import only agents-core.
  { files: ["packages/agents-core/**"], rules: internal([]) },
  { files: ["packages/agent-*/**", "packages/connectors/**"], rules: internal(["agents-core"]) },
  {
    files: ["apps/console/**/*.tsx"],
    languageOptions: { globals: { ...globals.browser } },
  },
);
