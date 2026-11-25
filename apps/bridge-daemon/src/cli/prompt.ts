import readline from "node:readline";

export async function askQuestion(query: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const promptText = defaultValue ? `${query} [${defaultValue}]: ` : `${query}: `;

  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed || defaultValue || "");
    });
  });
}

/**
 * Prompts the user for sensitive credentials (e.g. pairing secret, vault passphrase)
 * using masked input (asterisks) so that credentials never appear in terminal output,
 * process lists, or shell history. Supports non-interactive piped input.
 */
export async function askSecret(query: string): Promise<string> {
  // If stdin is not a TTY (e.g. piped input in scripts or CI), read from stream safely
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr, // Send prompt to stderr so stdout is not polluted
    });

    return new Promise((resolve) => {
      rl.question(`${query}: `, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  return new Promise((resolve) => {
    process.stdout.write(`${query}: `);
    let secret = "";

    const onData = (charBuffer: Buffer) => {
      const char = charBuffer.toString();

      // Enter / Return
      if (char === "\n" || char === "\r" || char === "\u0004") {
        process.stdin.removeListener("data", onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        resolve(secret.trim());
        return;
      }

      // Ctrl+C
      if (char === "\u0003") {
        process.stdin.setRawMode(false);
        process.stdout.write("\n");
        process.exit(130);
      }

      // Backspace / Delete
      if (char === "\u0008" || char === "\x7f") {
        if (secret.length > 0) {
          secret = secret.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }

      // Ignore other control sequences
      if (char.charCodeAt(0) < 32) {
        return;
      }

      // Normal character: append and print masked asterisk
      secret += char;
      process.stdout.write("*");
    };

    process.stdin.resume();
    process.stdin.setRawMode(true);
    process.stdin.on("data", onData);
  });
}
