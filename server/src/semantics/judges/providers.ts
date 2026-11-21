// Which provider answers a model: a model named gemini-* goes to the Gemini API, any other to the
// Claude API. Each provider is made on first use, so one whose key is not set costs nothing until
// a judge names one of its models.

import { claudeFold, type FoldModel } from './fold-model.ts';
import { geminiClient, geminiFold, geminiJudge } from './gemini.ts';
import { claudeClient, claudeJudge, type JudgeModel } from './model.ts';

export interface Models { judge: JudgeModel; fold: FoldModel }

export const isGemini = (model: string): boolean => model.startsWith('gemini-');

const once = (make: () => Models): (() => Models) => {
  let made: Models | null = null;
  return () => {
    made ??= make();
    return made;
  };
};

/** Models that send each call to the provider of the model it names. */
export function routedModels(make: { claude: () => Models; gemini: () => Models }): Models {
  const claude = once(make.claude);
  const gemini = once(make.gemini);
  const of = (model: string): Models => (isGemini(model) ? gemini() : claude());
  return {
    judge: { judge: (model, criterion, excerpt, system) => of(model).judge.judge(model, criterion, excerpt, system) },
    fold: { fold: (model, system, text) => of(model).fold.fold(model, system, text) },
  };
}

/** The models of the process: Claude through the Anthropic SDK (ANTHROPIC_API_KEY), Gemini with GEMINI_API_KEY. */
export function modelsFromEnv(env: Record<string, string | undefined>): Models {
  return routedModels({
    claude: () => {
      const client = claudeClient();
      return { judge: claudeJudge(client), fold: claudeFold(client) };
    },
    gemini: () => {
      const client = geminiClient({ apiKey: env.GEMINI_API_KEY });
      return { judge: geminiJudge(client), fold: geminiFold(client) };
    },
  });
}
