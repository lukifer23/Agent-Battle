import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}", "test/**/*.ts"],
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.flat.recommended.rules,
  },
);
