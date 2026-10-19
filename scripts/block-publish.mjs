console.error(
  "Publishing blocked: serial access requires a local pnpm runtime patch. Use a released runtime with serial support before publishing to npm.",
);
process.exitCode = 1;
