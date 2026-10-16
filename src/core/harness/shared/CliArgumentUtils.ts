/** Move greedy multi-value option/value pairs after a positional prompt. */
export function moveGreedyOptionArgsAfterPrompt(
  args: readonly string[],
  prompt: string,
  option: string
): string[] {
  const regularArgs: string[] = [];
  const greedyOptionArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === option && index + 1 < args.length) {
      greedyOptionArgs.push(args[index], args[index + 1]);
      index += 1;
    } else {
      regularArgs.push(args[index]);
    }
  }

  return [...regularArgs, prompt, ...greedyOptionArgs];
}
