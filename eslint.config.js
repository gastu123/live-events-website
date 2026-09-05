export default [
  {
    files: ["**/*.js"],
    ignores: ["node_modules/**", "dist/**"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        history: "readonly",
        sessionStorage: "readonly",
        FormData: "readonly",
        fetch: "readonly",
        crypto: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        self: "readonly",
        caches: "readonly",
        Response: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-undef": "error",
    },
  },
];
