import { z } from "zod";
import type {
  AskUserAnswer,
  AskUserQuestionSpec,
  ToolHandler,
} from "@nova/core";

const optionSchema = z.object({
  label: z.string().min(1).max(60),
  description: z.string().max(200).optional(),
});

const questionSchema = z.object({
  question: z.string().min(1).max(500),
  header: z.string().min(1).max(12),
  options: z.array(optionSchema).min(2).max(4),
  multi_select: z.boolean().default(false),
});

const inputSchema = z.object({
  questions: z.array(questionSchema).min(1).max(4),
});

type QuestionInput = z.infer<typeof questionSchema>;

function formatAnswers(questions: QuestionInput[], answers: AskUserAnswer[]): string {
  const lines: string[] = ["[ask_user] answers:"];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const a = answers[i];
    if (!q) continue;
    if (!a) {
      lines.push(`- Q${i + 1} "${q.header}": (no answer)`);
      continue;
    }
    const picks = a.selected.length > 0 ? a.selected.join(" | ") : "(none)";
    const free = a.freeform ? ` → ${a.freeform}` : "";
    lines.push(`- Q${i + 1} "${q.header}": ${picks}${free}`);
  }
  return lines.join("\n");
}

export const askUserQuestionTool: ToolHandler = {
  definition: {
    name: "askUserQuestion",
    description:
      "Ask the user 1–4 multiple-choice questions in a single turn and wait for their answers. " +
      "Each question has its own short header (≤12 chars, used as a tab label), 2–4 options, and an " +
      "optional multi_select flag. The runtime appends an 'Other' option to every question that lets the " +
      "user supply freeform text — do not write your own 'Other' option. Use this only when the user's " +
      "intent cannot be inferred from context and a decision is genuinely needed; avoid asking on every step.",
    inputSchema,
  },
  async run(rawInput, ctx) {
    const input = inputSchema.parse(rawInput);
    if (!ctx.askUser) {
      return {
        output: "ask_user unavailable in this environment",
        isError: true,
      };
    }
    const specs: AskUserQuestionSpec[] = input.questions.map((q) => ({
      question: q.question,
      header: q.header,
      options: q.options.map((o) => ({
        label: o.label,
        ...(o.description ? { description: o.description } : {}),
      })),
      multiSelect: q.multi_select,
    }));
    const res = await ctx.askUser({ questions: specs });
    if (res.cancelled) {
      return { output: "user cancelled", isError: true };
    }
    return { output: formatAnswers(input.questions, res.answers) };
  },
};
