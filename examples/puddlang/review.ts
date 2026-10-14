import { input, spawn, z } from 'puddlang';

const Agent = z.enum(['claude-code', 'codex', 'opencode', 'gemini-cli']);
const Mode = z.enum(['interactive', 'scripted']);
const task = z
  .object({
    project: z.string(),
    worktree: z.string().optional(),
    task: z.string(),
    coder: Agent.default('codex'),
    reviewer: Agent.default('codex'),
    coderMode: Mode.default('interactive'),
    reviewerMode: Mode.default('scripted'),
  })
  .parse(input);
const location = { project: task.project, ...(task.worktree ? { worktree: task.worktree } : {}) };
const coder = await spawn({
  agent: task.coder,
  mode: task.coderMode,
  ...location,
  title: 'Implementer',
});
const reviewer = await spawn({
  agent: task.reviewer,
  mode: task.reviewerMode,
  ...location,
  title: 'Reviewer',
});
const Review = z.object({ complete: z.boolean(), feedback: z.string() });

let instruction = task.task;
let approved = false;
for (let round = 0; round < 5; round++) {
  const result = await coder.ask(instruction);
  const review = await reviewer.ask({
    prompt:
      'Review the implementation against the original task. Inspect the actual changes ' +
      'and run relevant checks. Do not modify files. Return complete only when the task is ' +
      'satisfied; otherwise give actionable feedback.',
    input: { task: task.task, result },
    schema: Review,
  });
  console.log({ round: round + 1, review });
  if (review.complete) {
    approved = true;
    break;
  }
  instruction = `Original task: ${task.task}\nAddress the reviewer’s feedback:\n${review.feedback}`;
}
if (!approved) throw new Error('Reviewer did not approve within five rounds');
export default { approved, coder: coder.handle, reviewer: reviewer.handle };
