import readline from 'readline';

interface PromptForYesNoOptions {
  defaultValue?: boolean;
  invalidAnswerMessage?: string;
}

export async function promptLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    return await new Promise<string>((resolve) => {
      rl.question(prompt, (answer) => {
        resolve(answer.trim());
      });
    });
  } finally {
    rl.close();
  }
}

export async function promptForYesNo(
  prompt: string,
  {
    defaultValue = false,
    invalidAnswerMessage = 'Please answer "y" or "n".',
  }: PromptForYesNoOptions = {}
): Promise<boolean> {
  while (true) {
    const answer = (await promptLine(prompt)).toLowerCase();

    if (answer === '') {
      return defaultValue;
    }

    if (answer === 'y' || answer === 'yes') {
      return true;
    }

    if (answer === 'n' || answer === 'no') {
      return false;
    }

    process.stdout.write(`${invalidAnswerMessage}\n`);
  }
}
