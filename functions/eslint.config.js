module.exports = [
  {
    files: ["**/*.js"],
    ignores: ["node_modules/**"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        Buffer: "readonly",
        console: "readonly",
        process: "readonly",
        require: "readonly",
        module: "readonly",
        exports: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", {"argsIgnorePattern": "^_"}],
      "no-undef": "error",
      "eqeqeq": "error",
    },
  },
];
